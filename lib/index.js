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
import { randomUUID, createHash } from "node:crypto";
import z from "@deepseek-ai/schemastery";

export const name = "dsh-prompt-dock";
export const inject = ["webServer"];

const VERSION = "1.0.0";
// 插件在 profile 里的条目 id（cordis.patch.yml 的 id），同时也是官方 settings 表单的命名空间
const CONFIG_NS = "dsh-prompt-dock";
const MAX_TEXT = 32000;
const REWRITE_TIMEOUT_MS = 90000;
const CTX_PER_MSG = 800;
const CTX_TOTAL = 6000;
const MAX_CONCURRENT = 2;
const RATE_LIMIT_PER_MINUTE = 10;

// 提示词与模板长度上限（与 README 的字段约束一致，保存时截断）
const MAX_GLOBAL_DISCIPLINE = 4000;
const MAX_INSTRUCTION = 2000;
const MAX_STYLE_NAME = 40;
const MAX_TEMPLATE_NAME = 60;
const MAX_TEMPLATE_TEXT = 4000;
const MAX_TEMPLATES = 100;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 24;
// 旧配置文件保留 30 天后自动清理
const RETIRED_SETTINGS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// 回环主机名判定：RFC 6761 规定 .localhost 一律解析到回环，桌面壳（Electron/Tauri）
// 常用 tauri.localhost 这类名字；这也覆盖了 dsh 桌面端同源访问的情形。
function isLoopbackHostname(h) {
  const name = String(h || "").toLowerCase();
  if (!name) return false;
  return LOOPBACK_HOSTS.has(name) || name.endsWith(".localhost");
}

// ---- 共同纪律：改写链路的 system prompt 主体（先纪律、后风格指令） ----
// 它约束「改写器不是需求生成器」，是所有风格共用的底座；用户可在设置里编辑，
// 默认值写在这里，界面上的「恢复默认」也读这一份。
const DEFAULT_GLOBAL_DISCIPLINE =
  "你是提示词改写器，不是需求生成器。你的唯一任务是把用户草稿改写得更可用，不新增草稿未包含的事实、数据、案例或结论。\n" +
  "\n" +
  "改写前先做性质判断：\n" +
  "- 若草稿是确认、道谢、闲聊、简单提问或纯情绪表达，原样返回或仅修正明显语病，不按任何风格扩写。\n" +
  "- 若草稿是可执行的任务请求，再按下方风格约束改写。\n" +
  "\n" +
  "所有风格的共同约定：\n" +
  "1. 只输出改写后的正文，不输出解释、前言、问候、改写说明。\n" +
  "2. 逐字保留：反引号内代码、文件路径、命令行参数、函数/变量/类名、URL、@引用、/命令、Markdown 结构。\n" +
  "3. 逐字保留：专有名词、规范术语、直接引语中的措辞、具体数字与版本号。\n" +
  "4. 不把用户的观察改写成结论（\"我觉得它有点慢\"不得变成\"它性能不足\"）。\n" +
  "5. 不替用户做草稿未做的决定；不确定处保留原表述。\n" +
  "6. 控制长度：不超过草稿字数的约定倍数，且不低于 80 字；超限先收敛，仍超则保持原样并提示。";

// 会话背景的附加说明：只在带了上下文时追加，避免影响无上下文的默认行为
const CONTEXT_NOTE =
  "【会话背景使用规则】" +
  "若提供了会话背景，仅用它消解草稿中的指代（如「上面那个」「刚才的代码」），使改写后的文本自洽；" +
  "不要把背景内容当作草稿输出，不要复述背景。";

// 内置风格指令。写作要求：每条都是「可执行规则」，标明必须保留什么、禁止做什么、
// 目标长度区间——避免模型自由发挥导致信息丢失或编造。
// 这里的默认值同时是设置卡片「恢复默认」的来源，所以每条都要能独立读懂。
const DEFAULT_STYLES = [
  {
    id: "concise",
    name: "更简洁",
    instruction:
      "压缩表达：删掉重复、修饰与客套，让每句话都承载信息。" +
      "必须原样保留：全部约束与否定条件（「不要…」「禁止…」）、失败路径与异常处理要求、数字与阈值、" +
      "文件/接口/字段名、验收标准。" +
      "不得为缩短而删除任何要求；不得把含义不同的两句话合并成一句，也不得把并列的两个要求压成一个。" +
      "目标长度为原文的 50%–70%，且不低于 80 字。",
  },
  {
    id: "detailed",
    name: "更详细",
    instruction:
      "在草稿已隐含的信息范围内补全：目标、输入、输出、边界条件、验证方式。" +
      "禁止引入草稿未提及的技术选型、第三方库、数据结构或数据；不得编造事实与数字。" +
      "判断强度保持不变（「可能有问题」不得变成「一定有问题」）。" +
      "目标长度为原文的 1.5–2.5 倍且不超过 800 字；草稿不足三行时按内容补全，不做比例扩写。",
  },
  {
    id: "structured",
    name: "结构化",
    instruction:
      "用固定章节重排草稿，顺序为：目标 / 上下文 / 任务步骤 / 约束 / 输出格式。" +
      "某章节在草稿中没有对应信息时，写「未指定」，不要自行编造填充。" +
      "任务步骤的每条以动词开头，按执行先后排列。" +
      "标识符、路径、数字一律保留原形，不改写为解释性文字；只重组与明确化，不新增需求。",
  },
  {
    id: "en",
    name: "译成英文",
    instruction:
      "翻译成地道、精确的英文技术写作。" +
      "逐字保留：代码、文件路径、命令行参数、标识符、URL、术语、直接引语、数字与版本号。" +
      "保留 Markdown 结构与 @引用 //命令 语法。" +
      "保持原意与判断强度不变，不扩写、不解释、不补充建议。" +
      "术语使用通行的英文写法；没有公认译法时保留原文并用括号注明。",
  },
  { id: "custom", name: "自定义", instruction: "" },
];

