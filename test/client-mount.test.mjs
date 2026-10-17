/**
 * 临时冒烟测试（不随插件发布）：用桩 React 在 Node 里真实加载 lib/client.js，
 * 验证 ① 模块注册形状 ② apply() 挂到 conversation.input.right ③ Toolbar 能渲染
 * ④ 含芯片时改写按钮被禁用 ⑤ 空草稿时禁用。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// ---- 桩 React：有状态的 hook 槽位 + 可遍历的 createElement ----
// 说明：组件是用普通函数直接调用的，因此必须按「组件函数 + hook 序号」保存状态，
// 否则 useState 每次渲染都回到初值，菜单/面板等交互状态永远打不开。
const hookStore = new Map();
let activeHooks = null;
// useEffect 收集：默认不执行（保持既有用例的确定性），需要时用 runEffectsEnabled 打开
let pendingEffects = [];
const ranEffects = new Set();
const fnIds = new WeakMap();
let nextFnId = 1;
let runEffectsEnabled = false;
function fnId(fn) {
  if (!fnIds.has(fn)) fnIds.set(fn, nextFnId++);
  return fnIds.get(fn);
}
function renderComponent(fn, props) {
  const slots = hookStore.get(fn) || { states: [], cursor: 0 };
  hookStore.set(fn, slots);
  slots.cursor = 0;
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
      try { cb(); } catch (e) {}
    });
  }
  return out;
}
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
    const p = props || {};
    // 模拟 ref 挂载：useAnchorFollow 依赖 anchorRef.current 的 getBoundingClientRect
    if (p.ref && typeof p.ref === "object" && "current" in p.ref) {
      p.ref.current = {
        getBoundingClientRect: () => ({ left: 100, top: 700, width: 120, height: 28, right: 220, bottom: 728 }),
        contains: () => false,
      };
    }
    return {
      $$el: true, type, props: p,
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    };
  },
};

const registered = { slot: null, def: null, component: null };
const fakeCtx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, cb) => { registered.slot = name; return cb(); },
    register: (def, component) => { registered.def = def; registered.component = component; return () => {}; },
  },
};

// 模拟输入框区域：故意偏离视口中轴（左侧有侧栏的真实情形）
const COMPOSER_RECT = { left: 260, top: 400, width: 880, height: 120, right: 1140, bottom: 520 };

let loaded = null;
const sandbox = {
  require: (name) => (name === "react" ? React : {}),
  document: {
    // 让 ensureCss 短路，同时为 [data-composer-card] 提供输入框矩形
    querySelector: (sel) => (sel === "[data-composer-card]" ? { getBoundingClientRect: () => COMPOSER_RECT } : {}),
    createElement: () => ({ dataset: {}, textContent: "" }),
    head: { appendChild: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
  },
  // fetch 可切换：默认失败桩，[6] 里换成 SSE 流桩
  fetch: (...a) => currentFetch(...a),
  AbortController: class { abort() {} get signal() { return {}; } },
  TextDecoder, TextEncoder,
  JSON, Math, Date, String, Number, Array, Object, console, setTimeout, clearInterval, setInterval,
};
sandbox.window = {
  __ModuleLoader__: { load: ({ id, factory }) => { loaded = { id, factory }; } },
  innerHeight: 800, innerWidth: 1200,
  addEventListener: () => {}, removeEventListener: () => {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

// 默认 fetch 桩：非流式失败响应（让错误路径可测）
let currentFetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) });
// 把一个数组的 SSE 帧喂给客户端读取器
function sseFetch(frames) {
  return () => Promise.resolve({
    ok: true,
    body: {
      getReader: () => {
        let i = 0;
        return {
          read: () => Promise.resolve(
            i < frames.length
              ? { done: false, value: new TextEncoder().encode(frames[i++]) }
              : { done: true }
          ),
        };
      },
    },
  });
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  -> " + JSON.stringify(detail) : ""}`); }
};

console.log("\n[1] 模块注册");
check("通过 __ModuleLoader__.load 注册", loaded !== null && loaded.id === "dsh-prompt-dock", loaded && loaded.id);
const mod = loaded.factory((n) => (n === "react" ? React : {}));
check("exports.apply 是函数", typeof mod.apply === "function");
check("exports.inject 含 slots", Array.isArray(mod.inject) && mod.inject.includes("slots"), mod.inject);

console.log("\n[2] 挂载到工具行插槽");
mod.apply(fakeCtx);
check("插槽名为 conversation.input.right", registered.slot === "conversation.input.right", registered.slot);
check("注册 id 为 prompt-dock", registered.def && registered.def.id === "prompt-dock", registered.def);
check("组件的 label 返回中文名", typeof registered.def.label === "function" && registered.def.label() === "提示词助手");
check("组件已登记", typeof registered.component === "function");

// ---- 遍历渲染树：展开函数组件（桩 createElement 不执行组件） ----
function walk(node, out = []) {
  if (Array.isArray(node)) { for (const c of node) walk(c, out); return out; }
  if (!node || typeof node !== "object" || !node.$$el) return out;
  if (typeof node.type === "function") {
    // 函数组件：用其 props 调用后继续遍历（组件内部只用被桩化的 hook）
    walk(renderComponent(node.type, node.props), out);
    return out;
  }
  out.push(node);
  for (const c of node.children || []) walk(c, out);
  return out;
}
function makeProps(draft, extraState) {
  const state = Object.assign({ draft }, extraState || {});
  return {
    useInput: () => JSON.stringify(state),
    inputActions: { setDraft: () => {} },
    sessionId: "s1",
  };
}
// 可写回的有线 props：setDraft 会真的改状态，用于验证「改写→回填→撤销」
function makeWiredProps(draft, extraState) {
  const state = Object.assign({ draft }, extraState || {});
  const props = {
    useInput: () => JSON.stringify(state),
    inputActions: {
      setDraft: (text) => { state.draft = text; },
    },
    sessionId: "s1",
  };
  return { props, state };
}
function findRewrite(nodes) {
  return nodes.find((n) => n.type === "button" && String(n.props.className || "").includes("pd-btnPrimary"));
}

console.log("\n[3] 渲染与禁用逻辑");
{
  let tree, err = null;
  try { tree = renderComponent(registered.component, makeProps("把日志时间戳换成下拉")); } catch (e) { err = e; }
  check("Toolbar 渲染不抛异常", err === null, err && err.message);
  const nodes = walk(tree);
  check("渲染出按钮", nodes.filter((n) => n.type === "button").length > 0);
  const btn = findRewrite(nodes);
  check("普通草稿：改写按钮存在且可用", !!btn && btn.props.disabled === false, btn && btn.props.disabled);
  // 改写按钮为纯图标：内含 svg，且没有文字标签
  check("改写按钮是纯图标（有 svg、无文字）",
    !!btn && walk(btn).some((n) => n.type === "svg") && !walk(btn).some((n) => String(n.props.className || "").includes("pd-label")),
    btn && walk(btn).map((n) => n.type + ":" + (n.props.className || "")));
  check("改写按钮悬停文案简洁", !!btn && btn.props.title === "改写草稿", btn && btn.props.title);
}
{
  const tree = renderComponent(registered.component, makeProps("请把 @src/a.ts 改一下", {
    occurrences: [{ label: "@src/a.ts", clipboardText: "@src/a.ts", source: "file", ref: "src/a.ts", offset: 3, length: 10 }],
  }));
  const nodes = walk(tree);
  const btn = findRewrite(nodes);
  check("含芯片：改写按钮被禁用", !!btn && btn.props.disabled === true, btn && btn.props.disabled);
  const hint = nodes.find((n) => String(n.props.className || "").includes("pd-err"));
  check("含芯片：显示简短禁用提示", !!hint && String(hint.children[0]) === "含芯片", hint && hint.children);
  check("含芯片：完整原因在 title 里", !!hint && String(hint.props.title || "").includes("引用芯片"), hint && hint.props.title);
}
{
  const tree = renderComponent(registered.component, makeProps("   "));
  const btn = findRewrite(walk(tree));
  check("空草稿：改写按钮被禁用", !!btn && btn.props.disabled === true, btn && btn.props.disabled);
}
{
  const tree = renderComponent(registered.component, makeProps("正常草稿"));
  const nodes = walk(tree);
  check("无模板时不渲染「模板」入口", !nodes.some((n) => n.type === "button" && String(n.props.className || "").includes("pd-label") && n.children.some((c) => c && c.children && c.children.includes && c.children.includes("模板"))));
}

console.log("\n[4] 设置面板：改写模型右对齐");
{
  // 展开函数组件后收集某节点下的所有元素
  function desc(node, out = []) {
    if (Array.isArray(node)) { node.forEach((n) => desc(n, out)); return out; }
    if (!node || typeof node !== "object" || !node.$$el) return out;
    if (typeof node.type === "function") { desc(node.type(node.props), out); return out; }
    out.push(node);
    (node.children || []).forEach((c) => desc(c, out));
    return out;
  }

  // 先渲染一次拿到设置齿轮，点开面板
  const tree0 = renderComponent(registered.component, makeProps("正常草稿"));
  const gear = walk(tree0).find((n) => n.type === "button" && String(n.props.className || "").includes("pd-iconBtn"));
  check("找到设置齿轮按钮", !!gear);
  if (gear) gear.props.onClick();

  const tree = renderComponent(registered.component, makeProps("正常草稿"));
  const nodes = walk(tree);

  const isModelLabel = (n) => String(n.props.className || "").includes("pd-fieldLabel") && (n.children || []).includes("改写模型");
  check("设置面板渲染出「改写模型」标签", nodes.some(isModelLabel));

  // 找到「直接子节点」恰好是〔改写模型标签 + 模型控件〕的 flex 行
  // （工具栏外层 div 也是 flex，且设置面板在其子树里，必须用直接子节点区分）
  function directChildren(node) {
    const out = [];
    for (const c of node.children || []) {
      if (!c || typeof c !== "object" || !c.$$el) continue;
      if (typeof c.type === "function") {
        const r = renderComponent(c.type, c.props);
        if (r && r.$$el) out.push(r);
      } else out.push(c);
    }
    return out;
  }
  const modelRow = nodes.find((n) => {
    const s = n.props.style || {};
    if (s.display !== "flex" || s.alignItems !== "center") return false;
    const kids = directChildren(n);
    return kids.some(isModelLabel) && kids.some((x) => x.type === "button" && String(x.props.className || "").includes("pd-btn"));
  });
  check("存在「标签 + 模型控件」同一行的 flex 布局", !!modelRow);

  if (modelRow) {
    const kids = directChildren(modelRow);
    const labelNode = kids.find(isModelLabel);
    const trigger = kids.find((x) => x.type === "button" && String(x.props.className || "").includes("pd-btn"));
    check("行内标签为可伸缩（flex:1）", !!(labelNode && labelNode.props.style && labelNode.props.style.flex === 1));
    const labelSpan = walk(trigger).find((n) => String(n.props.className || "").includes("pd-label"));
    check("模型控件文案为「跟随全局默认」", !!labelSpan && String(labelSpan.children[0]) === "跟随全局默认", labelSpan && labelSpan.children);
    check("控件排在标签之后（即位于右侧）", kids.indexOf(trigger) > kids.indexOf(labelNode));
  }

  const closeBtn = nodes.find((n) => n.type === "button" && n.props.title === "关闭");
  if (closeBtn) closeBtn.props.onClick();

  // 设置面板以「输入框」为基准居中（不是视口）：输入框偏右时面板应跟着右移
  const pop = nodes.find((n) => String(n.props.className || "").includes("pd-pop"));
  const W = Math.min(440, Math.max(280, sandbox.window.innerWidth - 32));
  const composerCenter = COMPOSER_RECT.left + COMPOSER_RECT.width / 2;
  const expectedByComposer = Math.round(composerCenter - W / 2);
  check("设置面板按输入框中轴居中（非视口中轴）",
    !!pop && pop.props.style.left === expectedByComposer && pop.props.style.width === W,
    pop && { left: pop.props.style.left, expectedByComposer, viewportCenterLeft: Math.round(sandbox.window.innerWidth / 2 - W / 2) });
  check("居中位置确实不等于视口中轴（说明用的是输入框）",
    expectedByComposer !== Math.round(sandbox.window.innerWidth / 2 - W / 2),
    { expectedByComposer, viewport: Math.round(sandbox.window.innerWidth / 2 - W / 2) });
}

console.log("\n[5] 工具行与面板的冗余收敛");
{
  const nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));

  // 工具行同时出现的控件数量（默认态：风格 / 改写 / 设置）
  const rowButtons = nodes.filter((n) => n.type === "button" &&
    (String(n.props.className || "").includes("pd-btn") || String(n.props.className || "").includes("pd-iconBtn")));
  check("工具行控件不超过 4 个", rowButtons.length <= 4, rowButtons.length);

  // 「上下文」已从工具行移除（只在设置面板里）
  check("工具行不再有上下文开关", !nodes.some((n) => n.type === "button" && String(n.props.className || "").includes("pd-toggle")));
  check("工具行不再渲染预览浮层", !nodes.some((n) => String(n.props.className || "").includes("pd-preview")));

  // 设置按钮在最左：工具行的第一个控件必须是设置齿轮，下拉框在其右侧
  check("工具行第一个控件是设置按钮", rowButtons.length > 0 && rowButtons[0].props.title === "提示词助手设置",
    rowButtons.map((n) => n.props.title || String(n.props.className)));
  const styleTriggerIdx = rowButtons.findIndex((n) => walk(n).some((x) => String(x.props.className || "").includes("pd-label") && String(x.children[0]) === "更简洁"));
  check("风格下拉位于设置按钮右侧", styleTriggerIdx > 0, styleTriggerIdx);
  check("设置按钮只有一个", rowButtons.filter((n) => n.props.title === "提示词助手设置").length === 1,
    rowButtons.filter((n) => n.props.title === "提示词助手设置").length);

  const gear = nodes.find((n) => n.type === "button" && String(n.props.className || "").includes("pd-iconBtn"));
  if (gear) gear.props.onClick();
  const panelNodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  check("设置面板仍保留上下文开关", panelNodes.some((n) => n.type === "button" && String(n.props.className || "").includes("pd-toggle")));

  const tabs = panelNodes.filter((n) => n.type === "button" && String(n.props.className || "").includes("pd-tab"));
  const tabTexts = tabs.map((t) => t.children[0]);
  check("标签页文案无数量后缀", tabTexts.every((t) => typeof t === "string" && !/\s\d+$/.test(t)), tabTexts);
  check("三个标签页仍在", tabTexts.join(",") === "常规,模板,风格", tabTexts);
  check("不再有重复的「收起」按钮", !panelNodes.some((n) => (n.children || []).includes("收起")));
  const closeBtn = panelNodes.find((n) => n.type === "button" && n.props.title === "关闭");
  if (closeBtn) closeBtn.props.onClick();
}

console.log("\n[6] 改写状态与撤销共用同一槽位");
{
  const { props, state } = makeWiredProps("原始草稿");
  currentFetch = sseFetch([
    'event: meta\ndata: {"requestId":"r1"}\n\n',
    'event: delta\ndata: {"text":"新"}\n\n',
    'event: delta\ndata: {"text":"草稿文本"}\n\n',
    'event: done\ndata: {"text":"新草稿文本"}\n\n',
  ]);

  const btn = walk(renderComponent(registered.component, props))
    .find((n) => n.type === "button" && String(n.props.className || "").includes("pd-btnPrimary"));
  check("找到改写按钮", !!btn);
  if (btn) btn.props.onClick();

  // 同步观察 busy 态（fetch 的微任务此时尚未结算）
  let nodes = walk(renderComponent(registered.component, props));
  const status = nodes.find((n) => String(n.props.className || "").includes("pd-status"));
  check("改写中：槽位显示状态文字", !!status && status.children[0] === "改写中…", status && status.children);
  check("改写中：改写按钮变为取消（中性色，非 danger）",
    nodes.some((n) => String(n.props.className || "").includes("pd-btnQuiet")) &&
    !nodes.some((n) => String(n.props.className || "").includes("pd-btnDanger")));
  check("改写中：不渲染浮层", !nodes.some((n) => String(n.props.className || "").includes("pd-preview")));

  // 等待流完成：writeDraft 会轮询校验，需要在轮询窗口内反复渲染以刷新 draft ref
  for (let i = 0; i < 10; i++) {
    await tick(40);
    renderComponent(registered.component, props);
  }

  nodes = walk(renderComponent(registered.component, props));
  const undoBtn = nodes.find((n) => n.type === "button" && n.props.title === "还原为改写前的原文");
  check("完成后：同一槽位变为 ↩ 撤销", !!undoBtn, nodes.map((n) => n.props.title).filter(Boolean));
  check("完成后：模型文本已回填", state.draft === "新草稿文本", state.draft);
  check("完成后：不再显示「改写中…」", !nodes.some((n) => String(n.props.className || "").includes("pd-status")));
  currentFetch = () => Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false }) });
}

console.log("\n[7] 二级菜单（风格 / 模板）与设置面板同序");
{
  const nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const styleBtn = nodes.find((n) => n.type === "button" &&
    walk(n).some((x) => String(x.props.className || "").includes("pd-label") && String(x.children[0]) === "更简洁"));
  check("找到合并后的菜单触发器（显示当前风格名）", !!styleBtn);
  if (styleBtn) styleBtn.props.onClick();

  let menuNodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const topNames = menuNodes.filter((n) => String(n.props.className || "").includes("pd-optionName")).map((n) => n.children[0]);
  check("一级菜单为分类入口", topNames.join(",") === "风格", topNames);
  check("一级菜单有子级箭头", menuNodes.filter((n) => String(n.props.className || "").includes("pd-optionSub")).length === 1);

  // 菜单宽度必须由内容决定，不能跟随触发按钮宽度（在菜单打开时检查）
  const menu = menuNodes.find((n) => String(n.props.className || "").includes("pd-menu"));
  check("菜单用 right 右对齐（不再用 left + minWidth 跟随按钮宽度）",
    !!menu && menu.props.style.right !== undefined && menu.props.style.left === undefined && menu.props.style.minWidth === undefined,
    menu && menu.props.style);
  check("菜单宽度上限不超过 320px", !!menu && menu.props.style.maxWidth <= 320, menu && menu.props.style.maxWidth);
  check("选项文本带 title，可读完整内容",
    menuNodes.filter((n) => String(n.props.className || "").includes("pd-optionName")).every((n) => typeof n.props.title === "string" && n.props.title.length > 0));

  // 悬停分类 → 右侧树形展开子级（父级保留，不替换）
  const styleEntry = menuNodes.find((n) => String(n.props.className || "").includes("pd-optionSub"));
  check("找到「风格」分类入口", !!styleEntry);
  const hoverEvent = { currentTarget: { getBoundingClientRect: () => ({ top: 320, left: 100, right: 220, width: 120, height: 34 }) } };
  if (styleEntry) styleEntry.props.onMouseEnter(hoverEvent);

  menuNodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const panels = menuNodes.filter((n) => String(n.props.className || "").includes("pd-menu"));
  check("展开后同时存在父级与子级两个面板", panels.length === 2, panels.length);
  const allNames = menuNodes.filter((n) => String(n.props.className || "").includes("pd-optionName")).map((n) => n.children[0]);
  check("父级仍在（未被替换）且子级列出全部风格",
    allNames.join(",") === "风格,更简洁,更详细,结构化,译成英文,自定义", allNames);
  check("子级面板在父级右侧展开",
    panels.length === 2 && panels[1].props.style.left !== undefined,
    panels[1] && panels[1].props.style);
  check("子级以父级底边为基准向上生长（用 bottom，不用 top）",
    panels.length === 2 && panels[1].props.style.bottom !== undefined && panels[1].props.style.top === undefined,
    panels[1] && panels[1].props.style);
  check("子级高度受向上可用空间约束",
    panels.length === 2 && typeof panels[1].props.style.maxHeight === "number" && panels[1].props.style.maxHeight > 0,
    panels[1] && panels[1].props.style.maxHeight);

  // 选中态：底色 + 阴影描边，且不再有 ✓ 列
  const selected = menuNodes.filter((n) => String(n.props.className || "").includes("pd-optionOn"));
  check("子级中当前风格使用选中态", selected.length === 1 && walk(selected[0]).some((x) => String(x.children[0]) === "更简洁"), selected.length);
  check("菜单不再渲染 ✓ 列", !menuNodes.some((n) => String(n.props.className || "").includes("pd-check")));

  // 点选子级条目 → 风格切换（触发器文案随之变化）
  const detailedRow = menuNodes.find((n) => String(n.props.className || "").includes("pd-option") && walk(n).some((x) => String(x.children[0]) === "更详细"));
  const pickEv = { preventDefault() {}, stopPropagation() {}, nativeEvent: { stopPropagation() {} } };
  if (detailedRow) detailedRow.props.onMouseDown(pickEv);
  const afterPick = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const triggerLabel = afterPick.map((n) => String(n.props.className || "").includes("pd-label") && n.children[0]).filter(Boolean);
  check("选择后触发器显示新风格", triggerLabel.includes("更详细"), triggerLabel);

  // 面板最小宽度必须贴近内容（3–4 字标签约 84px），否则短标签菜单会被撑宽
  const minWidthMatch = src.match(/min-width:(\d+)px;max-width:min\(320px/);
  check("菜单 min-width 已收敛到贴近内容的尺寸", !!minWidthMatch && Number(minWidthMatch[1]) <= 100, minWidthMatch && minWidthMatch[1]);

  // 箭头用官方风格的 svg chevron
  const chevrons = menuNodes.filter((n) => String(n.props.className || "").includes("pd-chevron"));
  check("下拉箭头是 svg（非字体符号）", chevrons.length > 0 && chevrons.every((n) => n.type === "svg"), chevrons.map((n) => n.type));

  if (styleBtn) styleBtn.props.onClick(); // 收起菜单
}

console.log("\n[8] 浮层材质（背景模糊）与层级");
{
  const desc = (node, out = []) => {
    if (Array.isArray(node)) { node.forEach((n) => desc(n, out)); return out; }
    if (!node || typeof node !== "object" || !node.$$el) return out;
    if (typeof node.type === "function") { desc(renderComponent(node.type, node.props), out); return out; }
    out.push(node);
    (node.children || []).forEach((c) => desc(c, out));
    return out;
  };

  let nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const gear = nodes.find((n) => n.type === "button" && String(n.props.className || "").includes("pd-iconBtn"));
  if (gear) gear.props.onClick();

  nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const pop = nodes.find((n) => String(n.props.className || "").includes("pd-pop"));
  check("设置面板声明官方菜单材质", !!pop && pop.props["data-menu-material"] === "translucent", pop && pop.props["data-menu-material"]);

  // 打开模型下拉，检查它与面板是兄弟而非后代
  const modelTrigger = nodes.find((n) => n.type === "button" &&
    walk(n).some((x) => String(x.props.className || "").includes("pd-label") && String(x.children[0]) === "跟随全局默认"));
  check("找到模型下拉触发器", !!modelTrigger);
  if (modelTrigger) modelTrigger.props.onClick();

  const nodes2 = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const pop2 = nodes2.find((n) => String(n.props.className || "").includes("pd-pop"));
  const menu2 = nodes2.find((n) => String(n.props.className || "").includes("pd-menu"));
  check("下拉框声明官方菜单材质", !!menu2 && menu2.props["data-menu-material"] === "translucent", menu2 && menu2.props["data-menu-material"]);
  check("下拉渲染在设置面板之外（不被 filter 包含块困住）",
    !!pop2 && !!menu2 && !desc(pop2).includes(menu2));
  // 两个浮层必须用的是同一份材质配方（直接查源码里的 CSS 声明，避免同义反复）
  const surfaceFill = (src.match(/background:var\(--dsw-specific-menu/g) || []).length;
  const backdrop = (src.match(/backdrop-filter:var\(--dsw-menu-backdrop-filter/g) || []).length;
  check("两个浮层共用同一份材质配方（填充 + backdrop-filter 各 2 处）",
    surfaceFill >= 2 && backdrop >= 2, { surfaceFill, backdrop });

  // 没有输入框锚点时回退到视口中轴
  const originalQS = sandbox.document.querySelector;
  sandbox.document.querySelector = () => ({});
  const nodes3 = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const pop3 = nodes3.find((n) => String(n.props.className || "").includes("pd-pop"));
  const W3 = Math.min(440, Math.max(280, sandbox.window.innerWidth - 32));
  check("缺少输入框锚点时回退视口中轴",
    !!pop3 && pop3.props.style.left === Math.max(8, Math.round((sandbox.window.innerWidth - W3) / 2)),
    pop3 && pop3.props.style.left);
  sandbox.document.querySelector = originalQS;

  // 复原：关下拉、关面板
  if (modelTrigger) modelTrigger.props.onClick();
  const closeBtn = nodes2.find((n) => n.type === "button" && n.props.title === "关闭");
  if (closeBtn) closeBtn.props.onClick();
}

console.log("\n[9] 配色令牌与说明文案");
{
  // 主操作色必须用官方 accent 令牌（随浅/深色切换）
  check("主操作使用官方 accent 令牌", src.includes("--dsw-alias-button-info-fill"), true);
  check("不再使用 danger 红作为取消色", !src.includes("pd-btnDanger"), src.includes("pd-btnDanger"));
  check("状态/取消/撤销同为中性色系",
    src.includes("pd-status{") && src.includes("pd-btnQuiet"));

  // 常规页说明只描述功能，不解释原因
  let nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const gear = nodes.find((n) => n.type === "button" && String(n.props.className || "").includes("pd-iconBtn"));
  if (gear) gear.props.onClick();
  nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const helps = nodes.filter((n) => String(n.props.className || "").includes("pd-help"))
    .map((n) => String(n.children[0] || ""));
  const rationale = ["用于消解", "同源", "时生效", "则使用内置"];
  check("常规页说明不含“为什么”式表述", !helps.some((t) => rationale.some((r) => t.includes(r))), helps);
  check("常规页说明覆盖三项设置",
    helps.some((t) => t.includes("选择改写使用的模型")) &&
    helps.some((t) => t.includes("改写时附带最近对话")) &&
    helps.some((t) => t.includes("附带最近 N 轮")), helps);

  // 「自定义改写指令」已从常规页移除（改由「风格」页的「自定义」行维护）
  check("常规页不再有自定义改写指令输入框",
    !nodes.some((n) => String(n.props.className || "").includes("pd-textarea")),
    nodes.filter((n) => String(n.props.className || "").includes("pd-textarea")).length);
  check("常规页不再出现该字段标题",
    !nodes.some((n) => (n.children || []).includes("自定义改写指令")));

  // 模板/风格折叠行：用官方 svg chevron，收起 -90deg、展开 none
  check("折叠指示器不再使用文字字符 ▶", !src.includes('"▶"'));
  check("折叠指示器使用 IconChevron", src.includes("h(IconChevron, { style:"));
  check("折叠旋转与官方一致（收起 -90deg）", src.includes("rotate(-90deg)"));

  const closeBtn = nodes.find((n) => n.type === "button" && n.props.title === "关闭");
  if (closeBtn) closeBtn.props.onClick();
}

console.log("\n[10] 打开配置文件");
{
  let nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const gear = nodes.find((n) => n.type === "button" && String(n.props.className || "").includes("pd-iconBtn"));
  if (gear) gear.props.onClick();
  nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));

  const openBtn = nodes.find((n) => n.type === "button" && n.props.title === "打开配置文件");
  check("设置面板有「打开配置文件」按钮", !!openBtn);
  check("该按钮使用图标（svg）", !!openBtn && walk(openBtn).some((n) => n.type === "svg"));

  // 未取到路径时给出占位说明，而不是空白
  const helps = nodes.filter((n) => String(n.props.className || "").includes("pd-help")).map((n) => String(n.children[0] || ""));
  check("常规页显示配置文件位置（无路径时给出占位）", helps.some((t) => t.startsWith("配置文件：")), helps.filter((t) => t.startsWith("配置文件：")));

  // 点击后应 POST 到 open-config
  const calls = [];
  const prevFetch = currentFetch;
  currentFetch = (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || "GET" });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  };
  if (openBtn) openBtn.props.onClick();
  await tick(20);
  currentFetch = prevFetch;

  check("点击后请求 open-config 接口",
    calls.some((c) => String(c.url).includes("/api/prompt-dock/open-config") && c.method === "POST"),
    calls);

  // 404（宿主未重启、路由未注册）要给出可操作的提示，而不是笼统报错
  currentFetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error("not json")) });
  if (openBtn) openBtn.props.onClick();
  await tick(20);
  currentFetch = prevFetch;
  const errNodes = walk(renderComponent(registered.component, makeProps("正常草稿")))
    .filter((n) => String(n.props.className || "").includes("pd-err"))
    .map((n) => String(n.children[0] || ""));
  check("接口缺失时提示需重启宿主", errNodes.some((t) => t.includes("重启")), errNodes);

  // 宿主返回具体错误时原样展示
  currentFetch = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ ok: false, error: { code: "OPEN_FAILED", message: "spawn explorer.exe ENOENT" } }) });
  if (openBtn) openBtn.props.onClick();
  await tick(20);
  currentFetch = prevFetch;
  const errNodes2 = walk(renderComponent(registered.component, makeProps("正常草稿")))
    .filter((n) => String(n.props.className || "").includes("pd-err"))
    .map((n) => String(n.children[0] || ""));
  check("宿主错误信息原样透出", errNodes2.some((t) => t.includes("ENOENT")), errNodes2);

  const closeBtn = nodes.find((n) => n.type === "button" && n.props.title === "关闭");
  if (closeBtn) closeBtn.props.onClick();
}

console.log("\n[11] 模型选择持久化（端到端）");
{
  // 真实 React 在卸载时会丢弃组件状态；桩环境不会，这里显式重置，避免继承前面的菜单/标签页状态
  hookStore.clear();
  ranEffects.clear();
  const prevFetch = currentFetch;
  const posts = [];
  const calls = [];
  const saved = {
    ok: true, settingsPath: "C:/x/settings.json",
    styles: [{ id: "concise", name: "更简洁" }, { id: "detailed", name: "更详细" }],
    templates: [], customInstruction: "", contextEnabled: true, contextTurns: 6, rewriteModel: null,
  };
  currentFetch = (url, opts) => {
    const u = String(url);
    calls.push(u);
    const method = (opts && opts.method) || "GET";
    if (u.includes("/api/prompt-dock/models")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        ok: true,
        groups: [{ id: "p1", name: "P1", models: [{ id: "m1", name: "M1" }] }],
        global: { provider: "p1", model: "m1" },
      }) });
    }
    if (u.includes("/api/prompt-dock/config")) {
      if (method === "POST") {
        let body = {};
        try { body = JSON.parse(opts.body || "{}"); } catch (e) {}
        posts.push(body);
        if ("rewriteModel" in body) saved.rewriteModel = body.rewriteModel;
        return Promise.resolve({ ok: true, json: () => Promise.resolve(Object.assign({}, saved)) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(Object.assign({}, saved)) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  };

  // 打开 effect 执行：ensureConf / reloadConf / ensureModels 才会真的跑
  runEffectsEnabled = true;
  renderComponent(registered.component, makeProps("正常草稿"));
  await tick(20);

  let nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const gear = nodes.find((n) => n.type === "button" && String(n.props.className || "").includes("pd-iconBtn"));
  if (gear) gear.props.onClick();
  // 先挂载面板（此时才触发 ensureModels/reloadConf），再等一拍让请求落地
  nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  await tick(20);
  nodes = walk(renderComponent(registered.component, makeProps("正常草稿")));

  const modelTrigger = nodes.find((n) => n.type === "button" &&
    walk(n).some((x) => String(x.props.className || "").includes("pd-label") && String(x.children[0]) === "跟随全局默认"));
  check("模型下拉可用", !!modelTrigger);
  check("已请求模型目录", calls.some((u) => u.includes("/api/prompt-dock/models")), calls);
  if (modelTrigger) modelTrigger.props.onClick();

  const panelNodes = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const optionLabels = panelNodes.filter((n) => String(n.props.className || "").includes("pd-optionName")).map((n) => n.children[0]);
  check("下拉里列出模型选项", optionLabels.some((t) => String(t).includes("M1")), optionLabels);

  const pickEv = { preventDefault() {}, stopPropagation() {}, nativeEvent: { stopPropagation() {} } };
  const m1Row = panelNodes.find((n) => String(n.props.className || "").includes("pd-option") &&
    walk(n).some((x) => String(x.props.className || "").includes("pd-optionName") && String(x.children[0]).includes("M1")));
  if (m1Row) m1Row.props.onMouseDown(pickEv);
  await tick(20);

  const modelPost = posts.filter((p) => p && p.rewriteModel).pop();
  check("点选后发出保存请求", !!modelPost, posts.length);
  check("保存内容为所选模型",
    !!modelPost && modelPost.rewriteModel.provider === "p1" && modelPost.rewriteModel.model === "m1",
    modelPost && modelPost.rewriteModel);

  // 重开面板：标签应显示上次选择，而不是默认
  const closeBtn = walk(renderComponent(registered.component, makeProps("正常草稿"))).find((n) => n.type === "button" && n.props.title === "关闭");
  if (closeBtn) closeBtn.props.onClick();
  renderComponent(registered.component, makeProps("正常草稿"));
  const gear2 = walk(renderComponent(registered.component, makeProps("正常草稿"))).find((n) => n.type === "button" && String(n.props.className || "").includes("pd-iconBtn"));
  if (gear2) gear2.props.onClick();
  const reopened = walk(renderComponent(registered.component, makeProps("正常草稿")));
  const labels = reopened.filter((n) => String(n.props.className || "").includes("pd-label")).map((n) => n.children[0]);
  check("重开后显示上次选择的模型", labels.includes("M1"), labels);

  runEffectsEnabled = false;
  currentFetch = prevFetch;
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
