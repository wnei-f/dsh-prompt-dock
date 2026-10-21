/**
 * 临时验证脚本（不随插件发布）：验证宿主半的回环围栏、错误码、限流与 SSE 流。
 * 用真实 http.Server + 假 webServer / llm / agentDefaultModel 驱动。
 */
import http from "node:http";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { apply, Config, defaultSettings } from "../lib/index.js";

// 每次运行都用一个全新的 DSH_HOME，绝不碰用户真实的 ~/.dsh
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "pd-host-"));

// ---- 模拟官方 settings 服务 ----
// 真实语义（dsh-settings 的 SettingsForms）：mutate(ns, ops, revision) 只接受 volatile
// 字段路径，写入后经 configEditor 落盘，Loader 重组让 cfg 的 volatile 引用拿到新值。
// 这里保存的是「profile 里用户显式写入的那一层」（patch 文件内容），
// 并把它重新解析成一份新的 cfg——与真实 Loader 重组行为一致。
const CONFIG_NS = "dsh-prompt-dock";
let rawConfig = {};          // profile patch 里用户显式写入的值 = describe().user
let liveCfg = null;
const writeLog = [];

function resolveCfg(raw) {
  // structuredClone 会把 volatile 代理迭代成 {}，这里走 JSON 往返得到纯数据再解析
  const [value] = z.resolve(JSON.parse(JSON.stringify(raw || {})), Config);
  return value;
}

// 记录哪些字段是 volatile 的（真实服务会拒绝写非 volatile 路径）
function volatilePaths() {
  return configPaths(Config);
}
function configPaths(schema, out = new Set(), prefix = []) {
  if (schema.meta && schema.meta.volatile) { out.add(prefix.join(".")); return out; }
  for (const [key, child] of Object.entries(schema.dict || {})) configPaths(child, out, [...prefix, key]);
  return out;
}

const settingsService = {
  // settings.describe()：真实服务返回每个入口的 { ns, value, base, user, revision }。
  // value 是当前生效值（含 schema 默认），user 是 profile 里显式写入的那部分。
  describe() {
    return [{
      ns: CONFIG_NS,
      revision: 0,
      applies: "live",
      value: JSON.parse(JSON.stringify(rawConfig)),
      base: {},
      user: JSON.parse(JSON.stringify(rawConfig)),
    }];
  },
  async mutate(ns, ops) {
    if (ns !== CONFIG_NS) throw new Error(`No configurable plugin entry "${ns}"`);
    writeLog.push({ ns, ops: structuredClone(ops) });
    const allowed = volatilePaths();
    for (const op of ops) {
      const path = op.path.join(".");
      if (!allowed.has(path)) throw new Error(`Config field "${path}" is not volatile`);
    }
    const next = { ...rawConfig };
    for (const op of ops) next[op.path[0]] = op.value;
    rawConfig = next;
    liveCfg = resolveCfg(rawConfig);   // 模拟 Loader 重组：插件拿到新引用
    return { ok: true };
  },
};