// 内置模板：插入到草稿末尾的整段正文，直接面向执行者。
// 三个模板统一遵循「任务 + 禁止项 + 兜底」结构：先说做什么，再说不能做什么，最后给出
// 信息不足或没有发现时的行为，避免模型硬凑内容。
const DEFAULT_TEMPLATES = [
  {
    id: "t-review",
    name: "代码审查",
    text:
      "审查下面的代码改动。按严重程度从高到低排序，每条问题给出四项：位置、问题类型、触发条件、最小修复方向。\n" +
      "\n" +
      "- 只报告能在所给代码中定位的问题；不假设未展示的代码有问题。\n" +
      "- 不评价命名风格、格式偏好等不影响正确性的写法。\n" +
      "- 如果没有任何可定位的问题，输出「未发现可定位问题」，并列出你没有覆盖到的部分（如未提供的调用方、未给出的测试）。\n" +
      "\n" +
      "改动：\n",
  },
  {
    id: "t-explain",
    name: "解释代码",
    text:
      "解释下面这段代码，按顺序说明四部分：整体职责、数据流、边界与失败路径、对调用方的约束。\n" +
      "\n" +
      "- 标识符、路径、数字逐字保留，不要意译。\n" +
      "- 不评价代码好坏，不提改进建议。\n" +
      "- 无法从代码确认的地方标注「未验证」，不要推测。\n" +
      "\n" +
      "代码：\n",
  },
  {
    id: "t-test",
    name: "写测试",
    text:
      "为下面的代码编写测试。\n" +
      "\n" +
      "- 不修改被测代码，不改签名、不重命名、不引入新测试框架、不 mock 被测逻辑本身。\n" +
      "- 每个用例给出四项：名称、输入、预期结果、覆盖的路径。\n" +
      "- 优先覆盖失败路径与边界条件。\n" +
      "- 无法确定预期行为时，列成待确认问题，不要编造断言。\n" +
      "\n" +
      "代码：\n",
  },
];

// 稳定 id 由内容派生：同一份默认文案在升级前后得到同一 id，配置合并时不会漂移
function stableId(prefix, seed) {
  return prefix + createHash("sha1").update(String(seed)).digest("hex").slice(0, 8);
}

// ---- Config schema（官方设置存储） ----
// 只有带 .volatile() 的字段会出现在官方设置表单并可被写入：DSH 的 configForms /
// settings.mutate 只接受 volatile 路径，写非 volatile 字段会抛
// 「Config field ... is not volatile」。因此凡是用户在设置里编辑的东西都必须 volatile。
//
// schemastery 的硬规则：volatile 字段不能有「固定的对象路径之外的、被 volatile 包裹的」
// 子字段——即 z.object({...}).volatile() 与子字段再 .volatile() 不能同时出现。
// 数组/dict 的内部元素是动态路径（`*`），因此永远不能在内层加 .volatile()；
// 想让整个列表可编辑，只能把 .volatile() 加在列表本身（得到整体可替换的引用）。
const styleEntrySchema = z.object({
  name: z.string().default(""),
  instruction: z.string().default(""),
});

const templateEntrySchema = z.object({
  name: z.string().default(""),
  text: z.string().default(""),
  category: z.string().default(""),
  tags: z.array(z.string()).default([]),
});

