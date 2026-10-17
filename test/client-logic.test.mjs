/**
 * 临时验证脚本 v3（不随插件发布）：直接对 lib/client.js 的真实源码跑断言。
 * 按函数名切出源码在 vm 中执行，确保测的就是发布的那份代码。
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

const errorTextStart = src.indexOf("var ERROR_TEXT");
const errorTextSrc = src.slice(errorTextStart, src.indexOf("}", src.indexOf("INTERNAL:")) + 1) + ";";
const phStart = src.indexOf("var REFERENCE_PLACEHOLDER_RE");
const phSrc = src.slice(phStart, src.indexOf(";", phStart) + 1);

const ctx = {};
vm.createContext(ctx);
vm.runInContext(
  errorTextSrc + phSrc +
    extract("errorText") + extract("chipFromState") + extract("collectChipFragments") +
    extract("detectChip") + extract("pickDraftText") +
    "; this.__api = { errorText, chipFromState, collectChipFragments, detectChip, pickDraftText };",
  ctx
);
const { errorText, chipFromState, collectChipFragments, detectChip, pickDraftText } = ctx.__api;

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

console.log("\n[3] 降级与防误判");
check("props.chips 片段命中", detectChip("看看 @src/a.ts 这段", collectChipFragments({ chips: [{ text: "@src/a.ts" }] })) === "@src/a.ts");
check("@路径 文本兜底", detectChip("请读 @src/index.ts 然后总结", []) === "@src/index.ts");
check("行首 /命令 兜底", detectChip("/compact 一下", []) === "/compact");
check("普通 @提及 不误判", detectChip("问一下 @alice 的意见", []) === "");
check("普通中文 不误判", detectChip("把日志时间戳换成下拉", []) === "");
check("行中斜杠 不误判", detectChip("路径是 a/b 这样", []) === "");
check("空草稿安全", detectChip("", []) === "");

console.log("\n[4] 错误码本地化");
check("已知码 → 中文", errorText({ code: "AUTH" }) === "模型凭证无效，请检查 API Key");
check("限流用后端带秒数文案", errorText({ code: "RATE_LIMIT", message: "请 42 秒后再试" }) === "请 42 秒后再试");
check("未知码回退 message", errorText({ code: "WAT", message: "自定义错误" }) === "自定义错误");
check("空错误兜底", errorText(null) === "改写失败");

console.log("\n[5] SSE 解析（同客户端 pump/handleEvent 规则）");
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
  'event: meta\ndata: {"requestId":"r1"}\n\n' +
  'event: delta\ndata: {"text":"你"}\n\n' +
  'event: delta\ndata: {"text":"好"}\n\n' +
  'event: done\ndata: {"text":"你好"}\n\n';
const evs = parseSse(sample);
check("解析出 4 个事件", evs.length === 4, evs.length);
check("顺序正确", evs.map((e) => e.event).join(",") === "meta,delta,delta,done");
check("delta 拼接等于 done 全文", evs.filter((e) => e.event === "delta").map((e) => e.data.text).join("") === evs[3].data.text);
const partial = parseSse('event: delta\ndata: {"text":"a"}\n\nevent: del');
check("半包帧不崩且只消费完整帧", partial.length === 1 && partial[0].data.text === "a", partial);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
