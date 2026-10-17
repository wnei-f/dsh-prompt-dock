/**
 * 临时验证脚本（不随插件发布）：验证宿主半的回环围栏、错误码、限流与 SSE 流。
 * 用真实 http.Server + 假 webServer / llm / agentDefaultModel 驱动。
 */
import http from "node:http";
import { apply } from "../lib/index.js";

const routes = new Map();
const fakeCtx = {
  get(name) {
    if (name === "webServer") {
      return { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } };
    }
    if (name === "llm") {
      return {
        listProviders: () => [{ id: "p1", name: "P1" }],
        listModels: async () => [{ id: "m1", name: "M1" }],
        stream: async function* (opts) {
          for (const t of ["你", "好"]) {
            if (opts.signal && opts.signal.aborted) {
              yield { type: "finish", reason: { kind: "aborted" } };
              return;
            }
            await new Promise((r) => setTimeout(r, 20));
            yield { type: "text-delta", text: t };
          }
          yield { type: "finish", reason: { kind: "stop" } };
        },
      };
    }
    if (name === "agentDefaultModel") return { currentSelection: () => ({ provider: "p1", model: "m1" }) };
    return undefined;
  },
  effect(fn) { return fn(); },
};

process.env.DSH_HOME = process.env.TMP_DSH_HOME;
apply(fakeCtx, {});

const server = http.createServer(async (req, res) => {
  const handler = routes.get(req.url.split("?")[0]);
  if (!handler) { res.writeHead(404); res.end("no route"); return; }
  await handler(req, res);
});
const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const base = `http://127.0.0.1:${port}`;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
}
async function post(path, body, headers) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers || {}),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

console.log("\n[1] 回环围栏：拒绝");
{
  const r = await fetch(`${base}/api/prompt-dock/config`, { headers: { "x-forwarded-for": "1.2.3.4" } });
  const j = await r.json();
  check("X-Forwarded-For → 403/AUTH", r.status === 403 && j.error.code === "AUTH", `${r.status}`);
}
{
  const r = await fetch(`${base}/api/prompt-dock/config`, { headers: { forwarded: "for=1.2.3.4" } });
  check("Forwarded → 403", r.status === 403);
}
{
  const r = await fetch(`${base}/api/prompt-dock/config`, { headers: { origin: "http://evil.example" } });
  check("远端 http Origin → 403", r.status === 403);
}

console.log("\n[2] 回环围栏：放行（桌面壳兼容）");
{
  const r = await fetch(`${base}/api/prompt-dock/config`);
  check("无 Origin → 200", r.status === 200);
}
{
  const r = await fetch(`${base}/api/prompt-dock/config`, { headers: { origin: "http://127.0.0.1:9211" } });
  check("回环 http Origin → 200", r.status === 200);
}
{
  const r = await fetch(`${base}/api/prompt-dock/config`, { headers: { origin: "http://tauri.localhost" } });
  check("*.localhost Origin → 200（桌面壳）", r.status === 200, `${r.status}`);
}
{
  const r = await fetch(`${base}/api/prompt-dock/config`, { headers: { origin: "tauri://localhost" } });
  check("自定义 scheme Origin → 200（桌面壳）", r.status === 200, `${r.status}`);
}
{
  const r = await fetch(`${base}/api/prompt-dock/config`, { headers: { origin: "null" } });
  check("Origin: null（file://）→ 200", r.status === 200);
}

console.log("\n[3] 方法校验与输入错误码");{
  const r = await fetch(`${base}/api/prompt-dock/rewrite`, { method: "GET" });
  const j = await r.json();
  check("GET rewrite → 405/METHOD", r.status === 405 && j.error.code === "METHOD");
}
{
  const { json } = await post("/api/prompt-dock/rewrite", { text: "   " });
  check("空草稿 → EMPTY_TEXT", json.error.code === "EMPTY_TEXT", JSON.stringify(json));
}
{
  const { json } = await post("/api/prompt-dock/rewrite", { text: "x".repeat(33000) });
  check("超长 → TEXT_OVER", json.error.code === "TEXT_OVER");
}
{
  const { json } = await post("/api/prompt-dock/rewrite", "{bad json");
  check("坏 JSON → BAD_JSON", json.error.code === "BAD_JSON");
}

console.log("\n[3.5] 内置风格与模板");
{
  const r = await fetch(`${base}/api/prompt-dock/config`);
  const { styles, templates } = await r.json();
  const ids = styles.map((s) => s.id);
  check("5 个内置风格且 id 顺序稳定", ids.join(",") === "concise,detailed,structured,en,custom", ids.join(","));
  check("风格 name 与客户端回退一致", styles.map((s) => s.name).join(",") === "更简洁,更详细,结构化,译成英文,自定义", styles.map((s) => s.name).join(","));
  check("custom 的 instruction 为空（由用户自定义指令提供）", styles.find((s) => s.id === "custom").instruction === "");
  check("其余风格都有非空指令", styles.filter((s) => s.id !== "custom").every((s) => typeof s.instruction === "string" && s.instruction.length > 10));
  check("concise 明确要求保留硬性约束", /必须原样保留/.test(styles.find((s) => s.id === "concise").instruction));
  check("concise 有长度区间", /50%–70%/.test(styles.find((s) => s.id === "concise").instruction));
  check("detailed 禁止编造", /不得编造/.test(styles.find((s) => s.id === "detailed").instruction));
  check("detailed 要求占位符而非臆测", /待补充/.test(styles.find((s) => s.id === "detailed").instruction));
  check("structured 声明章节顺序", /目标 \/ 上下文 \/ 任务步骤 \/ 约束 \/ 输出格式/.test(styles.find((s) => s.id === "structured").instruction));
  check("en 要求标识符不译", /保持原样不译/.test(styles.find((s) => s.id === "en").instruction));

  check("3 个内置模板", templates.map((t) => t.id).join(",") === "t-review,t-explain,t-test", templates.map((t) => t.id).join(","));
  check("模板均以可填写的占位标题结尾", templates.every((t) => /：\n$/.test(t.text)));
  check("审查模板要求给出行号与修复建议", /文件:行号/.test(templates[0].text) && /修复建议/.test(templates[0].text));
  check("解释模板禁止逐行复述", /不要逐行复述/.test(templates[1].text));
  check("测试模板要求隔离外部依赖", /不要 mock 被测逻辑本身/.test(templates[2].text));
}