const routes = new Map();
const fakeCtx = {
  get(name) {
    if (name === "webServer") {
      return { register({ path, handler }) { routes.set(path, handler); return () => routes.delete(path); } };
    }
    if (name === "settings") return settingsService;
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

// 用真实 Config schema 解析出 volatile 包装，插件运行时拿到的就是这种对象
liveCfg = resolveCfg(rawConfig);
// 插件拿到的 cfg 是 Loader 解析出的 volatile 包装；真实宿主重组时会换掉这个引用，
// 通过一层 getter 代理模拟“同一进程里 cfg 会更新”的语义。
const cfgProxy = new Proxy({}, { get: (_t, key) => liveCfg[key] });
apply(fakeCtx, cfgProxy);

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
  check("concise 要求失败路径不丢", /失败路径/.test(styles.find((s) => s.id === "concise").instruction));
  check("detailed 禁止编造", /禁止引入|不得编造/.test(styles.find((s) => s.id === "detailed").instruction));
  check("detailed 有长度上限", /800 字/.test(styles.find((s) => s.id === "detailed").instruction));
  check("detailed 草稿过短不做比例扩写", /不足三行/.test(styles.find((s) => s.id === "detailed").instruction));
  check("structured 声明章节顺序", /目标 \/ 上下文 \/ 任务步骤 \/ 约束 \/ 输出格式/.test(styles.find((s) => s.id === "structured").instruction));
  check("structured 缺失章节写「未指定」", /未指定/.test(styles.find((s) => s.id === "structured").instruction));
  check("en 要求标识符保留", /逐字保留/.test(styles.find((s) => s.id === "en").instruction));
  check("en 要求判断强度不变", /判断强度/.test(styles.find((s) => s.id === "en").instruction));

  check("3 个内置模板", templates.map((t) => t.id).join(",") === "t-review,t-explain,t-test", templates.map((t) => t.id).join(","));
  check("模板均以可填写的占位标题结尾", templates.every((t) => /：\n$/.test(t.text)));
  check("审查模板要求给位置与修复方向", /位置/.test(templates[0].text) && /最小修复方向/.test(templates[0].text));
  check("审查模板无问题时不硬凑", /未发现可定位问题/.test(templates[0].text));
  check("解释模板禁止评价与建议", /不提改进建议/.test(templates[1].text));
  check("解释模板不确定标「未验证」", /未验证/.test(templates[1].text));
  check("测试模板不改被测代码", /不修改被测代码/.test(templates[2].text));
  check("测试模板不 mock 被测逻辑", /不 mock 被测逻辑本身/.test(templates[2].text));
}

console.log("\n[3.6] 共同纪律（system prompt 主体）");
{
  const body = await (await fetch(`${base}/api/prompt-dock/config`)).json();
  const d = body.globalDiscipline;
  check("返回共同纪律全文", typeof d === "string" && d.length > 200, String(d).length);
  check("纪律声明「改写器不是需求生成器」", /不是需求生成器/.test(d));
  check("纪律含性质判断（确认/道谢不扩写）", /确认、道谢/.test(d) && /不按任何风格扩写/.test(d));
  check("纪律要求逐字保留代码与路径", /反引号内代码/.test(d) && /文件路径/.test(d));
  check("纪律禁止把观察改写为结论", /观察改写成结论/.test(d));
  check("纪律含长度软约束", /不低于 80 字/.test(d));
  check("默认不是自定义（可被恢复默认覆盖）", body.globalDisciplineCustom === false);
}

console.log("\n[4] 非流式改写");
{
  const { json } = await post("/api/prompt-dock/rewrite", { text: "把日志时间戳换成下拉" });
  check("成功且文本正确", json.ok === true && json.text === "你好", JSON.stringify(json));
  check("返回模型", json.provider === "p1" && json.model === "m1");
}

console.log("\n[4.5] 设置存储（官方 Config + 旧文件迁移）");
{
  const r = await fetch(`${base}/api/prompt-dock/config`);
  const j = await r.json();
  check("GET config 声明存储为官方 Config", j.storage === "config", j.storage);
  check("GET config 不再暴露 settingsPath 作为写入口", !("settingsPath" in j));
  check("GET config 报告旧文件路径供诊断", typeof j.legacyPath === "string" && j.legacyPath.endsWith("settings.json"), j.legacyPath);
}
{
  const r = await fetch(`${base}/api/prompt-dock/open-config`);
  const j = await r.json();
  check("open-config 仅支持 POST", r.status === 405 && j.error.code === "METHOD", `${r.status}`);
}
{
  // 宿主没提供 configEditor 时不谎报路径
  process.env.DSH_PROMPT_DOCK_DISABLE_OPEN = "1";
  const { status, json } = await post("/api/prompt-dock/open-config", {});
  check("无 configEditor 时明确报 NO_DOCUMENT", status === 404 && json.error.code === "NO_DOCUMENT", JSON.stringify(json));
  delete process.env.DSH_PROMPT_DOCK_DISABLE_OPEN;
}

console.log("\n[4.6] 改写模型持久化（volatile 字段）");
{
  const before = await (await fetch(`${base}/api/prompt-dock/config`)).json();
  check("初始 rewriteModel 为 null", before.rewriteModel === null, before.rewriteModel);

  const saved = await post("/api/prompt-dock/config", { rewriteModel: { provider: "p1", model: "m1" } });
  check("保存 rewriteModel 成功", saved.json.ok === true && saved.json.rewriteModel && saved.json.rewriteModel.model === "m1",
    JSON.stringify(saved.json.rewriteModel));

  const after = await (await fetch(`${base}/api/prompt-dock/config`)).json();
  check("重新读取仍是上次选择的模型", after.rewriteModel && after.rewriteModel.provider === "p1" && after.rewriteModel.model === "m1",
    JSON.stringify(after.rewriteModel));

  // 只提交部分字段时，其余字段保持现值（旧实现是整份覆盖）
  const other = await post("/api/prompt-dock/config", { contextTurns: 9 });
  check("只改其它字段时保留模型", other.json.rewriteModel && other.json.rewriteModel.model === "m1", JSON.stringify(other.json.rewriteModel));
  check("改动的字段生效", other.json.contextTurns === 9, String(other.json.contextTurns));

  // 清空模型
  const cleared = await post("/api/prompt-dock/config", { rewriteModel: null });
  check("可以清回跟随全局默认", cleared.json.rewriteModel === null, JSON.stringify(cleared.json.rewriteModel));
  // 复原，避免影响后续改写用例
  await post("/api/prompt-dock/config", { rewriteModel: { provider: "p1", model: "m1" } });
}

console.log("\n[4.7] 提示词可编辑（写入 Config 后实时生效）");
{
  const cur = await (await fetch(`${base}/api/prompt-dock/config`)).json();
  const next = cur.styles.map((s) => (s.id === "concise" ? { ...s, instruction: "只做一件事：把草稿压到一半长度且不删任何约束。" } : s));
  const saved = await post("/api/prompt-dock/config", { styles: next });
  check("保存风格 instruction 成功", saved.json.ok === true);
  const edited = saved.json.styles.find((s) => s.id === "concise");
  check("改写后的 instruction 被持久化", /只做一件事/.test(edited.instruction), edited.instruction);

  // 恢复默认，避免污染后面的用例
  const reset = await post("/api/prompt-dock/config", {
    styles: defaultSettings().styles,
  });
  check("可以恢复默认风格", /必须原样保留/.test(reset.json.styles.find((s) => s.id === "concise").instruction));

  // 共同纪律改成与默认一致时，应存为空串以继续跟随默认
  const disc = await post("/api/prompt-dock/config", { globalDiscipline: defaultSettings().globalDiscipline });
  check("共同纪律与默认相同时存为跟随默认", disc.json.globalDisciplineCustom === false);
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

// ---- [8] 旧 settings.json → 官方 Config 的幂等回填 ----
// 单独起一份隔离环境：只有这里才写旧文件
console.log("\n[8] 旧配置迁移（幂等回填 + .migrated）");
{
  const { default: fs } = await import("node:fs/promises");
  const home = mkdtempSync(join(tmpdir(), "pd-migrate-"));
  process.env.DSH_HOME = home;
  const dir = join(home, "prompt-dock");
  await fs.mkdir(dir, { recursive: true });
  const legacyFile = join(dir, "settings.json");
  const retiredFile = legacyFile + ".migrated";

  // 旧文件里带着“用户改过的”风格与上下文设置
  writeFileSync(legacyFile, JSON.stringify({
    styles: [
      { id: "concise", name: "我的简洁", instruction: "用户自定义的简洁指令：只删客套。" },
    ],
    templates: [{ id: "t-mine", name: "我的模板", text: "正文：\n" }],
    contextEnabled: false,
    contextTurns: 11,
    rewriteModel: { provider: "p1", model: "m1" },
  }, null, 2), "utf8");

  // 重置官方存储到空（模拟“官方配置为空”）
  rawConfig = {};
  liveCfg = resolveCfg(rawConfig);
  const routes2 = new Map();
  const ctx2 = {
    get(n) {
      if (n === "webServer") return { register({ path, handler }) { routes2.set(path, handler); return () => routes2.delete(path); } };
      if (n === "settings") return settingsService;
      return undefined;
    },
    effect(fn) { return fn(); },
  };
  // 独立的 Config 引用（模拟第二个进程）
  const cfg2 = new Proxy({}, { get: (_t, key) => liveCfg[key] });
  apply(ctx2, cfg2);
  await apply.migrated;

  // 触发一次 config 读取，让迁移完成
  const srv = http.createServer(async (req, res) => {
    const h = routes2.get(req.url.split("?")[0]);
    if (!h) { res.writeHead(404); res.end(); return; }
    await h(req, res);
  });
  const p2 = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  const j1 = await (await fetch(`http://127.0.0.1:${p2}/api/prompt-dock/config`)).json();

  check("迁移被记录", j1.migrated === true, String(j1.migrated));
  check("旧文件已改名为 .migrated", existsSync(retiredFile) && !existsSync(legacyFile));
  check("用户改过的风格被回填", j1.styles.some((s) => s.name === "我的简洁"), JSON.stringify(j1.styles.map((s) => s.name)));
  check("回填的指令内容正确", /只删客套/.test((j1.styles.find((s) => s.id === "concise") || {}).instruction || ""));
  check("模板被回填", j1.templates.some((t) => t.name === "我的模板"));
  check("上下文开关被回填", j1.contextEnabled === false, String(j1.contextEnabled));
  check("上下文轮数被回填", j1.contextTurns === 11, String(j1.contextTurns));
  check("改写模型被回填", j1.rewriteModel && j1.rewriteModel.model === "m1", JSON.stringify(j1.rewriteModel));

  // 再读完一次不应重复迁移
  const j2 = await (await fetch(`http://127.0.0.1:${p2}/api/prompt-dock/config`)).json();
  check("第二次读取不再报告迁移", j2.migrated === false, String(j2.migrated));
  check("第二次读取数据保持一致", j2.contextTurns === 11);
  srv.close();
}

// ---- [9] 回填不覆盖官方配置里已有的值 ----
{
  const { default: fs } = await import("node:fs/promises");
  const home = mkdtempSync(join(tmpdir(), "pd-noover-"));
  process.env.DSH_HOME = home;
  const dir = join(home, "prompt-dock");
  await fs.mkdir(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextTurns: 3, contextEnabled: false }), "utf8");

  // 官方配置里已经有 15 轮且启用
  rawConfig = { contextRounds: 15, useContext: true };
  liveCfg = resolveCfg(rawConfig);
  const routes3 = new Map();
  const ctx3 = {
    get(n) {
      if (n === "webServer") return { register({ path, handler }) { routes3.set(path, handler); return () => routes3.delete(path); } };
      if (n === "settings") return settingsService;
      return undefined;
    },
    effect(fn) { return fn(); },
  };
  const cfg3 = new Proxy({}, { get: (_t, key) => liveCfg[key] });
  apply(ctx3, cfg3);
  await apply.migrated;
  const srv = http.createServer(async (req, res) => {
    const h = routes3.get(req.url.split("?")[0]);
    if (!h) { res.writeHead(404); res.end(); return; }
    await h(req, res);
  });
  const p3 = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  const j = await (await fetch(`http://127.0.0.1:${p3}/api/prompt-dock/config`)).json();
  check("官方已有的值不被旧文件覆盖", j.contextTurns === 15, String(j.contextTurns));
  check("官方已有的开关不被覆盖", j.contextEnabled === true, String(j.contextEnabled));
  srv.close();
}