export const Config = z.object({
  // 固定改写模型（provider/model 两个字段，任一为 null 表示跟随全局默认）
  rewriteProvider: z.string().default("").volatile(),
  rewriteModel: z.string().default("").volatile(),
  timeoutMs: z.natural().min(5000).max(300000).default(REWRITE_TIMEOUT_MS).volatile(),
  // 是否附带最近对话背景，以及附带多少轮
  useContext: z.boolean().default(true).volatile(),
  contextRounds: z.natural().min(1).max(20).default(6).volatile(),
  // 共同纪律（改写链路 system prompt 主体）；空字符串表示「用内置默认」
  globalDiscipline: z.string().default("").volatile(),
  // 风格库 / 模板库：整体可替换（dict 内层不能单独 volatile）
  styles: z.dict(styleEntrySchema).default({}).volatile(),
  templates: z.dict(templateEntrySchema).default({}).volatile(),
  // 工具行：auto | always | never
  showStyleEntry: z.union([z.const("auto"), z.const("always"), z.const("never")]).default("auto").volatile(),
  showTemplateEntry: z.union([z.const("auto"), z.const("always"), z.const("never")]).default("auto").volatile(),
  compactThreshold: z.natural().min(160).max(1200).default(320).volatile(),
  // 快捷键（展示用字符串，实际拦截在浏览器半侧）
  shortcutStyle: z.string().default("Alt+M").volatile(),
  shortcutTemplate: z.string().default("Alt+T").volatile(),
  shortcutRewrite: z.string().default("Alt+R").volatile(),
});

// 兼容旧部署：cordis.patch.yml 里曾经写的是 { model }（单个对象），
// schemastery 会忽略未知字段，但旧值需要手动搬一次；这里提供一次性读取。
export function readLegacyPatchModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const m = raw.model;
  if (!m || typeof m !== "object") return null;
  if (typeof m.provider !== "string" || typeof m.model !== "string") return null;
  return { provider: m.provider, model: m.model };
}

function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "prompt-dock");
}

// 旧版独立配置文件：设置迁入官方存储后只读一次（回填），随后改名为 .migrated
function settingsPath() {
  return join(dataDir(), "settings.json");
}
function retiredSettingsPath() {
  return join(dataDir(), "settings.json.migrated");
}

/**
 * 官方配置文件位置：profile 的 cordis.patch.yml（configEditor.documentPath）。
 * 宿主没提供时返回空串，界面据此隐藏「打开配置文件」。
 */
