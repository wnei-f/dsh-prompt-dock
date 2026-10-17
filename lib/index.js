/**
 * dsh-prompt-dock —— 宿主半 v0.5
 *
 * 路由（全部 JSON，除 stream 为 SSE）：
 *   GET  /api/prompt-dock/config    读取设置（风格表 / 模板 / 自定义指令 / 上下文开关与轮数）
 *   POST /api/prompt-dock/config    保存设置
 *   GET  /api/prompt-dock/models    模型目录（与主页面模型选择同源）+ 全局默认
 *   POST /api/prompt-dock/rewrite   { text, styleId, customInstruction, sessionId, useContext } → { ok, text }
 *   POST /api/prompt-dock/rewrite-stream  同上，text/event-stream：delta / done / error 事件
 *   POST /api/prompt-dock/cancel    { requestId } 中断进行中的改写
 *   POST /api/prompt-dock/probe     客户端形状探针（开发期，写 probe.json）
 *
 * 安全（对齐竞品 loopback 围栏）：
 *   所有 /api/prompt-dock/* 仅接受本机回环来源；校验 socket 地址、Host、Origin，并拒绝带
 *   X-Forwarded-For / Forwarded 头的请求（这类头只在经过代理时出现，说明围栏已失效）。
 *
 * 错误码（对齐竞品结构化错误）：AUTH / RATE_LIMIT / QUOTA / CONTEXT_WINDOW / TIMEOUT /
 *   EMPTY_TEXT / TEXT_OVER / NO_INSTRUCTION / NO_MODEL / NO_LLM / LLM_FAILED / EMPTY_REPLY /
 *   CONCURRENCY_LIMIT / METHOD / BAD_JSON / BODY_OVER_SIZE。
 *
 * 限流（宿主进程内存内）：并发改写上限 MAX_CONCURRENT（默认 2），每分钟成功调用上限
 *   RATE_LIMIT_PER_MINUTE（默认 10）；失败调用不占用分钟配额。
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

export const name = "dsh-prompt-dock";
export const inject = ["webServer"];

export const config = {
  // { provider, model } 或 null（跟随全局默认模型）
  model: null,
};

const VERSION = "1.0.0";
const MAX_TEXT = 32000;
const REWRITE_TIMEOUT_MS = 90000;
const CTX_PER_MSG = 800;
const CTX_TOTAL = 6000;
const MAX_CONCURRENT = 2;
const RATE_LIMIT_PER_MINUTE = 10;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// 回环主机名判定：RFC 6761 规定 .localhost 一律解析到回环，桌面壳（Electron/Tauri）
// 常用 tauri.localhost 这类名字；这也覆盖了 dsh 桌面端同源访问的情形。
function isLoopbackHostname(h) {
  const name = String(h || "").toLowerCase();
  if (!name) return false;
  return LOOPBACK_HOSTS.has(name) || name.endsWith(".localhost");
}

const GUARD =
  '你是「提示词修改助手」。按给定的风格指令改写用户草稿。' +
  "只输出改写后的文本本身：不要解释、不要前后缀、不要引号或代码围栏。保持草稿使用的语言（除非风格指令要求翻译）。" +
  "若提供了会话背景，仅用它消解草稿中的指代（如“上面那个”“刚才的代码”），使改写后的文本自洽；不要把背景内容当作草稿输出。";

// 内置风格指令。写作要求：每条都是「可执行规则」，标明必须保留什么、禁止做什么、
// 目标长度区间——避免模型自由发挥导致信息丢失或编造。custom 的 instruction 必须为空，
// 它由用户在设置里的「自定义改写指令」提供（宿主在二者都为空时报 NO_INSTRUCTION）。
const DEFAULT_STYLES = [
  {
    id: "concise",
    name: "更简洁",
    instruction:
      "把草稿压缩成更短的版本：删除客套、重复、铺垫与模糊修饰，合并同义句。" +
      "必须原样保留：全部硬性约束、数字与阈值、文件/接口/字段名、验收标准，以及否定条件（如「不要…」「禁止…」）。" +
      "不得为缩短而删除任何要求；原句中的约束即使换措辞也必须带过去。" +
      "目标长度为原文的 50%–70%。",
  },
  {
    id: "detailed",
    name: "更详细",
    instruction:
      "把草稿扩写成可执行的任务说明，补齐：目标、输入材料、约束、期望输出、完成判定。" +
      "只补充草稿已隐含的信息；不得编造事实、文件、接口、数字或需求。" +
      "确实缺失的关键信息写成占位符（如「待补充：…」），不要臆测填充。" +
      "目标长度为原文的 1.5–3 倍。",
  },
  {
    id: "structured",
    name: "结构化",
    instruction:
      "把草稿整理成结构化提示词，用 Markdown 二级标题按此顺序组织：目标 / 上下文 / 任务步骤 / 约束 / 输出格式。" +
      "任务步骤必须可执行、按先后编号；约束需包含硬性限制与禁止项。" +
      "只做重组与明确化，不新增需求；内容为空的章节直接省略。",
  },
  {
    id: "en",
    name: "译成英文",
    instruction:
      "把草稿翻译成地道、精确的英文提示词。" +
      "代码标识符、文件路径、命令行参数、产品与协议名保持原样不译；Markdown 结构原样保留。" +
      "不得增删信息或改变约束强度。",
  },
  { id: "custom", name: "自定义", instruction: "" },
];

// 内置模板：插入到草稿末尾的整段文本，直接面向执行者，因此要写清「要什么」和「输出格式」。
const DEFAULT_TEMPLATES = [
  {
    id: "t-review",
    name: "代码审查",
    text:
      "请审查以下改动，按严重程度从高到低列出问题：\n" +
      "1) bug 与逻辑错误：触发条件、影响范围\n" +
      "2) 安全隐患\n" +
      "3) 可维护性问题\n" +
      "每条给出位置（文件:行号）与具体修复建议。若确无问题，请明确说明结论；不要罗列无关的风格偏好。\n\n" +
      "改动：\n",
  },
  {
    id: "t-explain",
    name: "解释代码",
    text:
      "解释下面这段代码，面向有经验的开发者，不要逐行复述：\n" +
      "- 整体职责与调用方式\n" +
      "- 关键控制流与数据流\n" +
      "- 边界条件与异常处理\n" +
      "- 可预见的坑点（并发、空值、性能、副作用）\n\n" +
      "代码：\n",
  },
  {
    id: "t-test",
    name: "写测试",
    text:
      "为下面的代码编写单元测试：\n" +
      "- 覆盖正常路径、边界条件与失败路径\n" +
      "- 每个用例用一句话说明意图\n" +
      "- 不要 mock 被测逻辑本身；只隔离外部依赖\n" +
      "- 说明所用测试框架与运行命令\n\n" +
      "代码：\n",
  },
];

function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "prompt-dock");
}

// 配置文件位置：界面保存与手工编辑的是同一份文件（界面保存会整份覆盖）
function settingsPath() {
  return join(dataDir(), "settings.json");
}

// 确保配置文件存在，便于用户直接打开编辑
async function ensureSettingsFile() {
  const file = settingsPath();
  try {
    await fs.access(file);
  } catch (e) {
    await saveSettings(await loadSettings());
  }
  return file;
}

// 用系统默认方式打开配置文件（Windows 定位到文件，macOS 用 -R，Linux 打开所在目录）
function revealSettingsFile(file) {
  // 无头/测试环境不弹文件管理器（仍会生成配置文件并返回路径）
  if (process.env.DSH_PROMPT_DOCK_DISABLE_OPEN === "1") return Promise.resolve();
  const platform = process.platform;
  const cmd = platform === "win32"
    // 用单参数 "/select,<path>"（不带空格），这是 explorer 的标准形式，避免引号拼接歧义
    ? { bin: "explorer.exe", args: ["/select," + file] }
    : platform === "darwin"
      ? { bin: "open", args: ["-R", file] }
      : { bin: "xdg-open", args: [dataDir()] };
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd.bin, cmd.args, { detached: true, stdio: "ignore" });
    } catch (e) {
      reject(apiError("OPEN_FAILED", String((e && e.message) || e)));
      return;
    }
    child.on("error", (e) => reject(apiError("OPEN_FAILED", String((e && e.message) || e))));
    child.unref();
    // 打开动作本身没有退出码可依赖，成功派发即视为完成
    resolve();
  });
}

function apiError(code, message, extra) {
  return Object.assign(new Error(message || code), { code }, extra || {});
}

function json(res, status, body, headers) {
  const text = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  }, headers || {}));
  res.end(text);
}

// ---- 回环围栏：拒绝非本机来源 / 代理转发来的请求 ----
function isLoopbackRequest(req) {
  const sock = req.socket && req.socket.remoteAddress;
  if (!sock || !LOOPBACK_PEERS.has(sock)) return false;
  if (req.headers["x-forwarded-for"] || req.headers.forwarded) return false;

  const host = req.headers.host;
  if (host) {
    const hostname = host.replace(/:\d+$/, "");
    if (!isLoopbackHostname(hostname)) return false;
  } else if (req.httpVersion === "1.1") {
    return false;
  }

  // Origin：http(s) 必须是回环；非 http(s) 的自定义 scheme（app://、tauri://、file:// 等）
  // 无法由远端网页伪造，直接放行，否则会把桌面壳挡在外面。
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      const u = new URL(origin);
      const proto = u.protocol.toLowerCase();
      if (proto === "http:" || proto === "https:") {
        if (!isLoopbackHostname(u.hostname)) return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function guard(req, res) {
  if (isLoopbackRequest(req)) return true;
  json(res, 403, { ok: false, error: { code: "AUTH", message: "仅允许本机回环访问" } });
  return false;
}

async function readJsonBody(req, maxBytes = 1024 * 1024) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maxBytes) throw apiError("BODY_OVER_SIZE", "请求体过大");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw apiError("BODY_OVER_SIZE", "请求体过大");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw apiError("BAD_JSON", "JSON 解析失败"); }
}

// ---- 限流：宿主进程内存内的并发 + 每分钟配额 ----
const admission = { inFlight: new Set(), recentSuccess: [] };

function pruneRecentSuccess(now) {
  while (admission.recentSuccess.length && now - admission.recentSuccess[0] > 60000) {
    admission.recentSuccess.shift();
  }
}

function admit(requestId) {
  const now = Date.now();
  pruneRecentSuccess(now);
  if (admission.inFlight.size >= MAX_CONCURRENT) {
    throw apiError("CONCURRENCY_LIMIT", "同时进行中的改写已达上限，请稍后再试");
  }
  if (admission.recentSuccess.length >= RATE_LIMIT_PER_MINUTE) {
    const wait = Math.ceil((60000 - (now - admission.recentSuccess[0])) / 1000);
    throw apiError("RATE_LIMIT", `改写频率超限，请 ${wait} 秒后再试`, { params: { retryAfter: wait } });
  }
  admission.inFlight.add(requestId);
}

function release(requestId, success) {
  admission.inFlight.delete(requestId);
  if (success) admission.recentSuccess.push(Date.now());
}

// ---- 上游错误归类：把模型调用失败映射成可理解的结构化错误码 ----
function classifyUpstream(message) {
  const m = String(message || "").toLowerCase();
  const has = (...ws) => ws.some((w) => m.includes(w));
  if (has("401", "403", "unauthor", "invalid api key", "authentication", "invalid_api_key")) {
    return apiError("AUTH", "模型凭证无效或未授权，请检查 API Key", { params: { reason: "auth" } });
  }
  if (has("429", "rate limit", "too many requests", "rate_limit")) {
    return apiError("RATE_LIMIT", "模型端限流，请稍后重试", { params: { reason: "rateLimit" } });
  }
  if (has("quota", "insufficient", "balance", "余额")) {
    return apiError("QUOTA", "模型额度不足，请充值后重试", { params: { reason: "quota" } });
  }
  if (has("context", "too long", "max_tokens", "maximum context")) {
    return apiError("CONTEXT_WINDOW", "草稿或会话背景超出模型上下文长度", { params: { reason: "contextWindow" } });
  }
  return apiError("LLM_FAILED", message || "模型调用失败");
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(join(dataDir(), "settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    return {
      styles: Array.isArray(parsed.styles) && parsed.styles.length ? parsed.styles : DEFAULT_STYLES,
      templates: Array.isArray(parsed.templates) ? parsed.templates : DEFAULT_TEMPLATES,
      customInstruction: typeof parsed.customInstruction === "string" ? parsed.customInstruction : "",
      contextEnabled: parsed.contextEnabled !== false,
      contextTurns: typeof parsed.contextTurns === "number" && parsed.contextTurns >= 1 && parsed.contextTurns <= 20 ? Math.floor(parsed.contextTurns) : 6,
      rewriteModel: parsed.rewriteModel && parsed.rewriteModel.provider && parsed.rewriteModel.model
        ? { provider: String(parsed.rewriteModel.provider), model: String(parsed.rewriteModel.model) } : null,
    };
  } catch {
    return { styles: DEFAULT_STYLES, templates: DEFAULT_TEMPLATES, customInstruction: "", contextEnabled: true, contextTurns: 6, rewriteModel: null };
  }
}

async function saveSettings(settings) {
  await fs.mkdir(dataDir(), { recursive: true });
  const clean = {
    styles: Array.isArray(settings.styles) ? settings.styles : DEFAULT_STYLES,
    templates: (Array.isArray(settings.templates) ? settings.templates : [])
      .filter((t) => t && typeof t.name === "string" && typeof t.text === "string")
      .slice(0, 100)
      .map((t, i) => ({ id: String(t.id || `t-${i}-${Date.now()}`), name: String(t.name).slice(0, 60), text: String(t.text).slice(0, 4000) })),
    customInstruction: typeof settings.customInstruction === "string" ? settings.customInstruction.slice(0, 2000) : "",
    contextEnabled: settings.contextEnabled !== false,
    contextTurns: typeof settings.contextTurns === "number" ? Math.min(20, Math.max(1, Math.floor(settings.contextTurns))) : 6,
    rewriteModel: settings.rewriteModel && settings.rewriteModel.provider && settings.rewriteModel.model
      ? { provider: String(settings.rewriteModel.provider), model: String(settings.rewriteModel.model) } : null,
  };
  await fs.writeFile(join(dataDir(), "settings.json"), JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

// 模型目录：与主页面模型选择同源（cordis.yml providers→models 由 llm 服务装载，10s 缓存）
let modelListCache = { at: 0, groups: null };
async function listModelGroups(ctx) {
  const llm = ctx.get("llm");
  if (llm === undefined) return modelListCache.groups || [];
  if (modelListCache.groups && Date.now() - modelListCache.at < 10000) return modelListCache.groups;
  let providers = [];
  try { providers = llm.listProviders() || []; } catch (e) { return modelListCache.groups || []; }
  const groups = [];
  for (const p of providers) {
    let models = [];
    try { models = await llm.listModels(p.id); } catch (e) {}
    groups.push({
      id: String(p.id), name: String(p.name || p.id),
      models: (models || []).map((m) => ({ id: String(m.id), name: String(m.name || m.id) })),
    });
  }
  modelListCache = { at: Date.now(), groups };
  return groups;
}

function messageText(m) {
  const c = m && m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    let out = "";
    for (const b of c) { if (b && b.type === "text" && typeof b.text === "string") out += b.text; }
    return out;
  }
  return "";
}

// 最近 turns 轮对话的 user/assistant 文本（自内存会话，不落盘）
function buildContext(ctx, sessionId, turns) {
  const sessions = ctx.get("sessions");
  if (sessions === undefined || !sessionId) return "";
  let session;
  try { session = sessions.get(String(sessionId)); } catch (e) { return ""; }
  if (!session || typeof session.deriveMessages !== "function") return "";
  let msgs;
  try { msgs = session.deriveMessages(); } catch (e) { return ""; }
  if (!Array.isArray(msgs)) return "";
  const want = Math.max(1, Math.min(20, turns)) * 2;
  const picks = [];
  for (let i = msgs.length - 1; i >= 0 && picks.length < want; i--) {
    const m = msgs[i];
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const t = messageText(m).trim();
    if (!t) continue;
    picks.unshift({ role: m.role, text: t.slice(0, CTX_PER_MSG) });
  }
  let total = 0;
  const lines = [];
  for (let i = picks.length - 1; i >= 0; i--) {
    const line = (picks[i].role === "user" ? "用户: " : "助手: ") + picks[i].text;
    if (total + line.length > CTX_TOTAL) break;
    total += line.length;
    lines.unshift(line);
  }
  return lines.join("\n");
}

// ---- 改写主流程：准备（校验 + 解析模型 + 组上下文）→ 流式调用 ----
async function prepareRewrite(ctx, cfg, body) {
  const llm = ctx.get("llm");
  if (llm === undefined) throw apiError("NO_LLM", "llm 服务不可用");

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) throw apiError("EMPTY_TEXT", "草稿为空");
  if (text.length > MAX_TEXT) throw apiError("TEXT_OVER", "草稿过长");

  const settings = await loadSettings();
  const styleId = typeof body.styleId === "string" ? body.styleId : "concise";
  let instruction = "";
  if (styleId === "custom") {
    instruction = (typeof body.customInstruction === "string" && body.customInstruction.trim())
      || settings.customInstruction;
  } else {
    const style = settings.styles.find((s) => s.id === styleId);
    instruction = style ? style.instruction : settings.styles[0].instruction;
  }
  if (!instruction) throw apiError("NO_INSTRUCTION", "缺少改写指令");

  // 模型优先级：settings.rewriteModel（可用性校验通过）→ cfg.model（patch 强制）→ 全局默认
  let provider, model, modelFallback = false;
  const want = settings.rewriteModel;
  if (want && want.provider && want.model) {
    let ok = false;
    try {
      const groups = await listModelGroups(ctx);
      const g = groups.find((x) => x.id === want.provider);
      ok = !!(g && g.models.some((m) => m.id === want.model));
    } catch (e) { ok = false; }
    if (ok) { provider = want.provider; model = want.model; }
    else modelFallback = true;
  }
  const forced = cfg && cfg.model;
  if (!provider && forced && forced.provider && forced.model) {
    provider = forced.provider; model = forced.model;
  }
  if (!provider) {
    const defaultModel = ctx.get("agentDefaultModel");
    if (defaultModel === undefined) throw apiError("NO_MODEL", "默认模型服务不可用");
    const sel = defaultModel.currentSelection();
    provider = sel && sel.provider; model = sel && sel.model;
  }
  if (!provider || !model) throw apiError("NO_MODEL", "未能确定改写模型");

  let context = "";
  const wantCtx = body.useContext !== false && settings.contextEnabled !== false;
  if (wantCtx && body.sessionId) {
    try { context = buildContext(ctx, body.sessionId, settings.contextTurns || 6); } catch (e) { context = ""; }
  }

  const userPrompt =
    `【风格指令】${instruction}\n` +
    (context ? `\n【会话背景（仅供理解指代，禁止复述进输出）】\n${context}\n` : "") +
    `\n【待改写草稿】\n${text}`;

  return { llm, provider, model, userPrompt, contextUsed: !!context, modelFallback };
}

function openLLMStream(prep, signal) {
  return prep.llm.stream({
    provider: prep.provider,
    model: prep.model,
    system: GUARD,
    messages: [{ role: "user", content: [{ type: "text", text: prep.userPrompt }] }],
    temperature: 0.3,
    signal,
  });
}

// 非流式：一次 JSON 返回（保留旧接口，内部同样走流式收集）
async function rewrite(ctx, cfg, body) {
  const requestId = randomUUID();
  admit(requestId);
  let success = false;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REWRITE_TIMEOUT_MS);
  try {
    const prep = await prepareRewrite(ctx, cfg, body);
    let out = "";
    let failure = null;
    for await (const chunk of openLLMStream(prep, abort.signal)) {
      if (chunk.type === "text-delta") out += chunk.text;
      else if (chunk.type === "finish") {
        const kind = chunk.reason && chunk.reason.kind;
        if (kind === "error" || kind === "aborted") {
          failure = (chunk.reason.failure && chunk.reason.failure.message) || "模型调用失败";
        }
      }
    }
    if (failure) throw classifyUpstream(failure);
    out = out.trim();
    if (!out) throw apiError("EMPTY_REPLY", "模型返回为空");
    success = true;
    return { text: out, provider: prep.provider, model: prep.model, contextUsed: prep.contextUsed, modelFallback: prep.modelFallback };
  } catch (e) {
    if (e && e.code) throw e;
    if (abort.signal.aborted) throw apiError("TIMEOUT", `改写超时（${REWRITE_TIMEOUT_MS / 1000}s）`);
    throw e;
  } finally {
    clearTimeout(timer);
    release(requestId, success);
  }
}

// SSE 流式：delta 渐进输出，可经 /cancel 中断；客户端断开会中止上游调用
async function rewriteStream(ctx, cfg, body, req, res) {
  const requestId = typeof body.requestId === "string" && body.requestId ? body.requestId : randomUUID();

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const finish = () => { if (!res.writableEnded) res.end(); };

  let closed = false;
  req.on("close", () => { closed = true; });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REWRITE_TIMEOUT_MS);
  const onCancel = () => abort.abort();
  cancelHooks.set(requestId, onCancel);

  let success = false;
  try {
    admit(requestId);
    const prep = await prepareRewrite(ctx, cfg, body);
    send("meta", { requestId, provider: prep.provider, model: prep.model, contextUsed: prep.contextUsed, modelFallback: prep.modelFallback });

    let out = "";
    let failure = null;
    for await (const chunk of openLLMStream(prep, abort.signal)) {
      if (closed) { abort.abort(); break; }
      if (chunk.type === "text-delta") {
        out += chunk.text;
        send("delta", { text: chunk.text });
      } else if (chunk.type === "finish") {
        const kind = chunk.reason && chunk.reason.kind;
        if (kind === "error" || kind === "aborted") {
          failure = (chunk.reason.failure && chunk.reason.failure.message) || "模型调用失败";
        }
      }
    }
    if (failure) throw classifyUpstream(failure);
    out = out.trim();
    if (!out) throw apiError("EMPTY_REPLY", "模型返回为空");
    success = true;
    send("done", { text: out, provider: prep.provider, model: prep.model });
  } catch (e) {
    if (!closed) {
      const err = e && e.code ? e : (abort.signal.aborted
        ? apiError("TIMEOUT", `改写超时（${REWRITE_TIMEOUT_MS / 1000}s）`)
        : apiError("INTERNAL", String((e && e.message) || e)));
      send("error", { code: err.code, message: err.message, params: err.params || null });
    }
  } finally {
    clearTimeout(timer);
    cancelHooks.delete(requestId);
    release(requestId, success);
    finish();
  }
}

// 进行中的改写：requestId → abort 回调
const cancelHooks = new Map();

export function apply(ctx, cfg) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;

  ctx.effect(() => {
    const offs = [];

    offs.push(webServer.register({
      kind: "exact", path: "/api/prompt-dock/config",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          const settingsPathValue = settingsPath();
          if (req.method === "GET") {
            json(res, 200, { ok: true, version: VERSION, settingsPath: settingsPathValue, ...(await loadSettings()) });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            json(res, 200, { ok: true, version: VERSION, settingsPath: settingsPathValue, ...(await saveSettings(body)) });
            return;
          }
          json(res, 405, { ok: false, error: { code: "METHOD", message: "仅支持 GET/POST" } });
        } catch (e) {
          json(res, 400, { ok: false, error: { code: e.code || String(e.message || e), message: String(e.message || e) } });
        }
      },
    }));

    // 打开配置文件所在位置（界面里的「打开配置文件」按钮）
    offs.push(webServer.register({
      kind: "exact", path: "/api/prompt-dock/open-config",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          if (req.method !== "POST") { json(res, 405, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }); return; }
          const file = await ensureSettingsFile();
          await revealSettingsFile(file);
          json(res, 200, { ok: true, path: file });
        } catch (e) {
          json(res, 500, { ok: false, error: { code: e.code || "OPEN_FAILED", message: String(e.message || e) } });
        }
      },
    }));

    offs.push(webServer.register({
      kind: "exact", path: "/api/prompt-dock/models",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          if (req.method !== "GET") { json(res, 405, { ok: false, error: { code: "METHOD", message: "仅支持 GET" } }); return; }
          const groups = await listModelGroups(ctx);
          let global = null;
          try {
            const adm = ctx.get("agentDefaultModel");
            const s = adm && adm.currentSelection();
            if (s && s.provider && s.model) global = { provider: String(s.provider), model: String(s.model) };
          } catch (e) {}
          json(res, 200, { ok: true, groups, global });
        } catch (e) {
          json(res, 400, { ok: false, error: { code: e.code || String(e.message || e), message: String(e.message || e) } });
        }
      },
    }));

    offs.push(webServer.register({
      kind: "exact", path: "/api/prompt-dock/rewrite",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          if (req.method !== "POST") { json(res, 405, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }); return; }
          const body = await readJsonBody(req);
          const result = await rewrite(ctx, cfg || {}, body);
          json(res, 200, { ok: true, ...result });
        } catch (e) {
          const status = e.code === "CONCURRENCY_LIMIT" || e.code === "RATE_LIMIT" ? 429 : 400;
          json(res, status, { ok: false, error: { code: e.code || "REWRITE_FAILED", message: String(e.message || e), params: e.params || null } });
        }
      },
    }));

    offs.push(webServer.register({
      kind: "exact", path: "/api/prompt-dock/rewrite-stream",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        if (req.method !== "POST") { json(res, 405, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }); return; }
        let body;
        try {
          body = await readJsonBody(req);
        } catch (e) {
          json(res, 400, { ok: false, error: { code: e.code || "BAD_JSON", message: String(e.message || e) } });
          return;
        }
        await rewriteStream(ctx, cfg || {}, body, req, res);
      },
    }));

    offs.push(webServer.register({
      kind: "exact", path: "/api/prompt-dock/cancel",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          if (req.method !== "POST") { json(res, 405, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }); return; }
          const body = await readJsonBody(req);
          const id = typeof body.requestId === "string" ? body.requestId : "";
          const hook = id ? cancelHooks.get(id) : null;
          if (hook) { hook(); cancelHooks.delete(id); }
          json(res, 200, { ok: true, cancelled: !!hook });
        } catch (e) {
          json(res, 400, { ok: false, error: { code: e.code || "BAD_JSON", message: String(e.message || e) } });
        }
      },
    }));

    // 开发期探针：客户端上报 props 形状，便于适配 inputActions 真实 API
    offs.push(webServer.register({
      kind: "exact", path: "/api/prompt-dock/probe",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          if (req.method !== "POST") { json(res, 405, { ok: false, error: { code: "METHOD" } }); return; }
          const body = await readJsonBody(req);
          await fs.mkdir(dataDir(), { recursive: true });
          await fs.writeFile(join(dataDir(), "probe.json"), JSON.stringify(body, null, 2), "utf8");
          json(res, 200, { ok: true });
        } catch (e) {
          json(res, 400, { ok: false, error: { code: e.code || String(e.message || e) } });
        }
      },
    }));

    return () => {
      for (const off of offs) { try { off(); } catch (e) {} }
      for (const [, hook] of cancelHooks) { try { hook(); } catch (e) {} }
      cancelHooks.clear();
      admission.inFlight.clear();
      admission.recentSuccess.length = 0;
    };
  }, "dsh-prompt-dock: routes");
}


