console.log("\n[4] 非流式改写");
{
  const { json } = await post("/api/prompt-dock/rewrite", { text: "把日志时间戳换成下拉" });
  check("成功且文本正确", json.ok === true && json.text === "你好", JSON.stringify(json));
  check("返回模型", json.provider === "p1" && json.model === "m1");
}

console.log("\n[4.5] 配置文件（界面与配置文件同源）");
{
  const r = await fetch(`${base}/api/prompt-dock/config`);
  const j = await r.json();
  check("GET config 返回配置文件路径", typeof j.settingsPath === "string" && j.settingsPath.endsWith("settings.json"), j.settingsPath);
}
{
  const r = await fetch(`${base}/api/prompt-dock/open-config`);
  const j = await r.json();
  check("open-config 仅支持 POST", r.status === 405 && j.error.code === "METHOD", `${r.status}`);
}
{
  process.env.DSH_PROMPT_DOCK_DISABLE_OPEN = "1";
  const { status, json } = await post("/api/prompt-dock/open-config", {});
  check("open-config 返回路径", status === 200 && json.ok === true && String(json.path).endsWith("settings.json"), JSON.stringify(json));
  const { existsSync } = await import("node:fs");
  check("open-config 会生成配置文件", existsSync(json.path), json.path);
  delete process.env.DSH_PROMPT_DOCK_DISABLE_OPEN;
}

console.log("\n[4.6] 改写模型持久化");
{
  const before = await (await fetch(`${base}/api/prompt-dock/config`)).json();
  check("初始 rewriteModel 为 null", before.rewriteModel === null, before.rewriteModel);

  const saved = await post("/api/prompt-dock/config", { rewriteModel: { provider: "p1", model: "m1" } });
  check("保存 rewriteModel 成功", saved.json.ok === true && saved.json.rewriteModel && saved.json.rewriteModel.model === "m1",
    JSON.stringify(saved.json.rewriteModel));

  const after = await (await fetch(`${base}/api/prompt-dock/config`)).json();
  check("重新读取仍是上次选择的模型", after.rewriteModel && after.rewriteModel.provider === "p1" && after.rewriteModel.model === "m1",
    JSON.stringify(after.rewriteModel));

  // 其它字段单独保存时不应把 rewriteModel 冲掉（界面里会整份提交）
  const other = await post("/api/prompt-dock/config", { contextTurns: 9, rewriteModel: { provider: "p1", model: "m1" } });
  check("保存其它字段时保留模型", other.json.rewriteModel && other.json.rewriteModel.model === "m1", JSON.stringify(other.json.rewriteModel));
}

console.log("\n[5] SSE 流式");
{
  const r = await fetch(`${base}/api/prompt-dock/rewrite-stream`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "再来一次" }),
  });
  check("content-type 正确", (r.headers.get("content-type") || "").includes("text/event-stream"));
  check("cache-control no-store", r.headers.get("cache-control") === "no-store");
  const body = await r.text();
  const evs = body.split("\n\n").filter(Boolean).map((raw) => {
    const lines = raw.split("\n");
    const ev = (lines.find((l) => l.startsWith("event:")) || "").slice(6).trim();
    const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    return { ev, data: JSON.parse(data) };
  });
  check("首事件 meta", evs[0] && evs[0].ev === "meta");
  check("2 个 delta", evs.filter((e) => e.ev === "delta").length === 2);
  check("末事件 done 文本完整", evs[evs.length - 1].ev === "done" && evs[evs.length - 1].data.text === "你好");
}

console.log("\n[6] 限流");
{
  let last;
  for (let i = 0; i < 12; i++) {
    last = await post("/api/prompt-dock/rewrite", { text: "ping" + i });
    if (!last.json.ok) break;
  }
  check("超配额 → 429/RATE_LIMIT", last.status === 429 && last.json.error.code === "RATE_LIMIT", JSON.stringify(last.json));
  check("带 retryAfter", typeof last.json?.error?.params?.retryAfter === "number", JSON.stringify(last.json));
}

console.log("\n[7] 取消接口");
{
  const { json } = await post("/api/prompt-dock/cancel", { requestId: "nope" });
  check("取消不存在的请求 → ok/cancelled=false", json.ok === true && json.cancelled === false, JSON.stringify(json));
}

server.close();
console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