function configDocumentPath(ctx) {
  try {
    const editor = ctx && typeof ctx.get === "function" ? ctx.get("configEditor") : undefined;
    const p = editor && editor.documentPath;
    return typeof p === "string" ? p : "";
  } catch (e) {
    return "";
  }
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

// ---- 设置存储：官方 Config（volatile 字段）为唯一事实来源 ----
// 旧版是 ~/.dsh/prompt-dock/settings.json 一整套独立 JSON；现在改成官方配置：
//   · 普通安装：用户在「插件」页的卡片里编辑，值落在 profile 的 cordis.patch.yml；
//   · 旧文件仍在时，启动后做一次幂等回填——只填官方配置里还没写过的字段，
//     然后把旧文件改名为 settings.json.migrated，之后不再读写它。

/** 读取 volatile 字段的当前值（schemastery 的 volatile 包装支持 .get()）。 */
function confValue(holder, fallback) {
  try {
    if (holder && typeof holder.get === "function") {
      const v = holder.get();
      return v === undefined ? fallback : v;
    }
    return holder === undefined ? fallback : holder;
  } catch (e) {
    return fallback;
  }
}

/** 把任意值收敛成字符串。 */
function asString(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

/** 把任意值收敛成整数并夹到 [min, max]。 */
function asInt(v, min, max, fallback) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** 清洗一条风格：id 由调用方保证唯一，名字与指令做长度截断。 */
function cleanStyle(id, entry) {
  const src = entry && typeof entry === "object" ? entry : {};
  return {
    id,
    name: asString(src.name).slice(0, MAX_STYLE_NAME),
    instruction: asString(src.instruction).slice(0, MAX_INSTRUCTION),
  };
}

/** 清洗一条模板：name/text/category/tags 全部按上限截断。 */
function cleanTemplate(id, entry) {
  const src = entry && typeof entry === "object" ? entry : {};
  const tags = Array.isArray(src.tags)
    ? src.tags
        .map((t) => asString(t).trim().slice(0, MAX_TAG_LEN))
        .filter(Boolean)
        .slice(0, MAX_TAGS)
    : [];
  return {
    id,
    name: asString(src.name).slice(0, MAX_TEMPLATE_NAME),
    text: asString(src.text).slice(0, MAX_TEMPLATE_TEXT),
    category: asString(src.category).slice(0, 40),
    tags,
  };
}

/** 把 dict 形式的风格库展开成按 id 排序的数组；空/损坏时回退内置默认。 */
function stylesToArray(dict) {
  const out = [];
  if (dict && typeof dict === "object") {
    for (const [id, entry] of Object.entries(dict)) {
      const cleaned = cleanStyle(id, entry);
      // custom 风格由用户的「自定义指令」提供，必须留空
      if (id === "custom") cleaned.instruction = "";
      out.push(cleaned);
    }
  }
  if (!out.length) return DEFAULT_STYLES.map((s) => ({ ...s }));
  // 稳定顺序：内置风格按默认顺序在前，其余按 id 字典序在后
  const order = DEFAULT_STYLES.map((s) => s.id);
  return out.sort((a, b) => {
    const ia = order.indexOf(a.id);
    const ib = order.indexOf(b.id);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.id.localeCompare(b.id);
  });
}

/** 把 dict 形式的模板库展开成数组；超过上限的按 id 字典序截断。 */
function templatesToArray(dict) {
  const out = [];
  if (dict && typeof dict === "object") {
    for (const [id, entry] of Object.entries(dict)) out.push(cleanTemplate(id, entry));
  }
  if (!out.length) return DEFAULT_TEMPLATES.map((t) => ({ ...t, category: t.category || "", tags: t.tags || [] }));
  return out.slice(0, MAX_TEMPLATES);
}

/** 把数组形式的风格/模板折叠回 dict 形式，供 Config 写入。 */
function arrayToDict(list, makeId, clean) {
  const dict = {};
  for (const row of Array.isArray(list) ? list : []) {
    const id = String(row && row.id ? row.id : makeId(row));
    if (!id || dict[id]) continue;
    dict[id] = clean(id, row);
  }
  return dict;
}

/**
 * 把运行时配置对象整理成界面/路由使用的扁平形状。
 * @param cfg 插件 Config 的已解析对象（含 volatile 包装）
 */
function normalizeConfig(cfg) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const discipline = asString(confValue(c.globalDiscipline, "")).slice(0, MAX_GLOBAL_DISCIPLINE);
  return {
    rewriteModel: (() => {
      // 两个字段都是字符串，空串表示「跟随全局默认」
      const provider = asString(confValue(c.rewriteProvider, ""));
      const model = asString(confValue(c.rewriteModel, ""));
      return provider && model ? { provider, model } : null;
    })(),
    timeoutMs: asInt(confValue(c.timeoutMs, REWRITE_TIMEOUT_MS), 5000, 300000, REWRITE_TIMEOUT_MS),
    contextEnabled: confValue(c.useContext, true) !== false,
    contextTurns: asInt(confValue(c.contextRounds, 6), 1, 20, 6),
    // 空字符串表示「沿用内置默认」；界面按只读+编辑切换
    globalDiscipline: discipline || DEFAULT_GLOBAL_DISCIPLINE,
    globalDisciplineCustom: !!discipline,
    styles: stylesToArray(confValue(c.styles, {})),
    templates: templatesToArray(confValue(c.templates, {})),
    toolbar: {
      showStyleEntry: confValue(c.showStyleEntry, "auto"),
      showTemplateEntry: confValue(c.showTemplateEntry, "auto"),
      compactThreshold: asInt(confValue(c.compactThreshold, 320), 160, 1200, 320),
    },
    shortcuts: {
      openStyle: asString(confValue(c.shortcutStyle, "Alt+M")),
      openTemplate: asString(confValue(c.shortcutTemplate, "Alt+T")),
      rewrite: asString(confValue(c.shortcutRewrite, "Alt+R")),
    },
  };
}

/** 供默认值/测试使用：与 normalizeConfig(默认 Config) 等价的扁平配置。 */
export function defaultSettings() {
  return normalizeConfig(defaultConfigObject());
}

/** 构造一份「全部为默认值」的 Config 对象（不经 schemastery 解析）。 */
function defaultConfigObject() {
  return {
    rewriteProvider: null,
    rewriteModel: null,
    timeoutMs: REWRITE_TIMEOUT_MS,
    useContext: true,
    contextRounds: 6,
    globalDiscipline: "",
    styles: Object.fromEntries(DEFAULT_STYLES.filter((s) => s.id !== "custom").map((s) => [s.id, { name: s.name, instruction: s.instruction }])),
    templates: Object.fromEntries(DEFAULT_TEMPLATES.map((t) => [t.id, { name: t.name, text: t.text, category: "", tags: [] }])),
    showStyleEntry: "auto",
    showTemplateEntry: "auto",
    compactThreshold: 320,
    shortcutStyle: "Alt+M",
    shortcutTemplate: "Alt+T",
    shortcutRewrite: "Alt+R",
  };
}

/**
 * 读取旧版独立配置文件（只用于一次性回填）。
 * @returns 旧形状的设置对象；文件不存在或损坏时返回 null
 */
async function readLegacySettings() {
  try {
    const raw = await fs.readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

/**
 * 把旧版设置转换成**扁平设置补丁**（与 writeConfig 的入参同一套键名）。
 * 只包含旧文件里**显式存在**的字段，让官方配置里已有的值优先（幂等回填的关键）。
 */
function legacyToConfigPatch(legacy) {
  const patch = {};
  if (!legacy || typeof legacy !== "object") return patch;

  if (Array.isArray(legacy.styles) && legacy.styles.length) {
    patch.styles = legacy.styles.map((row, i) => {
      const id = String((row && row.id) || `s-${i}`);
      return {
        id,
        name: asString(row && row.name).slice(0, MAX_STYLE_NAME),
        // custom 风格的改写指令由用户填写，回填时留空
        instruction: id === "custom" ? "" : asString(row && row.instruction).slice(0, MAX_INSTRUCTION),
      };
    });
  }
  if (Array.isArray(legacy.templates)) {
    patch.templates = legacy.templates.map((row, i) => cleanTemplate(String((row && row.id) || `t-${i}`), row));
  }
  if (typeof legacy.contextEnabled === "boolean") patch.contextEnabled = legacy.contextEnabled;
  if (typeof legacy.contextTurns === "number") patch.contextTurns = legacy.contextTurns;
  if (legacy.rewriteModel && legacy.rewriteModel.provider && legacy.rewriteModel.model) {
    patch.rewriteModel = { provider: String(legacy.rewriteModel.provider), model: String(legacy.rewriteModel.model) };
  }
  return patch;
}

// 回填是「一次、原子、幂等」的：每个插件实例（ctx）只做一次，之后整进程不再读旧文件。
// 多窗口/多进程同时启动时，rename 是原子操作，只有一方能成功，另一方看到 .migrated 即跳过。
const migrationByCtx = new WeakMap();

function migrateLegacySettings(ctx, cfg) {
  const cached = migrationByCtx.get(ctx);
  if (cached) return cached;
  const run = (async () => {
    const log = safeLogger(ctx);
    const retired = retiredSettingsPath();
    // 已经迁移过：不重复回填，但顺手清掉过期的 .migrated
    let alreadyRetired = false;
    try {
      const st = await fs.stat(retired);
      alreadyRetired = true;
      if (Date.now() - st.mtimeMs > RETIRED_SETTINGS_TTL_MS) {
        await fs.rm(retired, { force: true });
        log.info("prompt-dock: 已清理 30 天前的旧配置文件");
      }
    } catch {
      alreadyRetired = false;
    }
    if (alreadyRetired) return { migrated: false, reason: "already-retired" };

    const legacy = await readLegacySettings();
    if (!legacy) return { migrated: false, reason: "no-legacy-file" };

    const patch = legacyToConfigPatch(legacy);
    const fields = Object.keys(patch);
    if (!fields.length) {
      // 旧文件存在但没有可回填的字段：直接退休，避免每次启动重复解析
      await retireLegacyFile(retired);
      return { migrated: false, reason: "empty-legacy" };
    }

    // 官方配置里已经有值的字段不覆盖（幂等）。
    // 关键：不能用 cfg 上 volatile 的 .get() 判断——它返回的是 schema 默认值，
    // 用户是否真的设置过只有 settings.describe() 能区分（value 是当前值，user 是
    // profile 里显式写入的那部分）。没有 settings 服务时退化为“全部回填”。
    const explicit = await readExplicitUserConfig(ctx);
    const only = {};
    const written = [];
    for (const field of fields) {
      // explicit 里已经是布尔（该字段在官方存储里是否被用户显式写过）
      if (explicit && explicit[field]) continue;
      only[field] = patch[field];
      written.push(field);
    }
    if (written.length) {
      const r = await writeConfig(ctx, only);
      if (!r.ok) {
        // 写不进官方配置时保留旧文件，下次启动再试——数据不能丢
        log.warn(`prompt-dock: 旧配置回填失败（${r.reason}），保留 settings.json`);
        return { migrated: false, reason: r.reason };
      }
      log.info(`prompt-dock: 已将旧配置回填到官方设置（${written.join(", ")}）`);
    }

    // 写入成功（或没有需要写的字段）后退休旧文件，杜绝下次启动再读
    await retireLegacyFile(retired);
    return { migrated: true, fields: written };
  })().catch((e) => {
    // 迁移失败不应阻断插件启动；下次启动会再试
    migrationByCtx.delete(ctx);
    return { migrated: false, reason: "error" };
  });
  migrationByCtx.set(ctx, run);
  return run;
}

/**
 * 读取官方设置里**用户显式写入**的那部分字段（settings.describe() 的 `user`）。
 * 只有它能区分「用户设过」与「只是用了 schema 默认值」——cfg 上的 volatile 引用
 * 两者都返回默认值，不能用来做幂等判断。
 * @returns 扁平设置键 → 用户是否真的写过（布尔）；宿主没有 settings 服务时返回 null
 */
async function readExplicitUserConfig(ctx) {
  const settings = getService(ctx, "settings");
  if (!settings || typeof settings.describe !== "function") return null;
  let row;
  try {
    const rows = settings.describe();
    row = Array.isArray(rows) ? rows.find((r) => r && r.ns === CONFIG_NS) : undefined;
  } catch (e) {
    return null;
  }
  const user = row && row.user && typeof row.user === "object" ? row.user : {};
  const out = {};
  for (const [flat, configField] of SETTING_TO_CONFIG_FIELD) {
    const v = user[configField];
    out[flat] = v !== undefined && v !== null && v !== "" &&
      !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
  }
  return out;
}

// 扁平设置键 → 官方 Config 字段名。对外保持旧 API 形状，对内用 schema 字段；
// 回填幂等判断与写入映射都依赖这张表，避免两处各写一套再漂移。
const SETTING_TO_CONFIG_FIELD = new Map([
  ["rewriteModel", "rewriteModel"],
  ["timeoutMs", "timeoutMs"],
  ["contextEnabled", "useContext"],
  ["contextTurns", "contextRounds"],
  ["globalDiscipline", "globalDiscipline"],
  ["styles", "styles"],
  ["templates", "templates"],
  ["showStyleEntry", "showStyleEntry"],
  ["showTemplateEntry", "showTemplateEntry"],
  ["compactThreshold", "compactThreshold"],
  ["openStyle", "shortcutStyle"],
  ["openTemplate", "shortcutTemplate"],
  ["rewrite", "shortcutRewrite"],
]);

/** 原子地把旧配置文件改名为 .migrated；失败时保持原样（下次再试）。 */
async function retireLegacyFile(retired) {
  try {
    await fs.rename(settingsPath(), retired);
    return true;
  } catch (e) {
    return false;
  }
}

/** 从 ctx 取一个带 info/warn 的 logger，宿主没提供时退化为 console。 */
function safeLogger(ctx) {
  try {
    const logger = ctx && typeof ctx.get === "function" ? ctx.get("logger") : undefined;
    if (logger && typeof logger.info === "function") {
      return {
        info: (msg) => logger.info(msg),
        warn: (msg) => (typeof logger.warn === "function" ? logger.warn(msg) : logger.info(msg)),
      };
    }
  } catch (e) {}
  return { info: () => {}, warn: () => {} };
}

/** 读取规范化后的设置（Config 为唯一来源）。 */
async function loadSettings(cfg) {
  return normalizeConfig(cfg);
}

/**
 * 把一份扁平设置补丁写回官方设置存储的 volatile 字段。
 *
 * 关键事实（已核对 DSH 0.2.1-rc.2 源码）：Config 上的 volatile 字段只有 `.get()`，
 * 没有 `.set()`——volatile 值由 Loader 从 profile 的 cordis.patch.yml 重新解析产生，
 * 所以“改内存里那份 cfg”不会落盘。官方写入路径是 `settings` 服务：
 *   settings.mutate(entryId, ops, expectedRevision)
 * 它先做 volatile 路径校验，再经 configEditor.edit() 写 YAML 并触发 Loader 重组，
 * 新值随后出现在 cfg 的 volatile 引用上（同一引用，.get() 返回新值）。
 *
 * 这里按「字段 → 官方路径」的映射把扁平补丁翻成 set 操作。风格库/模板库是 dict，
 * 在官方 Config 里是整体 volatile 的单一字段，所以整份替换（set 顶层路径）。
 *
 * @param ctx 插件上下文（用来取 settings 服务）
 * @param patch 扁平设置补丁；只处理出现过的键
 * @returns {{ok: boolean, reason?: string, written?: string[]}}
 */
async function writeConfig(ctx, patch) {
  if (!patch || typeof patch !== "object") return { ok: true, written: [] };
  const ops = [];
  const written = [];
  const push = (field, value) => { ops.push({ op: "set", path: [field], value }); };

  if ("rewriteModel" in patch) {
    const rm = patch.rewriteModel;
    if (rm && typeof rm === "object" && rm.provider && rm.model) {
      push("rewriteProvider", String(rm.provider));
      push("rewriteModel", String(rm.model));
    } else {
      // 空串 = 跟随全局默认（schemastery 的 string 字段不接受 null）
      push("rewriteProvider", "");
      push("rewriteModel", "");
    }
    written.push("rewriteModel");
  }
  if (typeof patch.timeoutMs === "number") {
    push("timeoutMs", asInt(patch.timeoutMs, 5000, 300000, REWRITE_TIMEOUT_MS));
    written.push("timeoutMs");
  }
  if (typeof patch.contextEnabled === "boolean") {
    push("useContext", patch.contextEnabled);
    written.push("contextEnabled");
  }
  if (typeof patch.contextTurns === "number") {
    push("contextRounds", asInt(patch.contextTurns, 1, 20, 6));
    written.push("contextTurns");
  }
  if (typeof patch.globalDiscipline === "string") {
    // 与默认一致时存空串，让后续版本改进默认文案能自动生效
    const v = patch.globalDiscipline.trim();
    push("globalDiscipline", v === DEFAULT_GLOBAL_DISCIPLINE ? "" : v.slice(0, MAX_GLOBAL_DISCIPLINE));
    written.push("globalDiscipline");
  }
  if (Array.isArray(patch.styles)) {
    push("styles", arrayToDict(patch.styles, (row, i) => `s-${i}`, (id, row) => ({
      name: asString(row && row.name).slice(0, MAX_STYLE_NAME),
      instruction: id === "custom" ? "" : asString(row && row.instruction).slice(0, MAX_INSTRUCTION),
    })));
    written.push("styles");
  }
  if (Array.isArray(patch.templates)) {
    push("templates", arrayToDict(patch.templates, (row, i) => `t-${i}`, cleanTemplate));
    written.push("templates");
  }
  if (patch.toolbar && typeof patch.toolbar === "object") {
    const t = patch.toolbar;
    const oneOf = (v, fallback) => (v === "auto" || v === "always" || v === "never" ? v : fallback);
    if ("showStyleEntry" in t) { push("showStyleEntry", oneOf(t.showStyleEntry, "auto")); written.push("showStyleEntry"); }
    if ("showTemplateEntry" in t) { push("showTemplateEntry", oneOf(t.showTemplateEntry, "auto")); written.push("showTemplateEntry"); }
    if (typeof t.compactThreshold === "number") {
      push("compactThreshold", asInt(t.compactThreshold, 160, 1200, 320));
      written.push("compactThreshold");
    }
  }
  if (patch.shortcuts && typeof patch.shortcuts === "object") {
    const s = patch.shortcuts;
    if (typeof s.openStyle === "string") { push("shortcutStyle", s.openStyle.slice(0, 40)); written.push("openStyle"); }
    if (typeof s.openTemplate === "string") { push("shortcutTemplate", s.openTemplate.slice(0, 40)); written.push("openTemplate"); }
    if (typeof s.rewrite === "string") { push("shortcutRewrite", s.rewrite.slice(0, 40)); written.push("rewrite"); }
  }

  if (!ops.length) return { ok: true, written: [] };

  // 首选官方 settings 服务；缺失时明确失败，而不是“假装保存成功”
  const settings = getService(ctx, "settings");
  if (settings && typeof settings.mutate === "function") {
    try {
      await settings.mutate(CONFIG_NS, ops);
      return { ok: true, written };
    } catch (e) {
      return { ok: false, reason: "settings-mutate-failed" };
    }
  }

  // 兜底：老版本直接改入口配置（没有 settings 服务时）
  const editor = getService(ctx, "configEditor");
  if (editor && typeof editor.edit === "function" && typeof editor.entries === "function") {
    try {
      const entry = editor.entries().find((row) => row.options && row.options.id === CONFIG_NS);
      if (!entry) return { ok: false, reason: "no-config-entry" };
      await editor.edit(entry, (raw) => {
        const next = { ...(raw || {}) };
        for (const op of ops) next[op.path[0]] = op.value;
        return next;
      });
      return { ok: true, written };
    } catch (e) {
      return { ok: false, reason: "config-editor-failed" };
    }
  }
  return { ok: false, reason: "no-settings-service" };
}

/** 取一个宿主服务，取不到或抛错时返回 undefined（不中断请求处理）。 */
function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === "function" ? ctx.get(name) : undefined;
  } catch (e) {
    return undefined;
  }
}

// 探针里不允许落盘的字段：任何可能承载草稿原文的键名
const DRAFT_KEYS = new Set(["draft", "draftGuess", "text", "content", "value", "clipboardText", "prompt", "original"]);

/**
 * 递归剔除探针载荷里的草稿原文。
 * 字符串型草稿字段替换为 `{ chars: n }`，保留形状信息但绝不留下内容。
 * @param node 任意 JSON 形状的值
 * @param depth 递归深度（防御循环引用/超深结构）
 */
function redactProbe(node, depth = 0) {
  if (depth > 6) return "[depth]";
  if (Array.isArray(node)) return node.map((v) => redactProbe(v, depth + 1));
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, v] of Object.entries(node)) {
      if (DRAFT_KEYS.has(key)) {
        out[key] = typeof v === "string" ? { chars: v.length, redacted: true } : { redacted: true };
        continue;
      }
      out[key] = redactProbe(v, depth + 1);
    }
    return out;
  }
  return node;
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

  const settings = normalizeConfig(cfg);
  const styleId = typeof body.styleId === "string" ? body.styleId : "concise";
  let instruction = "";
  if (styleId === "custom") {
    // 「自定义」风格的指令来自该风格自身的 instruction（设置卡片里可编辑），
    // 请求体里的 customInstruction 作为一次性的临时覆盖
    const custom = settings.styles.find((s) => s.id === "custom");
    instruction = (typeof body.customInstruction === "string" && body.customInstruction.trim())
      || (custom && custom.instruction)
      || "";
  } else {
    const style = settings.styles.find((s) => s.id === styleId);
    instruction = style ? style.instruction : settings.styles[0].instruction;
  }
  if (!instruction) throw apiError("NO_INSTRUCTION", "缺少改写指令");

  // 模型优先级：settings.rewriteModel（可用性校验通过）→ 全局默认
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

  // system prompt = 共同纪律 + 风格指令（纪律在前，风格在后，风格只做增量约束）
  const discipline = settings.globalDiscipline || DEFAULT_GLOBAL_DISCIPLINE;
  const system = discipline + "\n\n" + (context ? CONTEXT_NOTE + "\n\n" : "") + "【本次风格指令】\n" + instruction;

  const userPrompt =
    (context ? `【会话背景（仅供理解指代，禁止复述进输出）】\n${context}\n\n` : "") +
    `【待改写草稿】\n${text}`;

  return {
    llm, provider, model, system, userPrompt, contextUsed: !!context, modelFallback,
    timeoutMs: settings.timeoutMs || REWRITE_TIMEOUT_MS,
    draftChars: text.length,
  };
}

