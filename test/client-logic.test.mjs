/**
 * 临时验证脚本 v4（不随插件发布）：直接对 lib/client.js 的真实源码跑断言。
 * 按函数名切出源码在 vm 中执行，确保测的就是发布的那份代码。
 *
 * 覆盖：InputState 读取、芯片检测、六类错误分类与文案、长度提示、快捷键解析/匹配、
 * 三级降级、SSE 解析、CSS 令牌（无硬编码颜色）与尺寸规范。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`未找到函数 ${name}`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`函数 ${name} 花括号不闭合`);
}

// 取出一个 `var NAME = {...};` 形式的对象字面量声明
function extractVarLiteral(name) {
  const start = src.indexOf(`var ${name} = {`);
  if (start < 0) throw new Error(`未找到变量 ${name}`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1) + ";";
    }
  }
  throw new Error(`变量 ${name} 花括号不闭合`);
}

// 取出 `var NAME = <number>;` 形式的标量声明
function extractVarScalar(name) {
  const re = new RegExp(`var ${name} = ([-0-9.]+);`);
  const m = src.match(re);
  if (!m) throw new Error(`未找到标量变量 ${name}`);
  return m[0];
}

// CSS_TEXT 是字符串数组 join 出来的：按行还原，测试的就是发布的那份 CSS
function extractCssText() {
  const start = src.indexOf("var CSS_TEXT = [");
  const end = src.indexOf('].join("\\n")', start);
  if (start < 0 || end < 0) throw new Error("未找到 CSS_TEXT");
  const body = src.slice(start + "var CSS_TEXT = [".length, end);
  const lines = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(body)) !== null) lines.push(JSON.parse(`"${m[1]}"`));
  return lines.join("\n");
}
const CSS_TEXT = extractCssText();

const phStart = src.indexOf("var REFERENCE_PLACEHOLDER_RE");
const phSrc = src.slice(phStart, src.indexOf(";", phStart) + 1);

const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  extractVarLiteral("PHASE") + extractVarLiteral("ERROR_CLASS") +
    extractVarLiteral("ERROR_COPY") + extractVarLiteral("ERROR_ACTION") +
    extractVarScalar("LENGTH_MIN") + extractVarScalar("TOAST_MAX") +    phSrc +
    extract("shortReason") + extract("errorCopy") + extract("classifyError") + extract("errorFeedback") +
    extract("lengthHint") + extract("parseShortcut") + extract("shortcutLabel") +
    extract("isEditableTarget") + extract("matchShortcut") + extract("chipFromState") +
    extract("collectChipFragments") + extract("detectChip") + extract("pickDraftText") +
    extract("computeLevel") +
    "; this.__api = { PHASE, ERROR_CLASS, ERROR_COPY, ERROR_ACTION, shortReason, errorCopy, classifyError," +
    " errorFeedback, lengthHint, parseShortcut, shortcutLabel, isEditableTarget, matchShortcut," +
    " chipFromState, collectChipFragments, detectChip, pickDraftText, computeLevel };",
  ctx
);
const {
  PHASE, ERROR_CLASS, ERROR_COPY, ERROR_ACTION, shortReason, errorCopy, classifyError, errorFeedback,
  lengthHint, parseShortcut, shortcutLabel, isEditableTarget, matchShortcut,
  chipFromState, collectChipFragments, detectChip, pickDraftText, computeLevel,
} = ctx.__api;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail !== undefined ? "  -> " + JSON.stringify(detail) : ""}`); }
}

console.log("\n[0] InputState 读取（对齐宿主 compose() 实际发布形状）");
const realState = {
  draft: "请把 @src/a.ts 的日志时间戳换成下拉",
  draftRev: 7,
  phase: "idle",
  occurrences: [{ source: "file", ref: "src/a.ts", offset: 9, length: 10, label: "@src/a.ts", clipboardText: "@src/a.ts" }],
};
check("从真实形状取出 draft 文本", pickDraftText(realState) === realState.draft, pickDraftText(realState));
check("草稿快照对象也能取 text", pickDraftText({ draft: { text: "abc", references: [] } }) === "abc");
check("无草稿字段返回空串", pickDraftText({}) === "");

console.log("\n[1] 芯片检测：occurrences 主路径");
check("occurrences 非空 → 命中 label", chipFromState(realState) === "@src/a.ts", chipFromState(realState));
check("无 label 回退 clipboardText", chipFromState({ occurrences: [{ clipboardText: "@b.ts" }] }) === "@b.ts");
check("occurrences 为空 → 不命中", chipFromState({ occurrences: [], draft: "普通草稿" }) === "");
check("命令芯片 command.token 命中", chipFromState({ command: { token: "/compact" } }) === "/compact");
check("草稿快照 references 兜底命中", chipFromState({ draft: { references: [{ label: "@c.ts" }] } }) === "@c.ts");
check("草稿文本含 U+FFFC → 命中", chipFromState({ text: "看看 \uFFFC 这段" }) === "引用芯片");
check("草稿文本含私有区字符 → 命中", chipFromState({ text: "x\uE100y" }) === "引用芯片");
check("真实无芯片状态 → 不命中", chipFromState({ draft: "写个周报", occurrences: [], draftRev: 1 }) === "");

console.log("\n[2] 端到端：真实状态 → 改写按钮禁用判定");
check("含 occurrence 的真实状态 → 检测命中", detectChip(realState.draft, [], realState) === "@src/a.ts");
check("普通文本状态 → 不命中", detectChip("写个周报", [], { draft: "写个周报", occurrences: [] }) === "");
check("props.chips 片段命中", detectChip("看看 @src/a.ts 这段", collectChipFragments({ chips: [{ text: "@src/a.ts" }] })) === "@src/a.ts");
check("@路径 文本兜底", detectChip("请读 @src/index.ts 然后总结", []) === "@src/index.ts");
check("行首 /命令 兜底", detectChip("/compact 一下", []) === "/compact");
check("普通 @提及 不误判", detectChip("问一下 @alice 的意见", []) === "");
check("普通中文 不误判", detectChip("把日志时间戳换成下拉", []) === "");
check("行中斜杠 不误判", detectChip("路径是 a/b 这样", []) === "");
check("空草稿安全", detectChip("", []) === "");

console.log("\n[3] 六态反馈机");
check("恰好 6 个状态", Object.keys(PHASE).length === 6, Object.keys(PHASE));
check("状态名与设计一致",
  ["idle", "requesting", "streaming", "success", "error", "cancelled"].every((p) => Object.values(PHASE).includes(p)),
  Object.values(PHASE));
check("恰好 6 类错误", Object.keys(ERROR_CLASS).length === 6, Object.keys(ERROR_CLASS));
check("错误类枚举正确",
  Object.values(ERROR_CLASS).join(",") === "network,timeout,auth,model,empty,cancelled", Object.values(ERROR_CLASS));

console.log("\n[4] 六类错误文案（用户话术，不露原始错误）");
check("network 文案", errorCopy("network") === "连接失败，请检查网络后重试", errorCopy("network"));
check("timeout 文案带秒数", errorCopy("timeout", { seconds: 90 }) === "改写超时（90 秒），可重试或缩短草稿",
  errorCopy("timeout", { seconds: 90 }));
check("timeout 默认 90 秒", errorCopy("timeout", {}) === "改写超时（90 秒），可重试或缩短草稿");
check("auth 文案指向设置", errorCopy("auth") === "改写模型未配置或凭据失效，请到设置中检查");
check("model 文案带简短原因", errorCopy("model", { reason: "rate limited" }) === "模型未能完成改写：rate limited",
  errorCopy("model", { reason: "rate limited" }));
check("empty 文案", errorCopy("empty") === "未获得有效改写结果");
check("cancelled 文案", errorCopy("cancelled") === "已取消改写");
for (const [cls, want] of Object.entries(ERROR_COPY)) {
  check(`文案里没有原始错误码/堆栈样内容（${cls}）`, !/Error:|at \w+\(|ENOENT|TypeError/.test(want), want);
}

console.log("\n[5] 错误分类映射");
const cases = [
  ["NO_MODEL", "auth"], ["NO_LLM", "auth"], ["AUTH", "auth"], ["AUTH_FORBIDDEN", "auth"],
  ["QUOTA", "auth"], ["NO_INSTRUCTION", "auth"],
  ["TIMEOUT", "timeout"],
  ["EMPTY_REPLY", "empty"], ["EMPTY_TEXT", "empty"],
  ["NETWORK", "network"], ["FETCH_FAILED", "network"],
  ["LLM_FAILED", "model"], ["INTERNAL", "model"], ["RATE_LIMIT", "model"], ["CONTEXT_WINDOW", "model"],
];
for (const [code, want] of cases) {
  check(`错误码 ${code} → ${want}`, classifyError({ code }) === want, classifyError({ code }));
}
check("未知码归 model 类", classifyError({ code: "WHATEVER" }) === "model");
check("空错误归 model 类", classifyError(null) === "model");
check("模型原因被截短到 ≤41 字", shortReason("x".repeat(200)).length <= 41, shortReason("x".repeat(200)).length);
check("模型原因去掉换行", shortReason("a\nb") === "a b", shortReason("a\nb"));
check("模型原因去掉英文前缀", shortReason("Error: boom") === "boom", shortReason("Error: boom"));
check("空原因有兜底", shortReason("") === "上游返回错误");

console.log("\n[6] 错误动作");
check("auth → 打开设置", ERROR_ACTION.auth === "openSettings");
check("network/timeout/model/empty → 重试",
  ["network", "timeout", "model", "empty"].every((c) => ERROR_ACTION[c] === "retry"), ERROR_ACTION);
check("cancelled → 无动作（只出 Toast）", ERROR_ACTION.cancelled === "none");
const fb = errorFeedback({ code: "TIMEOUT", seconds: 90 });
check("errorFeedback 组合出文案+动作+可重试",
  fb.cls === "timeout" && fb.action === "retry" && fb.retryable === true &&
  fb.text === "改写超时（90 秒），可重试或缩短草稿", fb);
const fbAuth = errorFeedback({ code: "NO_MODEL" });
check("auth 反馈不可重试、动作是打开设置",
  fbAuth.cls === "auth" && fbAuth.action === "openSettings" && fbAuth.retryable === false, fbAuth);

console.log("\n[7] 长度提示（琥珀提示，不截断）");
check("少于 80 字提示偏短", /^结果偏短（40 字）/.test(lengthHint(40, 0)), lengthHint(40, 0));
check("超过 1.2 倍上限提示偏长", /^结果偏长（130 字）/.test(lengthHint(130, 100)), lengthHint(130, 100));
check("刚好 1.2 倍不提示", lengthHint(120, 100) === "", lengthHint(120, 100));
check("80 字不提示偏短", lengthHint(80, 0) === "", lengthHint(80, 0));
check("正常长度无提示", lengthHint(100, 100) === "", lengthHint(100, 100));
check("无结果不提示", lengthHint(0, 100) === "", lengthHint(0, 100));

console.log("\n[8] 快捷键");
check("解析 Alt+M", JSON.stringify(parseShortcut("Alt+M")) === JSON.stringify({ alt: true, ctrl: false, shift: false, meta: false, key: "M" }),
  parseShortcut("Alt+M"));
check("解析 Ctrl+Shift+K", parseShortcut("Ctrl+Shift+K").ctrl && parseShortcut("Ctrl+Shift+K").shift);
check("展示为 Alt+M", shortcutLabel("Alt+M") === "Alt+M", shortcutLabel("Alt+M"));
check("展示为 Ctrl+K", shortcutLabel("ctrl+k") === "Ctrl+K", shortcutLabel("ctrl+k"));
const sc = { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" };
check("Alt+M → openStyle", matchShortcut({ key: "m", altKey: true }, sc) === "openStyle");
check("大写 M 也命中", matchShortcut({ key: "M", altKey: true }, sc) === "openStyle");
check("Alt+T → openTemplate", matchShortcut({ key: "t", altKey: true }, sc) === "openTemplate");
check("Alt+R → rewrite", matchShortcut({ key: "r", altKey: true }, sc) === "rewrite");
check("无 Alt 不触发", matchShortcut({ key: "m", altKey: false }, sc) === "");
check("Ctrl 组合让给浏览器", matchShortcut({ key: "m", altKey: true, ctrlKey: true }, sc) === "");
check("Cmd 组合让给浏览器", matchShortcut({ key: "m", altKey: true, metaKey: true }, sc) === "");
check("额外 Shift 不命中", matchShortcut({ key: "m", altKey: true, shiftKey: true }, sc) === "");
check("输入法组合中不触发", matchShortcut({ key: "m", altKey: true, isComposing: true }, sc) === "");
check("自定义快捷键生效", matchShortcut({ key: "j", altKey: true }, { openStyle: "Alt+J" }) === "openStyle");
check("无快捷键配置不炸", matchShortcut({ key: "m", altKey: true }, null) === "");
check("输入框内判定为可编辑目标",
  isEditableTarget({ tagName: "INPUT" }) && isEditableTarget({ tagName: "TEXTAREA" }) &&
  isEditableTarget({ tagName: "SELECT" }) && isEditableTarget({ isContentEditable: true }) &&
  isEditableTarget({ getAttribute: () => "textbox" }));
check("普通容器不算输入框", !isEditableTarget({ tagName: "DIV" }) && !isEditableTarget(null));
// 输入框内只忽略「纯字符键」；带修饰键的组合必须放行，否则 composer 里快捷键永不生效
check("源码在 keydown 里判断输入框（且只忽略纯字符键）",
  src.includes("isEditableTarget(t) && !isShortcutChord(e)"));

console.log("\n[9] 三级降级");
const cfg = (over) => Object.assign({ toolbar: { showStyleEntry: "auto", showTemplateEntry: "auto", compactThreshold: 320 } }, over || {});
check("宽 600 → L0", computeLevel(600, cfg()).level === 0);
check("300 → L1 紧凑", computeLevel(300, cfg()).level === 1 && computeLevel(300, cfg()).compact === true);
check("200 → L2 合并", computeLevel(200, cfg()).level === 2);
check("阈值边界 320 → L1", computeLevel(320, cfg()).level === 1);
check("阈值边界 319 → L1", computeLevel(319, cfg()).level === 1);
check("阈值 75% 以下 → L2", computeLevel(239, cfg()).level === 2);
check("showStyleEntry=never → L2", computeLevel(600, cfg({ toolbar: { showStyleEntry: "never", showTemplateEntry: "auto", compactThreshold: 320 } })).level === 2);
check("showTemplateEntry=never → L2", computeLevel(600, cfg({ toolbar: { showStyleEntry: "auto", showTemplateEntry: "never", compactThreshold: 320 } })).level === 2);
check("自定义阈值生效", computeLevel(400, cfg({ toolbar: { showStyleEntry: "auto", showTemplateEntry: "auto", compactThreshold: 500 } })).level === 1);
check("宽度未知时不降级", computeLevel(0, cfg()).level === 0);

console.log("\n[10] SSE 解析（同客户端 pump/handleEvent 规则）");
function parseSse(body) {
  const out = [];
  let buf = body, idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    let event = "message", data = "";
    for (const line of raw.split("\n")) {
      if (line.indexOf("event:") === 0) event = line.slice(6).trim();
      else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
    }
    if (data) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}
const sample =
  'event: meta\ndata: {"requestId":"r1","draftChars":4,"timeoutMs":90000}\n\n' +
  'event: delta\ndata: {"text":"你"}\n\n' +
  'event: delta\ndata: {"text":"好"}\n\n' +
  'event: done\ndata: {"text":"你好"}\n\n';
const evs = parseSse(sample);
check("解析出 4 个事件", evs.length === 4, evs.length);
check("顺序正确", evs.map((e) => e.event).join(",") === "meta,delta,delta,done");
check("delta 拼接等于 done 全文", evs.filter((e) => e.event === "delta").map((e) => e.data.text).join("") === evs[3].data.text);
check("meta 带 draftChars 与 timeoutMs", evs[0].data.draftChars === 4 && evs[0].data.timeoutMs === 90000, evs[0].data);
const partial = parseSse('event: delta\ndata: {"text":"a"}\n\nevent: del');
check("半包帧不崩且只消费完整帧", partial.length === 1 && partial[0].data.text === "a", partial);

console.log("\n[11] CSS 令牌与尺寸规范");
check("没有 hex 颜色", !/#[0-9a-fA-F]{3,8}\b/.test(CSS_TEXT));
check("没有 rgb()/rgba()", !/\brgba?\(/.test(CSS_TEXT));
check("没有 hsl()/hsla()", !/\bhsla?\(/.test(CSS_TEXT));
check("颜色来自官方令牌（声明数 > 40）", (CSS_TEXT.match(/var\(--dsw-alias-[a-z0-9-]+\)/g) || []).length > 40,
  (CSS_TEXT.match(/var\(--dsw-alias-[a-z0-9-]+\)/g) || []).length);
check("不使用 --dsw-alias-brand-primary（改用 state-business-primary）",
  !/--dsw-alias-brand-primary/.test(CSS_TEXT));
check("没有 backdrop-filter（弹层不透明）", !/backdrop-filter/.test(CSS_TEXT));
check("区块标题 18px/600", /\.pd-cardTitle\{font-size:18px;font-weight:600/.test(CSS_TEXT));
check("导航标题 16px/500", /\.pd-cardNav\{font-size:16px;font-weight:500/.test(CSS_TEXT));
check("分组标题 14px/500", /\.pd-groupTitle\{font-size:14px;font-weight:500/.test(CSS_TEXT));
check("正文/菜单 13px", /\.pd-option\{[^}]*font-size:13px/.test(CSS_TEXT));
check("说明/错误 12px", /\.pd-help\{font-size:12px/.test(CSS_TEXT) && /\.pd-errorBar\{[^}]*font-size:12px/.test(CSS_TEXT));
check("胶囊 11px", /\.pd-pill\{[^}]*font-size:11px/.test(CSS_TEXT));
check("区块间距 12px", /\.pd-card\{[^}]*gap:12px/.test(CSS_TEXT));
check("列表行距 10px", /\.pd-itemList\{[^}]*gap:10px/.test(CSS_TEXT));
check("卡片内边距 14×16", /\.pd-sub\{[^}]*padding:14px 16px/.test(CSS_TEXT));
check("卡片/输入框圆角 12px",
  /\.pd-sub\{[^}]*border-radius:12px/.test(CSS_TEXT) && /\.pd-search\{[^}]*border-radius:12px/.test(CSS_TEXT));
check("小按钮圆角 6px", /\.pd-btn\{[^}]*border-radius:var\(--dsw-radius-sm,6px\)/.test(CSS_TEXT));
check("胶囊全圆", /\.pd-pill\{[^}]*border-radius:999px/.test(CSS_TEXT));
check("弹层 12px 圆角 + border-l2 + bg-layer-3",
  /\.pd-popover\{[^}]*border-radius:12px[^}]*border:1px solid var\(--dsw-alias-border-l2\)/.test(CSS_TEXT) &&
  /background:var\(--dsw-alias-bg-layer-3\)/.test(CSS_TEXT));
check("菜单行 32px", /\.pd-option\{[^}]*min-height:32px/.test(CSS_TEXT));
check("显现动画 120–160ms", /animation:pd-materialize 1[2-6]0ms/.test(CSS_TEXT));
check("尊重 prefers-reduced-motion", /prefers-reduced-motion:reduce/.test(CSS_TEXT));
check("错误条 danger 10% 背景",
  /background:color-mix\(in srgb,var\(--dsw-alias-state-danger\) 10%,transparent\)/.test(CSS_TEXT));
check("长度提示用 warning 令牌", /\.pd-hint\{[^}]*var\(--dsw-alias-state-warning\)/.test(CSS_TEXT));
check("成功高亮用 success 令牌", /pd-success[^{]*\{[^}]*var\(--dsw-alias-state-success\)/.test(CSS_TEXT));
check("Toast 8px 圆角 + bg-layer-3 + border-l2 + 12px",
  /\.pd-toast\{[^}]*border-radius:8px[^}]*var\(--dsw-alias-border-l2\)[^}]*var\(--dsw-alias-bg-layer-3\)[^}]*font-size:12px/.test(CSS_TEXT));
check("流光条 2px", /\.pd-shimmer\{[^}]*height:2px/.test(CSS_TEXT));
check("焦点环 3px", /box-shadow:0 0 0 3px var\(--dsw-alias-state-business-primary\)/.test(CSS_TEXT));
// Toast 的 8px 是设计文档明确要求；其余组件不许出现 8/10px 这类中间值
// 允许的圆角取值：12（卡片/弹层/输入框）、6（小按钮）、8（Toast，设计指定）、
// 999（胶囊全圆）、4（滚动条滑块）、2（开关旋钮轨道内的细节）；不允许 10 / 14 这类中间值。
const radii = [...new Set((CSS_TEXT.match(/border-radius:(\d+)px/g) || []).map((d) => Number(d.match(/(\d+)px/)[1])))].sort((a, b) => a - b);
check("圆角取值只用 12/6/8/999（及滑块 4）",
  radii.every((r) => [4, 6, 8, 12, 999].includes(r)), radii);
check("不使用 10px / 14px 这类中间值", !radii.includes(10) && !radii.includes(14), radii);

console.log("\n[12] 源码整洁性");
check("没有 emoji 字符", !/[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/u.test(src));
check("没有「✕」「＋」文本符号按钮", !/["']✕["']|["']＋["']/.test(src));
// 只检查字符串字面量（注释里作为说明出现的符号不算 UI 使用）
const stringLiterals = src.match(/"(?:[^"\\\n]|\\.)*"/g) || [];
check("字符串字面量里没有 ⚙ / ▶ / ✓ 文本符号",
  !stringLiterals.some((lit) => /[⚙▶✓]/.test(lit)), stringLiterals.filter((l) => /[⚙▶✓]/.test(l)));
check("只 require react",
  (src.match(/require\(\s*["'][^"']+["']\s*\)/g) || []).every((m) => /require\(\s*["']react["']\s*\)/.test(m)),
  (src.match(/require\(\s*["'][^"']+["']\s*\)/g) || []));
check("使用官方 sparkle 图标", src.includes("function IconSparkle"));
check("不再有 customInstruction 字段", !/customInstruction/.test(src));
check("不再有 SettingsPop / IconSliders", !/function SettingsPop|function IconSliders|IconSliders/.test(src));
check("不再有 settings.plugin.item / settings.register",
  !/settings\.plugin\.item|settings\.register|installSection|settingsScope/.test(src));
check("声明了 plugins.bundle.config 座位", src.includes('"plugins.bundle.config"'));
check("配置座位 key 为包名", /PKG_NAME = "dsh-prompt-dock"/.test(src) && /key: PKG_NAME/.test(src));
check("设置只经 HTTP 路由保存（不依赖 form.mutate）",
  src.includes("/config") &&
  !stringLiterals.some((lit) => /form\.(?:mutate|state)/.test(lit)),
  stringLiterals.filter((l) => /form\./.test(l)));

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
