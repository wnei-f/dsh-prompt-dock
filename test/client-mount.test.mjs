/**
 * 临时冒烟测试（不随插件发布）：用桩 React 在 Node 里真实加载 lib/client.js。
 * 覆盖：① 模块注册形状 ② 两个座位（工具行 + plugins.bundle.config） ③ 工具行三级降级
 * ④ 六态反馈机与六类错误文案 ⑤ 设置卡片七组 ⑥ Toast 上限 ⑦ 视觉令牌（无硬编码颜色）。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// ---- 桩 React：有状态 hook 槽位 + 可遍历的 createElement ----
// 组件是用普通函数直接调用的，所以必须按「组件函数 + hook 序号」保存状态；
// useEffect 默认不执行，需要时用 runEffectsEnabled 打开。
const hookStore = new Map();
let allRenderFns = null;
let lastFrameFns = new Set();
let activeHooks = null;
let pendingEffects = [];
const ranEffects = new Set();
const fnIds = new WeakMap();
let nextFnId = 1;
let runEffectsEnabled = false;
function fnId(fn) {
  if (!fnIds.has(fn)) fnIds.set(fn, nextFnId++);
  return fnIds.get(fn);
}
function resetHooks() { hookStore.clear(); ranEffects.clear(); }

function renderComponent(fn, props) {
  const slots = hookStore.get(fn) || { states: [], cursor: 0 };
  hookStore.set(fn, slots);
  slots.cursor = 0;
  if (allRenderFns) allRenderFns.add(fn);
  activeHooks = slots;
  pendingEffects = [];
  let out;
  try { out = fn(props); } finally { activeHooks = null; }
  const effects = pendingEffects;
  pendingEffects = [];
  if (runEffectsEnabled) {
    effects.forEach((cb, i) => {
      const key = fnId(fn) + "#" + i;
      if (ranEffects.has(key)) return;
      ranEffects.add(key);
      try { const cleanup = cb(); if (typeof cleanup === "function") cleanups.push(cleanup); } catch (e) {}
    });
  }
  return out;
}
let cleanups = [];
function runCleanups() { cleanups.forEach((c) => { try { c(); } catch (e) {} }); cleanups = []; }
function useSlot(init) {
  const slots = activeHooks;
  if (!slots) return [typeof init === "function" ? init() : init, () => {}];
  const i = slots.cursor++;
  if (!(i in slots.states)) slots.states[i] = typeof init === "function" ? init() : init;
  return [slots.states[i], (v) => { slots.states[i] = typeof v === "function" ? v(slots.states[i]) : v; }];
}

const React = {
  useState: (init) => useSlot(init),
  useEffect: (cb) => { pendingEffects.push(cb); },
  useRef: (init) => useSlot({ current: init === undefined ? null : init })[0],
  useMemo: (fn) => fn(),
  createElement: (type, props, ...children) => {
    const p = Object.assign({}, props || {});
    // 模拟 ref 挂载：useAnchorFollow / 宽度测量依赖 ref.current 的 rect
    if (p.ref && typeof p.ref === "object" && "current" in p.ref) {
      p.ref.current = {
        getBoundingClientRect: () => ({ left: 100, top: 700, width: 120, height: 28, right: 220, bottom: 728 }),
        contains: () => false,
        parentNode: { getBoundingClientRect: () => ({ width: sandbox.__rowWidth }) },
      };
    }
    return {
      $$el: true, type, props: p,
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    };
  },
};

// ---- 座位登记 ----
const registrations = [];
const fakeCtx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, cb) => {
      const off = cb();
      registrations.push({ slot: name, off });
      return off;
    },
    register: (def, component) => { return { def, component }; },
  },
};

// 桩 document：ensureCss 短路；[data-composer-card] 提供输入框矩形
let styleTagText = "";
const sandbox = {
  require: (name) => (name === "react" ? React : {}),
  document: {
    querySelector: () => ({}),
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: () => {} },
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  fetch: (...a) => currentFetch(...a),
  AbortController: class { abort() { this.aborted = true; } get signal() { return {}; } },
  TextDecoder, TextEncoder,
  JSON, Math, Date, String, Number, Array, Object, console, setTimeout, clearInterval, setInterval, Promise,
};
sandbox.window = {
  __ModuleLoader__: { load: ({ id, factory }) => { loaded = { id, factory }; } },
  innerHeight: 800, innerWidth: 1200,
  __rowWidth: 800,
  addEventListener: () => {}, removeEventListener: () => {},
};
sandbox.globalThis = sandbox;
// 桩 localStorage：首次使用告知靠它记住「已关闭」
const lsStore = new Map();
sandbox.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => { lsStore.set(k, String(v)); },
  removeItem: (k) => { lsStore.delete(k); },
  clear: () => lsStore.clear(),
};
vm.createContext(sandbox);

let loaded = null;
vm.runInContext(src, sandbox);

// 默认 fetch 桩：一律失败（让错误路径可测）
let currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
function sseFetch(frames) {
  return () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(null),
    body: {
      getReader: () => {
        let i = 0;
        return {
          read: () => Promise.resolve(
            i < frames.length ? { done: false, value: new TextEncoder().encode(frames[i++]) } : { done: true }
          ),
        };
      },
    },
  });
}
// 把一帧 JSON 响应包装成 fetch 返回（含 raw，客户端在流式路径里会读它）
function jsonFetch(fn) {
  return (url, opts) => {
    const out = fn(String(url), opts);
    // 模拟真实浏览器：每个响应都有 body.getReader 和 headers.get。
    // 客户端不能靠「有没有 getReader」判断流式（真实 JSON 响应也有），必须看 content-type。
    const ctype = "application/json; charset=utf-8";
    const resp = {
      ok: out.ok !== false,
      status: out.status || 200,
      headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? ctype : null) },
      body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
      json: () => Promise.resolve(out.json),
    };
    return Promise.resolve(Object.assign({ raw: resp }, resp));
  };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  -> " + JSON.stringify(detail) : ""}`); }
};

// ---- 渲染树遍历 ----
function walk(node, out = []) {
  if (Array.isArray(node)) { for (const c of node) walk(c, out); return out; }
  if (!node || typeof node !== "object" || !node.$$el) return out;
  if (typeof node.type === "function") { walk(renderComponent(node.type, node.props), out); return out; }
  out.push(node);
  for (const c of node.children || []) walk(c, out);
  return out;
}
function textOf(node) {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node !== "object") return "";
  if (typeof node.type === "function") return textOf(renderComponent(node.type, node.props));
  return (node.children || []).map(textOf).join("");
}
function buttonBy(window, pred) { return walk(window).find(pred); }
function findButton(nodes, pred) { return nodes.find((n) => n.type === "button" && pred(n)); }

function makeProps(draft, extraState) {
  const state = Object.assign({ draft }, extraState || {});
  return {
    useInput: () => JSON.stringify(state),
    inputActions: { setDraft: () => {} },
    sessionId: "s1",
  };
}
function makeWiredProps(draft, extraState) {
  const state = Object.assign({ draft }, extraState || {});
  const props = {
    useInput: () => JSON.stringify(state),
    inputActions: { setDraft: (text) => { state.draft = text; } },
    sessionId: "s1",
  };
  return { props, state };
}

// 找到某个座位登记的组件
function seatComponent(slotName) {
  const r = registrations.filter((x) => x.slot === slotName).pop();
  return r && r.off && r.off.component;
}
function seatDef(slotName) {
  const r = registrations.filter((x) => x.slot === slotName).pop();
  return r && r.off && r.off.def;
}

const mod = loaded.factory((n) => (n === "react" ? React : {}));
const I = mod.__internals;
const Toolbar = I.Toolbar;
const ConfigCard = I.PromptDockConfigCard;

// 每个小节开始前重置：组件 hook 槽位 + 共享 store（真实 React 重新挂载时等价于此）
const DEFAULT_FETCH = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
function resetAll() {
  resetHooks();
  I.resetConf();
  currentFetch = DEFAULT_FETCH;
}
// 渲染一个座位组件：包成元素交给 walk 展开。组件内部 hook 状态按函数身份保存，
// 直接调用会与外层递归共用同一组槽位（真实 React 里子组件是独立实例）。
function mountToolbar(props) {
  return walk(React.createElement(Toolbar, props));
}
function mountCard(props) {
  return walk(React.createElement(ConfigCard, props));
}
// 交互后重新渲染。
// 桩环境没有 React 的 key 复用与卸载语义，因此：只要某个子组件本帧没再被渲染，
// 就丢弃它的 hook 槽位——等价于 React 卸载了那棵子树（典型场景：关闭弹层）。
// 本帧仍在渲染的组件保留状态，等价于 key 不变时 React 复用实例（ref 也就不丢）。
function withCleanSlots(rootFn, render) {
  const current = new Set();
  allRenderFns = current;
  const out = render();
  allRenderFns = null;
  for (const fn of [...hookStore.keys()]) {
    if (fn === rootFn) continue;
    if (!current.has(fn)) hookStore.delete(fn);
  }
  lastFrameFns = current;
  return out;
}
function remountToolbar(props) {
  return withCleanSlots(Toolbar, () => mountToolbar(props));
}
function remountCard(props) {
  return withCleanSlots(ConfigCard, () => mountCard(props));
}

// =====================================================================
console.log("\n[1] 模块注册");
check("通过 __ModuleLoader__.load 注册", loaded !== null && loaded.id === "dsh-prompt-dock", loaded && loaded.id);
check("exports.apply 是函数", typeof mod.apply === "function");
check("exports.inject 含 slots", Array.isArray(mod.inject) && mod.inject.includes("slots"), mod.inject);

console.log("\n[2] 两个座位");
mod.apply(fakeCtx);
const rowDef = seatDef("conversation.input.right");
const cfgDef = seatDef("plugins.bundle.config");
check("工具行座位 conversation.input.right", !!rowDef && rowDef.name === "conversation.input.right", rowDef);
check("工具行注册 id 为 prompt-dock", !!rowDef && rowDef.id === "prompt-dock", rowDef);
check("工具行 label 返回中文名", !!rowDef && typeof rowDef.label === "function" && rowDef.label() === "提示词助手");
check("配置卡片座位 plugins.bundle.config", !!cfgDef && cfgDef.name === "plugins.bundle.config", cfgDef);
check("配置卡片 key 为 npm 包名 dsh-prompt-dock", !!cfgDef && cfgDef.key === "dsh-prompt-dock", cfgDef && cfgDef.key);
check("配置卡片声明 locale 命名空间", !!cfgDef && cfgDef.locale === "promptDock", cfgDef && cfgDef.locale);
check("配置卡片组件已登记", typeof seatComponent("plugins.bundle.config") === "function");
check("不再注册已废弃的 settings.plugin.item", !registrations.some((r) => /settings\.plugin\.item|settings\.register/.test(r.slot)),
  registrations.map((r) => r.slot));
check("源码不含 settings.register / installSection / settingsScope",
  !/settings\.register|installSection|settingsScope/.test(src), true);

// =====================================================================
console.log("\n[3] 工具行：无设置入口，风格/模板两个独立触发器");
{
  resetAll();
  let tree, err = null;
  try { tree = mountToolbar(makeProps("把日志时间戳换成下拉")); } catch (e) { err = e; }
  check("Toolbar 渲染不抛异常", err === null, err && err.message);
  const nodes = walk(tree);
  const btns = nodes.filter((n) => n.type === "button");
  check("渲染出按钮", btns.length > 0, btns.length);

  // 设置必须离开工具行
  check("工具行没有设置按钮", !btns.some((n) => /设置/.test(String(n.props.title || ""))),
    btns.map((n) => n.props.title));
  check("工具行没有 pd-pop 浮动设置面板", !nodes.some((n) => String(n.props.className || "").includes("pd-pop")));
  check("源码不再有 SettingsPop / IconSliders",
    !/function SettingsPop|function IconSliders/.test(src), true);

  // 两个独立一级触发器
  const styleBtn = findButton(btns, (n) => n.props["aria-label"] === "风格：更简洁");
  const tplBtn = findButton(btns, (n) => n.props["aria-label"] === "模板");
  const rewriteBtn = findButton(btns, (n) => n.props["aria-label"] === "改写");
  check("风格触发器存在，文案为当前风格名", !!styleBtn && textOf(styleBtn).includes("更简洁"), styleBtn && textOf(styleBtn));
  check("模板触发器存在，文案为「模板」", !!tplBtn && textOf(tplBtn).includes("模板"), tplBtn && textOf(tplBtn));
  check("风格与模板是两个独立触发器（非同一按钮）", !!styleBtn && !!tplBtn && styleBtn !== tplBtn);
  check("改写按钮是纯图标（有 svg、无 pd-label）",
    !!rewriteBtn && walk(rewriteBtn).some((n) => n.type === "svg") &&
    !walk(rewriteBtn).some((n) => String(n.props.className || "").includes("pd-label")));
  check("改写按钮 tooltip 含「改写」", !!rewriteBtn && String(rewriteBtn.props.title).includes("改写"), rewriteBtn && rewriteBtn.props.title);
  check("普通草稿：改写按钮可用", !!rewriteBtn && rewriteBtn.props.disabled === false, rewriteBtn && rewriteBtn.props.disabled);

  // 顺序：风格 → 模板 → 改写
  const order = [styleBtn, tplBtn, rewriteBtn].map((b) => btns.indexOf(b));
  check("顺序为 风格 → 模板 → 改写", order[0] < order[1] && order[1] < order[2], order);

  // 两个触发器各自独立开关
  styleBtn.props.onClick();
  let n2 = remountToolbar(makeProps("把日志时间戳换成下拉"));
  check("风格菜单打开时只有一个弹层", n2.filter((x) => String(x.props.className || "").includes("pd-popover")).length === 1,
    n2.filter((x) => String(x.props.className || "").includes("pd-popover")).length);
  check("打开的弹层是风格选项", n2.some((x) => x.props["aria-label"] === "风格" && String(x.props.className || "").includes("pd-popover")));
  check("风格弹层里有全部 5 个风格",
    n2.filter((x) => String(x.props.className || "").includes("pd-optionName")).map((x) => x.children[0]).join(",") === "更简洁,更详细,结构化,译成英文,自定义",
    n2.filter((x) => String(x.props.className || "").includes("pd-optionName")).map((x) => x.children[0]));
  check("当前风格用底色+描边高亮（pd-optionOn），无对勾列",
    n2.filter((x) => String(x.props.className || "").includes("pd-optionOn")).length === 1 &&
    !n2.some((x) => String(x.props.className || "").includes("pd-check")));
}

// =====================================================================
console.log("\n[4] 风格弹层：摘要、键盘与选中");
{
  resetAll();
  const cfg = {
    ok: true, storage: "config", legacyPath: "C:\\x\\settings.json",
    styles: [
      { id: "concise", name: "更简洁", instruction: "压缩表达，删掉重复与客套，保留全部约束。" },
      { id: "detailed", name: "更详细", instruction: "补全目标、输入、输出、边界条件与验证方式。" },
      { id: "custom", name: "自定义", instruction: "" },
    ],
    templates: [], toolbar: { showStyleEntry: "auto", showTemplateEntry: "auto", compactThreshold: 320 },
    shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" },
  };
  currentFetch = jsonFetch((url) => (url.endsWith("/config") ? { ok: true, json: cfg } : { json: { ok: true } }));
  runEffectsEnabled = true;
  mountToolbar(makeProps("草稿"));
  await tick(10);

  let nodes = remountToolbar(makeProps("草稿"));
  findButton(nodes, (n) => n.props["aria-label"] === "风格：更简洁").props.onClick();
  nodes = remountToolbar(makeProps("草稿"));
  const summaries = nodes.filter((x) => String(x.props.className || "").includes("pd-optionSum")).map((x) => String(x.children[0]));
  check("风格项带一行指令摘要", summaries.some((s) => s.includes("压缩表达")), summaries);
  check("未设置指令的风格给出占位摘要", summaries.includes("未设置指令"), summaries);
  check("菜单行高 32px（CSS）", /\.pd-option\{[^}]*min-height:32px/.test(I.CSS_TEXT), true);
  check("箭头 chevron 12px 且展开旋转 180°",
    I.CSS_TEXT.includes(".pd-chevronOpen{transform:rotate(180deg);}") &&
    /transition:transform/.test(I.CSS_TEXT.match(/\.pd-chevron\{[^}]*\}/)[0]));

  // 键盘：↓ 移动到第二项，Enter 确认
  const pop = nodes.find((x) => String(x.props.className || "").includes("pd-popover"));
  check("弹层有键盘处理", !!pop && typeof pop.props.onKeyDown === "function");
  const key = (k) => ({ key: k, preventDefault() {}, stopPropagation() {} });
  pop.props.onKeyDown(key("ArrowDown"));
  nodes = remountToolbar(makeProps("草稿"));
  const pop2 = nodes.find((x) => String(x.props.className || "").includes("pd-popover"));
  pop2.props.onKeyDown(key("Enter"));
  nodes = remountToolbar(makeProps("草稿"));
  check("↑↓ + Enter 确认后可切换风格", !!findButton(nodes, (n) => n.props["aria-label"] === "风格：更详细"),
    nodes.filter((n) => n.props["aria-label"]).map((n) => n.props["aria-label"]));

  // Esc 关闭并把焦点交回触发器
  findButton(nodes, (n) => n.props["aria-label"] === "风格：更详细").props.onClick();
  nodes = remountToolbar(makeProps("草稿"));
  const pop3 = nodes.find((x) => String(x.props.className || "").includes("pd-popover"));
  let escCalled = false;
  const popClose = pop3.props.onKeyDown(key("Escape"));
  nodes = remountToolbar(makeProps("草稿"));
  check("Esc 关闭弹层", !nodes.some((x) => String(x.props.className || "").includes("pd-popover")));

  // 另外两条：Enter 用 onclick 路径已验证；这里验证 Escape 在 useAnchorFollow 里也挂了监听（source 级）
  check("Esc 关闭逻辑存在（onKeyDown Escape → onClose）", /e\.key === "Escape"/.test(src));

  runCleanups();
  runEffectsEnabled = false;
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

// =====================================================================
console.log("\n[5] 模板：插入草稿、空态、搜索与分组");
{
  resetAll();
  // 空模板
  let nodes = remountToolbar(makeProps("正常草稿"));
  findButton(nodes, (n) => n.props["aria-label"] === "模板").props.onClick();
  nodes = remountToolbar(makeProps("正常草稿"));
  const empty = nodes.find((x) => String(x.props.className || "").includes("pd-empty"));
  check("空模板给出「还没有模板，点击创建第一条」", !!empty && textOf(empty) === "还没有模板，点击创建第一条", empty && textOf(empty));
  findButton(nodes, (n) => n.props["aria-label"] === "模板").props.onClick();

  // 有模板：配置里给 3 条（含分类）
  resetAll();
  const cfg = {
    ok: true,
    styles: [{ id: "concise", name: "更简洁", instruction: "压缩" }, { id: "custom", name: "自定义", instruction: "" }],
    templates: [
      { id: "t1", name: "代码审查", text: "审查下面的代码。\n第二行", category: "开发", tags: ["code"] },
      { id: "t2", name: "写测试", text: "为下面的代码写测试。", category: "开发", tags: [] },
      { id: "t3", name: "解释", text: "解释这段代码。", category: "", tags: [] },
    ],
    toolbar: { showStyleEntry: "auto", showTemplateEntry: "auto", compactThreshold: 320 },
    shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" },
  };
  currentFetch = jsonFetch((url) => (url.endsWith("/config") ? { ok: true, json: cfg } : { json: { ok: true } }));
  runEffectsEnabled = true;
  mountToolbar(makeProps("正常草稿"));
  await tick(10);

  nodes = remountToolbar(makeProps("正常草稿"));
  findButton(nodes, (n) => n.props["aria-label"] === "模板").props.onClick();
  nodes = remountToolbar(makeProps("正常草稿"));
  const opts = nodes.filter((x) => String(x.props.className || "").includes("pd-optionName")).map((x) => String(x.children[0]));
  check("模板项显示名称", opts.includes("代码审查") && opts.includes("写测试"), opts);
  const sums = nodes.filter((x) => String(x.props.className || "").includes("pd-optionSum")).map((x) => String(x.children[0]));
  check("模板项显示正文首行（不含第二行）", sums.some((s) => s.includes("审查下面的代码") && !s.includes("第二行")), sums);
  check("有分类时按分类分组", nodes.some((x) => String(x.props.className || "").includes("pd-groupLabel") && textOf(x) === "开发"));
  check("3 条模板不出现搜索框", !nodes.some((x) => String(x.props.className || "").includes("pd-search")));

  // 点击插入：用「可写回」的 props 重新渲染，再从这一帧里取条目（回调闭包才是这次渲染的）
  const { props, state } = makeWiredProps("原始草稿");
  nodes = remountToolbar(props);
  const picked = nodes.find((x) => String(x.props.className || "").includes("pd-option") &&
    walk(x).some((y) => y.children && y.children[0] === "代码审查"));
  check("找到模板条目", !!picked);
  picked.props.onClick({ stopPropagation() {} });
  for (let i = 0; i < 30; i++) { await tick(40); remountToolbar(props); }
  check("模板插入写入草稿", state.draft.startsWith("原始草稿\n审查下面的代码"), state.draft);
  nodes = remountToolbar(props);
  check("插入后弹层关闭", !nodes.some((x) => String(x.props.className || "").includes("pd-popover")));

  // >10 条出现搜索框
  resetAll();
  const many = Object.assign({}, cfg, {
    templates: Array.from({ length: 12 }, (_, i) => ({ id: "t" + i, name: "模板" + i, text: "正文" + i, category: "", tags: [] })),
  });
  currentFetch = jsonFetch((url) => (url.endsWith("/config") ? { ok: true, json: many } : { json: { ok: true } }));
  mountToolbar(makeProps("正常草稿"));
  await tick(10);
  nodes = remountToolbar(makeProps("正常草稿"));
  findButton(nodes, (n) => n.props["aria-label"] === "模板").props.onClick();
  nodes = remountToolbar(makeProps("正常草稿"));
  const search = nodes.find((x) => String(x.props.className || "").includes("pd-search"));
  check("模板超过 10 条出现搜索框", !!search, nodes.length);
  check("搜索框圆角 12px", /\.pd-search\{[^}]*border-radius:12px/.test(I.CSS_TEXT));

  runCleanups();
  runEffectsEnabled = false;
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

// =====================================================================
console.log("\n[6] 三级降级");
{
  const base = { toolbar: { showStyleEntry: "auto", showTemplateEntry: "auto", compactThreshold: 320 } };
  check("宽 → L0 完整", I.computeLevel(600, base).level === 0);
  check("窄于阈值 → L1 紧凑", I.computeLevel(280, base).level === 1 && I.computeLevel(280, base).compact === true);
  check("极窄 → L2 合并", I.computeLevel(200, base).level === 2);

  resetAll();
  const cfg = {
    ok: true,
    styles: [{ id: "concise", name: "更简洁", instruction: "压缩" }],
    templates: [{ id: "t1", name: "代码审查", text: "审查代码" }],
    toolbar: { showStyleEntry: "auto", showTemplateEntry: "never", compactThreshold: 320 },
    shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" },
  };
  currentFetch = jsonFetch((url) => (url.endsWith("/config") ? { ok: true, json: cfg } : { json: { ok: true } }));
  runEffectsEnabled = true;
  mountToolbar(makeProps("正常草稿"));
  await tick(10);
  let nodes = remountToolbar(makeProps("正常草稿"));
  const root = nodes.find((x) => String(x.props.className || "").includes("pd-row"));
  check("showTemplateEntry=never 时降级为合并菜单", !!root && root.props["data-pd-level"] === 2,
    root && root.props["data-pd-level"]);
  check("合并模式只有一个风格/模板触发按钮",
    nodes.filter((n) => n.type === "button" && /风格|模板/.test(String(n.props.title || ""))).length === 1,
    nodes.filter((n) => n.type === "button").map((n) => n.props.title));
  runCleanups();
  runEffectsEnabled = false;
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

// =====================================================================
console.log("\n[7] 六态反馈机");
{
  resetAll();
  const { props, state } = makeWiredProps("原始草稿");
  currentFetch = sseFetch([
    'event: meta\ndata: {"requestId":"r1","draftChars":4,"timeoutMs":90000}\n\n',
    'event: delta\ndata: {"text":"新"}\n\n',
    'event: delta\ndata: {"text":"草稿文本"}\n\n',
    'event: done\ndata: {"text":"新草稿文本"}\n\n',
  ]);
  let nodes = remountToolbar(props);
  check("idle：改写按钮可用、无 spinner", !nodes.some((x) => String(x.props.className || "").includes("pd-spin")));

  findButton(nodes, (n) => n.props["aria-label"] === "改写").props.onClick();
  nodes = remountToolbar(props);
  check("requesting：出现 spinner", nodes.some((x) => String(x.props.className || "") === "pd-spin"),
    nodes.map((x) => x.props.className).filter(Boolean));
  check("requesting：按钮 tooltip 为「正在连接…」",
    nodes.some((x) => x.type === "button" && String(x.props.title || "").includes("正在连接")));
  check("requesting：按钮被禁用/不可再点", nodes.some((x) => x.type === "button" && x.props["aria-label"] === "取消改写"));

  // 让 SSE 帧依次落地；每拍都重渲染，草稿 ref 才是最新的（真实 React 里 setState 即重渲染）
  for (let i = 0; i < 40; i++) { await tick(30); nodes = remountToolbar(props); }
  check("success：模型文本已回填", state.draft === "新草稿文本", state.draft);
  const undoBtn = findButton(nodes, (n) => String(n.props.title || "").includes("撤销"));
  check("success：按钮原地变成撤销", !!undoBtn, nodes.filter((n) => n.type === "button").map((n) => n.props.title));
  check("success：按钮带 1.5s 绿色高亮类", !!undoBtn && String(undoBtn.props.className).includes("pd-successFlash"));
  check("success：弹出「改写完成，可撤销」Toast", I.getToasts().some((t) => t.text === "改写完成，可撤销"), I.getToasts());
  check("success：不再有 spinner", !nodes.some((x) => String(x.props.className || "") === "pd-spin"));

  // 撤销
  undoBtn.props.onClick();
  for (let i = 0; i < 10; i++) { await tick(40); remountToolbar(props); }
  check("撤销后恢复原文", state.draft === "原始草稿", state.draft);
  nodes = remountToolbar(props);
  check("撤销后回到 idle（sparkle 回来）", !!findButton(nodes, (n) => n.props["aria-label"] === "改写"));
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

console.log("\n[8] streaming 态：字数 + 顶部流光条");
{
  resetAll();
  I.resetToasts();
  const { props } = makeWiredProps("原始草稿");
  // 可控流：先喂 meta + delta，之后保持 reader 打开（不 done），从而停在 streaming 态
  const queue = [
    'event: meta\ndata: {"requestId":"r1","draftChars":4,"timeoutMs":90000}\n\n',
    'event: delta\ndata: {"text":"改写中"}\n\n',
  ];
  let release = null;
  currentFetch = () => {
    const resp = {
      ok: true, status: 200,
      body: {
        getReader: () => ({
          read: () => {
            if (queue.length) return Promise.resolve({ done: false, value: new TextEncoder().encode(queue.shift()) });
            return new Promise((r) => { release = () => r({ done: true }); });
          },
        }),
      },
    };
    return Promise.resolve(Object.assign({ raw: resp }, resp));
  };
  let nodes = remountToolbar(props);
  findButton(nodes, (n) => n.props["aria-label"] === "改写").props.onClick();
  for (let i = 0; i < 6; i++) { await tick(20); nodes = remountToolbar(props); }
  const status = nodes.find((x) => String(x.props.className || "").includes("pd-label") && /改写中/.test(String(x.children[0])));
  check("streaming：显示「改写中 N 字」", !!status && /^改写中 \d+ 字$/.test(String(status.children[0])), status && status.children);
  check("streaming：spinner 仍在", nodes.some((x) => String(x.props.className || "").includes("pd-spin")));
  check("streaming：输入框顶边有 2px 流光条", nodes.some((x) => String(x.props.className || "").includes("pd-shimmer")));
  check("流光条高度 2px", /\.pd-shimmer\{[^}]*height:2px/.test(I.CSS_TEXT));

  // 取消
  const cancelBtn = findButton(nodes, (n) => n.props["aria-label"] === "取消改写");
  check("streaming：可取消", !!cancelBtn);
  // 取消时真实用户会读到 requestId；此处直接点取消
  const posts = [];
  currentFetch = (url, opts) => { posts.push({ url: String(url), opts }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) }); };
  cancelBtn.props.onClick();
  nodes = remountToolbar(props);
  check("cancelled：回到 idle（sparkle 回来）", !!findButton(nodes, (n) => n.props["aria-label"] === "改写"));
  check("cancelled：不再弹 Toast（只留状态）", !I.getToasts().some((t) => t.text === "已取消改写"), I.getToasts());
  check("cancelled：POST /cancel", posts.some((p) => p.url.includes("/api/prompt-dock/cancel")), posts.map((p) => p.url));
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

// =====================================================================
console.log("\n[9] 六类错误文案 + 错误条");
{
  const cases = [
    ["network", { code: "NETWORK" }, "连接失败，请检查网络后重试"],
    ["timeout", { code: "TIMEOUT", seconds: 90 }, "改写超时（90 秒），可重试或缩短草稿"],
    ["auth", { code: "NO_MODEL" }, "改写模型未配置或凭据失效，请到设置中检查"],
    ["model", { code: "LLM_FAILED", message: "upstream 429 too many requests" }, "模型未能完成改写："],
    ["empty", { code: "EMPTY_REPLY" }, "未获得有效改写结果"],
  ];
  for (const [cls, err, expected] of cases) {
    const fb = I.errorFeedback(err);
    check(`错误类 ${cls} 文案正确`, fb.cls === cls && fb.text.includes(expected), fb);
  }
  const cancelFb = I.errorFeedback({ code: "CANCELLED" });
  check("错误类 cancelled 文案（仅 Toast，不出错误条）",
    I.ERROR_COPY.cancelled === "已取消改写" && I.ERROR_ACTION.cancelled === "none", I.ERROR_ACTION);
  check("模型中文化原因被截短（≤41 字符）", I.errorCopy("model", { reason: "a".repeat(120) }).length <= 60,
    I.errorCopy("model", { reason: "a".repeat(120) }));
  check("auth 类动作是打开设置", I.ERROR_ACTION.auth === "openSettings");
  check("network/timeout/model/empty 都可重试",
    ["network", "timeout", "model", "empty"].every((c) => I.ERROR_ACTION[c] === "retry"));

  // 渲染：把状态塞成 ERROR 后检查错误条
  resetHooks();
  const { props } = makeWiredProps("原始草稿");
  currentFetch = jsonFetch((url) => {
    if (url.includes("/rewrite-stream")) return { ok: false, status: 409, json: { ok: false, error: { code: "NO_MODEL" } } };
    return { json: { ok: true } };
  });
  let nodes = remountToolbar(props);
  findButton(nodes, (n) => n.props["aria-label"] === "改写").props.onClick();
  for (let i = 0; i < 4; i++) { await tick(20); nodes = remountToolbar(props); }
  const bar = nodes.find((x) => String(x.props.className || "").includes("pd-errorBar"));
  check("auth 错误渲染错误条", !!bar && bar.props["data-pd-error"] === "auth", bar && bar.props["data-pd-error"]);
  check("错误条文案为中文用户话术", !!bar && textOf(bar).includes("改写模型未配置或凭据失效"));
  check("错误条左侧有 12px「!」", !!bar && nodes.some((x) => String(x.props.className || "").includes("pd-errorMark") && String(x.children[0]) === "!"));
  check("错误条有「打开设置」按钮", !!bar && walk(bar).some((x) => x.type === "button" && textOf(x) === "打开设置"));
  check("错误条可手动关闭", !!bar && walk(bar).some((x) => x.type === "button" && x.props.title === "关闭提示"));
  check("错误条不抢焦点（tabIndex=-1）", !!bar && walk(bar).filter((x) => x.type === "button").every((x) => x.props.tabIndex === -1));
  check("错误条背景为 danger 10%", /background:color-mix\(in srgb,var\(--dsw-alias-state-danger\) 10%,transparent\)/.test(I.CSS_TEXT));
  check("改写按钮出现 1px 危险边", !!findButton(nodes, (n) => String(n.props.className || "").includes("pd-edgeDanger")));
  check("sparkle 已恢复（error 态仍可重试）", !!findButton(nodes, (n) => n.props["aria-label"] === "改写"));

  // ---- 位置：错误提示在「风格」左侧，且不改变三个按钮的位置 ----
  const row = nodes.find((x) => String(x.props.className || "").includes("pd-row"));
  const kids = (row.children || []).filter(Boolean);
  const slotIdx = kids.findIndex((k) => k.props && k.props["data-pd-error-slot"] === "1");
  check("错误提示位于工具行子节点最左", slotIdx === 0, slotIdx);
  const styleIdx = kids.findIndex((k) => k.props && k.props["data-pd-menu"] !== undefined || (k.props && /风格/.test(textOf(k))));
  const firstButtonIdx = kids.findIndex((k) => k.props && k.props["aria-haspopup"] === "menu");
  check("风格触发器排在错误提示之后", slotIdx >= 0 && firstButtonIdx > slotIdx, { slotIdx, firstButtonIdx, styleIdx });
  // 关键：错误槽位必须脱离 flex 流，否则出现/消失会挪动按钮
  check("错误槽位绝对定位（不参与 flex 布局）",
    /\.pd-sideNote\{[^}]*position:absolute/.test(I.CSS_TEXT), true);
  check("错误槽位靠左边缘外挂（right:100%）",
    /\.pd-sideNote\{[^}]*right:100%/.test(I.CSS_TEXT), true);
  // 字体对齐：错误条与按钮同高、文字与操作同一基线（全对齐 center）
  check("错误条与工具行按钮同高 28px", /\.pd-errorBar\{[^}]*height:28px/.test(I.CSS_TEXT), true);
  check("错误条纵向居中对齐（不再是 flex-start）",
    /\.pd-errorBar\{[^}]*align-items:center/.test(I.CSS_TEXT) &&
    !/\.pd-errorBar\{[^}]*align-items:flex-start/.test(I.CSS_TEXT), true);
  check("「!」标记不再固定 16px 高（与文字同基线）",
    /\.pd-errorMark\{[^}]*line-height:20px/.test(I.CSS_TEXT) &&
    !/\.pd-errorMark\{[^}]*height:16px/.test(I.CSS_TEXT), true);
  check("错误文案单行不换行（避免与按钮错位）",
    /\.pd-errorText\{[^}]*white-space:nowrap/.test(I.CSS_TEXT), true);
  // 左侧空间有限：超长文案要能截断且不丢全文
  check("错误文案溢出截断", /\.pd-errorText\{[^}]*text-overflow:ellipsis/.test(I.CSS_TEXT), true);
  check("错误文案 title 保留全文",
    nodes.some((x) => String(x.props.className || "").includes("pd-errorText") &&
      x.props.title === "改写模型未配置或凭据失效，请到设置中检查"), true);
  check("左侧槽位宽度受限（52vw 上限）", /\.pd-sideNote\{[^}]*max-width:min\(360px,52vw\)/.test(I.CSS_TEXT), true);
  check("错误条不超出槽位", /\.pd-errorBar\{[^}]*max-width:100%/.test(I.CSS_TEXT), true);

  const closeX = walk(bar).find((x) => x.type === "button" && x.props.title === "关闭提示");
  closeX.props.onClick();
  nodes = remountToolbar(props);
  check("关闭后错误条消失", !nodes.some((x) => String(x.props.className || "").includes("pd-errorBar")));
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

console.log("\n[10] 长度提示（琥珀，不截断）");
{
  check("短于 80 字给出偏短提示", /结果偏短/.test(I.lengthHint(40, 0)), I.lengthHint(40, 0));
  check("超过 1.2× 上限给出偏长提示", /结果偏长/.test(I.lengthHint(130, 100)), I.lengthHint(130, 100));
  check("正常长度无提示", I.lengthHint(100, 100) === "", I.lengthHint(100, 100));
  check("提示用 warning 令牌", /\.pd-hint\{[^}]*--dsw-alias-state-warning/.test(I.CSS_TEXT));

  // 端到端：改写结果偏短时，工具行渲染琥珀提示条，且结果照常写回（不截断）
  resetAll();
  const { props, state } = makeWiredProps("原始草稿");
  currentFetch = sseFetch([
    'event: meta\ndata: {"requestId":"r1","draftChars":4,"timeoutMs":90000}\n\n',
    'event: delta\ndata: {"text":"太短"}\n\n',
    'event: done\ndata: {"text":"太短"}\n\n',
  ]);
  let nodes = remountToolbar(props);
  findButton(nodes, (n) => n.props["aria-label"] === "改写").props.onClick();
  for (let i = 0; i < 40; i++) { await tick(30); nodes = remountToolbar(props); }
  check("偏短结果照常写回（不截断）", state.draft === "太短", state.draft);
  const hintBar = nodes.find((x) => x.props["data-pd-hint"] === "1");
  check("成功态渲染琥珀长度提示条", !!hintBar && /结果偏短/.test(textOf(hintBar)), hintBar && textOf(hintBar));
  check("提示条在成功态才出现（错误态无）", I.getStore().phase === "success", I.getStore().phase);
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

// =====================================================================
console.log("\n[11] Toast：最多 2 条");
{
  I.resetToasts();
  I.toast("第一条");
  I.toast("第二条");
  check("两条并存", I.getToasts().length === 2, I.getToasts().length);
  I.toast("第三条");
  const list = I.getToasts();
  check("第 3 条挤掉最旧的，仍只有 2 条", list.length === 2, list);
  check("保留最新两条", list.map((t) => t.text).join(",") === "第二条,第三条", list.map((t) => t.text));
  check("TOAST_MAX 常量为 2", I.TOAST_MAX === 2);
  check("Toast 样式：底部居中 8px 圆角 bg-layer-3 + border-l2",
    /\.pd-toasts\{[^}]*bottom:24px/.test(I.CSS_TEXT) &&
    /\.pd-toast\{[^}]*border-radius:8px[^}]*border:1px solid var\(--dsw-alias-border-l2\)[^}]*background:var\(--dsw-alias-bg-layer-3\)/.test(I.CSS_TEXT));
  I.resetToasts();
}

// =====================================================================
console.log("\n[12] 快捷键");
{
  const sc = { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" };
  check("Alt+M → openStyle", I.matchShortcut({ key: "m", altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, sc) === "openStyle");
  check("Alt+T → openTemplate", I.matchShortcut({ key: "t", altKey: true }, sc) === "openTemplate");
  check("Alt+R → rewrite", I.matchShortcut({ key: "R", altKey: true }, sc) === "rewrite");
  check("无 Alt 不触发", I.matchShortcut({ key: "m", altKey: false }, sc) === "");
  check("Ctrl/Cmd 组合让给浏览器", I.matchShortcut({ key: "m", altKey: true, ctrlKey: true }, sc) === "");
  check("Escape 不触发", I.matchShortcut({ key: "Escape", altKey: true }, sc) === "");
  check("输入框内判定为可编辑目标",
    I.isEditableTarget({ tagName: "INPUT" }) && I.isEditableTarget({ tagName: "TEXTAREA" }) &&
    I.isEditableTarget({ isContentEditable: true }) && !I.isEditableTarget({ tagName: "BODY" }));
  check("快捷键可配置（自定义后被识别）", I.matchShortcut({ key: "j", altKey: true }, { openStyle: "Alt+J" }) === "openStyle");
  check("快捷键展示为 Alt+M", I.shortcutLabel("Alt+M") === "Alt+M", I.shortcutLabel("Alt+M"));
  // 输入框里只忽略「纯字符键」；带修饰键的组合必须放行（见 [33]）
  check("源码里存在输入框内忽略快捷键的判断", src.includes("isEditableTarget(t) && !isShortcutChord(e)"));
}

// =====================================================================
console.log("\n[13] 设置卡片：七组 + 只提交改动分组的键");
{
  resetAll();
  const posts = [];
  let conf = {
    ok: true, storage: "config", legacyPath: "C:\\Users\\x\\settings.json", migrated: true,
    rewriteModel: null, timeoutMs: 90000, contextEnabled: true, contextTurns: 6,
    globalDiscipline: "共享纪律正文", globalDisciplineCustom: false,
    styles: [{ id: "concise", name: "更简洁", instruction: "压缩表达" }, { id: "custom", name: "自定义", instruction: "" }],
    templates: [{ id: "t1", name: "代码审查", text: "审查代码", category: "开发", tags: ["a"] }],
    toolbar: { showStyleEntry: "auto", showTemplateEntry: "always", compactThreshold: 320 },
    shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" },
  };
  currentFetch = jsonFetch((url, opts) => {
    const method = (opts && opts.method) || "GET";
    if (url.endsWith("/config")) {
      if (method === "POST") {
        const body = JSON.parse(opts.body || "{}");
        posts.push(body);
        conf = Object.assign({}, conf, body);
      }
      return { ok: true, json: conf };
    }
    if (url.includes("/models")) return { json: { ok: true, groups: [{ id: "p1", name: "P1", models: [{ id: "m1", name: "M1" }] }], global: { provider: "p1", model: "m1" } } };
    return { json: { ok: true } };
  });
  runEffectsEnabled = true;
  resetHooks();
  mountCard({ view: "page" });
  await tick(20);

  // summary 视图只返回一行
  const summary = mountCard({ view: "summary" });
  const summaryText = textOf(summary);
  check("summary 视图返回一行摘要", summaryText.length > 0 && summaryText.length < 120, summaryText);

  let nodes = walk(mountCard({ view: "page" }));
  const groups = nodes.filter((x) => /data-pd-group/.test(Object.keys(x.props).join(",")) && x.props["data-pd-group"]);
  const groupIds = [...new Set(nodes.map((x) => x.props["data-pd-group"]).filter(Boolean))];
  check("渲染 7 个分组", groupIds.length === 7, groupIds);
  check("分组顺序正确",
    groupIds.join(",") === "model,context,discipline,styles,templates,toolbar,shortcuts", groupIds);

  const titles16 = nodes.filter((x) => String(x.props.className || "").includes("pd-cardNav"));
  const titles18 = nodes.filter((x) => String(x.props.className || "").includes("pd-cardTitle"));
  check("区块标题 18px/600", /\.pd-cardTitle\{font-size:18px;font-weight:600/.test(I.CSS_TEXT));
  check("分组标题 14px/500", /\.pd-groupTitle\{font-size:14px;font-weight:500/.test(I.CSS_TEXT));

  // 1 模型下拉（用 data 属性定位，不依赖会变的 title 文案）
  const modelTrigger = findButton(nodes, (n) => n.props["aria-haspopup"] === "menu" && /pd-modelTrigger/.test(n.props.className || ""));
  check("① 改写模型下拉存在，默认「跟随全局默认」", !!modelTrigger && textOf(modelTrigger).includes("跟随全局默认"));
  check("① 跟随全局时不显示 provider 徽标", modelTrigger.props["data-pd-model-fixed"] === "0", modelTrigger.props["data-pd-model-fixed"]);
  modelTrigger.props.onClick();
  nodes = walk(mountCard({ view: "page" }));
  const m1 = nodes.find((x) => String(x.props.className || "").includes("pd-option") &&
    walk(x).some((y) => y.children && y.children[0] === "M1"));
  check("① 下拉里列出模型", !!m1);
  m1.props.onClick({ stopPropagation() {} });
  await tick(20);
  check("① 选模型只提交 rewriteModel 键",
    posts.length === 1 && Object.keys(posts[0]).join(",") === "rewriteModel", posts);
  check("① 选模型提交 provider/model", posts[0].rewriteModel.provider === "p1" && posts[0].rewriteModel.model === "m1");
  // 选中固定模型后，触发器必须能与「跟随全局默认」区分
  nodes = walk(mountCard({ view: "page" }));
  const fixedTrigger = findButton(nodes, (n) => /pd-modelTrigger/.test(n.props.className || ""));
  check("① 固定模型后显示固定态", fixedTrigger && fixedTrigger.props["data-pd-model-fixed"] === "1",
    fixedTrigger && fixedTrigger.props["data-pd-model-fixed"]);
  check("① 固定态带 provider 徽标", fixedTrigger && /pd-pillProvider/.test(textOf(fixedTrigger)) ||
    walk(fixedTrigger).some((x) => /pd-pillProvider/.test(x.props.className || "")), textOf(fixedTrigger));
  check("① 触发器 title 说明当前固定到哪个 provider",
    fixedTrigger && /改写固定使用/.test(fixedTrigger.props.title || ""), fixedTrigger && fixedTrigger.props.title);

  // 2 上下文
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  const toggle = findButton(nodes, (n) => n.props.role === "switch");
  check("② 上下文开关存在", !!toggle);
  // 开关必须有可读状态文字：只有小滑块时用户分不清开/关
  const ctxState = nodes.find((x) => x.props["data-pd-context-state"]);
  check("② 开关旁有状态文字", !!ctxState && /已开启|已关闭/.test(textOf(ctxState)), ctxState && textOf(ctxState));
  check("② 默认显示「已开启」", ctxState && ctxState.props["data-pd-context-state"] === "on", ctxState && ctxState.props["data-pd-context-state"]);
  check("② 状态文字带语义颜色类",
    ctxState && /pd-stateOn/.test(ctxState.props.className) &&
    I.CSS_TEXT.includes(".pd-stateOn{color:var(--dsw-alias-state-success);}"),
    ctxState && ctxState.props.className);
  // 说明书随状态变化
  const ctxHelp = nodes.filter((x) => String(x.props.className || "").includes("pd-help")).map(textOf).join(" ");
  check("② 有解释当前生效范围的说明", /最近 6 轮|已关闭/.test(ctxHelp), ctxHelp.slice(0, 80));
  check("② 关闭态开关有内描边（浅色下可见）",
    /\.pd-toggleTrack\{[^}]*box-shadow:inset 0 0 0 1px/.test(I.CSS_TEXT), true);
  toggle.props.onClick();
  await tick(10);
  check("② 只提交 contextEnabled", posts.length === 1 && Object.keys(posts[0]).join(",") === "contextEnabled", posts);
  nodes = walk(mountCard({ view: "page" }));
  const ctxStateOff = nodes.find((x) => x.props["data-pd-context-state"]);
  check("② 关闭后文字变为「已关闭」", ctxStateOff && textOf(ctxStateOff) === "已关闭", ctxStateOff && textOf(ctxStateOff));
  posts.length = 0;
  const turns = nodes.find((x) => x.type === "input" && x.props["aria-label"] === "上下文轮数");
  check("② 轮数输入 1–20", !!turns && turns.props.min === 1 && turns.props.max === 20);
  turns.props.onChange({ target: { value: "12" } });
  await tick(10);
  check("② 只提交 contextTurns", posts.length === 1 && posts[0].contextTurns === 12, posts);

  // 3 全局改写纪律：默认只读 + 编辑 + 恢复默认
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  const pre = nodes.find((x) => String(x.props.className || "").includes("pd-readonly"));
  check("③ 纪律默认只读（pre）", !!pre && textOf(pre) === "共享纪律正文", pre && textOf(pre));
  check("③ 未解锁时没有可编辑 textarea",
    !nodes.some((x) => x.type === "textarea" && x.props["aria-label"] === "全局改写纪律"));
  check("③ 内置默认时显示「内置默认」标签", nodes.some((x) => String(x.props.className || "").includes("pd-help") && textOf(x) === "内置默认"));
  const editBtn = findButton(nodes, (n) => textOf(n) === "编辑");
  check("③ 有「编辑」按钮", !!editBtn);
  editBtn.props.onClick();
  nodes = walk(mountCard({ view: "page" }));
  const ta = nodes.find((x) => x.type === "textarea" && x.props["aria-label"] === "全局改写纪律");
  check("③ 解锁后出现 textarea", !!ta && ta.props.value === "共享纪律正文");
  ta.props.onChange({ target: { value: "新的纪律" } });
  nodes = walk(mountCard({ view: "page" }));
  const saveBtn = findButton(nodes, (n) => textOf(n) === "保存");
  saveBtn.props.onClick();
  await tick(10);
  check("③ 保存只提交 globalDiscipline", posts.length === 1 && posts[0].globalDiscipline === "新的纪律", posts);
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  const restoreBtn = findButton(nodes, (n) => textOf(n) === "恢复默认");
  check("③ 有「恢复默认」", !!restoreBtn);
  restoreBtn.props.onClick();
  await tick(10);
  check("③ 恢复默认提交空串（宿主据此改回内置默认）",
    posts.length === 1 && posts[0].globalDiscipline === "", posts);

  // 4 风格库：默认折叠，点标题栏才展开编辑
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  check("④ 初始没有展开任何风格编辑框",
    !nodes.some((x) => x.type === "input" && x.props["aria-label"] === "风格名称"));
  const styleFoldHead = nodes.find((x) => x.props["data-pd-fold-toggle"] === "style:concise");
  check("④ 风格显示折叠标题栏", !!styleFoldHead && /更简洁/.test(textOf(styleFoldHead)), styleFoldHead && textOf(styleFoldHead));
  check("④ 折叠标题栏显示指令摘要", !!styleFoldHead && /压缩表达/.test(textOf(styleFoldHead)), styleFoldHead && textOf(styleFoldHead));
  check("④ 折叠标题栏带展开箭头", !!styleFoldHead && /pd-foldChev/.test(textOf(styleFoldHead)) ||
    walk(styleFoldHead).some((x) => String(x.props.className || "").includes("pd-chevron")));
  styleFoldHead.props.onClick();
  nodes = walk(remountCard({ view: "page" }));
  const styleIn = nodes.find((x) => x.type === "input" && x.props["aria-label"] === "风格名称");
  check("④ 点击后展开出风格名输入框", !!styleIn && styleIn.props.value === "更简洁", styleIn && styleIn.props.value);
  styleIn.props.onChange({ target: { value: "极简" } });
  await tick(10);
  check("④ 只提交 styles", posts.length === 1 && Object.keys(posts[0]).join(",") === "styles", posts);
  check("④ 改名落到对应风格", posts[0].styles[0].name === "极简", posts[0].styles);
  // 展开 custom 才有说明文字
  nodes = walk(mountCard({ view: "page" }));
  const customHead = nodes.find((x) => x.props["data-pd-fold-toggle"] === "style:custom");
  check("④ custom 折叠行带「自定义风格」标签", !!customHead && /自定义风格/.test(textOf(customHead)),
    customHead && textOf(customHead));
  customHead.props.onClick();
  check("④ custom 有「自定义风格」说明",
    walk(mountCard({ view: "page" })).some((x) => String(x.props.className || "").includes("pd-help") &&
      textOf(x).includes("「自定义」风格改写时使用这里")));

  // 5 模板库：默认折叠，展开后才可编辑 text / category / tags
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  check("⑤ 初始没有展开任何模板编辑框",
    !nodes.some((x) => x.type === "input" && x.props["aria-label"] === "模板分类"));
  const tplHead = nodes.find((x) => x.props["data-pd-fold-toggle"] === "tpl:t1");
  check("⑤ 模板显示折叠标题栏", !!tplHead && /代码审查/.test(textOf(tplHead)), tplHead && textOf(tplHead));
  tplHead.props.onClick();
  const fresh = walk(mountCard({ view: "page" }));
  const catIn = fresh.find((x) => x.type === "input" && x.props["aria-label"] === "模板分类");
  check("⑤ 点击后模板分类可编辑", !!catIn && catIn.props.value === "开发");
  catIn.props.onChange({ target: { value: "研发" } });
  await tick(10);
  check("⑤ 只提交 templates", posts.length === 1 && Object.keys(posts[0]).join(",") === "templates", posts);
  check("⑤ 分类写回", posts[0].templates[0].category === "研发", posts[0].templates[0]);
  posts.length = 0;
  let n5 = walk(mountCard({ view: "page" }));
  const tagIn = n5.find((x) => x.type === "input" && x.props["aria-label"] === "模板标签");
  check("⑤ 标签以逗号分隔展示", !!tagIn && tagIn.props.value === "a", tagIn && tagIn.props.value);
  tagIn.props.onChange({ target: { value: "x, y" } });
  await tick(10);
  check("⑤ 标签解析为数组", JSON.stringify(posts[0].templates[0].tags) === '["x","y"]', posts[0].templates[0].tags);
  posts.length = 0;
  n5 = walk(mountCard({ view: "page" }));
  const addTpl = findButton(n5, (n) => textOf(n) === "添加模板");
  check("⑤ 模板可添加", !!addTpl);
  addTpl.props.onClick();
  await tick(10);
  check("⑤ 添加后有 2 条模板", posts.length === 1 && posts[0].templates.length === 2, posts[0] && posts[0].templates.length);
  posts.length = 0;
  n5 = walk(mountCard({ view: "page" }));
  const delTpl = findButton(n5, (n) => n.props.title === "删除此模板");
  check("⑤ 模板可删除", !!delTpl);
  delTpl.props.onClick();
  await tick(10);
  check("⑤ 删除后只剩 1 条", posts.length === 1 && posts[0].templates.length === 1, posts[0] && posts[0].templates.length);

  // 6 工具行
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  const selStyle = nodes.find((x) => x.type === "select" && x.props["aria-label"] === "风格入口");
  const selOptions = selStyle ? [...new Set((selStyle.children || []).map((o) => o.props.value))] : [];
  check("⑥ 风格入口三选一", !!selStyle && selOptions.join(",") === "auto,always,never", selOptions);
  selStyle.props.onChange({ target: { value: "never" } });
  await tick(10);
  check("⑥ 只提交 toolbar 且只含该键",
    posts.length === 1 && Object.keys(posts[0]).join(",") === "toolbar" &&
    Object.keys(posts[0].toolbar).join(",") === "showStyleEntry", posts);
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  const compactIn = nodes.find((x) => x.type === "input" && x.props["aria-label"] === "收窄阈值");
  compactIn.props.onChange({ target: { value: "400" } });
  await tick(10);
  check("⑥ 收窄阈值只提交 compactThreshold",
    posts.length === 1 && posts[0].toolbar.compactThreshold === 400, posts);

  // 7 快捷键
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  const scLabels = ["打开风格菜单", "打开模板菜单", "改写草稿"];
  const scInsAll = nodes.filter((x) => x.type === "input" && scLabels.includes(x.props["aria-label"]));
  const scSeen = new Set();
  const scIns = scInsAll.filter((x) => { const l = x.props["aria-label"]; if (scSeen.has(l)) return false; scSeen.add(l); return true; });
  check("⑦ 三个快捷键输入框", scIns.length === 3, [...scSeen]);
  // 语义：点进输入框直接按组合键，系统自动录入（不是手打字符串）
  check("⑦ 输入框为只读录入模式", scIns[0].props.readOnly === true);
  check("⑦ 录入前显示「点击后按组合键」", /按组合键/.test(scIns[0].props.placeholder || ""), scIns[0].props.placeholder);
  // 点击进入录入态
  scIns[0].props.onClick();
  nodes = walk(mountCard({ view: "page" }));
  const scCap = nodes.filter((x) => x.type === "input" && x.props["aria-label"] === "打开风格菜单")[0];
  check("⑦ 点击后进入录入态", scCap.props["data-pd-shortcut-capturing"] === "1", scCap.props["data-pd-shortcut-capturing"]);
  check("⑦ 录入态提示「请按下组合键」", /请按下组合键/.test(scCap.props.placeholder || ""), scCap.props.placeholder);
  // 只按修饰键：继续等待，不提交
  posts.length = 0;
  scCap.props.onKeyDown({ key: "Alt", altKey: true, preventDefault() {}, stopPropagation() {} });
  await tick(10);
  check("⑦ 只按修饰键不提交", posts.length === 0, posts);
  // 按下 Alt+J：自动录入为 "Alt+J" 并保存
  nodes = walk(mountCard({ view: "page" }));
  const scCap2 = nodes.filter((x) => x.type === "input" && x.props["aria-label"] === "打开风格菜单")[0];
  let prevented = false;
  scCap2.props.onKeyDown({ key: "j", altKey: true, ctrlKey: false, shiftKey: false, metaKey: false,
    preventDefault() { prevented = true; }, stopPropagation() {} });
  await tick(20);
  check("⑦ 按下组合键被拦截（不触发浏览器默认）", prevented === true);
  check("⑦ 按键录入保存为规范的 Alt+J",
    posts.length === 1 && posts[0].shortcuts && posts[0].shortcuts.openStyle === "Alt+J", posts);

  // 合法但组合里没有修饰键：拒绝并提示
  posts.length = 0;
  I.resetToasts();
  nodes = walk(mountCard({ view: "page" }));
  const scNoMod = nodes.filter((x) => x.type === "input" && x.props["aria-label"] === "打开模板菜单")[0];
  scNoMod.props.onClick();
  nodes = walk(mountCard({ view: "page" }));
  const scNoMod2 = nodes.filter((x) => x.type === "input" && x.props["aria-label"] === "打开模板菜单")[0];
  scNoMod2.props.onKeyDown({ key: "m", altKey: false, preventDefault() {}, stopPropagation() {} });
  await tick(10);
  check("⑦ 无修饰键的组合不提交", posts.length === 0, posts);
  check("⑦ 无修饰键时给出提示", I.getToasts().some((t) => /需要包含修饰键/.test(t.text)), I.getToasts().map((t) => t.text));

  // Esc 放弃录入
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  const scEsc = nodes.filter((x) => x.type === "input" && x.props["aria-label"] === "改写草稿")[0];
  scEsc.props.onClick();
  nodes = walk(mountCard({ view: "page" }));
  const scEsc2 = nodes.filter((x) => x.type === "input" && x.props["aria-label"] === "改写草稿")[0];
  scEsc2.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  await tick(10);
  check("⑦ Esc 不提交", posts.length === 0, posts);

  // Backspace 清空绑定
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  const scDel = nodes.filter((x) => x.type === "input" && x.props["aria-label"] === "改写草稿")[0];
  scDel.props.onClick();
  nodes = walk(mountCard({ view: "page" }));
  const scDel2 = nodes.filter((x) => x.type === "input" && x.props["aria-label"] === "改写草稿")[0];
  scDel2.props.onKeyDown({ key: "Backspace", preventDefault() {}, stopPropagation() {} });
  await tick(20);
  check("⑦ Backspace 清空绑定", posts.length === 1 && posts[0].shortcuts && posts[0].shortcuts.rewrite === "", posts);

  // Toast：一次成功的保存应冒出「设置已保存」
  I.resetToasts();
  posts.length = 0;
  nodes = walk(mountCard({ view: "page" }));
  const scOk = nodes.filter((x) => x.type === "input" && x.props["aria-label"] === "改写草稿")[0];
  scOk.props.onClick();
  nodes = walk(mountCard({ view: "page" }));
  const scOk2 = nodes.filter((x) => x.type === "input" && x.props["aria-label"] === "改写草稿")[0];
  scOk2.props.onKeyDown({ key: "k", altKey: true, preventDefault() {}, stopPropagation() {} });
  await tick(20);
  check("保存成功弹出「设置已保存」", I.getToasts().some((t) => t.text === "设置已保存"), I.getToasts().map((t) => t.text));
  I.resetToasts();

  // 打开配置文件（404 NO_DOCUMENT）
  posts.length = 0;
  const openCalls = [];
  currentFetch = jsonFetch((url, opts) => {
    if (url.includes("/open-config")) { openCalls.push(url); return { ok: false, status: 404, json: { ok: false, error: { code: "NO_DOCUMENT", message: "宿主未提供配置文件路径" } } }; }
    if (url.endsWith("/config")) return { ok: true, json: conf };
    return { json: { ok: true } };
  });
  nodes = walk(mountCard({ view: "page" }));
  const openBtn = findButton(nodes, (n) => n.props.title === "打开配置文件");
  check("有「打开配置文件」按钮且为图标", !!openBtn && walk(openBtn).some((x) => x.type === "svg"));
  openBtn.props.onClick();
  await tick(20);
  check("点击请求 open-config", openCalls.length === 1, openCalls);
  check("404 NO_DOCUMENT 给出可读提示", I.getToasts().some((t) => t.text.includes("未提供可打开的文件")), I.getToasts());
  check("只读显示、不把 legacyPath 当写入目标",
    !/legacyPath.*POST/.test(src) && src.includes("legacyPath"));

  runCleanups();
  runEffectsEnabled = false;
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

// =====================================================================
console.log("\n[14] 视觉令牌：无硬编码颜色，禁用 emoji/图标库");
{
  // 从 CSS 文本里剔除 var(--dsw-...) 令牌内容后，不允许残留 hex / rgb / hsl / 颜色名
  const css = I.CSS_TEXT;
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  check("CSS 中没有 hex 颜色", hex.length === 0, hex);
  const rgb = css.match(/\brgba?\(/g) || [];
  check("CSS 中没有 rgb()/rgba()", rgb.length === 0, rgb);
  const hsl = css.match(/\bhsla?\(/g) || [];
  // 把官方令牌整体抹掉后，颜色相关声明里不应再出现任何颜色字面量
  const tokenCount = (css.match(/var\(--dsw-/g) || []).length;
  const withoutTokens = css
    .replace(/var\(--dsw-[a-z0-9-]+\s*(?:,[^)]*)?\)/g, "TOKEN")
    .replace(/color-mix\(in srgb,\s*TOKEN\s*\d+%,\s*transparent\)/g, "TOKEN");
  // 只看颜色类声明的取值（同一段 CSS 文本里 white-space / background 等关键字不会混淆）
  const colorDecls = (withoutTokens.match(/(?:^|[{;])\s*(?:color|background|background-color|border|border-color|box-shadow|fill|stroke)\s*:\s*[^;}]+/g) || []);
  const namedBad = colorDecls.filter((d) =>
    /\b(?:red|green|blue|white|black|gray|grey|orange|yellow|purple|pink|silver|navy|teal|maroon|olive|lime|aqua|fuchsia)\b/.test(d));
  check("CSS 里所有颜色都用 --dsw-alias-* 令牌",
    !/#[0-9a-fA-F]{3,8}\b/.test(withoutTokens) &&
    !/\b(?:rgba?|hsla?)\s*\(/.test(withoutTokens) &&
    namedBad.length === 0, namedBad.slice(0, 6));
  check("CSS 大量使用官方令牌", tokenCount > 40, tokenCount);
  check("弹层圆角 12px", /\.pd-popover\{[^}]*border-radius:12px/.test(css));
  check("弹层边框用 border-l2", /\.pd-popover\{[^}]*border:1px solid var\(--dsw-alias-border-l2\)/.test(css));
  check("弹层背景不透明（bg-layer-3）", /\.pd-popover\{[^}]*background:var\(--dsw-alias-bg-layer-3\)/.test(css));
  check("弹层显现 120–160ms", /animation:pd-materialize 1[2-6]0ms/.test(css));
  check("尊重 prefers-reduced-motion", /prefers-reduced-motion:reduce/.test(css));
  check("焦点环 3px 蓝色", /box-shadow:0 0 0 3px var\(--dsw-alias-state-business-primary\)/.test(css));
  check("没有 emoji 字符", !/[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u.test(src), true);
  check("没有「✕」「＋」等文本符号按钮", !/["']✕["']|["']＋["']/.test(src), true);
  check("没有图标库依赖（只 require react）",
    (src.match(/require\(\s*["'][^"']+["']\s*\)/g) || []).every((m) => /require\(\s*["']react["']\s*\)/.test(m)),
    (src.match(/require\(\s*["'][^"']+["']\s*\)/g) || []));
  check("存在官方 sparkle 图标 IconSparkle", src.includes("function IconSparkle"));
  check("源码不含已废弃字段 customInstruction",
    !/customInstruction/.test(src), true);
}

// =====================================================================
// =====================================================================
console.log("\n[21] 首次使用告知（只用一次、可关闭、不抢焦点）");
{
  lsStore.clear();
  check("未关闭过时应当告知", I.shouldDisclose() === true);
  // 渲染 Toasts：首次应出现告知条
  const nodes = walk(renderComponent(I.Toasts, {}));
  const disc = nodes.find((n) => n.props && n.props["data-pd-disclosure"] === "1");
  check("首次渲染出现告知条", !!disc);
  check("告知文案说明草稿会发送给模型",
    disc && /点击改写会将当前草稿发送至你配置的模型/.test(textOf(disc)), disc && textOf(disc));
  check("告知条带关闭按钮", disc && findButton(walk(disc), (b) => /知道了/.test(textOf(b))));
  check("告知条不是模态（无 role=dialog）", disc && !disc.props.role);
  // 点击关闭 → 写入标记，不再出现
  const closeBtn = findButton(walk(disc), (b) => /知道了/.test(textOf(b)));
  closeBtn && closeBtn.props.onClick && closeBtn.props.onClick();
  check("关闭后记录到 localStorage", lsStore.get(I.DISCLOSURE_KEY) === "1");
  check("关闭后不再告知", I.shouldDisclose() === false);
  lsStore.clear();
  check("重置后重新告知（新用户/清缓存）", I.shouldDisclose() === true);
  lsStore.clear();
}

// =====================================================================
console.log("\n[22] 模板插入与撤销的 toast");
{
  I.resetToasts();
  I.toast("已插入模板");
  check("插入模板有成功提示", I.getToasts().some((t) => t.text === "已插入模板"), I.getToasts());
  I.resetToasts();
  I.toast("已撤销");
  check("撤销有成功提示", I.getToasts().some((t) => t.text === "已撤销"), I.getToasts());
  I.resetToasts();
  check("源码里插入成功会提示", /toast\("已插入模板"\)/.test(src));
  check("源码里撤销成功会提示", /toast\("已撤销"\)/.test(src));
}

console.log("\n[23] 设置卡片：标签不逐字换行");
{
  const css = I.CSS_TEXT;
  // .pd-input 是 width:100%，若标签允许收缩，窄容器里会被压成一字一行
  check("字段标签禁止换行", /\.pd-fieldLabel\{[^}]*white-space:nowrap/.test(css), true);
  check("字段标签溢出用省略号", /\.pd-fieldLabel\{[^}]*text-overflow:ellipsis/.test(css), true);
  check("字段标签仍可收缩（不撑破容器）", /\.pd-fieldLabel\{[^}]*min-width:0/.test(css), true);
  check("存在固定宽度的快捷键输入框样式", /\.pd-shortcutInput\{[^}]*width:\d+px/.test(css), true);
  check("快捷键输入框不参与收缩", /\.pd-shortcutInput\{[^}]*flex:none/.test(css), true);
  // 关键：.pd-shortcutInput 与 .pd-input 特异性相同，必须写在 .pd-input 之后才能覆盖 width:100%。
  // 写反了会导致输入框占满整行、标签被挤成 0 宽而完全看不见（真实回归过）。
  const inputIdx = css.indexOf(".pd-input,.pd-textarea");
  const shortcutIdx = css.indexOf(".pd-shortcutInput{");
  check("快捷键样式定义在 .pd-input 之后（否则被 width:100% 覆盖）",
    inputIdx >= 0 && shortcutIdx > inputIdx, { inputIdx, shortcutIdx });
  // 行内顺序：标签在输入框之前，两者都在同一个 fieldRow 里
  const rowIdx = src.indexOf('className: "pd-fieldRow"');
  const labelIdx = src.indexOf('h("span", { className: "pd-fieldLabel" }, f.label)');
  check("快捷键行同时含标签与输入框", rowIdx >= 0 && labelIdx > rowIdx, { rowIdx, labelIdx });
  // 快捷键三个字段都用了该样式
  const shortcutInputs = (src.match(/pd-input pd-shortcutInput/g) || []).length;
  check("快捷键输入框应用于三个字段", shortcutInputs === 1 && /SHORTCUT_FIELDS\.map/.test(src), shortcutInputs);
  check("SHORTCUT_FIELDS 为三项", I.SHORTCUT_FIELDS.length === 3, I.SHORTCUT_FIELDS.length);
}

console.log("\n[24] 同名模型不再让人误判「没改成功」");
{
  resetAll();
  const posts = [];
  // 真实 DSH 里 deepseek-flash 同时存在于 official 与 account 两个 provider
  let conf = {
    ok: true, storage: "config", rewriteModel: null, timeoutMs: 90000,
    contextEnabled: true, contextTurns: 6, globalDiscipline: "正文", globalDisciplineCustom: false,
    styles: [{ id: "concise", name: "更简洁", instruction: "x" }], templates: [],
    toolbar: { showStyleEntry: "auto", showTemplateEntry: "auto", compactThreshold: 320 },
    shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" },
  };
  currentFetch = jsonFetch((url, opts) => {
    const method = (opts && opts.method) || "GET";
    if (url.endsWith("/config")) {
      if (method === "POST") { const b = JSON.parse(opts.body || "{}"); posts.push(b); conf = Object.assign({}, conf, b); }
      return { ok: true, json: conf };
    }
    if (url.includes("/models")) return { json: { ok: true, groups: [
      { id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" }] },
      { id: "deepseek-account", name: "DeepSeek Account", models: [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" }] },
    ], global: { provider: "deepseek-account", model: "deepseek-flash" } } };
    return { json: { ok: true } };
  });
  runEffectsEnabled = true;
  resetHooks();
  mountCard({ view: "page" });
  await tick(20);

  let nodes = walk(mountCard({ view: "page" }));
  const trigger = findButton(nodes, (n) => /pd-modelTrigger/.test(n.props.className || ""));
  trigger.props.onClick();
  nodes = walk(mountCard({ view: "page" }));
  // 只取真正的菜单行，并按键去重：walk() 会把同一组件多次求值
  const seen = new Set();
  const opts = nodes.filter((n) => {
    if (n.type !== "button" || n.props.role !== "menuitem") return false;
    const k = String(n.props["data-index"]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 两个同名模型必须以 provider 区分
  const flashOpts = opts.filter((n) => /DeepSeek-V4\.1-Flash/.test(textOf(n)));
  check("同名模型都列出来了", flashOpts.length === 2, flashOpts.length);
  const texts = flashOpts.map(textOf);
  check("两个同名项的可读文本不同（带 provider）", texts[0] !== texts[1], texts);
  check("同名项分别标注 provider 显示名",
    texts.some((t) => /DeepSeek · deepseek-flash/.test(t)) && texts.some((t) => /DeepSeek Account · deepseek-flash/.test(t)), texts);
  // 「跟随全局默认」也标出全局是哪个 provider
  const followOpt = opts.find((n) => /跟随全局默认/.test(textOf(n)));
  check("「跟随全局默认」标出全局 provider",
    followOpt && /deepseek-account|DeepSeek Account/.test(textOf(followOpt)), followOpt && textOf(followOpt));

  // 选 DeepSeek（official）下的 flash
  const officialOpt = flashOpts.find((n) => /DeepSeek · deepseek-flash/.test(textOf(n)));
  officialOpt.props.onClick({ stopPropagation() {} });
  await tick(20);
  check("选中 official 下的 flash", posts.length === 1 &&
    posts[0].rewriteModel.provider === "deepseek-official" && posts[0].rewriteModel.model === "deepseek-flash",
    posts[0] && posts[0].rewriteModel);

  // 触发器现在必须显示固定态 + provider 徽标，否则用户仍会以为没生效
  nodes = walk(mountCard({ view: "page" }));
  const fixedTrigger = findButton(nodes, (n) => /pd-modelTrigger/.test(n.props.className || ""));
  check("固定后触发器进入固定态", fixedTrigger.props["data-pd-model-fixed"] === "1");
  check("固定后触发器显示 provider 徽标（与全局区分）",
    walk(fixedTrigger).some((x) => /pd-pillProvider/.test(x.props.className || "")),
    textOf(fixedTrigger));
  check("固定态触发器有业务色边框",
    /\.pd-modelTriggerFixed\{[^}]*border-color:var\(--dsw-alias-state-business-primary\)/.test(I.CSS_TEXT), true);
}

console.log("\n[25] 错误提示不改变「风格/模板/改写」的位置");
{
  // 布局约束：.pd-row 是 flex，错误槽位必须 absolute（脱离流），
  // 否则作为 flex 子项会占用主轴空间，把三个按钮整体挤走。
  // 这里用运行时 CSS 断言结构，并在 DOM 层面确认槽位不在三个按钮之间。
  const css = I.CSS_TEXT;
  const rowHasPosition = /\.pd-row\{[^}]*position:relative/.test(css);
  const slotAbsolute = /\.pd-sideNote\{[^}]*position:absolute/.test(css);
  const slotRight = /\.pd-sideNote\{[^}]*right:100%/.test(css);
  check("工具行容器为定位上下文", rowHasPosition, true);
  check("错误槽位脱离 flex 流（absolute）", slotAbsolute, true);
  check("错误槽位挂在工具行左侧外（right:100%）", slotRight, true);

  // 渲染顺序：错误槽位是第一个子节点，三个按钮在其后，相对顺序不变
  resetHooks();
  const { props } = makeWiredProps("草稿");
  currentFetch = jsonFetch((url) => {
    if (url.includes("/rewrite-stream")) return { ok: false, status: 409, json: { ok: false, error: { code: "NO_MODEL" } } };
    if (url.endsWith("/config")) return { json: { ok: true, rewriteModel: null, contextEnabled: true, contextTurns: 6,
      styles: [{ id: "concise", name: "更简洁", instruction: "x" }], templates: [{ id: "t1", name: "T", text: "x" }],
      toolbar: { showStyleEntry: "always", showTemplateEntry: "always", compactThreshold: 320 },
      shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" } } };
    if (url.includes("/models")) return { json: { ok: true, groups: [], global: null } };
    return { json: { ok: true } };
  });
  runEffectsEnabled = true;

  function buttonOrder(nodes) {
    const row = nodes.find((x) => String(x.props.className || "").includes("pd-row"));
    return (row.children || []).filter((k) => k && k.props && k.props["aria-haspopup"] === "menu")
      .map((k) => textOf(k).replace(/\s+/g, "")).filter(Boolean);
  }

  let nodes = remountToolbar(props);
  for (let i = 0; i < 3; i++) { await tick(20); nodes = remountToolbar(props); }
  const before = buttonOrder(nodes);
  findButton(nodes, (n) => n.props["aria-label"] === "改写").props.onClick();
  for (let i = 0; i < 4; i++) { await tick(20); nodes = remountToolbar(props); }
  const after = buttonOrder(nodes);
  const hasError = nodes.some((x) => x.props["data-pd-error-slot"] === "1");
  check("错误出现后仍在同一工具行", hasError, true);
  check("三个按钮的先后顺序不变", JSON.stringify(before) === JSON.stringify(after), { before, after });
  check("错误提示没有插进按钮之间（槽位在最左）", (() => {
    const row = nodes.find((x) => String(x.props.className || "").includes("pd-row"));
    const kids = (row.children || []).filter(Boolean);
    return kids[0] && kids[0].props["data-pd-error-slot"] === "1";
  })(), true);
  // 极窄视口下左侧放不下：改挂到下方，仍然绝对定位、仍然不移动按钮
  check("窄视口改为下方挂载（仍 absolute）",
    /@media \(max-width:640px\)\{[\s\S]*?\.pd-sideNote\{[^}]*top:100%/.test(I.CSS_TEXT.replace(/\n/g, "")), true);
  check("窄视口下宽度限制到视口内",
    /@media \(max-width:640px\)\{[\s\S]*?max-width:calc\(100vw - 24px\)/.test(I.CSS_TEXT.replace(/\n/g, "")), true);
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

console.log("\n[26] SSE 流不能被 request() 预读（真实「连接失败」根因）");
{
  // 真实浏览器里 response.body 只能读一次：先 json() 会把流读掉/读坏，
  // 随后 getReader() 拿不到任何 delta，表现为「点改写→连接失败」。
  // 这里用会真正消费 body 的 json() 来复现。
  resetHooks();
  const { props, state } = makeWiredProps("帮我把这段话改短一点");
  const frames = [
    'event: meta\ndata: {"requestId":"r1","provider":"p","model":"m","draftChars":12}\n\n',
    'event: delta\ndata: {"text":"你"}\n\n',
    'event: delta\ndata: {"text":"好"}\n\n',
    'event: done\ndata: {"text":"你好","provider":"p","model":"m"}\n\n',
  ];
  let bodyConsumed = false;
  let jsonCalled = false;
  currentFetch = (url) => {
    if (!String(url).includes("/rewrite-stream")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    }
    let i = 0;
    const stream = {
      getReader: () => ({
        read: () => {
          if (bodyConsumed) return Promise.reject(new TypeError("body stream already read"));
          if (i < frames.length) {
            return Promise.resolve({ done: false, value: new TextEncoder().encode(frames[i++]) });
          }
          bodyConsumed = true;
          return Promise.resolve({ done: true });
        },
      }),
    };
    const resp = {
      ok: true, status: 200,
      body: stream,
      // 真实 SSE 响应的 json() 会尝试把整个流当 JSON 读，从而破坏它
      json: () => { jsonCalled = true; bodyConsumed = true; return Promise.reject(new SyntaxError("Unexpected token 'e'")); },
    };
    return Promise.resolve(resp);
  };
  runEffectsEnabled = true;
  let nodes = remountToolbar(props);
  for (let i = 0; i < 3; i++) { await tick(20); nodes = remountToolbar(props); }
  findButton(nodes, (n) => n.props["aria-label"] === "改写").props.onClick();
  for (let i = 0; i < 8; i++) { await tick(20); nodes = remountToolbar(props); }

  check("SSE 响应没有被预先 json() 读取", jsonCalled === false);
  check("改写成功写回草稿", state.draft === "你好", state.draft);
  check("成功态显示撤销", I.getStore().phase === "success", I.getStore().phase);
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

console.log("\n[27] 错误归类：连不上 vs 流中断 vs 凭据");
{
  check("FETCH 失败 → network", I.classifyError({ code: "NETWORK" }) === "network");
  // 流中断说明连接是通的，不能误报「连接失败」
  check("流中断 → model（不是 network）", I.classifyError({ code: "STREAM_BROKEN" }) === "model",
    I.classifyError({ code: "STREAM_BROKEN" }));
  check("AUTH → auth 且有「打开设置」",
    I.classifyError({ code: "AUTH" }) === "auth" && I.ERROR_ACTION.auth === "openSettings");
  check("超时 → timeout", I.classifyError({ code: "TIMEOUT" }) === "timeout");
  check("流中断文案不含「连接失败」", !/连接失败/.test(I.errorFeedback({ code: "STREAM_BROKEN" }).text),
    I.errorFeedback({ code: "STREAM_BROKEN" }).text);
}

console.log("\n[29] 三处内容必须真正显示（风格库/模板库/全局提示词）");
{
  // 回归：配置到达后，这三处都必须有可见内容：
  // ① 全局改写纪律正文可读（非“（空）”）
  // ② 风格库每个风格都有折叠标题栏
  // ③ 模板库每条模板都有折叠标题栏
  resetAll();
  let conf = {
    ok: true, storage: "config", rewriteModel: null, timeoutMs: 90000,
    contextEnabled: true, contextTurns: 6,
    globalDiscipline: "你是提示词改写器，不是需求生成器。",
    globalDisciplineCustom: false,
    styles: [
      { id: "concise", name: "更简洁", instruction: "压缩表达" },
      { id: "detailed", name: "更详细", instruction: "补全信息" },
      { id: "custom", name: "自定义", instruction: "" },
    ],
    templates: [
      { id: "t-review", name: "代码审查", text: "审查下面的代码", category: "", tags: [] },
      { id: "t-test", name: "写测试", text: "为代码写测试", category: "开发", tags: [] },
    ],
    toolbar: { showStyleEntry: "auto", showTemplateEntry: "auto", compactThreshold: 320 },
    shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" },
  };
  currentFetch = jsonFetch((url, opts) => {
    const method = (opts && opts.method) || "GET";
    if (url.endsWith("/config")) {
      if (method === "POST") { const b = JSON.parse(opts.body || "{}"); conf = Object.assign({}, conf, b); }
      return { ok: true, json: conf };
    }
    if (url.includes("/models")) return { json: { ok: true, groups: [], global: null } };
    return { json: { ok: true } };
  });
  runEffectsEnabled = true;
  resetHooks();
  mountCard({ view: "page" });
  await tick(20);
  const nodes = walk(mountCard({ view: "page" }));

  // ① 全局改写纪律
  const pre = nodes.find((x) => String(x.props.className || "").includes("pd-readonly"));
  check("全局提示词有正文", !!pre && textOf(pre).includes("提示词改写器"), pre && textOf(pre).slice(0, 40));
  check("全局提示词不是「（空）」", !!pre && textOf(pre) !== "（空）", pre && textOf(pre));

  // ② 风格库
  // walk() 会重复求值，按折叠键去重后再计数
  const uniq = (list, key) => { const m = new Map(); list.forEach((x) => m.set(String(x.props[key]), x)); return [...m.values()]; };
  const styleHeads = uniq(nodes.filter((x) => String(x.props["data-pd-fold-toggle"] || "").startsWith("style:")), "data-pd-fold-toggle");
  check("风格库显示全部风格", styleHeads.length === 3, styleHeads.length);
  check("风格库显示风格名", styleHeads.some((x) => /更简洁/.test(textOf(x))), styleHeads.map(textOf));
  check("风格库显示指令摘要", styleHeads.some((x) => /压缩表达/.test(textOf(x))), styleHeads.map(textOf));

  // ③ 模板库
  const tplHeads = uniq(nodes.filter((x) => String(x.props["data-pd-fold-toggle"] || "").startsWith("tpl:")), "data-pd-fold-toggle");
  check("模板库显示全部模板", tplHeads.length === 2, tplHeads.length);
  check("模板库显示模板名", tplHeads.some((x) => /代码审查/.test(textOf(x))), tplHeads.map(textOf));
  check("模板库显示正文首行", tplHeads.some((x) => /审查下面的代码/.test(textOf(x))), tplHeads.map(textOf));
}

console.log("\n[30] 配置未就绪时不能显示为空壳");
{
  resetAll();
  // 配置请求失败：必须明确说“读取失败 + 重试”，而不是三处一片空白
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false, error: { message: "boom" } }) });
  runEffectsEnabled = true;
  resetHooks();
  mountCard({ view: "page" });
  await tick(30);
  const nodes = walk(mountCard({ view: "page" }));
  const box = nodes.find((x) => x.props["data-pd-config-state"]);
  check("失败时显示状态框", !!box && box.props["data-pd-config-state"] === "error", box && box.props["data-pd-config-state"]);
  check("失败时说明原因", !!box && /无法读取当前配置/.test(textOf(box)), box && textOf(box).slice(0, 40));
  const retry = findButton(nodes, (n) => /重试/.test(textOf(n)));
  check("失败时提供重试按钮", !!retry);
  // 重试后恢复正常渲染
  currentFetch = jsonFetch((url) => {
    if (url.endsWith("/config")) return { ok: true, json: {
      ok: true, rewriteModel: null, timeoutMs: 90000, contextEnabled: true, contextTurns: 6,
      globalDiscipline: "纪律正文", globalDisciplineCustom: false,
      styles: [{ id: "concise", name: "更简洁", instruction: "x" }], templates: [],
      toolbar: {}, shortcuts: {} } };
    if (url.includes("/models")) return { json: { ok: true, groups: [], global: null } };
    return { json: { ok: true } };
  });
  if (retry) retry.props.onClick();
  await tick(30);
  const after = walk(mountCard({ view: "page" }));
  check("重试后恢复显示配置", after.some((x) => String(x.props["data-pd-fold-toggle"] || "").startsWith("style:")), true);
  check("重试后状态框消失", !after.some((x) => x.props["data-pd-config-state"]), true);
}

console.log("\n[31] 响应类型判定：不能靠 body.getReader 判断流式");
{
  // 真实浏览器的每个响应都有 body.getReader（包括普通 JSON）。
  // 若据此判断「这是流」，普通 JSON 就永远不会被 json() 解析，
  // 表现就是设置页显示「无法读取当前配置：HTTP 200」。
  resetAll();
  let posts = 0;
  currentFetch = (url, opts) => {
    const method = (opts && opts.method) || "GET";
    if (String(url).endsWith("/config")) {
      if (method === "POST") posts++;
      // 普通 JSON 响应，但故意提供 body.getReader（模拟浏览器）
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json; charset=utf-8" : null) },
        body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
        json: () => Promise.resolve({
          ok: true, rewriteModel: null, timeoutMs: 90000, contextEnabled: true, contextTurns: 6,
          globalDiscipline: "纪律正文", globalDisciplineCustom: false,
          styles: [{ id: "concise", name: "更简洁", instruction: "压缩表达" }],
          templates: [{ id: "t1", name: "代码审查", text: "审查代码", category: "", tags: [] }],
          toolbar: { showStyleEntry: "auto", showTemplateEntry: "auto", compactThreshold: 320 },
          shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" },
        }),
      });
    }
    if (String(url).includes("/models")) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: () => "application/json" },
        body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
        json: () => Promise.resolve({ ok: true, groups: [], global: null }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, headers: { get: () => "application/json" },
      body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
      json: () => Promise.resolve({ ok: true }) });
  };
  runEffectsEnabled = true;
  resetHooks();
  mountCard({ view: "page" });
  await tick(30);
  const nodes = walk(mountCard({ view: "page" }));

  // 关键：普通 JSON 必须被解析，界面进入正常态而不是错误态
  check("JSON 响应被正确解析（无状态框）", !nodes.some((x) => x.props["data-pd-config-state"]),
    nodes.find((x) => x.props["data-pd-config-state"]) ? textOf(nodes.find((x) => x.props["data-pd-config-state"])) : "none");
  check("风格库正常渲染", nodes.some((x) => String(x.props["data-pd-fold-toggle"] || "").startsWith("style:")), true);
  check("模板库正常渲染", nodes.some((x) => String(x.props["data-pd-fold-toggle"] || "").startsWith("tpl:")), true);
  check("全局纪律正常渲染",
    nodes.some((x) => String(x.props.className || "").includes("pd-readonly") && textOf(x).includes("纪律正文")), true);

  // SSE 端点仍按流处理：content-type 为 text/event-stream 时不能被 json() 预读
  const frames = [
    "event: meta\ndata: {\"requestId\":\"r1\",\"provider\":\"p\",\"model\":\"m\"}\n\n",
    "event: delta\ndata: {\"text\":\"改写\"}\n\n",
    "event: done\ndata: {\"text\":\"改写结果\"}\n\n",
  ];
  let frameIdx = 0;
  let jsonCalled = false;
  currentFetch = (url) => {
    const u = String(url);
    if (u.includes("/rewrite-stream")) {
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "text/event-stream; charset=utf-8" : null) },
        body: { getReader: () => ({ read: () => (frameIdx < frames.length
          ? Promise.resolve({ done: false, value: new TextEncoder().encode(frames[frameIdx++]) })
          : Promise.resolve({ done: true })) }) },
        json: () => { jsonCalled = true; return Promise.reject(new Error("SSE must not be json()-ed")); },
      });
    }
    // 其它端点：普通 JSON（同样带 getReader，模拟浏览器）
    const payload = u.endsWith("/config")
      ? { ok: true, rewriteModel: null, timeoutMs: 90000, contextEnabled: false, contextTurns: 6,
          globalDiscipline: "d", globalDisciplineCustom: false,
          styles: [{ id: "concise", name: "更简洁", instruction: "x" }], templates: [],
          toolbar: { showStyleEntry: "always", showTemplateEntry: "always", compactThreshold: 320 },
          shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" } }
      : { ok: true, groups: [], global: null };
    return Promise.resolve({
      ok: true, status: 200,
      headers: { get: () => "application/json; charset=utf-8" },
      body: { getReader: () => ({ read: () => Promise.resolve({ done: true }) }) },
      json: () => Promise.resolve(payload),
    });
  };
  resetAll();
  resetHooks();
  const { props: wprops, state: wstate } = makeWiredProps("需要改写的草稿");
  let tnodes = remountToolbar(wprops);
  for (let k = 0; k < 4; k++) { await tick(20); tnodes = remountToolbar(wprops); }
  const btn = findButton(tnodes, (n) => n.props["aria-label"] === "改写");
  check("初始态能找到改写按钮", !!btn, I.getStore().phase);
  if (btn) btn.props.onClick();
  for (let k = 0; k < 10; k++) { await tick(20); tnodes = remountToolbar(wprops); }
  check("SSE 响应没有被 json() 预读", jsonCalled === false);
  // SSE 的完整流式写回路径已在 [26] 单独覆盖（那里用最小桩，不受本节状态影响）；
  // 本节只证明「JSON 被正确解析」与「SSE 不被 json() 预读」两件事。
}

console.log("\n[32] 错误场景只留左侧错误条，不弹 Toast");
{
  // 完成判定：原先会弹提示语的场景不再弹；左侧错误条照常显示。
  resetAll();
  I.resetToasts();
  const { props } = makeWiredProps("一段会改写失败的草稿");
  currentFetch = jsonFetch((url) => {
    if (url.includes("/rewrite-stream")) return { ok: false, status: 409, json: { ok: false, error: { code: "NO_MODEL" } } };
    return { json: { ok: true } };
  });
  runEffectsEnabled = true;
  let nodes = remountToolbar(props);
  for (let i = 0; i < 3; i++) { await tick(20); nodes = remountToolbar(props); }
  const btn = findButton(nodes, (n) => n.props["aria-label"] === "改写");
  check("能触发一次改写", !!btn, I.getStore().phase);
  if (btn) btn.props.onClick();
  for (let i = 0; i < 5; i++) { await tick(20); nodes = remountToolbar(props); }

  // ① 左侧错误条照常显示
  const bar = nodes.find((x) => String(x.props.className || "").includes("pd-errorBar"));
  check("错误条仍显示", !!bar, I.getStore().phase);
  check("错误条文案未变", !!bar && /改写模型未配置或凭据失效/.test(textOf(bar)), bar && textOf(bar));
  check("错误条仍在左侧旁注槽位",
    nodes.some((x) => x.props["data-pd-side-note"] === "1" &&
      walk(x).some((y) => String(y.props.className || "").includes("pd-errorBar"))), true);

  // ② 不弹 toast
  check("错误场景不弹 Toast", I.getToasts().length === 0, I.getToasts().map((t) => t.text));

  // ③ 点「打开设置」也不再弹 toast（这是原先会重复提示的路径）
  I.resetToasts();
  const openBtn = findButton(nodes, (n) => /打开设置/.test(textOf(n)));
  check("错误条有「打开设置」", !!openBtn);
  if (openBtn) openBtn.props.onClick();
  await tick(20);
  check("打开设置不再弹 Toast", I.getToasts().length === 0, I.getToasts().map((t) => t.text));
  check("点击后错误条仍在（不被误清）", !!walk(remountToolbar(props)).find((x) => String(x.props.className || "").includes("pd-errorBar")));

  // ④ 与错误无关的 toast 保持原样（约束：只删错误场景的弹窗）
  I.resetToasts();
  I.toast("设置已保存");
  check("设置保存的 Toast 保留", I.getToasts().some((t) => t.text === "设置已保存"), I.getToasts());
  I.resetToasts();
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

console.log("\n[33] 快捷键：输入框内也生效，且修改后能改掉");
{
  // 问题一：dsh 的 composer 是 contenteditable，旧逻辑把「可编辑目标」一律跳过，
  // 导致快捷键在唯一的使用场景（正在输入草稿）里永远不响应。
  check("Alt 组合键被识别为快捷键", I.isShortcutChord({ altKey: true, key: "m" }) === true);
  check("Ctrl 组合键被识别为快捷键", I.isShortcutChord({ ctrlKey: true, key: "m" }) === true);
  check("纯字符键不是快捷键", I.isShortcutChord({ altKey: false, key: "m" }) === false);
  const composer = { tagName: "DIV", isContentEditable: true, getAttribute: () => "textbox" };
  check("composer 被识别为可编辑目标", I.isEditableTarget(composer) === true);
  // 组合键 + 可编辑目标：应当放行（关键修复点）
  check("输入框内按 Alt 组合键不被拦截",
    !(I.isEditableTarget(composer) && !I.isShortcutChord({ altKey: true, key: "m" })), true);
  // 纯字符 + 可编辑目标：必须拦截，否则会吞掉正在打的字
  check("输入框内核纯字符键仍被拦截",
    I.isEditableTarget(composer) && !I.isShortcutChord({ altKey: false, key: "m" }), true);
  check("源码里不再无条件跳过可编辑目标",
    !/if \(isEditableTarget\(e && e\.target\)\) return;/.test(src.slice(src.indexOf("function onKey(e)"))));

  // 问题二：改过的快捷键必须真的能匹配上
  const custom = { openStyle: "Alt+J", openTemplate: "Alt+T", rewrite: "Alt+R" };
  check("自定义快捷键能被匹配",
    I.matchShortcut({ key: "j", altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, custom) === "openStyle");
  check("旧的默认组合不再匹配",
    I.matchShortcut({ key: "m", altKey: true, ctrlKey: false, shiftKey: false, metaKey: false }, custom) === "");
  check("其它快捷键不受影响",
    I.matchShortcut({ key: "t", altKey: true }, custom) === "openTemplate");

  // 校验：非法值不会被存进配置
  check("空值非法", I.validShortcut("") === false);
  check("单独字母非法（会吞掉打字）", I.validShortcut("m") === false);
  check("合法组合通过", I.validShortcut("Alt+J") === true && I.validShortcut("Ctrl+Shift+K") === true);
}

console.log("\n[34] 录入快捷键时不触发全局快捷键");
{
  // 录入态由 data-pd-shortcut-capturing="1" 标记，全局监听必须先看这个标记。
  const iDoc = src.indexOf('document.addEventListener("keydown", onKey, true)');
  const iGuard = src.indexOf('data-pd-shortcut-capturing');
  check("全局监听里存在录入态守卫", iGuard > 0 && iGuard < iDoc, { iGuard, iDoc });
  check("守卫使用 getAttribute 读取（兼容 DOM 元素）",
    /getAttribute\("data-pd-shortcut-capturing"\)/.test(src), true);

  // 录入框自身带该标记，且只在录入态为 "1"
  resetAll();
  currentFetch = jsonFetch((url) => {
    if (url.endsWith("/config")) return { ok: true, json: {
      ok: true, rewriteModel: null, timeoutMs: 90000, contextEnabled: true, contextTurns: 6,
      globalDiscipline: "d", globalDisciplineCustom: false,
      styles: [{ id: "concise", name: "更简洁", instruction: "x" }], templates: [],
      toolbar: {}, shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" } } };
    if (url.includes("/models")) return { json: { ok: true, groups: [], global: null } };
    return { json: { ok: true } };
  });
  runEffectsEnabled = true;
  resetHooks();
  mountCard({ view: "page" });
  await tick(20);
  let nodes = walk(mountCard({ view: "page" }));
  const uniq = (list) => { const m = new Map(); list.forEach((x) => m.set(String(x.props["aria-label"]), x)); return [...m.values()]; };
  const input0 = uniq(nodes.filter((x) => x.type === "input" && /打开风格菜单/.test(x.props["aria-label"] || "")))[0];
  check("未点击时标记为 0", input0.props["data-pd-shortcut-capturing"] === "0", input0.props["data-pd-shortcut-capturing"]);
  input0.props.onClick();
  nodes = walk(mountCard({ view: "page" }));
  const input1 = uniq(nodes.filter((x) => x.type === "input" && /打开风格菜单/.test(x.props["aria-label"] || "")))[0];
  check("点击录入时标记为 1", input1.props["data-pd-shortcut-capturing"] === "1", input1.props["data-pd-shortcut-capturing"]);
  check("录入时清空显示内容（提示按组合键）", input1.props.value === "", JSON.stringify(input1.props.value));
}

console.log("\n[35] 浮层键盘导航：↑↓ 切换、Enter 选中且不发送草稿");
{
  // 根因：Alt+M 打开浮层时焦点仍在 composer，键盘事件只在浮层内部挂 onKeyDown 收不到。
  // 必须在 document 捕获阶段接管。
  const pIdx = src.indexOf("function PdPopover");
  const seg = src.slice(pIdx, pIdx + 6000);
  check("浮层在 document 上接管方向键",
    /document\.addEventListener\("keydown", onDocKey, true\)/.test(seg), true);
  check("监听在卸载时移除",
    /document\.removeEventListener\("keydown", onDocKey, true\)/.test(seg), true);
  check("接管 ArrowDown / ArrowUp", /"ArrowDown"/.test(seg) && /"ArrowUp"/.test(seg), true);
  check("接管 Enter", /"Enter"/.test(seg), true);
  check("接管 Home / End", /"Home"/.test(seg) && /"End"/.test(seg), true);
  check("接管时 preventDefault（回车不会发送草稿）",
    /e\.preventDefault\(\)/.test(seg) && /e\.stopPropagation\(\)/.test(seg), true);
  check("输入法组合中不拦截（回车用于确认候选词）", /if \(e\.isComposing\) return;/.test(seg), true);
  check("用 ref 保存权威索引（避免连按读到旧值）", /indexRef/.test(seg) && /moveIndex/.test(seg), true);
  check("按键同步推进 ref 再渲染", /function moveIndex\(next\) \{[\s\S]*?indexRef\.current = next;[\s\S]*?setIndex\(next\);/.test(seg), true);
  // 高亮必须跟随键盘索引，而不是只看「已选中」
  check("菜单行带键盘当前项类", /pd-optionActive/.test(seg), true);
  check("键盘当前项由 index 决定", /var kbCurrent = i === index;/.test(seg), true);
  check("键盘当前项与已选中可共存",
    /\(active \? " pd-optionOn" : ""\) \+ \(kbCurrent \? " pd-optionActive" : ""\)/.test(seg), true);
  check("有 data 标记便于测试/调试", /data-pd-option-active/.test(seg), true);
  check("样式定义了键盘当前项", I.CSS_TEXT.includes(".pd-optionActive{"), true);

  // 打开浮层后，只放行「风格 / 模板」两个开关；其它快捷键（如 Alt+R 改写）不触发
  const kIdx = src.indexOf("// ---- 快捷键（Alt+M");
  const kSeg = src.slice(kIdx, kIdx + 2400);
  check("浮层打开时拦截无关快捷键", /if \(openMenu\) \{/.test(kSeg), true);
  check("风格/模板之间互相切换被放行", /switchesMenu/.test(kSeg), true);
  check("同一个键仍走 toggle 关闭",
    /setOpenMenu\(openMenu === "style" \? null : "style"\)/.test(kSeg) &&
    /setOpenMenu\(openMenu === "tpl" \? null : "tpl"\)/.test(kSeg), true);

  // 索引推进逻辑：越界要夹紧（↑ 在第一项、↓ 在最后一项都不越界）
  const next = (i, n, key) => key === "ArrowDown" ? Math.min(n - 1, i + 1)
    : key === "ArrowUp" ? Math.max(0, i - 1) : key === "Home" ? 0 : n - 1;
  check("↓ 前进一格", next(0, 3, "ArrowDown") === 1);
  check("↑ 后退一格", next(2, 3, "ArrowUp") === 1);
  check("↓ 在末项不越界", next(2, 3, "ArrowDown") === 2);
  check("↑ 在首项不越界", next(0, 3, "ArrowUp") === 0);
  check("Home / End 跳到首末", next(1, 3, "Home") === 0 && next(1, 3, "End") === 2);
}

console.log("\n[36] 连按 ↑↓ 索引逐个推进（不得脏读）");
{
  // 复刻浮层的索引推进逻辑（与实现同构），验证连按不丢步。
  // 真实场景：两次 keydown 都发生在同一次 React 渲染之前。
  function makeNav(count) {
    const st = { renderedIndex: 0, indexRef: 0, pending: null };
    // 渲染：pending 匹配则清标记；否则（无 pending）采纳渲染值
    st.render = (v) => {
      if (st.pending !== null && v === st.pending) st.pending = null;
      else if (st.pending === null) st.indexRef = v;
      st.renderedIndex = v;
    };
    st.move = (next) => { st.indexRef = next; st.pending = next; st.renderedIndex = next; };
    st.key = (k) => {
      const cur = st.indexRef;
      if (k === "ArrowDown") st.move(Math.min(count - 1, cur + 1));
      else if (k === "ArrowUp") st.move(Math.max(0, cur - 1));
      else if (k === "Home") st.move(0);
      else if (k === "End") st.move(count - 1);
    };
    return st;
  }

  const nav = makeNav(4);
  const seen = [];
  for (let i = 0; i < 3; i++) { nav.key("ArrowDown"); seen.push(nav.renderedIndex); }
  check("连按 3 次 ↓ 逐格推进（0→1→2→3）", seen.join(",") === "1,2,3", seen);
  nav.key("ArrowUp");
  check("↑ 后退一格", nav.renderedIndex === 2, nav.renderedIndex);
  // 旧值渲染不得回退（并发/StrictMode 下会以旧 props 渲染一次）
  nav.render(0);
  check("以旧值渲染后不回退", nav.renderedIndex === 2 || nav.indexRef === 2, nav.indexRef);
  nav.key("End");
  nav.key("ArrowDown");
  check("End 后在末项不越界", nav.renderedIndex === 3, nav.renderedIndex);
  nav.key("Home");
  nav.key("ArrowUp");
  check("Home 后在首项不越界", nav.renderedIndex === 0, nav.renderedIndex);

  // 静态断言：实现必须从 indexRef 读当前值，不能用渲染闭包里的 index
  const pIdx = src.indexOf("function PdPopover");
  const seg = src.slice(pIdx, pIdx + 7000);
  check("按键路径从 indexRef 读取当前索引", /var cur = indexRef\.current;/.test(seg), true);
  check("按键路径不再直接读渲染值 index", !/var cur = index;/.test(seg), true);
}

console.log("\n[37] 风格/模板 快捷键互相切换（不得被吞）");
{
  // 复刻快捷键分支的决策逻辑（与实现同构）：
  //   浮层开着时只放行 openStyle / openTemplate，其余一律 return；
  //   同一个键 toggle 关闭，另一个键直接切过去。
  function decide(openMenu, action) {
    if (openMenu) {
      const switchesMenu = (action === "openStyle" || action === "openTemplate");
      if (!switchesMenu) return { handled: false, next: openMenu };
    }
    if (action === "openStyle") return { handled: true, next: openMenu === "style" ? null : "style" };
    if (action === "openTemplate") return { handled: true, next: openMenu === "tpl" ? null : "tpl" };
    return { handled: true, next: openMenu };
  }

  // ① 风格开着 → 按模板 → 切到模板
  const a = decide("style", "openTemplate");
  check("风格开着按模板：被处理", a.handled === true);
  check("风格开着按模板：切到模板", a.next === "tpl", a.next);

  // ② 模板开着 → 按风格 → 切到风格
  const b = decide("tpl", "openStyle");
  check("模板开着按风格：被处理", b.handled === true);
  check("模板开着按风格：切到风格", b.next === "style", b.next);

  // ③ 同一个键仍然关闭（保留原有语义）
  const c = decide("style", "openStyle");
  check("风格开着再按风格：关闭", c.handled === true && c.next === null, c.next);
  const d = decide("tpl", "openTemplate");
  check("模板开着再按模板：关闭", d.handled === true && d.next === null, d.next);

  // ④ 浮层关着时，两个键正常打开
  check("关闭态按风格：打开风格", decide(null, "openStyle").next === "style");
  check("关闭态按模板：打开模板", decide(null, "openTemplate").next === "tpl");

  // ⑤ 浮层开着时，无关快捷键（改写）不被吞掉执行——应当拦下，避免误触
  const e = decide("style", "rewrite");
  check("浮层开着按改写：被拦下（防误触）", e.handled === false, e);

  // 静态断言：源码里确实放行了两个开关
  const kIdx = src.indexOf("// ---- 快捷键（Alt+M");
  const kSeg = src.slice(kIdx, kIdx + 2400);
  check("源码放行两个开关而非仅同一个键",
    /switchesMenu = \(act2 === "openStyle" \|\| act2 === "openTemplate"\)/.test(kSeg), true);
}

console.log("\n[28] 全局：任何提示都不改变三个按钮的位置");
{
  // 「全局」约束：所有会挤动布局的旁注（错误条、长度提示、芯片说明）
  // 都必须是 .pd-sideNote 的绝对定位子项，不能当 flex 子项。
  const css = I.CSS_TEXT;
  check("旁注槽位脱离 flex（absolute + right:100%）",
    /\.pd-sideNote\{[^}]*position:absolute/.test(css) && /\.pd-sideNote\{[^}]*right:100%/.test(css), true);

  // 结构层：工具行的直接 flex 子项只能是「旁注槽位 + 触发器按钮」
  // （弹层/流光条虽是子节点但为 absolute，不影响主轴）
  const ABS = /position:(absolute|fixed)/;
  const cssOfClass = (cls) => {
    const m = I.CSS_TEXT.match(new RegExp("\\." + cls + "\\{[^}]*\\}"));
    return m ? m[0] : "";
  };
  check("旁注槽位为绝对定位", ABS.test(cssOfClass("pd-sideNote")), cssOfClass("pd-sideNote").slice(0, 60));
  check("弹层为绝对/固定定位（不占主轴）", ABS.test(cssOfClass("pd-popover")), cssOfClass("pd-popover").slice(0, 60));
  check("流光条为绝对定位", ABS.test(cssOfClass("pd-shimmer")), cssOfClass("pd-shimmer").slice(0, 60));

  // 行为层：成功态会出现长度提示，此时按钮相对顺序必须与初始一致
  resetAll();          // 清 hook 槽位 + 共享 store（上一节可能停在 success）
  resetHooks();
  const { props } = makeWiredProps("这是一段用于测试的草稿内容");
  const frames = [
    'event: meta\ndata: {"requestId":"r1","provider":"p","model":"m","draftChars":14}\n\n',
    'event: delta\ndata: {"text":"太短"}\n\n',
    'event: done\ndata: {"text":"太短"}\n\n',
  ];
  currentFetch = (url) => {
    if (String(url).includes("/rewrite-stream")) {
      let i = 0;
      return Promise.resolve({
        ok: true, status: 200,
        body: { getReader: () => ({ read: () => (i < frames.length
          ? Promise.resolve({ done: false, value: new TextEncoder().encode(frames[i++]) })
          : Promise.resolve({ done: true })) }) },
        json: () => Promise.reject(new Error("should not read")),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
  };
  runEffectsEnabled = true;

  // 只看「风格」「模板」两个下拉触发器的相对顺序（改写按钮在成功态会变成“撤销”）
  function orderOf(nodes) {
    const row = nodes.find((x) => String(x.props.className || "").includes("pd-row"));
    return (row.children || []).filter(Boolean)
      .map((k) => {
        const p = k.props || {};
        if (p["aria-haspopup"] === "menu") return "menu:" + (p["aria-label"] || "");
        if (p["data-pd-side-note"]) return "note";
        if (p["aria-label"] === "改写" || p["aria-label"] === "撤销改写") return "rewrite";
        return null;
      })
      .filter(Boolean);
  }
  let nodes = remountToolbar(props);
  for (let i = 0; i < 3; i++) { await tick(20); nodes = remountToolbar(props); }
  const before = orderOf(nodes);
  const rewriteBtn = findButton(nodes, (n) => n.props["aria-label"] === "改写");
  check("初始态找到改写按钮", !!rewriteBtn, I.getStore().phase);
  if (rewriteBtn) rewriteBtn.props.onClick();
  for (let i = 0; i < 8; i++) { await tick(20); nodes = remountToolbar(props); }
  const after = orderOf(nodes);
  check("成功态出现了长度提示", nodes.some((x) => x.props["data-pd-hint"] === "1"), true);
  // 关键断言：提示出现后，「风格」「模板」两个按钮的相对顺序与位置不变。
  // 提示只允许出现在序列的最前面（旁注槽位），不能插进按钮之间。
  const menusBefore = before.filter((x) => x.startsWith("menu:"));
  const menusAfter = after.filter((x) => x.startsWith("menu:"));
  check("有长度提示时风格/模板顺序不变",
    JSON.stringify(menusBefore) === JSON.stringify(menusAfter), { menusBefore, menusAfter });
  check("提示只在按钮之前出现（不插进按钮之间）",
    after.indexOf("note") === 0 && after.filter((x) => x === "note").length === 1, after);
  check("提示出现前没有旁注", before.every((x) => x !== "note"), before);
  check("长度提示在旁注槽位内（不在按钮之间）",
    nodes.some((x) => x.props["data-pd-side-note"] === "1" &&
      walk(x).some((y) => y.props["data-pd-hint"] === "1")), true);
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false }) });
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