function openLLMStream(prep, signal) {
  return prep.llm.stream({
    provider: prep.provider,
    model: prep.model,
    system: prep.system,
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
  let timer = null;
  try {
    const prep = await prepareRewrite(ctx, cfg, body);
    timer = setTimeout(() => abort.abort(), prep.timeoutMs);
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
    if (timer) clearTimeout(timer);
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
  let timer = null;
  const onCancel = () => abort.abort();
  cancelHooks.set(requestId, onCancel);

  let success = false;
  try {
    admit(requestId);
    const prep = await prepareRewrite(ctx, cfg, body);
    timer = setTimeout(() => abort.abort(), prep.timeoutMs);
    send("meta", {
      requestId, provider: prep.provider, model: prep.model,
      contextUsed: prep.contextUsed, modelFallback: prep.modelFallback,
      draftChars: prep.draftChars, timeoutMs: prep.timeoutMs,
    });

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
    if (timer) clearTimeout(timer);
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

  // 旧版 settings.json → 官方 Config 的一次性幂等回填。
  // 不阻塞插件挂载，但 config 路由会 await 它，保证界面第一次读到的就是回填后的结果。
  // 返回值供测试/宿主等待回填完成。
  const migrated = migrateLegacySettings(ctx, cfg);
  ctx.effect(() => () => {}, "dsh-prompt-dock: migration");
  apply.migrated = migrated;
  // 迁移结果只报告一次：界面据此知道“刚才回填过”，之后每次读取不再重复提示
  let migrateAcknowledged = false;

  ctx.effect(() => {
    const offs = [];

    offs.push(webServer.register({
      kind: "exact", path: "/api/prompt-dock/config",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          const m = await migrated;
          if (req.method === "GET") {
            json(res, 200, {
              ok: true, version: VERSION,
              // 设置已迁入官方存储；这里只报告旧文件位置供诊断，界面不再写它
              legacyPath: settingsPath(),
              storage: "config",
              migrated: (() => {
                const once = !!(m && m.migrated) && !migrateAcknowledged;
                migrateAcknowledged = true;
                return once;
              })(),
              ...normalizeConfig(cfg),
            });
            return;
          }
          if (req.method === "POST") {
            // 兼容旧客户端的保存：按字段写进官方设置，未提交的字段保持现值
            const body = await readJsonBody(req);
            const r = await writeConfig(ctx, body);
            if (!r.ok) {
              json(res, 409, { ok: false, version: VERSION, error: { code: "SAVE_FAILED", message: "设置未能写入官方存储，请在插件页的配置卡片里修改", params: { reason: r.reason || "" } } });
              return;
            }
            json(res, 200, { ok: true, version: VERSION, storage: "config", written: r.written || [], ...normalizeConfig(cfg) });
            return;
          }
          json(res, 405, { ok: false, error: { code: "METHOD", message: "仅支持 GET/POST" } });
        } catch (e) {
          json(res, 400, { ok: false, error: { code: e.code || String(e.message || e), message: String(e.message || e) } });
        }
      },
    }));

    // 打开配置文件所在位置：设置已迁入官方存储，这里打开的是 profile 的 patch 文件
    offs.push(webServer.register({
      kind: "exact", path: "/api/prompt-dock/open-config",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          if (req.method !== "POST") { json(res, 405, { ok: false, error: { code: "METHOD", message: "仅支持 POST" } }); return; }
          const file = configDocumentPath(ctx);
          if (!file) {
            json(res, 404, { ok: false, error: { code: "NO_DOCUMENT", message: "宿主未提供配置文件路径" } });
            return;
          }
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

    // 开发期探针：客户端上报 props 形状，便于适配 inputActions 真实 API。
    // 隐私：绝不落盘草稿原文——draft/text/content 一类字段在写入前统一剔除，
    // 只保留结构性信息（键名、类型、字符数）。
    offs.push(webServer.register({
      kind: "exact", path: "/api/prompt-dock/probe",
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          if (req.method !== "POST") { json(res, 405, { ok: false, error: { code: "METHOD" } }); return; }
          const body = await readJsonBody(req);
          await fs.mkdir(dataDir(), { recursive: true });
          await fs.writeFile(join(dataDir(), "probe.json"), JSON.stringify(redactProbe(body), null, 2), "utf8");
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


















