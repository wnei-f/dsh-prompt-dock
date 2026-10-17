/* dsh-prompt-dock —— 客户端半 v0.18
 * 布局：conversation.input.right（composer 工具行、模型选择左侧）。
 * 工具行顺序：上下文-模板-风格-改写/取消-设置（撤销临时出现在改写与设置之间）。
 * v0.18 对齐吸收清单：
 *  - 芯片保护：草稿含 @文件 / /命令 芯片时禁用改写（写回纯文本会摧毁芯片）；
 *  - 变更检测：改写期间草稿被改动则不回填，提示重新改写；
 *  - 只走 inputActions.setDraft，移除方法名启发式降级（猜 API 比显式报错更难排查）；
 *  - SSE 流式改写：改写中按钮变「取消」，边流边预览；
 *  - 结构化错误码本地化（AUTH/RATE_LIMIT/QUOTA/CONTEXT_WINDOW/TIMEOUT...）。
 * 视觉基准：官方模型选择下拉框（ModelSelect.module.css / MenuSurface 实测值）。
 */
window.__ModuleLoader__.load({
  id: "dsh-prompt-dock",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;
    var useMemo = React.useMemo;
    var h = React.createElement;

    // ---- 样式注入（数值/令牌取自模型选择下拉框真实 CSS；v0.18 新增预览与禁用态说明） ----
    var CSS_TEXT = [
      ".pd-btn{",
      "  box-sizing:border-box;height:28px;border-radius:var(--dsw-radius-sm,6px);",
      "  color:var(--dsw-alias-label-secondary,#666);background:transparent;border:none;outline:none;",
      "  display:inline-flex;align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:400;",
      "  line-height:20px;cursor:pointer;white-space:nowrap;flex:none;max-width:200px;",
      "  transition:background-color .12s;}",
      ".pd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}",
      ".pd-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));}",
      ".pd-btn:disabled{color:var(--dsw-alias-label-dimmed,#bbb);cursor:default;}",
      ".pd-btnPrimary{color:var(--dsw-alias-button-info-fill,var(--dsw-alias-state-business-primary,#4d6bfe));}",
      ".pd-btnQuiet{color:var(--dsw-alias-label-secondary,#666);}",
      ".pd-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden;}",
      ".pd-chevron{color:var(--dsw-alias-label-caption,#999);flex:none;display:block;transition:transform .12s;}",
      ".pd-chevronOpen{transform:rotate(180deg);}",
      // —— 上下文开关：纯 CSS 迷你开关（轨道 + 滑钮），无图标 ——
      ".pd-toggle{padding-left:6px;}",
      ".pd-toggleTrack{",
      "  box-sizing:border-box;width:36px;height:20px;padding:2px;flex:none;border-radius:999px;border:0;",
      "  background:var(--dsw-alias-border-l3,#c2c2c2);",
      "  position:relative;transition:background-color .12s;}",
      ".pd-toggleKnob{",
      "  position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;",
      "  background:var(--dsw-alias-switch-thumb,#fff);transition:transform .12s ease;}",
      ".pd-toggleOn{color:var(--dsw-alias-brand-primary,#4d6bfe);}",
      ".pd-toggleOn .pd-toggleTrack{background:var(--dsw-alias-brand-primary,#4d6bfe);}",
      ".pd-toggleOn .pd-toggleKnob{transform:translateX(16px);}",
      ".pd-toggle:disabled .pd-toggleTrack,.pd-toggle[aria-disabled=\"true\"] .pd-toggleTrack{opacity:.45;}",
      ".pd-toggle:disabled .pd-toggleKnob,.pd-toggle[aria-disabled=\"true\"] .pd-toggleKnob{opacity:.45;}",
      // 菜单面板（对齐 .menu + MenuSurface：radius-lg、menu-surface-fill、elevation-prominent）
      ".pd-menu{",
      "  box-sizing:border-box;z-index:2147483000;position:fixed;display:flex;flex-direction:column;",
      "  min-width:76px;max-width:min(320px,100vw - 32px);max-height:min(360px,100vh - 96px);overflow:hidden auto;",
      "  padding:4px;border-radius:var(--dsw-radius-lg,10px);border:0;",
      "  background:var(--dsw-specific-menu,var(--dsw-menu-surface-fill,var(--dsw-alias-bg-overlay,#fff)));",
      "  -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);backdrop-filter:var(--dsw-menu-backdrop-filter,none);",
      "  box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.25)),0 0 0 1px var(--dsw-alias-border-l1,#d0d0d0);",
      "  color:var(--dsw-alias-label-primary,#333);font-size:13px;",
      "  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.35));",
      "  --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2,rgba(128,128,128,.55));}",
      ".pd-menu::-webkit-scrollbar,.pd-pop::-webkit-scrollbar{width:8px;}",
      ".pd-menu::-webkit-scrollbar-thumb,.pd-pop::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,rgba(128,128,128,.35));border-radius:4px;}",
      ".pd-menu::-webkit-scrollbar-thumb:hover,.pd-pop::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover,rgba(128,128,128,.55));}",
      // 选项行（对齐 .option：34px、radius-md、hover 高亮、选中仅 ✓、disabled dimmed）
      ".pd-option{",
      "  box-sizing:border-box;border-radius:var(--dsw-radius-md,8px);width:auto;min-width:100%;min-height:34px;",
      "  color:inherit;text-align:left;cursor:pointer;background:transparent;border:none;outline:none;",
      "  display:flex;align-items:center;gap:6px;padding:5px 7px;",
      "  transition:background-color .12s;}",
      ".pd-option:hover:not(:disabled),.pd-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}",
      ".pd-option:disabled{color:var(--dsw-alias-label-dimmed,#bbb);cursor:default;}",
      ".pd-optionCopy{display:flex;flex:1;min-width:0;flex-direction:column;}",
      ".pd-optionName{min-width:0;max-width:100%;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:400;line-height:18px;overflow:hidden;}",
      // 选中态：不再用 ✓（与官方整体风格不统一），改为底色 + 细阴影描边
      ".pd-optionOn{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2,#c2c2c2);}",
      // 二级菜单：右侧树形展开时，父级分类用 hover 底色标记当前展开项
      ".pd-optionOpen{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}",
      ".pd-btnIconOnly{padding:0 7px;}",
      // 悬浮卡（设置）：同款 surface 配方
      ".pd-pop{",
      "  box-sizing:border-box;z-index:2147483000;position:fixed;display:flex;flex-direction:column;",
      "  border-radius:var(--dsw-radius-lg,10px);",
      // 与菜单同一材质：半透明填充 + 模糊（靠 data-menu-material 属性触发官方令牌）
      "  background:var(--dsw-specific-menu,var(--dsw-menu-surface-fill,var(--dsw-alias-bg-overlay,#fff)));",
      "  -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,none);backdrop-filter:var(--dsw-menu-backdrop-filter,none);",
      "  box-shadow:var(--dsw-elevation-prominent,0 12px 32px rgba(0,0,0,.28)),0 0 0 1px var(--dsw-alias-border-l1,#d0d0d0);",
      "  color:var(--dsw-alias-label-primary,#333);font-size:13px;line-height:20px;padding:12px;",
      "  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgba(128,128,128,.35));",
      "  --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2,rgba(128,128,128,.55));}",
      ".pd-popHead{display:flex;align-items:center;color:var(--dsw-alias-label-primary,#333);font-size:13px;font-weight:600;line-height:20px;margin-bottom:10px;flex:none;}",
      ".pd-foot{display:flex;gap:6px;align-items:center;justify-content:flex-end;border-top:1px solid var(--dsw-alias-border-l1,#e0e0e0);padding-top:10px;margin-top:2px;}",
      ".pd-iconBtn{",
      "  box-sizing:border-box;width:24px;height:24px;border:none;outline:none;background:transparent;",
      "  border-radius:50%;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;",
      "  display:inline-flex;align-items:center;justify-content:center;padding:0;flex:none;font-size:12px;",
      "  transition:background-color .12s;}",
      ".pd-iconBtn:hover:not(:disabled),.pd-iconBtn:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));outline:none;}",
      ".pd-input,.pd-textarea{",
      "  box-sizing:border-box;width:100%;max-width:100%;resize:vertical;",
      "  border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l1,#c9c9c9);",
      "  background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#333);",
      "  font-size:13px;line-height:18px;padding:5px 7px;outline:none;transition:border-color .12s;}",
      ".pd-input:focus,.pd-textarea:focus{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);}",
      ".pd-err{font-size:12px;line-height:16px;color:var(--dsw-alias-state-error-primary,#dc2626);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".pd-tabs{display:flex;gap:2px;justify-content:flex-end;border-bottom:1px solid var(--dsw-alias-border-l1,#e0e0e0);margin-bottom:12px;}",
      ".pd-tab{",
      "  box-sizing:border-box;height:30px;padding:0 10px;border:none;outline:none;background:transparent;cursor:pointer;",
      "  font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#666);border-bottom:2px solid transparent;",
      "  margin-bottom:-1px;border-radius:var(--dsw-radius-sm,6px) var(--dsw-radius-sm,6px) 0 0;transition:color .12s,background-color .12s;}",
      ".pd-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12));}",
      ".pd-tabOn{color:var(--dsw-alias-state-business-primary,#4d6bfe);border-bottom-color:var(--dsw-alias-state-business-primary,#4d6bfe);font-weight:500;}",
      ".pd-field{margin-bottom:14px;}",
      ".pd-fieldLabel{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#333);margin-bottom:4px;}",
      ".pd-help{font-size:12px;line-height:17px;color:var(--dsw-alias-label-caption,#999);margin-top:4px;}",
      ".pd-switchRow{display:flex;align-items:center;justify-content:space-between;gap:10px;}",
      ".pd-tplCard{",
      "  border:1px solid var(--dsw-alias-border-l1,#e0e0e0);border-radius:var(--dsw-radius-md,8px);",
      "  padding:10px;margin-bottom:10px;}",
      ".pd-tplName{font-size:13px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary,#333);text-overflow:ellipsis;white-space:nowrap;overflow:hidden;}",
      ".pd-tplSum{font-size:12px;line-height:17px;color:var(--dsw-alias-label-caption,#999);text-overflow:ellipsis;white-space:nowrap;overflow:hidden;margin-top:1px;}",
      // 改写状态与撤销共用同一个槽位：进行中显示状态文字，完成后原地变成 ↩
      ".pd-status{font-size:12px;line-height:20px;height:28px;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary,#888);white-space:nowrap;flex:none;}",
    ].join("\n");
    var cssInjected = false;
    function ensureCss() {
      if (cssInjected) return;
      if (document.querySelector('style[data-plugin-css="dsh-prompt-dock"]')) { cssInjected = true; return; }
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-prompt-dock";
      tag.dataset.pluginCss = "dsh-prompt-dock";
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
      cssInjected = true;
    }

    var DEFAULT_STYLES = [
      { id: "concise", name: "更简洁" }, { id: "detailed", name: "更详细" },
      { id: "structured", name: "结构化" }, { id: "en", name: "译成英文" }, { id: "custom", name: "自定义" },
    ];

    // ---- 错误码本地化（与宿主半的结构化错误码一一对应） ----
    var ERROR_TEXT = {
      AUTH: "模型凭证无效，请检查 API Key",
      AUTH_FORBIDDEN: "仅允许本机访问改写接口",
      RATE_LIMIT: "调用太频繁，请稍后再试",
      CONCURRENCY_LIMIT: "已有改写在进行中，请稍候",
      QUOTA: "模型额度不足，请充值后重试",
      CONTEXT_WINDOW: "内容超出模型上下文长度",
      TIMEOUT: "改写超时，请重试",
      EMPTY_TEXT: "草稿为空",
      TEXT_OVER: "草稿过长",
      NO_INSTRUCTION: "缺少改写指令",
      NO_MODEL: "未找到可用的改写模型",
      NO_LLM: "模型服务不可用",
      EMPTY_REPLY: "模型返回为空",
      LLM_FAILED: "模型调用失败",
      BAD_JSON: "请求格式有误",
      BODY_OVER_SIZE: "内容过长",
      METHOD: "请求方法不被支持",
      INTERNAL: "插件内部错误",
    };
    function errorText(err) {
      if (!err) return "改写失败";
      var base = ERROR_TEXT[err.code];
      if (!base) return err.message || err.code || "改写失败";
      // 后端给了更具体的文案（如带等待秒数的限流）时优先用它
      return err.message && err.code === "RATE_LIMIT" ? err.message : base;
    }

    // ---- 芯片检测：草稿含 @文件 / /命令 引用时禁止改写 ----
    // 权威依据（取自宿主 dsh-client-ui-conversation 的 SessionInputShell.compose()）：
    //   发布的 InputState = { draft: projection.clipboardText, draftRev, phase, occurrences, ... }
    //   occurrences 即引用芯片列表（元素形如 { source, ref, offset, length, label, clipboardText }）。
    // 而 inputActions.setDraft(text) 内部会 text.replace(REFERENCE_PLACEHOLDER_RE, "") 并重建段落
    //   —— 回填会抹掉全部芯片。故只要 occurrences 非空就拒绝改写。
    var REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/u;

    function chipFromState(inputState) {
      if (!inputState || typeof inputState !== "object") return "";
      try {
        // 主路径：宿主发布的 occurrences
        var occ = inputState.occurrences;
        if (Array.isArray(occ) && occ.length) {
          var o = occ[0] || {};
          return String(o.label || o.clipboardText || o.ref || "引用芯片");
        }
        // 兼容其它发布形状（草稿快照对象 / 命令）
        var snap = inputState.draft;
        if (snap && typeof snap === "object") {
          var refs = snap.references;
          if (Array.isArray(refs) && refs.length) {
            var r = refs[0] || {};
            return String(r.label || r.clipboardText || r.ref || "引用芯片");
          }
          if (snap.command && typeof snap.command.token === "string" && snap.command.token) return snap.command.token;
        }
        var cmd = inputState.command;
        if (cmd && typeof cmd.token === "string" && cmd.token) return cmd.token;
        // 编辑器 detect 投影里的占位符：仅在草稿文本含私有区字符时命中
        if (typeof inputState.text === "string" && REFERENCE_PLACEHOLDER_RE.test(inputState.text)) return "引用芯片";
      } catch (e) {}
      return "";
    }

    function collectChipFragments(props) {
      var out = [];
      try {
        var chips = props.chips || (props.inputActions && props.inputActions.chips) || null;
        if (Array.isArray(chips)) {
          for (var i = 0; i < chips.length; i++) {
            var c = chips[i];
            if (!c) continue;
            if (typeof c === "string") out.push(c);
            else if (typeof c.text === "string") out.push(c.text);
            else if (typeof c.label === "string") out.push(c.label);
            else if (c.value != null) out.push(String(c.value));
          }
        }
      } catch (e) {}
      return out;
    }
    // 返回命中的芯片文本；没有则返回空串
    function detectChip(draft, fragments, inputState) {
      var fromState = chipFromState(inputState);
      if (fromState) return fromState;
      var d = draft || "";
      if (!d) return "";
      if (REFERENCE_PLACEHOLDER_RE.test(d)) return "引用芯片";
      for (var i = 0; i < fragments.length; i++) {
        var frag = fragments[i];
        if (frag && d.indexOf(frag) >= 0) return frag;
      }
      // 无结构化信息时的保守文本兜底：@文件路径 或 行首 /命令
      var m = d.match(/(^|\s)@[^\s@]+\.[A-Za-z0-9]{1,8}\b/);
      if (m) return m[0].trim();
      var c = d.match(/(^|\n)\s*\/[a-zA-Z][\w:-]*/);
      if (c) return c[0].trim();
      return "";
    }

    // ---- 模块级共享状态（工具行与浮层共用） ----
    var store = {
      conf: null, styleId: "concise", error: "", undo: null, settingsOpen: false,
      models: null, modelsGlobal: null,
      // 配置文件绝对路径（界面显示 + 打开用）
      configPath: "",
      // 流式改写状态：busy 期间工具行显示「改写中…」，完成后同一槽位变撤销
      busy: false, requestId: "",
    };
    var subs = [];
    var currentAbort = null;
    function setStore(patch) {
      store = Object.assign({}, store, patch);
      for (var i = 0; i < subs.length; i++) { try { subs[i](); } catch (e) {} }
    }
    function useStore() {
      var tick = useState(0);
      useEffect(function () {
        var f = function () { tick[1](function (x) { return x + 1; }); };
        subs.push(f);
        return function () { subs = subs.filter(function (g) { return g !== f; }); };
      }, []);
      return store;
    }

    function api(path, body) {
      if (body === undefined) return fetch(path, { cache: "no-store" }).then(function (r) { return r.json(); });
      return fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); });
    }

    // 读取配置文件（界面与手工编辑同一份文件；打开设置面板时会重新读，外部改动即时可见）
    var confRequested = false;
    function fetchConf() {
      return api("/api/prompt-dock/config").then(function (j) {
        if (j && j.ok) setStore({ conf: j, configPath: j.settingsPath || "" });
        return j;
      }).catch(function () { return null; });
    }
    function ensureConf() {
      if (confRequested) return;
      confRequested = true;
      fetchConf();
    }
    function reloadConf() { return fetchConf(); }
    // 打开配置文件所在位置（系统文件管理器）
    // 注意：客户端 bundle 刷新即更新，但宿主路由只在进程启动时注册，
    // 所以这里要能区分「接口不存在（需重启宿主）」和「打开动作失败」。
    function openConfigFile() {
      fetch("/api/prompt-dock/open-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        cache: "no-store",
      }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) {
          if (r.ok && j && j.ok) { setStore({ error: "" }); return; }
          if (r.status === 404) {
            setStore({ error: "宿主未加载该接口，请重启 DSH 后再试" });
            return;
          }
          var msg = (j && j.error && (j.error.message || j.error.code)) || ("打开失败（HTTP " + r.status + "）");
          setStore({ error: msg });
        });
      }).catch(function () { setStore({ error: "打开配置文件失败（网络错误）" }); });
    }
    var modelsLoading = false;
    function ensureModels() {
      if (store.models || modelsLoading) return;
      modelsLoading = true;
      api("/api/prompt-dock/models").then(function (j) {
        modelsLoading = false;
        if (j && j.ok) setStore({ models: j.groups || [], modelsGlobal: j.global || null });
      }).catch(function () { modelsLoading = false; });
    }
    function saveConfig(next) {
      api("/api/prompt-dock/config", next).then(function (j) {
        if (j && j.ok) setStore({ conf: j, error: "" });
        else setStore({ error: (j && j.error && (j.error.message || j.error.code)) || "保存失败" });
      }).catch(function () { setStore({ error: "保存失败" }); });
    }

    function pickDraftText(s) {
      if (!s || typeof s !== "object") return "";
      var v = s.draft;
      if (typeof v === "string") return v;
      // 宿主若发布草稿快照对象，则取其中的 text
      if (v && typeof v === "object" && typeof v.text === "string") return v.text;
      v = s.text; if (typeof v === "string") return v;
      v = s.value; if (typeof v === "string") return v;
      v = s.content; if (typeof v === "string") return v;
      return "";
    }

    // ---- 草稿写回：只走官方 setDraft，显式失败（不再猜测其它方法名） ----
    function waitVerify(getDraft, expected) {
      return new Promise(function (resolve) {
        var t0 = Date.now();
        var iv = setInterval(function () {
          if (getDraft() === expected) { clearInterval(iv); resolve(true); }
          else if (Date.now() - t0 > 800) { clearInterval(iv); resolve(false); }
        }, 40);
      });
    }
    function writeDraft(actions, text, getDraft) {
      var fn = actions && actions.setDraft;
      if (typeof fn !== "function") {
        return Promise.resolve({ ok: false, reason: "NO_SETTER" });
      }
      try { fn.call(actions, text); } catch (e) {
        return Promise.resolve({ ok: false, reason: "THROW", detail: String((e && e.message) || e) });
      }
      return waitVerify(getDraft, text).then(function (ok) {
        return ok ? { ok: true } : { ok: false, reason: "NOT_APPLIED" };
      });
    }
    function writeDraftError(r) {
      if (r.reason === "NO_SETTER") return "当前宿主不支持改写回填（缺少 setDraft）";
      if (r.reason === "NOT_APPLIED") return "写入输入框未生效";
      return "写入输入框失败：" + (r.detail || r.reason);
    }

    function useDraftState(props) {
      var stateJson = props.useInput(function (s) {
        try { return JSON.stringify(s, function (k, v) { return typeof v === "function" ? "[fn]" : v; }); }
        catch (e) { return ""; }
      });
      var inputState = useMemo(function () {
        try { return JSON.parse(stateJson || "{}"); } catch (e) { return {}; }
      }, [stateJson]);
      var draft = pickDraftText(inputState);
      var ref = useRef(draft);
      ref.current = draft;
      return { draft: draft, inputState: inputState, getDraft: function () { return ref.current; } };
    }

    // ---- 跟随锚点重定位的浮层外壳（滚动/缩放实时跟随） ----
    function useAnchorFollow(anchorRef, onClose, escEnabled) {
      var tick = useState(0);
      useEffect(function () {
        var f = function () { tick[1](function (x) { return x + 1; }); };
        window.addEventListener("resize", f);
        window.addEventListener("scroll", f, true);
        var onKey = escEnabled ? function (e) { if (e.key === "Escape") onClose(); } : null;
        if (onKey) document.addEventListener("keydown", onKey);
        return function () {
          window.removeEventListener("resize", f);
          window.removeEventListener("scroll", f, true);
          if (onKey) document.removeEventListener("keydown", onKey);
        };
      }, []);
      var el = anchorRef.current;
      var r = el ? el.getBoundingClientRect() : null;
      return r ? { left: r.left, top: r.top, width: r.width, right: r.right, bottom: r.bottom } : null;
    }

    // ---- 下拉菜单（右缘对齐触发控件；二级菜单在右侧以树形浮层展开，不替换父级） ----
    function Menu(props) {
      var ref = useRef(null);
      var anchor = useAnchorFollow(props.anchorRef, props.onClose, true);
      var subState = useState(null);   // { item, top }
      var sub = subState[0]; var setSub = subState[1];
      useEffect(function () {
        function onDoc(e) {
          if (e && e.target && typeof e.target.closest === "function" && e.target.closest("[data-pd-menu]")) return;
          if (ref.current && !ref.current.contains(e.target)) props.onClose();
        }
        document.addEventListener("mousedown", onDoc);
        return function () { document.removeEventListener("mousedown", onDoc); };
      }, []);
      if (!anchor) return null;

      // 宽度由内容决定：用 right 对齐锚点右缘，面板向左生长。
      var maxW = Math.min(320, Math.max(76, anchor.right - 8));
      function openSub(it) {
        setSub({ item: it });
      }
      function renderRow(it, opts) {
        var isSub = !!(it.submenu && it.submenu.length);
        var active = it.active || it.id === props.activeId;
        var openNow = !!(sub && sub.item.id === it.id);
        return h("div", {
          key: it.id,
          // 选中态用底色 + 细阴影描边；展开中的分类用 hover 底色
          className: "pd-option" + (active ? " pd-optionOn" : "") +
            (isSub ? " pd-optionSub" : "") + (openNow ? " pd-optionOpen" : ""),
          role: "menuitem",
          tabIndex: 0,
          onMouseEnter: isSub && !opts.inSub ? function (e) { openSub(it); } : undefined,
          // 关键：在 mousedown 阶段就提交选择。
          // 文档级「点击外部关闭」可能先触发并卸载菜单，导致 click 永远不会到达。
          onMouseDown: function (e) {
            if (e) {
              if (typeof e.preventDefault === "function") e.preventDefault();
              if (typeof e.stopPropagation === "function") e.stopPropagation();
              if (e.nativeEvent && typeof e.nativeEvent.stopPropagation === "function") e.nativeEvent.stopPropagation();
            }
            if (isSub && !opts.inSub) { openSub(it); return; }
            props.onPick(it);
          },
          onClick: function (e) {
            // mousedown 已提交；这里只阻止冒泡，避免重复触发
            if (e && typeof e.stopPropagation === "function") e.stopPropagation();
          },
          onKeyDown: function (e) {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              if (isSub && !opts.inSub) { openSub(it); return; }
              props.onPick(it);
            }
          },
        },
          // 文本可能被省略号截断，title 保证完整内容可读
          h("span", { className: "pd-optionCopy" }, h("span", { className: "pd-optionName", title: it.label }, it.label)),
          // 有子级时给出右向箭头
          isSub ? h(IconChevron, { style: { transform: "rotate(-90deg)", marginLeft: 6 } }) : null
        );
      }

      var mainPanel = h("div", {
        key: "main",
        ref: ref,
        className: "pd-menu",
        // 与官方菜单同一材质开关（触发 --dsw-menu-backdrop-filter 令牌）
        "data-menu-material": "translucent",
        "data-pd-menu": "1",
        style: {
          right: Math.max(8, window.innerWidth - anchor.right),
          bottom: window.innerHeight - anchor.top + 6,
          maxWidth: maxW,
        },
      }, props.items.map(function (it) { return renderRow(it, { inSub: false }); }));

      if (!sub) return [mainPanel];

      // 子级浮层：优先放右侧，空间不足则贴父级左侧向左生长。
      // 垂直方向以「父级底边」为基准向上生长（bottom 对齐），避免向下压到下方内容。
      var rect = ref.current && typeof ref.current.getBoundingClientRect === "function"
        ? ref.current.getBoundingClientRect() : null;
      var subMaxW = maxW;
      var roomRight = rect ? window.innerWidth - rect.right - 8 : 0;
      var bottomEdge = rect ? rect.bottom : (anchor.bottom + 6);
      var anchorBottom = Math.max(8, window.innerHeight - bottomEdge);
      // 向上可用空间决定最大高度，至少留 8px 顶部余量
      var maxH = Math.max(120, Math.min(360, bottomEdge - 8));
      var style = roomRight >= Math.min(200, subMaxW)
        ? { left: (rect ? rect.right : anchor.right) + 4, bottom: anchorBottom, maxWidth: subMaxW, maxHeight: maxH }
        : { right: window.innerWidth - (rect ? rect.left : anchor.left) + 4, bottom: anchorBottom, maxWidth: subMaxW, maxHeight: maxH };
      var subPanel = h("div", {
        key: "sub",
        className: "pd-menu pd-submenu",
        "data-menu-material": "translucent",
        "data-pd-menu": "1",
        style: style,
      }, sub.item.submenu.map(function (it) { return renderRow(it, { inSub: true }); }));

      return [mainPanel, subPanel];
    }

    // ---- 官方风格图标（内置 SVG：插件不得 require @deepseek-ai/dsh-client-ui-primitives） ----
    // 箭头：与模型下拉同款细描边 chevron，颜色取 label-caption
    // 折叠行用法与官方一致：收起 rotate(-90deg)，展开 transform:none
    function IconChevron(props) {
      return h("svg", {
        className: "pd-chevron" + (props.open ? " pd-chevronOpen" : ""),
        style: props.style || undefined,
        width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
      }, h("path", {
        d: "M4 6.2 8 10.2l4-4",
        stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round",
      }));
    }

    // 改写：四角星（sparkle），与 DSH 工具卡片所用的图标同形
    function IconSparkle() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M9.9 1.9c.2 0 .4.1.4.4l.5 2.4c.2.9.9 1.6 1.8 1.8l2.4.5c.3 0 .4.2.4.4s-.1.4-.4.4l-2.4.5c-.9.2-1.6.9-1.8 1.8l-.5 2.4c0 .3-.2.4-.4.4s-.4-.1-.4-.4l-.5-2.4c-.2-.9-.9-1.6-1.8-1.8l-2.4-.5c-.3 0-.4-.2-.4-.4s.1-.4.4-.4l2.4-.5c.9-.2 1.6-.9 1.8-1.8l.5-2.4c0-.3.2-.4.4-.4Z",
          fill: "currentColor",
        }),
        h("path", {
          d: "M3.6 10.4c.15 0 .27.09.3.26l.28 1.1c.1.4.4.7.8.8l1.1.28c.17.03.26.15.26.3s-.09.27-.26.3l-1.1.28c-.4.1-.7.4-.8.8l-.28 1.1c-.03.17-.15.26-.3.26s-.27-.09-.3-.26l-.28-1.1c-.1-.4-.4-.7-.8-.8l-1.1-.28c-.17-.03-.26-.15-.26-.3s.09-.27.26-.3l1.1-.28c.4-.1.7-.4.8-.8l.28-1.1c.03-.17.15-.26.3-.26Z",
          fill: "currentColor", opacity: "0.65",
        })
      );
    }

    // ---- 触发按钮（对齐官方 .trigger：无边框 28px；支持纯图标 / 文本 + chevron） ----
    function Trigger(props) {
      return h("button", {
        ref: props.buttonRef,
        className: "pd-btn" + (props.extra ? " " + props.extra : "") + (props.label ? "" : " pd-btnIconOnly"),
        disabled: props.disabled,
        onClick: props.onClick,
        title: props.title,
        "aria-label": props.label ? undefined : props.title,
      },
        props.icon ? props.icon : null,
        props.label ? h("span", { className: "pd-label" }, props.label) : null,
        props.hasMenu ? h(IconChevron, { open: props.open }) : null
      );
    }

    function IconTrash() {
      return h("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M2.6 4.3h10.8M6.4 2.4h3.2M4.1 4.3l.65 8.4a1.1 1.1 0 0 0 1.1 1h4.3a1.1 1.1 0 0 0 1.1-1l.65-8.4M6.7 6.8v4.6M9.3 6.8v4.6",
          stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round", strokeLinejoin: "round",
        })
      );
    }

    // 文件夹：打开配置文件（与其它图标同为细描边风格）
    function IconFolder() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M2 4.6c0-.6.5-1.1 1.1-1.1h2.6l1.4 1.6h5.8c.6 0 1.1.5 1.1 1.1v5.2c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1V4.6Z",
          stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round", strokeLinejoin: "round",
        })
      );
    }

    // ---- 概述行卡片（二级展开；手风琴单开；模板/风格共用，textKey 区分内容字段） ----
    function TemplateRow(props) {
      var t = props.tpl, open = !!props.open;
      var key = props.textKey || "text";
      var summary = (t[key] || "").replace(/\s+/g, " ").trim();
      if (summary.length > 46) summary = summary.slice(0, 46) + "…";
      if (!summary) summary = "（空）";
      return h("div", { className: "pd-tplCard" },
        h("div", {
          style: { display: "flex", gap: 8, alignItems: "center", cursor: "pointer" },
          onClick: props.onToggle,
        },
          // 折叠指示器与官方一致：收起指向右（-90deg），展开指向下（none）
          h(IconChevron, { style: open ? { transform: "none" } : { transform: "rotate(-90deg)" } }),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { className: "pd-tplName" }, t.name || "未命名"),
            h("div", { className: "pd-tplSum" }, summary)
          ),
          h("button", {
            className: "pd-iconBtn", title: props.removeTitle || "删除此模板",
            onClick: function (e) { e.stopPropagation(); props.onRemove(); },
          }, h(IconTrash))
        ),
        open ? h("div", { style: { marginTop: 10 } },
          h("input", {
            className: "pd-input", style: { marginBottom: 8 }, value: t.name, placeholder: props.namePlaceholder || "模板名称",
            onChange: function (e) { props.onChange({ name: e.target.value }); },
          }),
          h("textarea", {
            className: "pd-textarea", style: { minHeight: 72, resize: "vertical" }, value: t[key],
            placeholder: props.placeholder || "模板内容（点击插入时追加到草稿末尾）",
            onChange: function (e) { var patch = {}; patch[key] = e.target.value; props.onChange(patch); },
          })
        ) : null
      );
    }

    function SettingsPop(props) {
      var anchor = useAnchorFollow(props.anchorRef, function () {}, false);
      var st = useStore();
      var tabState = useState("general"); var tab = tabState[0]; var setTab = tabState[1];
      var openState = useState(null); var openId = openState[0]; var setOpenId = openState[1];
      var modelRef = useRef(null);
      var modelMenuState = useState(false); var mOpen = modelMenuState[0]; var setMOpen = modelMenuState[1];
      var popRef = useRef(null);
      useEffect(function () {
        function onDoc(e) {
          // 下拉菜单被移出面板 DOM（避免被 backdrop-filter 困住），
          // 这里必须把「点在菜单里」也当作面板内部，否则点选模型会先关掉整个面板。
          if (e && e.target && typeof e.target.closest === "function" && e.target.closest("[data-pd-menu]")) return;
          var el = popRef.current;
          if (el && el.contains(e.target)) return;
          var a = props.anchorRef.current;
          if (a && a.contains(e.target)) return;
          setStore({ settingsOpen: false });
        }
        document.addEventListener("mousedown", onDoc);
        return function () { document.removeEventListener("mousedown", onDoc); };
      }, []);
      useEffect(function () { ensureModels(); }, []);
      // 每次打开面板都重新读配置文件：手工改过 settings.json 后无需刷新页面
      useEffect(function () { reloadConf(); }, []);
      if (!anchor) return null;
      // 以「输入框」为基准水平居中，而不是视口——左侧有侧栏时视口中轴与输入框中轴不重合。
      // 官方用 [data-composer-card] 标识输入框区域（DSH 自己的 Toast 就这么取锚点）。
      var composerRect = null;
      try {
        var composerEl = document.querySelector("[data-composer-card]");
        if (composerEl && typeof composerEl.getBoundingClientRect === "function") {
          var r = composerEl.getBoundingClientRect();
          if (r && r.width > 0) composerRect = r;
        }
      } catch (e) {}
      var W = Math.min(440, Math.max(280, window.innerWidth - 32));
      var centerX = composerRect ? composerRect.left + composerRect.width / 2 : window.innerWidth / 2;
      var left = Math.round(centerX - W / 2);
      // 不越出视口
      left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - W - 8));
      var conf = st.conf || { templates: [], styles: DEFAULT_STYLES, customInstruction: "" };
      var templates = conf.templates || [];
      var styles = conf.styles || DEFAULT_STYLES;
      var ctxOn = conf.contextEnabled !== false;
      var rm = conf.rewriteModel || null;
      var modelItems = [{ id: "", label: st.modelsGlobal ? "跟随全局默认（" + st.modelsGlobal.model + "）" : "跟随全局默认" }];
      (st.models || []).forEach(function (g) {
        (g.models || []).forEach(function (m) {
          modelItems.push({ id: g.id + "/" + m.id, label: g.name && g.name !== m.name ? g.name + " · " + m.name : m.name });
        });
      });
      var rmMissing = !!(rm && st.models && !st.models.some(function (g) {
        return g.id === rm.provider && (g.models || []).some(function (m) { return m.id === rm.model; });
      }));
      // 触发器显示模型「显示名」，找不到时回退到 id
      var rmLabel = null;
      if (rm) {
        rmLabel = rm.model;
        (st.models || []).forEach(function (g) {
          if (g.id !== rm.provider) return;
          (g.models || []).forEach(function (m) { if (m.id === rm.model) rmLabel = m.name || m.id; });
        });
      }
      var popEl = h("div", {
        ref: popRef,
        className: "pd-pop",
        // 与官方 MenuSurface 同样声明材质，令牌才会给出 blur(40px) saturate(150%)
        "data-menu-material": "translucent",
        style: { left: left, bottom: window.innerHeight - anchor.top + 8, width: W,
                 maxHeight: Math.min(520, Math.max(240, window.innerHeight * 0.7)) },
      },
        h("div", { className: "pd-popHead" },
          h("span", null, "提示词助手设置"),
          h("span", { style: { flex: 1 } }),
          // 打开配置文件：界面与配置文件双向，二者是同一份 JSON
          h("button", { className: "pd-iconBtn", onClick: openConfigFile, title: "打开配置文件" }, h(IconFolder)),
          h("button", { className: "pd-iconBtn", onClick: function () { setStore({ settingsOpen: false }); }, title: "关闭" }, "✕")
        ),
        h("div", { className: "pd-tabs" },
          h("button", { className: "pd-tab" + (tab === "general" ? " pd-tabOn" : ""), onClick: function () { setTab("general"); } }, "常规"),
          h("button", { className: "pd-tab" + (tab === "tpl" ? " pd-tabOn" : ""), onClick: function () { setTab("tpl"); } },
            "模板"),
          h("button", { className: "pd-tab" + (tab === "style" ? " pd-tabOn" : ""), onClick: function () { setTab("style"); } },
            "风格")
        ),
        tab === "general"
          ? h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto" } },
              h("div", { className: "pd-field" },
                // 标签在左、模型选择在右，与「会话上下文 / 带入轮数」两行的对齐方式保持一致
                h("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
                  h("div", { className: "pd-fieldLabel", style: { flex: 1, minWidth: 0, marginBottom: 0 } }, "改写模型"),
                  h(Trigger, {
                    buttonRef: modelRef, hasMenu: true, open: mOpen,
                    label: rm ? rmLabel : "跟随全局默认", title: "仅改写使用所选模型，不影响主页面全局选择",
                    onClick: function () { setMOpen(!mOpen); },
                  })
                ),
                h("div", { className: "pd-help", style: { marginTop: 4 } },
                  rmMissing ? "当前不可用，已回退默认" : "选择改写使用的模型")
              ),
              h("div", { className: "pd-field" },
                h("div", { className: "pd-fieldLabel" }, "会话上下文"),
                h("div", { className: "pd-switchRow" },
                  h("span", { className: "pd-help", style: { margin: 0 } }, "改写时附带最近对话"),
                  h("button", {
                    className: "pd-btn pd-toggle" + (ctxOn ? " pd-toggleOn" : ""),
                    "aria-pressed": ctxOn,
                    onClick: function () { saveConfig(Object.assign({}, conf, { contextEnabled: !ctxOn })); },
                  },
                    h("span", { className: "pd-toggleTrack" }, h("span", { className: "pd-toggleKnob" }))
                  )
                )
              ),
              h("div", { className: "pd-field" },
                h("div", { className: "pd-fieldLabel" }, "带入轮数"),
                h("div", { className: "pd-switchRow" },
                  h("span", { className: "pd-help", style: { margin: 0 } }, "附带最近 N 轮（1–20）"),
                  h("input", {
                    type: "number", min: 1, max: 20, className: "pd-input", style: { width: 64, flex: "none" },
                    defaultValue: conf.contextTurns || 6,
                    onBlur: function (e) {
                      var n = Math.min(20, Math.max(1, Number(e.target.value) || 6));
                      saveConfig(Object.assign({}, conf, { contextTurns: n }));
                    },
                  })
                )
              ),
              h("div", { className: "pd-help" }, "改动后自动保存"),
              // 配置文件位置：界面保存与手工编辑的是同一份 JSON
              h("div", {
                className: "pd-help",
                style: { marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
                title: st.configPath || "",
              }, "配置文件：" + (st.configPath || "（尚未生成）"))
            )
          : tab === "tpl" ? h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto" } },
              templates.length
                ? templates.map(function (t, i) {
                    var key = String(t.id || i);
                    return h(TemplateRow, {
                      key: key, tpl: t,
                      open: openId === key,
                      onToggle: function () { setOpenId(openId === key ? null : key); },
                      onChange: function (patch) {
                        var next = templates.slice(); next[i] = Object.assign({}, t, patch);
                        setStore({ conf: Object.assign({}, conf, { templates: next }) });
                      },
                      onRemove: function () {
                        var next = templates.slice(); next.splice(i, 1);
                        if (openId === key) setOpenId(null);
                        setStore({ conf: Object.assign({}, conf, { templates: next }) });
                      },
                    });
                  })
                : h("div", { className: "pd-help", style: { margin: "2px 0 10px" } }, "还没有模板。添加后可从工具行「模板」一键追加到草稿。"),
              h("div", { className: "pd-foot", style: { marginTop: "auto" } },
                h("button", {
                  className: "pd-btn", style: { marginRight: "auto" },
                  onClick: function () {
                    var nid = "t-" + Date.now();
                    setStore({ conf: Object.assign({}, conf, { templates: templates.concat([{ id: nid, name: "新模板", text: "" }]) }) });
                    setOpenId(nid);
                  },
                }, "＋ 添加模板"),
                h("button", { className: "pd-btn pd-btnPrimary", onClick: function () { saveConfig(conf); } }, "保存")
              )
            )
          : h("div", { style: { flex: 1, minHeight: 0, overflowY: "auto" } },
              styles.map(function (s, i) {
                var key = "s:" + String(s.id || i);
                var row = s.id === "custom" ? Object.assign({}, s, { instruction: conf.customInstruction || "" }) : s;
                return h(TemplateRow, {
                  key: key, tpl: row, textKey: "instruction",
                  namePlaceholder: "风格名称", placeholder: "改写指令：用一段话描述这个风格的要求",
                  removeTitle: "删除此风格",
                  open: openId === key,
                  onToggle: function () { setOpenId(openId === key ? null : key); },
                  onChange: function (patch) {
                    var next = styles.slice(); next[i] = Object.assign({}, s, patch);
                    var confNext = Object.assign({}, conf, { styles: next });
                    if (s.id === "custom" && typeof patch.instruction === "string") confNext.customInstruction = patch.instruction;
                    setStore({ conf: confNext });
                  },
                  onRemove: function () {
                    var next = styles.slice(); next.splice(i, 1);
                    if (openId === key) setOpenId(null);
                    setStore({ conf: Object.assign({}, conf, { styles: next }) });
                  },
                });
              }),
              h("div", { className: "pd-help", style: { margin: "0 0 10px" } }, "「自定义」与常规页指令同步；保存后工具行「风格」菜单即时更新。"),
              h("div", { className: "pd-foot", style: { marginTop: "auto" } },
                h("button", {
                  className: "pd-btn", style: { marginRight: "auto" },
                  onClick: function () {
                    var nid = "s-" + Date.now();
                    setStore({ conf: Object.assign({}, conf, { styles: styles.concat([{ id: nid, name: "新风格", instruction: "" }]) }) });
                    setOpenId("s:" + nid);
                  },
                }, "＋ 添加风格"),
                h("button", { className: "pd-btn pd-btnPrimary", onClick: function () { saveConfig(conf); } }, "保存")
              )
            )
      );

      // 模型下拉必须挂在面板之外：面板带 backdrop-filter，会成为 fixed 后代的包含块，
      // 导致弹层坐标错位。作为兄弟节点渲染即可保持相对视口定位。
      var modelMenu = mOpen ? h(Menu, {
        key: "model-menu",
        anchorRef: modelRef,
        items: modelItems,
        activeId: rm ? rm.provider + "/" + rm.model : "",
        onClose: function () { setMOpen(false); },
        onPick: function (it) {
          setMOpen(false);
          if (it.id === "") { saveConfig(Object.assign({}, conf, { rewriteModel: null })); return; }
          var sp = it.id.indexOf("/");
          saveConfig(Object.assign({}, conf, {
            rewriteModel: { provider: it.id.slice(0, sp), model: it.id.slice(sp + 1) },
          }));
        },
      }) : null;
      return modelMenu ? [popEl, modelMenu] : [popEl];
    }

    // ---- 设置图标：描边滑块（sliders），替代 ⚙ emoji ----
    function IconSliders() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M2 4h7M13.8 4h.2M2 8h3.2M9.2 8h6.8M2 12h7M13.8 12h.2",
          stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round",
        }),
        h("circle", { cx: 11.3, cy: 4, r: 1.7, stroke: "currentColor", strokeWidth: "1.3" }),
        h("circle", { cx: 7.3, cy: 8, r: 1.7, stroke: "currentColor", strokeWidth: "1.3" }),
        h("circle", { cx: 11.3, cy: 12, r: 1.7, stroke: "currentColor", strokeWidth: "1.3" })
      );
    }

    // ---- 工具行控件 ----
    function Toolbar(props) {
      ensureCss();
      var st = useStore();
      var ds = useDraftState(props);
      var menuState = useState(null); var menu = menuState[0]; var setMenu = menuState[1];
      var btnRef = useRef(null);
      var styleRef = useRef(null);
      var gearRef = useRef(null);
      var probedRef = useRef(false);
      // 改写发起时的草稿快照：用于「改写期间草稿是否被改动」的变更检测
      var baselineRef = useRef("");

      useEffect(function () { ensureConf(); }, []);

      useEffect(function () {
        if (probedRef.current) return;
        probedRef.current = true;
        var actionKeys = {};
        try {
          for (var k in props.inputActions) {
            var v = props.inputActions[k];
            actionKeys[k] = typeof v === "function" ? "fn/" + v.length : typeof v;
          }
        } catch (e) { actionKeys.__err = String(e); }
        api("/api/prompt-dock/probe", {
          at: Date.now(), seat: "input.right", v: "1.0.0",
          sessionId: String(props.sessionId == null ? "" : props.sessionId),
          propKeys: Object.keys(props), actionKeys: actionKeys,
          stateKeys: Object.keys(ds.inputState), draftGuess: ds.draft.slice(0, 40),
        }).catch(function () {});
      }, []);

      // 发送/清空草稿后，撤销自动消失（避免把旧原文覆盖到新内容上）
      useEffect(function () {
        if (st.undo && ds.draft === "") setStore({ undo: null });
      }, [ds.draft, st.undo]);

      // 卸载时中断进行中的流，避免泄漏
      useEffect(function () {
        return function () { if (currentAbort) { try { currentAbort.abort(); } catch (e) {} } };
      }, []);

      function cancelRewrite() {
        var rid = store.requestId;
        if (currentAbort) { try { currentAbort.abort(); } catch (e) {} currentAbort = null; }
        if (rid) api("/api/prompt-dock/cancel", { requestId: rid }).catch(function () {});
        setStore({ busy: false, requestId: "" });
      }

      function onRewrite() {
        if (store.busy) { cancelRewrite(); return; }
        var draft = ds.getDraft();
        if (!draft.trim()) return;

        // —— 变更检测基线：记录发起时的草稿 ——
        var baseline = ds.getDraft();
        baselineRef.current = baseline;
        var requestId = "r-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        var conf = store.conf || {};

        if (typeof fetch !== "function" || typeof AbortController === "undefined") {
          setStore({ error: "当前浏览器不支持流式改写" });
          return;
        }

        var ac = new AbortController();
        currentAbort = ac;
        setStore({ busy: true, requestId: requestId, error: "", undo: null });

        fetch("/api/prompt-dock/rewrite-stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            requestId: requestId,
            text: draft,
            styleId: store.styleId,
            customInstruction: conf.customInstruction || "",
            sessionId: String(props.sessionId == null ? "" : props.sessionId),
            useContext: conf.contextEnabled !== false,
          }),
          signal: ac.signal,
        }).then(function (resp) {
          if (!resp.ok || !resp.body || !resp.body.getReader) {
            // 服务端拒答（403/405 等）不是流，按 JSON 错误处理
            return resp.json().catch(function () { return null; }).then(function (j) {
              var err = (j && j.error) || { code: "INTERNAL", message: "HTTP " + resp.status };
              setStore({ busy: false, error: errorText(err) });
            });
          }
          var reader = resp.body.getReader();
          var decoder = new TextDecoder();
          var buf = "";
          var acc = "";
          function handleEvent(raw) {
            var lines = raw.split("\n");
            var event = "message", data = "";
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i];
              if (line.indexOf("event:") === 0) event = line.slice(6).trim();
              else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
            }
            if (!data) return;
            var obj;
            try { obj = JSON.parse(data); } catch (e) { return; }
            if (event === "delta") {
              acc += obj.text || ""; // 仅累积文本，完成时一次性回填
            } else if (event === "done") {
              onStreamDone(obj.text || acc);
            } else if (event === "error") {
              setStore({ busy: false, error: errorText({ code: obj.code, message: obj.message }) });
            }
          }
          function onStreamDone(finalText) {
            var text = finalText || "";
            if (!text) {
              setStore({ busy: false, error: errorText({ code: "EMPTY_REPLY", message: "模型返回为空" }) });
              return;
            }
            // —— 变更检测：改写期间草稿被改动 → 不回填，避免覆盖用户新输入 ——
            var now = ds.getDraft();
            if (now !== baseline) {
              setStore({ busy: false, error: "草稿在改写期间已改动，未回填（可重新改写）" });
              return;
            }
            writeDraft(props.inputActions, text, ds.getDraft).then(function (r) {
              if (r.ok) {
                setStore({ busy: false, undo: { original: baseline }, error: "" });
              } else {
                setStore({ busy: false, error: writeDraftError(r) });
              }
            });
          }
          function pump() {
            return reader.read().then(function (res) {
              if (res.done) { return; }
              buf += decoder.decode(res.value, { stream: true });
              var idx;
              while ((idx = buf.indexOf("\n\n")) >= 0) {
                var raw = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                handleEvent(raw);
              }
              return pump();
            });
          }
          return pump();
        }).catch(function (e) {
          if (!(e && (e.name === "AbortError" || e.code === 20))) {
            setStore({ busy: false, error: errorText({ code: "INTERNAL", message: String((e && e.message) || e) }) });
          }
        }).then(function () {
          currentAbort = null;
          if (store.busy) setStore({ busy: false });
        });
      }

      var styles = (st.conf && st.conf.styles) || DEFAULT_STYLES;
      var templates = (st.conf && st.conf.templates) || [];
      var activeStyle = styles.filter(function (s) { return s.id === st.styleId; })[0] || styles[0];
      var canUndo = !!st.undo && ds.draft !== "" && ds.draft !== st.undo.original;

      // —— 芯片保护：含 @文件 / /命令 芯片时禁止改写 ——
      var chip = detectChip(ds.draft, collectChipFragments(props), ds.inputState);
      var rewriteDisabled = (!st.busy && (!ds.draft.trim() || !!chip));

      // 单一入口 + 二级菜单：风格 / 模板 收进子级，工具行只留「菜单 + 改写」
      var menuItems = [{
        id: "style",
        label: "风格",
        submenu: styles.map(function (s) {
          return { id: "style:" + s.id, label: s.name, active: s.id === st.styleId };
        }),
      }];
      if (templates.length) {
        menuItems.push({
          id: "tpl",
          label: "模板",
          submenu: templates.map(function (t, i) { return { id: "tpl:" + i, label: t.name }; }),
        });
      }

      return h("div", { style: { display: "flex", gap: 2, alignItems: "center" } },
        // 设置在最左
        h("button", {
          ref: gearRef, className: "pd-iconBtn",
          onClick: function () { setStore({ settingsOpen: !st.settingsOpen }); }, title: "提示词助手设置",
        }, h(IconSliders)),
        // 风格/模板合并为一个下拉；触发器直接显示当前风格名
        h(Trigger, {
          buttonRef: styleRef, hasMenu: true, open: menu === "main",
          label: (activeStyle && activeStyle.name) || "风格", title: "风格与模板",
          onClick: function () { setMenu(menu === "main" ? null : "main"); },
        }),
        // 改写 / 取消 合一：进行中变成「取消」，可直接中断上游流
        st.busy
          ? h(Trigger, {
              buttonRef: btnRef, extra: "pd-btnQuiet",
              label: "取消", title: "中断本次改写",
              onClick: cancelRewrite,
            })
          : h(Trigger, {
              buttonRef: btnRef, extra: "pd-btnPrimary", disabled: rewriteDisabled,
              // 纯图标（官方 sparkle 形状），文案只在 tooltip / aria-label 里
              icon: h(IconSparkle),
              title: chip
                ? "草稿含「" + chip + "」引用芯片，改写会丢失它，请先移除后再改写"
                : "改写草稿",
              onClick: onRewrite,
            }),
        // 改写状态与撤销共用同一槽位：进行中显示状态，完成后原地变 ↩
        st.busy
          ? h("span", { className: "pd-status" }, "改写中…")
          : canUndo
            ? h("button", {
                className: "pd-iconBtn", title: "还原为改写前的原文", style: { fontSize: 13 },
                onClick: function () {
                  var u = st.undo;
                  writeDraft(props.inputActions, u.original, ds.getDraft).then(function (r) {
                    if (r.ok) setStore({ undo: null, error: "" });
                    else setStore({ error: writeDraftError(r) });
                  });
                },
              }, "↩")
            : null,
        // 芯片保护的可视说明（禁用原因要能被看到，而不是静默置灰）
        chip
          ? h("span", { className: "pd-err", style: { maxWidth: 160, color: "var(--dsw-alias-label-tertiary,#888)" },
                        title: "草稿含「" + chip + "」引用芯片，改写会丢失它" }, "含芯片")
          : null,
        st.error ? h("span", { className: "pd-err", title: st.error }, st.error) : null,
        st.settingsOpen ? h(SettingsPop, { anchorRef: gearRef }) : null,
        menu ? h(Menu, {
          anchorRef: styleRef,
          items: menuItems,
          onClose: function () { setMenu(null); },
          onPick: function (it) {
            setMenu(null);
            if (it.id.indexOf("style:") === 0) { setStore({ styleId: it.id.slice(6) }); return; }
            if (it.id.indexOf("tpl:") === 0) {
              var tpl = templates[Number(it.id.slice(4))];
              if (!tpl) return;
              var cur = ds.getDraft();
              var next = cur ? (cur.slice(-1) === "\n" ? cur + tpl.text : cur + "\n" + tpl.text) : tpl.text;
              writeDraft(props.inputActions, next, ds.getDraft).then(function (r) {
                setStore({ error: r.ok ? "" : "插入失败：" + writeDraftError(r) });
              });
            }
          },
        }) : null
      );
    }

    var inject = ["slots"];
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.slots.inject("conversation.input.right", function () {
          return ctx.slots.register(
            { name: "conversation.input.right", id: "prompt-dock", order: 0, label: function () { return "提示词助手"; } },
            Toolbar
          );
        });
      }, "dsh-prompt-dock: seats");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});


