// ---- [10] 写入字段校验：只写 volatile 字段 ----
{
  const fields = ["rewriteProvider", "rewriteModel", "timeoutMs", "useContext", "contextRounds", "globalDiscipline", "styles", "templates", "showStyleEntry", "showTemplateEntry", "compactThreshold", "shortcutStyle", "shortcutTemplate", "shortcutRewrite"];
  const have = volatilePaths();
  const missing = fields.filter((f) => !have.has(f));
  check("所有可编辑设置都是 volatile", missing.length === 0, missing.join(",") || "ok");
  // 反例：确保校验真的会拒绝非 volatile 路径（防止断言恒真）
  let rejected = false;
  try { await settingsService.mutate(CONFIG_NS, [{ op: "set", path: ["notAField"], value: 1 }]); }
  catch (e) { rejected = /not volatile/.test(e.message); }
  check("写非 volatile 字段会被拒绝", rejected);
}

// ---- [11] 隐私：探针不落盘草稿原文 ----
{
  const { default: fs } = await import("node:fs/promises");
  const home = mkdtempSync(join(tmpdir(), "pd-probe-"));
  process.env.DSH_HOME = home;
  const routes4 = new Map();
  const ctx4 = {
    get(n) {
      if (n === "webServer") return { register({ path, handler }) { routes4.set(path, handler); return () => routes4.delete(path); } };
      return undefined;
    },
    effect(fn) { return fn(); },
  };
  apply(ctx4, new Proxy({}, { get: (_t, key) => liveCfg[key] }));
  await apply.migrated;
  const srv = http.createServer(async (req, res) => {
    const h = routes4.get(req.url.split("?")[0]);
    if (!h) { res.writeHead(404); res.end(); return; }
    await h(req, res);
  });
  const p4 = await new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
  const SECRET = "这是一段不该出现在磁盘上的草稿原文";
  const r = await fetch(`http://127.0.0.1:${p4}/api/prompt-dock/probe`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ at: 1, draftGuess: SECRET, nested: { text: SECRET }, propKeys: ["useInput"] }),
  });
  check("探针接口可用", r.status === 200);
  const raw = await fs.readFile(join(home, "prompt-dock", "probe.json"), "utf8");
  check("探针文件不含草稿原文", !raw.includes(SECRET), raw.slice(0, 120));
  check("探针保留结构信息", /propKeys/.test(raw) && /chars/.test(raw), raw.slice(0, 160));
  srv.close();
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
