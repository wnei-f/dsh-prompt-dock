/* dsh-prompt-dock —— 客户端半 v1.0
 *
 * 座位（两处，互相独立）：
 *  1. conversation.input.right —— 工具行：[风格 ▾] [模板 ▾] [✨改写]；设置不在此处。
 *  2. plugins.bundle.config   —— 组合包详情页的配置卡片，key 必须是 npm 包名 "dsh-prompt-dock"。
 *     页面以 view:"page" 渲染（详情页），view:"summary" 只渲染一行摘要（卡片副标题）。
 *
 * 设置持久化只走宿主 HTTP 路由（POST /api/prompt-dock/config），不依赖页面传下来的
 * form.state / form.mutate —— 后者只有「暴露可编辑 Config 字段」的官方条目才有。
 *
 * 视觉令牌：颜色只用 --dsw-alias-*，不写死任何 hex/rgb；深色模式由令牌自动切换。
 * 尺寸：区块标题 18/600，导航标题 16/500，分组标题 14/500，正文/菜单 13，说明/错误 12，胶囊 11。
 * 间距：区块间距 12，分组标题上距 20（首个 12），列表行距 10，卡片内边距 14×16，圆角 12/12/6/全圆。
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

    var PKG_NAME = "dsh-prompt-dock";
    var NS = "promptDock";
    var API = "/api/prompt-dock";

    // =====================================================================
    // 样式：所有颜色取自官方令牌 --dsw-alias-*，不出现硬编码色值
    // =====================================================================
    var CSS_TEXT = [
      // ---- 工具行 ----
      ".pd-row{display:flex;gap:2px;align-items:center;min-width:0;position:relative;}",
      ".pd-btn{",
      "  box-sizing:border-box;height:28px;border-radius:var(--dsw-radius-sm,6px);",
      "  color:var(--dsw-alias-label-secondary);background:transparent;border:none;outline:none;",
      "  display:inline-flex;align-items:center;gap:4px;padding:0 8px;font-size:13px;font-weight:400;",
      "  line-height:20px;cursor:pointer;white-space:nowrap;flex:none;max-width:200px;",
      "  transition:background-color 120ms ease,color 120ms ease,opacity 120ms ease;}",
      ".pd-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}",
      ".pd-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active);}",
      ".pd-btn:focus-visible{box-shadow:0 0 0 3px var(--dsw-alias-state-business-primary);outline:none;}",
      ".pd-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;opacity:.5;}",
      ".pd-btnIconOnly{padding:0 7px;}",
      ".pd-btnPrimary{color:var(--dsw-alias-state-business-primary);}",
      ".pd-btnQuiet{color:var(--dsw-alias-label-secondary);}",
      ".pd-btnDangerText{color:var(--dsw-alias-state-danger);}",
      ".pd-btnSm{height:24px;padding:0 8px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm,6px);}",
      ".pd-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden;}",
      // 12px chevron，展开时旋转 180°
      ".pd-chevron{color:var(--dsw-alias-label-tertiary);flex:none;display:block;transition:transform 140ms ease;}",
      ".pd-chevronOpen{transform:rotate(180deg);}",
      // 流式改写时输入框顶边的 2px 流光条
      ".pd-shimmer{",
      "  position:absolute;left:0;right:0;top:0;height:2px;overflow:hidden;pointer-events:none;",
      "  border-radius:var(--dsw-radius-sm,6px) var(--dsw-radius-sm,6px) 0 0;",
      "  background:var(--dsw-alias-state-business-primary);opacity:.85;}",
      ".pd-shimmer::after{",
      "  content:\"\";position:absolute;inset:0;transform:translateX(-100%);",
      "  background:linear-gradient(90deg,transparent,var(--dsw-alias-bg-layer-2),transparent);",
      "  animation:pd-shimmer 1.1s linear infinite;}",
      "@keyframes pd-shimmer{to{transform:translateX(100%);}}",
      // ---- 弹层：不透明底、12px 圆角、border-l2 描边、120–160ms 显现 ----
      ".pd-popover{",
      "  box-sizing:border-box;z-index:2147483000;position:fixed;display:flex;flex-direction:column;",
      "  min-width:160px;max-width:min(360px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 96px));",
      "  overflow:hidden;padding:4px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);",
      "  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);",
      "  box-shadow:var(--dsw-elevation-prominent,0 8px 24px var(--dsw-alias-border-l2));",
      "  font-size:13px;line-height:20px;transform-origin:bottom right;",
      "  animation:pd-materialize 140ms cubic-bezier(.16,1,.3,1) both;",
      "  --dsh-scrollbar-thumb:var(--dsw-alias-border-l2);}",
      "@keyframes pd-materialize{from{opacity:0;transform:translateY(4px) scale(.98);}to{opacity:1;transform:none;}}",
      ".pd-popoverScroll{overflow-y:auto;overflow-x:hidden;min-height:0;}",
      ".pd-popover::-webkit-scrollbar,.pd-popoverScroll::-webkit-scrollbar{width:8px;}",
      ".pd-popover::-webkit-scrollbar-thumb,.pd-popoverScroll::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb,var(--dsw-alias-border-l2));border-radius:4px;}",
      // 32px 菜单行
      ".pd-option{",
      "  box-sizing:border-box;border-radius:var(--dsw-radius-md,6px);width:100%;min-height:32px;",
      "  color:inherit;text-align:left;cursor:pointer;background:transparent;border:none;outline:none;",
      "  display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:13px;font-family:inherit;",
      "  transition:background-color 120ms ease;}",
      ".pd-option:hover,.pd-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover);}",
      ".pd-option:focus-visible{box-shadow:0 0 0 3px var(--dsw-alias-state-business-primary);}",
      ".pd-optionCopy{display:flex;flex:1;min-width:0;flex-direction:column;}",
      ".pd-optionName{min-width:0;max-width:100%;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:400;line-height:18px;overflow:hidden;}",
      ".pd-optionSum{min-width:0;max-width:100%;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;}",
      // 当前项：底色 + inset 描边，不用对勾
      ".pd-optionOn{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);}",
      // 键盘当前项：与「已选中」区分开——用 business 色描边 + 更实的底色，
      // 让 ↑↓ 移动时一眼能看出焦点在哪（两个类可同时存在）。
      ".pd-optionActive{background:var(--dsw-alias-interactive-bg-hover);",
      "  box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary);}",
      ".pd-optionActive.pd-optionOn{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-business-primary);}",
      ".pd-groupLabel{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-weight:400;}",
      ".pd-empty{padding:10px 8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
      ".pd-search{",
      "  box-sizing:border-box;width:100%;height:32px;margin:0 0 4px;padding:0 10px;",
      "  border-radius:12px;border:1px solid var(--dsw-alias-border-l2);outline:none;font:inherit;",
      "  font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}",
      ".pd-search:focus{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px var(--dsw-alias-state-business-primary);}",
      // ---- 反馈：错误条（不挡输入框、不抢焦点） ----
      // 定位在工具行左侧的独立槽位里：不参与 flex 布局，因此不会撑宽工具行、
      // 不会挤动「风格 / 模板 / 改写」三个按钮的位置。
      // 左侧空间有限：超长文案截断并保留 title 全文，操作按钮保持完整可点。
      ".pd-sideNote{position:absolute;right:100%;top:50%;transform:translateY(-50%);",
      "  margin-right:8px;max-width:min(360px,52vw);display:flex;align-items:center;gap:6px;pointer-events:auto;}",
      ".pd-sideNote>*{flex:none;}",
      ".pd-sideNote>*{min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".pd-errorBar{",
      "  box-sizing:border-box;display:flex;gap:6px;align-items:center;max-width:100%;",
      // 与工具行按钮同高（28px）同字号，避免错误条比按钮高出一截造成视觉错位
      "  height:28px;padding:0 6px;border-radius:var(--dsw-radius-sm,6px);",
      "  font-size:12px;line-height:20px;white-space:nowrap;",
      "  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-state-danger);",
      "  background:color-mix(in srgb,var(--dsw-alias-state-danger) 10%,transparent);}",
      ".pd-errorMark{",
      "  flex:none;width:12px;text-align:center;font-size:12px;line-height:20px;font-weight:600;",
      "  color:var(--dsw-alias-state-danger);}",
      ".pd-errorText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      // 操作区压缩到最小，把有限宽度留给文案
      ".pd-errorActions{display:flex;gap:0;align-items:center;flex:none;}",
      ".pd-errorActions .pd-btnSm{height:22px;padding:0 6px;font-size:12px;}",
      // 极窄视口（左侧放不下）：改为挂到工具行下方，仍然不占 flex 主轴、不移动按钮
      "@media (max-width:640px){",
      "  .pd-sideNote{right:auto;left:0;top:100%;transform:none;margin:6px 0 0 0;max-width:calc(100vw - 24px);}",
      "}",
      ".pd-hint{font-size:12px;line-height:16px;color:var(--dsw-alias-state-warning);}",
      ".pd-err{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      // 按钮外侧 1px 危险边（改写失败）
      ".pd-edgeDanger{position:relative;}",
      ".pd-edgeDanger::after{content:\"\";position:absolute;inset:-2px;border-radius:var(--dsw-radius-sm,6px);",
      "  box-shadow:inset 0 0 0 1px var(--dsw-alias-state-danger);pointer-events:none;}",
      ".pd-successFlash{animation:pd-success 1.5s ease both;border-radius:var(--dsw-radius-sm,6px);}",
      "@keyframes pd-success{from{background:var(--dsw-alias-state-success);}to{background:transparent;}}",
      ".pd-spin{display:inline-block;width:12px;height:12px;border-radius:50%;flex:none;",
      "  border:1.5px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-state-business-primary);",
      "  animation:pd-spin 720ms linear infinite;}",
      "@keyframes pd-spin{to{transform:rotate(360deg);}}",
      // ---- Toast：底部居中，圆角 8，bg-layer-3 + border-l2，12px，最多 2 条 ----
      ".pd-toasts{",
      "  position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483600;",
      "  display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;}",
      ".pd-toast{",
      "  box-sizing:border-box;max-width:min(360px,calc(100vw - 32px));padding:6px 12px;",
      "  border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);",
      "  color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;",
      "  box-shadow:var(--dsw-elevation-prominent,0 4px 12px var(--dsw-alias-border-l2));",
      "  animation:pd-toastIn 160ms ease both;}",
      // 首次使用告知：常驻到用户关闭；可点，与纯展示 toast 区分
      ".pd-disclosure{display:flex;align-items:center;gap:10px;pointer-events:auto;max-width:min(420px,calc(100vw - 32px));}",
      ".pd-disclosure .pd-toastText{flex:1;min-width:0;}",
      ".pd-toastClose{",
      "  flex:none;border:none;background:transparent;padding:0 2px;cursor:pointer;",
      "  color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:18px;border-radius:6px;",
      "  font-family:inherit;}",
      ".pd-toastClose:hover{color:var(--dsw-alias-state-business-primary);text-decoration:underline;}",
      ".pd-toastClose:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsw-alias-state-business-primary);}",
      "@keyframes pd-toastIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}",
      // ---- 设置卡片 ----
      ".pd-card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);}",
      ".pd-cardTitle{font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary);}",
      ".pd-cardNav{font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary);}",
      ".pd-group{display:flex;flex-direction:column;gap:10px;}",
      ".pd-group+.pd-group{margin-top:12px;}",
      ".pd-groupTitle{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary);margin:0;}",
      ".pd-groupHead{display:flex;align-items:center;gap:8px;min-height:24px;}",
      ".pd-groupHead .pd-groupTitle{flex:1;min-width:0;}",
      ".pd-sub{box-sizing:border-box;padding:14px 16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);",
      "  background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:10px;}",
      ".pd-fieldRow{display:flex;align-items:center;gap:10px;min-height:24px;}",
      // 标签不换行：.pd-input 是 width:100%，flex 收缩会把标签压到一字一行
      ".pd-fieldLabel{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;",
      "  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".pd-help{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}",
      ".pd-pill{box-sizing:border-box;display:inline-flex;align-items:center;height:18px;padding:0 8px;",
      "  border-radius:999px;font-size:11px;line-height:18px;font-weight:400;",
      "  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);flex:none;}",
      ".pd-readonly{box-sizing:border-box;margin:0;padding:8px 10px;border-radius:12px;",
      "  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);",
      "  color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;",
      "  white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto;font-family:inherit;}",
      ".pd-input,.pd-textarea,.pd-select{",
      "  box-sizing:border-box;width:100%;max-width:100%;resize:vertical;font-family:inherit;",
      "  border-radius:12px;border:1px solid var(--dsw-alias-border-l2);",
      "  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);",
      "  font-size:13px;line-height:20px;padding:6px 10px;outline:none;",
      "  transition:border-color 120ms ease;}",
      ".pd-input:focus,.pd-textarea:focus,.pd-select:focus{border-color:var(--dsw-alias-state-business-primary);",
      "  box-shadow:0 0 0 3px var(--dsw-alias-state-business-primary);}",
      ".pd-input:disabled,.pd-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;}",
      // 快捷键输入框：固定宽度且不参与收缩，标签才有稳定空间。
      // 必须写在 .pd-input 之后：两者特异性相同，靠顺序覆盖 width:100%。
      ".pd-shortcutInput{width:120px;flex:none;cursor:pointer;}",
      // 录入态：边框高亮 + 占位提示，让用户知道“现在请按组合键”
      ".pd-shortcutCapturing{border-color:var(--dsw-alias-state-business-primary);",
      "  background:var(--dsw-alias-interactive-bg-hover);}",
      ".pd-shortcutCapturing::placeholder{color:var(--dsw-alias-state-business-primary);}",
      // 开关状态文字：颜色 + 文案双重表达，不依赖只有颜色的小滑块
      ".pd-stateText{flex:none;font-size:12px;line-height:18px;white-space:nowrap;margin-right:2px;}",
      ".pd-stateOn{color:var(--dsw-alias-state-success);}",
      ".pd-stateOff{color:var(--dsw-alias-label-tertiary);}",
      ".pd-inputSm{width:72px;flex:none;}",
      // 模型触发器：固定模型时给出明确的选中态，避免与「跟随全局默认」混淆
      ".pd-modelTrigger{max-width:260px;border:1px solid var(--dsw-alias-border-l2);}",
      ".pd-modelTriggerFixed{border-color:var(--dsw-alias-state-business-primary);",
      "  background:var(--dsw-alias-interactive-bg-hover);",
      "  color:var(--dsw-alias-state-business-primary);}",
      ".pd-pillProvider{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
      "  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}",
      ".pd-toggle{padding-left:6px;background:transparent;border:none;cursor:pointer;",
      "  display:inline-flex;align-items:center;border-radius:999px;}",
      ".pd-toggle:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsw-alias-state-business-primary);}",
      ".pd-toggle:disabled{cursor:default;}",
      ".pd-toggleTrack{box-sizing:border-box;width:36px;height:20px;padding:2px;flex:none;border-radius:999px;border:0;",
      "  background:var(--dsw-alias-border-l2);position:relative;transition:background-color 120ms ease;",
      // 关闭态额外加一圈内描边：浅色下 border-l2 与卡片底色太接近，看不出这是开关
      "  box-shadow:inset 0 0 0 1px var(--dsw-alias-label-tertiary);}",
      ".pd-toggleKnob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;",
      "  background:var(--dsw-alias-bg-layer-3);transition:transform 120ms ease;",
      "  box-shadow:0 1px 2px var(--dsw-alias-border-l2);}",
      ".pd-toggleOn .pd-toggleTrack{background:var(--dsw-alias-state-business-primary);",
      "  box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary);}",
      ".pd-toggleOn .pd-toggleKnob{transform:translateX(16px);}",
      ".pd-toggle:hover .pd-toggleTrack{filter:brightness(0.96);}",
      ".pd-toggle:disabled .pd-toggleTrack{opacity:.45;}",
      ".pd-itemList{display:flex;flex-direction:column;gap:10px;}",
      // 折叠行：标题栏常显，正文只在展开时渲染
      ".pd-fold{padding:0;overflow:hidden;}",
      ".pd-foldHead{",
      "  box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;",
      "  min-height:40px;padding:8px 12px;border:none;background:transparent;cursor:pointer;",
      "  text-align:left;font-family:inherit;color:var(--dsw-alias-label-primary);",
      "  border-radius:12px;transition:background-color 120ms ease;}",
      ".pd-foldHead:hover{background:var(--dsw-alias-interactive-bg-hover);}",
      ".pd-foldHead:focus-visible{outline:none;box-shadow:0 0 0 3px var(--dsw-alias-state-business-primary);}",
      ".pd-foldChev{flex:none;color:var(--dsw-alias-label-secondary);}",
      ".pd-foldMain{display:flex;flex-direction:column;flex:1;min-width:0;}",
      ".pd-foldName{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".pd-foldSum{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);",
      "  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".pd-foldBody{display:flex;flex-direction:column;gap:10px;padding:0 12px 12px;}",
      // 配置加载中/失败的状态框（避免三处内容同时显示为空壳）
      ".pd-stateBox{display:flex;flex-direction:column;gap:10px;align-items:flex-start;}",
      ".pd-stateBox[data-pd-config-state=\"error\"] .pd-help{color:var(--dsw-alias-state-danger);}",
      ".pd-foldOpen>.pd-foldHead{border-bottom:1px solid var(--dsw-alias-border-l2);",
      "  border-radius:12px 12px 0 0;}",
      ".pd-itemList{display:flex;flex-direction:column;gap:10px;}",
      ".pd-cardFoot{display:flex;gap:6px;align-items:center;justify-content:flex-end;}",
      "@media (prefers-reduced-motion:reduce){",
      "  .pd-popover,.pd-toast,.pd-successFlash,.pd-shimmer::after{animation:none;}",
      "  .pd-chevron,.pd-btn,.pd-option,.pd-toggleTrack,.pd-toggleKnob{transition:none;}",
      "  .pd-spin{animation:pd-spin 1.4s linear infinite;}}",
    ].join("\n");
    var cssInjected = false;
    function ensureCss() {
      if (cssInjected) return;
      try {
        var sel = 'style[data-plugin-css="' + PKG_NAME + '"]';
        if (document.querySelector(sel)) { cssInjected = true; return; }
        var tag = document.createElement("style");
        tag.dataset.plugin = PKG_NAME;
        tag.dataset.pluginCss = PKG_NAME;
        tag.textContent = CSS_TEXT;
        document.head.appendChild(tag);
        cssInjected = true;
      } catch (e) {}
    }

    // =====================================================================
    // 默认值兜底（宿主总是返回完整配置；这里只防首次读取前/读取失败）
    // =====================================================================
    var FALLBACK_STYLES = [
      { id: "concise", name: "更简洁", instruction: "" },
      { id: "detailed", name: "更详细", instruction: "" },
      { id: "structured", name: "结构化", instruction: "" },
      { id: "en", name: "译成英文", instruction: "" },
      { id: "custom", name: "自定义", instruction: "" },
    ];
    var FALLBACK_CONF = {
      rewriteModel: null, timeoutMs: 90000, contextEnabled: true, contextTurns: 6,
      globalDiscipline: "", globalDisciplineCustom: false,
      styles: FALLBACK_STYLES, templates: [],
      toolbar: { showStyleEntry: "auto", showTemplateEntry: "auto", compactThreshold: 320 },
      shortcuts: { openStyle: "Alt+M", openTemplate: "Alt+T", rewrite: "Alt+R" },
    };
    function confOf(st) {
      var c = st.conf || {};
      return {
        rewriteModel: c.rewriteModel || null,
        timeoutMs: typeof c.timeoutMs === "number" ? c.timeoutMs : 90000,
        contextEnabled: c.contextEnabled !== false,
        contextTurns: typeof c.contextTurns === "number" ? c.contextTurns : 6,
        globalDiscipline: c.globalDiscipline || "",
        globalDisciplineCustom: !!c.globalDisciplineCustom,
        styles: Array.isArray(c.styles) && c.styles.length ? c.styles : FALLBACK_STYLES,
        templates: Array.isArray(c.templates) ? c.templates : [],
        toolbar: Object.assign({}, FALLBACK_CONF.toolbar, c.toolbar || {}),
        shortcuts: Object.assign({}, FALLBACK_CONF.shortcuts, c.shortcuts || {}),
      };
    }

    // =====================================================================
    // 六态反馈机：idle → requesting → streaming → success / error / cancelled
    // 只实现一次，工具行与预览都复用它。
    // =====================================================================
    var PHASE = {
      IDLE: "idle", REQUESTING: "requesting", STREAMING: "streaming",
      SUCCESS: "success", ERROR: "error", CANCELLED: "cancelled",
    };
    var FEEDBACK_PHASES = [PHASE.IDLE, PHASE.REQUESTING, PHASE.STREAMING, PHASE.SUCCESS, PHASE.ERROR, PHASE.CANCELLED];
    // 六类错误：用户可见文案 + 可执行动作（绝不展示原始错误文本）
    var ERROR_CLASS = {
      NETWORK: "network", TIMEOUT: "timeout", AUTH: "auth",
      MODEL: "model", EMPTY: "empty", CANCELLED: "cancelled",
    };
    var ERROR_COPY = {
      network: "连接失败，请检查网络后重试",
      timeout: "改写超时（{seconds} 秒），可重试或缩短草稿",
      auth: "改写模型未配置或凭据失效，请到设置中检查",
      model: "模型未能完成改写：{reason}",
      empty: "未获得有效改写结果",
      cancelled: "已取消改写",
    };
    var ERROR_ACTION = {
      network: "retry", timeout: "retry", auth: "openSettings", model: "retry", empty: "retry", cancelled: "none",
    };
    function errorCopy(cls, params) {
      var tpl = ERROR_COPY[cls] || ERROR_COPY.model;
      var secs = (params && params.seconds) || 90;
      var reason = shortReason((params && params.reason) || "");
      return tpl.replace("{seconds}", String(secs)).replace("{reason}", reason);
    }
    // 模型原因必须「简短」：去掉换行/多余空白，超长截断
    function shortReason(raw) {
      var s = String(raw || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
      // 去掉上游常见的英文前缀，只留可读原因
      s = s.replace(/^(error|failed|exception|bad request|upstream error)\s*[:：-]\s*/i, "");
      if (s.length > 40) s = s.slice(0, 40) + "…";
      return s || "上游返回错误";
    }
    // 宿主/传输错误 → 六类；映射表集中在此，界面只认类
    function classifyError(err) {
      var code = String((err && err.code) || "").toUpperCase();
      if (code === "NO_MODEL" || code === "NO_LLM" || code === "AUTH" || code === "AUTH_FORBIDDEN"
        || code === "QUOTA" || code === "NO_INSTRUCTION") return ERROR_CLASS.AUTH;
      if (code === "TIMEOUT") return ERROR_CLASS.TIMEOUT;
      if (code === "EMPTY_REPLY" || code === "EMPTY_TEXT") return ERROR_CLASS.EMPTY;
      if (code === "NETWORK" || code === "FETCH_FAILED") return ERROR_CLASS.NETWORK;
      // STREAM_BROKEN：连接已建立但流中断/解析失败，属于上游未完成，不是连不上
      if (code === "STREAM_BROKEN") return ERROR_CLASS.MODEL;
      return ERROR_CLASS.MODEL;
    }
    function errorFeedback(err) {
      var cls = classifyError(err);
      return {
        cls: cls,
        text: errorCopy(cls, { reason: err && err.message, seconds: err && err.seconds }),
        action: ERROR_ACTION[cls] || "retry",
        retryable: ERROR_ACTION[cls] === "retry",
      };
    }

    // 长度提示（琥珀色提示，不截断结果）
    var LENGTH_MIN = 80;
    function lengthHint(resultLen, styleLimit) {
      var n = Number(resultLen) || 0;
      if (n > 0 && n < LENGTH_MIN) return "结果偏短（" + n + " 字），可能丢失了约束";
      var limit = Number(styleLimit) || 0;
      if (limit > 0 && n > Math.round(limit * 1.2)) return "结果偏长（" + n + " 字），请检查是否新增了内容";
      return "";
    }

    // =====================================================================
    // 芯片检测：草稿含 @文件 / /命令 引用时禁止改写
    // 权威依据：发布的 InputState.occurrences 即引用芯片列表；setDraft 会重建段落、
    // 抹掉占位符，所以只要 occurrences 非空就拒绝改写。
    // =====================================================================
    var REFERENCE_PLACEHOLDER_RE = /[\uE100-\uE11D\uFFFC]/u;

    function chipFromState(inputState) {
      if (!inputState || typeof inputState !== "object") return "";
      try {
        var occ = inputState.occurrences;
        if (Array.isArray(occ) && occ.length) {
          var o = occ[0] || {};
          return String(o.label || o.clipboardText || o.ref || "引用芯片");
        }
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
      var m = d.match(/(^|\s)@[^\s@]+\.[A-Za-z0-9]{1,8}\b/);
      if (m) return m[0].trim();
      var c = d.match(/(^|\n)\s*\/[a-zA-Z][\w:-]*/);
      if (c) return c[0].trim();
      return "";
    }

    function pickDraftText(s) {
      if (!s || typeof s !== "object") return "";
      var v = s.draft;
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && typeof v.text === "string") return v.text;
      v = s.text; if (typeof v === "string") return v;
      v = s.value; if (typeof v === "string") return v;
      v = s.content; if (typeof v === "string") return v;
      return "";
    }

    // =====================================================================
    // 快捷键：解析 / 匹配 / 描述（Alt+M 这类；忽略输入框内与浏览器保留组合）
    // =====================================================================
    function parseShortcut(str) {
      var parts = String(str || "").split("+").map(function (p) { return p.trim(); }).filter(Boolean);
      var out = { alt: false, ctrl: false, shift: false, meta: false, key: "" };
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i].toLowerCase();
        if (p === "alt" || p === "option" || p === "opt") out.alt = true;
        else if (p === "ctrl" || p === "control") out.ctrl = true;
        else if (p === "shift") out.shift = true;
        else if (p === "cmd" || p === "meta" || p === "win" || p === "super") out.meta = true;
        else out.key = parts[i];
      }
      return out;
    }
    function shortcutLabel(str) {
      var p = parseShortcut(str);
      if (!p.key) return String(str || "");
      var mods = [];
      if (p.ctrl) mods.push("Ctrl");
      if (p.alt) mods.push("Alt");
      if (p.shift) mods.push("Shift");
      if (p.meta) mods.push("Cmd");
      var key = p.key.length === 1 ? p.key.toUpperCase() : p.key;
      return mods.length ? mods.join("+") + "+" + key : key;
    }
    function isEditableTarget(el) {
      if (!el || typeof el !== "object") return false;
      var tag = String(el.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      if (typeof el.getAttribute === "function") {
        var role = el.getAttribute("role");
        if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
      }
      return false;
    }
    // 带修饰键（Alt/Ctrl/Meta）的组合：即使焦点在输入框里也应该触发快捷键。
    // 纯字符键（比如单独按 m）必须让给输入框，否则会吞掉用户正在打的字。
    // dsh 的 composer 本身就是 contenteditable，若一律跳过「可编辑目标」，
    // 快捷键在唯一的使用场景（正在输入时）反而永远不生效。
    function isShortcutChord(e) {
      return !!(e && (e.altKey || e.ctrlKey || e.metaKey));
    }
    // 返回命中的动作名（openStyle / openTemplate / rewrite），未命中返回 ""
    function matchShortcut(e, shortcuts) {
      if (!e || !shortcuts) return "";
      if (e.ctrlKey || e.metaKey) return "";  // Ctrl/Cmd 组合优先给浏览器
      if (typeof e.isComposing === "boolean" && e.isComposing) return "";
      var key = String(e.key || e.code || "");
      if (key.length === 1 && /[a-z]/i.test(key)) key = key.toUpperCase();
      var names = ["openStyle", "openTemplate", "rewrite"];
      for (var i = 0; i < names.length; i++) {
        var p = parseShortcut(shortcuts[names[i]]);
        if (!p.key) continue;
        var pk = p.key.length === 1 ? p.key.toUpperCase() : p.key;
        if (pk !== key) continue;
        if (!!p.alt !== !!e.altKey) continue;
        if (!!p.shift !== !!e.shiftKey) continue;
        if (!!p.ctrl !== !!e.ctrlKey) continue;
        if (!!p.meta !== !!e.metaKey) continue;
        return names[i];
      }
      return "";
    }

    // =====================================================================
    // 模块级共享状态（工具行 / 设置卡片 / Toast 共用）
    // =====================================================================
    var store = {
      conf: null,
      // 读取配置失败的原因（空串 = 没出错）；界面据此区分「加载中」与「读取失败」
      confError: "",
      styleId: "concise",
      phase: PHASE.IDLE,
      // 错误反馈 { cls, text, action }
      feedbackError: null,
      // 成功后可撤销的原文
      undo: null,
      models: null, modelsGlobal: null,
      // 轻量提示：宿主返回的诊断路径（不是写入目标）
      legacyPath: "",
      migrated: false,
      requestId: "",
      chars: 0,
      timeoutMs: 90000,
      // 结果长度提示（琥珀色）
      hint: "",
      // 刷新信号：宿主返回后让 React 重渲染
      rev: 0,
    };
    var subs = [];
    var currentAbort = null;
    function setStore(patch) {
      store = Object.assign({}, store, patch, { rev: (store.rev || 0) + 1 });
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

    // ---- HTTP ----
    // 传输层失败的真实原因只进控制台，绝不进 UI（UI 只显示映射后的用户话术）。
    // 排查“点改写就连接失败”时，控制台里这条是唯一的线索。
    function lastTransportError(e) {
      try {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[dsh-prompt-dock] rewrite transport failed:", {
            name: (e && e.name) || "",
            message: (e && e.message) || String(e || ""),
            url: typeof location !== "undefined" ? String(location.href) : "",
          });
        }
      } catch (err) {}
    }
    function request(path, opts) {
      var o = opts || {};
      var init = { cache: "no-store" };
      if (o.method) init.method = o.method;
      if (o.body !== undefined) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(o.body);
      }
      if (o.signal) init.signal = o.signal;
      // 显式声明期望的响应类型：只有 SSE 端点才走流式分支。
      // 不能靠「body 有没有 getReader」判断——真实浏览器的每个响应（包括普通 JSON）
      // 都有 body.getReader()，那样会把所有 JSON 响应误判成流，json 永远是空的。
      var wantsStream = !!o.stream;
      return fetch(path, init).then(function (r) {
        if (!r) return { status: undefined, ok: false, json: null, raw: undefined };
        var ctype = "";
        try {
          ctype = String((r.headers && typeof r.headers.get === "function" && r.headers.get("content-type")) || "");
        } catch (e) { ctype = ""; }
        var isSse = ctype.indexOf("text/event-stream") !== -1;
        // 流式响应（SSE）的 body 只能读一次，必须由调用方用 getReader 消费。
        // 这里绝不能预先 r.json()：那会把流读空/读失败，调用方随后拿不到 delta。
        if (isSse || (wantsStream && !ctype)) {
          return { status: r.status, ok: r.ok, json: null, raw: r, stream: true };
        }
        // 非流式：没有 json() 时按无正文处理
        if (typeof r.json !== "function") return { status: r.status, ok: !!r.ok, json: null, raw: r };
        return r.json().catch(function () { return null; }).then(function (j) {
          return { status: r.status, ok: r.ok, json: j, raw: r };
        });
      });
    }
    function api(path, body) {
      return body === undefined ? request(path) : request(path, { method: "POST", body: body });
    }

    var confRequested = false;
    function fetchConf() {
      return api(API + "/config").then(function (r) {
        var j = r.json;
        if (r.ok && j && j.ok) {
          setStore({
            conf: j,
            confError: "",
            legacyPath: j.legacyPath || "",
            migrated: !!j.migrated,
            timeoutMs: typeof j.timeoutMs === "number" ? j.timeoutMs : 90000,
          });
          return j;
        }
        // 服务端有应答但不是 ok：记下原因，界面据此显示“读取失败”而不是空壳
        var msg = (j && j.error && (j.error.message || j.error.code)) ||
          ("HTTP " + (r.status == null ? "?" : r.status));
        setStore({ confError: msg });
        return null;
      }).catch(function (e) {
        setStore({ confError: "网络不可用" });
        return null;
      });
    }
    function ensureConf() {
      if (confRequested) return;
      confRequested = true;
      fetchConf();
    }
    // 重试：允许再次请求（清掉一次性标记）
    function retryConf() {
      confRequested = false;
      setStore({ confError: "" });
      ensureConf();
      ensureModels();
    }
    var modelsLoading = false;
    function ensureModels() {
      if (store.models || modelsLoading) return;
      modelsLoading = true;
      api(API + "/models").then(function (r) {
        modelsLoading = false;
        var j = r.json;
        if (r.ok && j && j.ok) setStore({ models: j.groups || [], modelsGlobal: j.global || null });
      }).catch(function () { modelsLoading = false; });
    }

    // 保存：只提交改动分组的键；成功后用宿主返回的完整配置刷新本地
    function saveConfig(patch) {
      return api(API + "/config", patch).then(function (r) {
        var j = r.json;
        if (r.ok && j && j.ok) {
          setStore({
            conf: j, legacyPath: j.legacyPath || store.legacyPath, feedbackError: null,
            timeoutMs: typeof j.timeoutMs === "number" ? j.timeoutMs : store.timeoutMs,
          });
          toast("设置已保存");
          return { ok: true, json: j };
        }
        var msg = (j && j.error && j.error.message) || "设置未能写入";
        toast(msg);
        return { ok: false, message: msg };
      }).catch(function () {
        toast("连接失败，设置未保存");
        return { ok: false, message: "连接失败" };
      });
    }

    // 打开配置文件：宿主返回 404 NO_DOCUMENT 表示没有可打开的文档
    function openConfigFile() {
      return request(API + "/open-config", { method: "POST", body: {} }).then(function (r) {
        var j = r.json;
        if (r.ok && j && j.ok) return { ok: true, path: j.path };
        if (r.status === 404) {
          toast("当前宿主未提供可打开的文件");
          return { ok: false, code: (j && j.error && j.error.code) || "NO_DOCUMENT" };
        }
        var msg = (j && j.error && j.error.message) || ("打开失败（HTTP " + r.status + "）");
        toast(msg);
        return { ok: false, message: msg };
      }).catch(function () {
        toast("连接失败，无法打开文件");
        return { ok: false, message: "连接失败" };
      });
    }

    // =====================================================================
    // Toast：底部居中，最多 2 条，2500–3000ms 自动消失
    // =====================================================================
    var TOAST_MAX = 2;
    var TOAST_TTL = 2800;
    var toastSeq = 0;
    var toastState = [];
    var toastSubs = [];
    function emitToasts() {
      var snapshot = toastState.slice();
      for (var i = 0; i < toastSubs.length; i++) { try { toastSubs[i](snapshot); } catch (e) {} }
    }
    function toast(text) {
      if (!text) return "";
      var id = "t" + (++toastSeq);
      toastState = toastState.concat([{ id: id, text: String(text) }]);
      // 超出上限则丢弃最旧的
      if (toastState.length > TOAST_MAX) toastState = toastState.slice(toastState.length - TOAST_MAX);
      emitToasts();
      var ttl = TOAST_TTL;
      if (typeof setTimeout === "function") {
        setTimeout(function () { dismissToast(id); }, ttl);
      }
      return id;
    }
    function dismissToast(id) {
      var next = toastState.filter(function (t) { return t.id !== id; });
      if (next.length === toastState.length) return;
      toastState = next;
      emitToasts();
    }

    // ---- 首次使用告知（轻提示，非模态、不抢焦点、只用一次） ----
    // 设计取舍：它不是 toast——toast 2.8s 会自动消失，且与「已插入模板」等瞬时反馈
    // 共用 2 条上限，会被挤掉。这里做成一条常驻到用户关闭为止的细提示条。
    var DISCLOSURE_KEY = "dsh-prompt-dock:disclosure:v1";
    function readFlag(key) {
      try {
        return typeof localStorage !== "undefined" && localStorage.getItem(key) === "1";
      } catch (e) { return false; }
    }
    function writeFlag(key) {
      try { if (typeof localStorage !== "undefined") localStorage.setItem(key, "1"); } catch (e) {}
    }
    // 首次点击改写：告知草稿会发给用户自己配置的模型。关闭后不再出现。
    function shouldDisclose() { return !readFlag(DISCLOSURE_KEY); }
    function ackDisclosure() { writeFlag(DISCLOSURE_KEY); }
    function Toasts() {
      var list = useToasts();
      var disc = useState(function () { return shouldDisclose(); });
      var showDisc = disc[0]; var setShowDisc = disc[1];
      if (!list.length && !showDisc) return null;
      return h("div", {
        className: "pd-toasts", role: "status", "aria-live": "polite", "data-pd-toasts": "1",
      },
        showDisc ? h("div", { className: "pd-toast pd-disclosure", "data-pd-disclosure": "1" },
          h("span", { className: "pd-toastText" }, "点击改写会将当前草稿发送至你配置的模型。"),
          h("button", {
            className: "pd-toastClose", "aria-label": "知道了",
            onClick: function () { ackDisclosure(); setShowDisc(false); },
          }, "知道了")
        ) : null,
        list.map(function (t) { return h("div", { key: t.id, className: "pd-toast" }, t.text); }));
    }
    function useToasts() {
      var pair = useState(function () { return toastState.slice(); });
      useEffect(function () {
        toastSubs.push(pair[1]);
        return function () { toastSubs = toastSubs.filter(function (f) { return f !== pair[1]; }); };
      }, []);
      return pair[0];
    }
    // Toast 渲染：只依赖 react。座位把它挂在自身 React 树里（fixed 定位，不影响布局）。
    // 首次使用告知也是一条常驻到关闭为止的细条，与 toast 共用同一容器。

    // =====================================================================
    // 草稿读写
    // =====================================================================
    function waitVerify(getDraft, expected) {
      return new Promise(function (resolve) {
        var t0 = Date.now();
        var iv = setInterval(function () {
          if (getDraft() === expected) { clearInterval(iv); resolve(true); }
          else if (Date.now() - t0 > 800) { clearInterval(iv); resolve(false); }
        }, 40);
      });
    }
    // 只走官方 setDraft：失败时显式报告，不猜测其它方法名
    function writeDraft(actions, text, getDraft) {
      var fn = actions && actions.setDraft;
      if (typeof fn !== "function") return Promise.resolve({ ok: false, reason: "NO_SETTER" });
      try { fn.call(actions, text); } catch (e) {
        return Promise.resolve({ ok: false, reason: "THROW", detail: String((e && e.message) || e) });
      }
      return waitVerify(getDraft, text).then(function (ok) {
        return ok ? { ok: true } : { ok: false, reason: "NOT_APPLIED" };
      });
    }
    function writeDraftError(r) {
      if (r.reason === "NO_SETTER") return "当前宿主不支持写回输入框（缺少 setDraft）";
      if (r.reason === "NOT_APPLIED") return "写入输入框未生效";
      return "写入输入框失败";
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

    // =====================================================================
    // 图标（内置 SVG，stroke=currentColor，无 emoji）
    // =====================================================================
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
    // 改写：官方 sparkle
    function IconSparkle(props) {
      var size = props && props.size ? props.size : 14;
      return h("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
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
    // 撤销：↩ 的矢量等价物（细描边圆角箭头）
    function IconUndo() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M5.4 3.2 2.6 6l2.8 2.8M2.8 6h6.6a3.6 3.6 0 0 1 0 7.2H6.2",
          stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round",
        }));
    }
    // 风格：倾斜的笔尖
    function IconStyle() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M10.9 2.2 13.8 5.1 5.6 13.3 2.2 13.8 2.7 10.4 10.9 2.2Z",
          stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round",
        }));
    }
    // 模板：文本行
    function IconTemplate() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M3.2 3.4h9.6M3.2 6.6h9.6M3.2 9.8h6.4M3.2 13h4.4",
          stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round",
        }));
    }
    function IconTrash() {
      return h("svg", { width: 13, height: 13, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M2.6 4.3h10.8M6.4 2.4h3.2M4.1 4.3l.65 8.4a1.1 1.1 0 0 0 1.1 1h4.3a1.1 1.1 0 0 0 1.1-1l.65-8.4M6.7 6.8v4.6M9.3 6.8v4.6",
          stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round", strokeLinejoin: "round",
        }));
    }
    function IconPlus() {
      return h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M8 3.2v9.6M3.2 8h9.6", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }));
    }
    function IconClose() {
      return h("svg", { width: 12, height: 12, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", { d: "M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }));
    }
    function IconFolder() {
      return h("svg", { width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
        h("path", {
          d: "M2 4.6c0-.6.5-1.1 1.1-1.1h2.6l1.4 1.6h5.8c.6 0 1.1.5 1.1 1.1v5.2c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1V4.6Z",
          stroke: "currentColor", strokeWidth: "1.2", strokeLinecap: "round", strokeLinejoin: "round",
        }));
    }
    function Spinner() { return h("span", { className: "pd-spin", "aria-hidden": "true" }); }

    // =====================================================================
    // 弹层锚定：实时跟随触发按钮（滚动 / 缩放）
    // =====================================================================
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
      var el = anchorRef && anchorRef.current;
      var r = el && typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
      return r && r.width ? { left: r.left, top: r.top, width: r.width, right: r.right, bottom: r.bottom } : null;
    }

    // =====================================================================
    // PdPopover —— 一级菜单弹层（无嵌套；键盘 ↑↓ / Enter / Esc）
    // =====================================================================
    function PdPopover(props) {
      var ref = useRef(null);
      var anchor = useAnchorFollow(props.anchorRef, props.onClose, true);
      // 键盘高亮索引：受控则用 props.activeIndex + onActiveIndexChange（父级持有，
      // 弹层重挂载也不丢），否则退化为内部 state。
      var innerState = useState(0);
      var controlled = typeof props.onActiveIndexChange === "function";
      var index = controlled
        ? (props.activeIndex == null ? 0 : props.activeIndex)
        : innerState[0];
      function setIndex(n) {
        if (controlled) props.onActiveIndexChange(n);
        else innerState[1](n);
      }
      useEffect(function () {
        function onDoc(e) {
          if (e && e.target && typeof e.target.closest === "function" && e.target.closest("[data-pd-popover]")) return;
          var a = props.anchorRef && props.anchorRef.current;
          if (a && typeof a.contains === "function" && a.contains(e.target)) return;
          if (ref.current && typeof ref.current.contains === "function" && ref.current.contains(e.target)) return;
          props.onClose();
        }
        document.addEventListener("mousedown", onDoc);
        return function () { document.removeEventListener("mousedown", onDoc); };
      }, []);
      if (!anchor) return null;
      var items = props.items || [];
      var maxW = Math.min(props.maxWidth || 320, Math.max(160, anchor.right - 8));
      function onKeyDown(e) {
        var count = items.length;
        if (!count) return;
        if (e.key === "ArrowDown") { e.preventDefault(); setIndex(Math.min(count - 1, index + 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setIndex(Math.max(0, index - 1)); }
        else if (e.key === "Home") { e.preventDefault(); setIndex(0); }
        else if (e.key === "End") { e.preventDefault(); setIndex(count - 1); }
        else if (e.key === "Enter") {
          e.preventDefault();
          var it = items[index];
          if (it) props.onPick(it);
        } else if (e.key === "Escape") {
          e.preventDefault();
          props.onClose(true);
        }
      }
      // 关键：浮层是「焦点在 composer 里」时打开的（Alt+M / 点按钮都不夺焦点），
      // 键盘事件根本到不了浮层内部。因此浮层打开期间在 document 捕获阶段接管
      // ↑↓/Enter/Esc —— 否则 ↑↓ 会在输入框里移动光标、Enter 会把草稿发送出去。
      //
      // indexRef 是键盘导航的「权威索引」：按键时**同步**前进，再交给 setIndex 渲染。
      // 不能直接用渲染闭包里的 index——React 的 setState 是异步的，连按两下 ↓
      // 两次事件都发生在同一次渲染之前，会读到同一个旧 index，表现为
      // 「按了两下只移动一格」。
      //
      // 但也不能在每次渲染时无条件 indexRef.current = index：渲染可能发生在提交之前
      // （并发/StrictMode），会把刚推进的值覆盖回旧值。因此只在「这次渲染看到的值
      // 与我记录的待提交值不同」时才采纳渲染值——那是鼠标 hover 之类的**外部**变更。
      var indexRef = useRef(index);
      var pendingRef = useRef(null);   // 键盘刚提交、等待渲染确认的值
      if (pendingRef.current !== null && index === pendingRef.current) {
        // 渲染已跟上，清掉待确认标记
        pendingRef.current = null;
      } else if (pendingRef.current === null) {
        // 没有未确认的键盘变更：采纳渲染值（hover / 受控父级改动）
        indexRef.current = index;
      }
      var itemsRef = useRef(items);
      itemsRef.current = items;
      var handlersRef = useRef(null);
      handlersRef.current = { onPick: props.onPick, onClose: props.onClose, setIndex: setIndex };
      // 键盘推进后统一走这里：先同步 ref，再登记待确认值，最后触发渲染
      function moveIndex(next) {
        indexRef.current = next;
        pendingRef.current = next;
        setIndex(next);
      }      useEffect(function () {
        function onDocKey(e) {
          var list = itemsRef.current || [];
          if (!list.length) return;
          var key = e && e.key;
          if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End" &&
              key !== "Enter" && key !== "Escape") return;
          // 输入法组合中不拦截（回车用于确认候选词）
          if (e.isComposing) return;
          if (typeof e.preventDefault === "function") e.preventDefault();
          if (typeof e.stopPropagation === "function") e.stopPropagation();
          var count = list.length;
          var h2 = handlersRef.current;
          var cur = indexRef.current;
          if (key === "ArrowDown") moveIndex(Math.min(count - 1, cur + 1));
          else if (key === "ArrowUp") moveIndex(Math.max(0, cur - 1));
          else if (key === "Home") moveIndex(0);
          else if (key === "End") moveIndex(count - 1);
          else if (key === "Enter") {
            var it = list[indexRef.current];
            if (it) h2.onPick(it);
          } else if (key === "Escape") {
            h2.onClose(true);
          }
        }
        document.addEventListener("keydown", onDocKey, true);
        return function () { document.removeEventListener("keydown", onDocKey, true); };
      }, []);
      var rows = items.map(function (it, i) {
        var active = props.currentId != null && it.id === props.currentId;
        // 键盘当前项：↑↓ 移动时必须实时可见，否则用户看不出选到了哪一项。
        // 与 pd-optionOn（已选中的风格）是两个不同概念，两个类要能同时存在。
        var kbCurrent = i === index;
        var row = h("button", {
          key: it.id,
          type: "button",
          className: "pd-option" + (active ? " pd-optionOn" : "") + (kbCurrent ? " pd-optionActive" : ""),
          role: "menuitem",
          tabIndex: i === index ? 0 : -1,
          "data-index": i,
          "data-pd-option-active": kbCurrent ? "1" : "0",
          title: it.title || it.label,
          onMouseEnter: function () { setIndex(i); },
          onKeyDown: onKeyDown,
          onClick: function (e) { if (e && e.stopPropagation) e.stopPropagation(); props.onPick(it); },
        },
          h("span", { className: "pd-optionCopy" },
            h("span", { className: "pd-optionName" }, it.label),
            it.summary ? h("span", { className: "pd-optionSum" }, it.summary) : null
          ),
          // 当前项不用对勾：底色 + inset 描边由 .pd-optionOn 提供
          null
        );
        // 分组标题：item.header 非空时在该行之前插入
        if (!it.header) return row;
        return h("div", { key: "g:" + it.id, style: { display: "contents" } },
          h("div", { className: "pd-groupLabel" }, it.header), row);
      });
      return h("div", {
        key: "popover",
        ref: ref,
        className: "pd-popover" + (props.searchable || props.grouped ? " pd-popoverScroll" : ""),
        "data-pd-popover": "1",
        role: "menu",
        "aria-label": props.ariaLabel || "菜单",
        onKeyDown: onKeyDown,
        style: {
          right: Math.max(8, (typeof window !== "undefined" ? window.innerWidth : 0) - anchor.right),
          bottom: (typeof window !== "undefined" ? window.innerHeight : 0) - anchor.top + 6,
          maxWidth: maxW,
        },
      },
        props.header || null,
        props.searchable ? h("input", {
          className: "pd-search",
          placeholder: "搜索模板",
          value: props.query || "",
          "aria-label": "搜索模板",
          // 搜索框不在 items 里：键盘 ↑↓ 仍交给弹层
          onKeyDown: onKeyDown,
          onChange: function (e) { if (props.onQueryChange) props.onQueryChange(e.target.value); },
        }) : null,
        rows.length ? rows : h("div", { className: "pd-empty" }, props.emptyText || "没有可选项")
      );
    }

    // =====================================================================
    // 反馈渲染：六态统一在这里出文字/图标
    // =====================================================================
    function feedbackLabel(st) {
      if (st.phase === PHASE.REQUESTING) return "正在连接…";
      if (st.phase === PHASE.STREAMING) return "改写中 " + (st.chars || 0) + " 字";
      if (st.phase === PHASE.SUCCESS) return "改写完成";
      return "";
    }
    function FeedbackButton(props) {
      var st = props.store;
      var busy = st.phase === PHASE.REQUESTING || st.phase === PHASE.STREAMING;
      if (st.phase === PHASE.SUCCESS && props.onUndo) {
        // 成功：按钮原地变成 ↩ 撤销，1.5s 绿色高亮
        return h("button", {
          type: "button",
          className: "pd-btn pd-btnIconOnly pd-successFlash",
          title: "撤销改写，恢复原文",
          "aria-label": "撤销改写",
          disabled: props.disabled,
          onClick: props.onUndo,
        }, h(IconUndo));
      }
      if (busy && props.onCancel) {
        return h("button", {
          type: "button",
          className: "pd-btn pd-btnQuiet",
          title: st.phase === PHASE.REQUESTING ? "正在连接…" : "取消改写",
          "aria-label": "取消改写",
          onClick: props.onCancel,
        }, h(Spinner), h("span", { className: "pd-label" }, feedbackLabel(st)));
      }
      return h("button", {
        type: "button",
        className: "pd-btn pd-btnIconOnly pd-btnPrimary" + (st.phase === PHASE.ERROR ? " pd-edgeDanger" : ""),
        title: props.title,
        "aria-label": "改写",
        disabled: props.disabled,
        "aria-busy": busy ? "true" : undefined,
        onClick: props.onClick,
      }, h(IconSparkle));
    }
    // 错误条：位于工具行下方 / 输入框上方，不遮挡输入；可手动关闭；不抢焦点
    function ErrorBar(props) {
      var err = props.error;
      if (!err) return null;
      var retry = err.action === "retry" && props.onRetry ? h("button", {
        type: "button", className: "pd-btn pd-btnSm pd-btnDangerText", tabIndex: -1,
        onMouseDown: function (e) { if (e && e.preventDefault) e.preventDefault(); },
        onClick: props.onRetry,
      }, "重试") : null;
      var openSettings = err.action === "openSettings" && props.onOpenSettings ? h("button", {
        type: "button", className: "pd-btn pd-btnSm pd-btnDangerText", tabIndex: -1,
        onMouseDown: function (e) { if (e && e.preventDefault) e.preventDefault(); },
        onClick: props.onOpenSettings,
      }, "打开设置") : null;
      return h("div", {
        className: "pd-errorBar", role: "alert", "data-pd-error": err.cls,
      },
        h("span", { className: "pd-errorMark", "aria-hidden": "true" }, "!"),
        // 左侧槽位宽度有限：文案截断，但 title 保留全文
        h("span", { className: "pd-errorText", title: err.text }, err.text),
        h("span", { className: "pd-errorActions" },
          retry, openSettings,
          h("button", {
            type: "button", className: "pd-btn pd-btnSm", title: "关闭提示", tabIndex: -1,
            onMouseDown: function (e) { if (e && e.preventDefault) e.preventDefault(); },
            onClick: props.onDismiss,
          }, h(IconClose))
        )
      );
    }

    // =====================================================================
    // 设置卡片（plugins.bundle.config）
    // =====================================================================
    function Toggle(props) {
      var on = !!props.checked;
      return h("button", {
        type: "button",
        className: "pd-toggle" + (on ? " pd-toggleOn" : ""),
        "aria-pressed": on,
        role: "switch",
        "aria-checked": on,
        disabled: props.disabled,
        title: props.title,
        onClick: function () { if (props.onChange) props.onChange(!on); },
      }, h("span", { className: "pd-toggleTrack" }, h("span", { className: "pd-toggleKnob" })));
    }
    function ModelSelect(props) {
      var st = useStore();
      var btnRef = useRef(null);
      var openState = useState(false); var open = openState[0]; var setOpen = openState[1];
      useEffect(function () { ensureModels(); }, []);
      var rm = props.value || null;
      var groups = st.models || [];
      var global = st.modelsGlobal;
      // 同一个模型名会在多个 provider 下重复（deepseek-flash 在 official / account 都有），
      // 只显示模型名时用户看不出自己选的是哪个，会误以为"没改成功"。
      // 因此菜单项统一显示「provider · model」，并在选中判定里带上 provider。
      function providerName(pid) {
        var hit = null;
        groups.forEach(function (g) { if (g.id === pid) hit = g.name || g.id; });
        return hit || pid || "";
      }
      var items = [{
        id: "",
        label: "跟随全局默认",
        summary: global ? providerName(global.provider) + " · " + global.model : "",
      }];
      groups.forEach(function (g) {
        (g.models || []).forEach(function (m) {
          var modelName = m.name || m.id;
          items.push({
            id: g.id + "/" + m.id,
            label: modelName,
            summary: (g.name || g.id) + " · " + m.id,
          });
        });
      });
      // 触发器标签：固定模型时显示「provider · model」中的模型显示名 + provider 名，
      // 与「跟随全局默认」在视觉上必须可分辨
      var label = "跟随全局默认";
      var labelTitle = global ? "当前全局默认：" + providerName(global.provider) + " · " + global.model : "跟随全局默认模型";
      if (rm) {
        var modelLabel = rm.model;
        groups.forEach(function (g) {
          if (g.id !== rm.provider) return;
          (g.models || []).forEach(function (m) { if (m.id === rm.model) modelLabel = m.name || m.id; });
        });
        label = modelLabel;
        labelTitle = "改写固定使用：" + providerName(rm.provider) + " · " + rm.model;
      }
      var fixed = !!rm;
      return [
        h("button", {
          key: "model-trigger",
          ref: btnRef,
          type: "button",
          className: "pd-btn pd-modelTrigger" + (fixed ? " pd-modelTriggerFixed" : ""),
          "aria-haspopup": "menu",
          "aria-expanded": open,
          title: labelTitle,
          "data-pd-model-fixed": fixed ? "1" : "0",
          onClick: function () { setOpen(!open); },
        },
          h("span", { className: "pd-label" }, label),
          fixed ? h("span", { className: "pd-pill pd-pillProvider" }, providerName(rm.provider)) : null,
          h(IconChevron, { open: open })
        ),
        open ? h(PdPopover, {
          key: "model-menu",
          anchorRef: btnRef,
          items: items,
          currentId: rm ? rm.provider + "/" + rm.model : "",
          ariaLabel: "改写模型",
          maxWidth: 360,
          onClose: function () { setOpen(false); },
          onPick: function (it) {
            setOpen(false);
            if (it.id === "") { props.onChange(null); return; }
            var sp = it.id.indexOf("/");
            props.onChange({ provider: it.id.slice(0, sp), model: it.id.slice(sp + 1) });
          },
        }) : null,
      ];
    }

    // 风格库 / 模板库的行内编辑器
    // 折叠行：标题栏常显（名称 + 摘要 + 展开箭头），点击才展开编辑区。
    // 默认全部收起——风格/模板条目多时，一屏塞满输入框没法扫读。
    function FoldRow(props) {
      var open = !!props.open;
      return h("div", { className: "pd-sub pd-fold" + (open ? " pd-foldOpen" : ""), "data-pd-fold": props.id },
        h("button", {
          type: "button",
          className: "pd-foldHead",
          "aria-expanded": open,
          title: open ? "收起" : "展开编辑",
          onClick: props.onToggle,
          "data-pd-fold-toggle": props.id,
        },
          h(IconChevron, { open: open, className: "pd-foldChev" }),
          h("span", { className: "pd-foldMain" },
            h("span", { className: "pd-foldName" }, props.name || "未命名"),
            props.summary ? h("span", { className: "pd-foldSum" }, props.summary) : null
          ),
          props.pill ? h("span", { className: "pd-pill" }, props.pill) : null
        ),
        open ? h("div", { className: "pd-foldBody" }, props.body) : null
      );
    }
    // 摘要：把多行正文压成单行，超出截断
    function oneLine(text, max) {
      var s = String(text || "").replace(/\s+/g, " ").trim();
      if (!s) return "";
      var n = max || 60;
      return s.length > n ? s.slice(0, n) + "…" : s;
    }
    function StyleRows(props) {
      var styles = props.styles || [];
      var openState = useState({}); var open = openState[0]; var setOpen = openState[1];
      function toggle(id) { var n = Object.assign({}, open); n[id] = !n[id]; setOpen(n); }
      return h("div", { className: "pd-itemList" }, styles.map(function (s, i) {
        var isCustom = s.id === "custom";
        var key = String(s.id || i);
        return h(FoldRow, {
          key: key, id: "style:" + key, open: !!open[key],
          name: s.name || "未命名风格",
          summary: oneLine(s.instruction) || "未设置指令",
          pill: isCustom ? "自定义风格" : null,
          onToggle: function () { toggle(key); },
          body: [h("div", { className: "pd-fieldRow" },
            h("input", {
              className: "pd-input", "aria-label": "风格名称", value: s.name || "",
              placeholder: "风格名称",
              onChange: function (e) { props.onPatch(i, { name: e.target.value }); },
            }),
            h("button", {
              type: "button", className: "pd-btn pd-btnIconOnly", title: "删除此风格",
              onClick: function () { props.onRemove(i); },
            }, h(IconTrash))
          ),
          h("textarea", {
            className: "pd-textarea", "aria-label": "改写指令", value: s.instruction || "",
            placeholder: isCustom ? "自定义风格使用的改写指令" : "改写指令：描述这个风格的要求",
            style: { minHeight: 64 },
            onChange: function (e) { props.onPatch(i, { instruction: e.target.value }); },
          }),
          isCustom ? h("div", { className: "pd-help" }, "「自定义」风格改写时使用这里的指令。") : null
          ]});
      }),
        h("div", { className: "pd-cardFoot" },
          h("button", {
            type: "button", className: "pd-btn",
            onClick: function () { props.onAdd(); },
          }, h(IconPlus), h("span", { className: "pd-label" }, "添加风格"))
        )
      );
    }
    function TemplateRows(props) {
      var templates = props.templates || [];
      var openState = useState({}); var open = openState[0]; var setOpen = openState[1];
      function toggle(id) { var n = Object.assign({}, open); n[id] = !n[id]; setOpen(n); }
      if (!templates.length) return h("div", { className: "pd-sub" },
        h("div", { className: "pd-help" }, "还没有模板。添加后可从工具行「模板」一键插入草稿。"),
        h("div", { className: "pd-cardFoot" },
          h("button", { type: "button", className: "pd-btn", onClick: function () { props.onAdd(); } },
            h(IconPlus), h("span", { className: "pd-label" }, "添加模板")))
      );
      return h("div", { className: "pd-itemList" }, templates.map(function (t, i) {
        var key = String(t.id || i);
        return h(FoldRow, {
          key: key, id: "tpl:" + key, open: !!open[key],
          name: t.name || "未命名模板",
          summary: oneLine(String(t.text || "").split("\n")[0]) || "未填写内容",
          pill: t.category || null,
          onToggle: function () { toggle(key); },
          body: [h("div", { className: "pd-fieldRow" },
            h("input", {
              className: "pd-input", "aria-label": "模板名称", value: t.name || "", placeholder: "模板名称",
              onChange: function (e) { props.onPatch(i, { name: e.target.value }); },
            }),
            h("button", {
              type: "button", className: "pd-btn pd-btnIconOnly", title: "删除此模板",
              onClick: function () { props.onRemove(i); },
            }, h(IconTrash))
          ),
          h("textarea", {
            className: "pd-textarea", "aria-label": "模板内容", value: t.text || "", placeholder: "模板内容",
            style: { minHeight: 72 },
            onChange: function (e) { props.onPatch(i, { text: e.target.value }); },
          }),
          h("div", { className: "pd-fieldRow" },
            h("input", {
              className: "pd-input", "aria-label": "模板分类", value: t.category || "", placeholder: "分类（可留空）",
              onChange: function (e) { props.onPatch(i, { category: e.target.value }); },
            }),
            h("input", {
              className: "pd-input", "aria-label": "模板标签", value: (t.tags || []).join(", "),
              placeholder: "标签，逗号分隔",
              onChange: function (e) {
                var tags = String(e.target.value || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
                props.onPatch(i, { tags: tags });
              },
            })
          )],
        });
      }),
        h("div", { className: "pd-cardFoot" },
          h("button", { type: "button", className: "pd-btn", onClick: function () { props.onAdd(); } },
            h(IconPlus), h("span", { className: "pd-label" }, "添加模板")))
      );
    }

    // 「全局改写纪律」：默认只读 + 编辑解锁 + 恢复默认
    function DisciplineField(props) {
      var editingState = useState(false); var editing = editingState[0]; var setEditing = editingState[1];
      var draftState = useState(null); var draft = draftState[0]; var setDraftText = draftState[1];
      var value = editing ? (draft == null ? props.value : draft) : props.value;
      return h("div", { className: "pd-sub", "data-pd-group": "discipline" },
        h("div", { className: "pd-groupHead" },
          h("span", { className: "pd-help" }, props.custom ? "已自定义" : "内置默认"),
          h("span", { style: { flex: 1 } }),
          editing
            ? h("button", {
                type: "button", className: "pd-btn pd-btnSm",
                onClick: function () { setDraftText(null); setEditing(false); },
              }, "取消")
            : h("button", {
                type: "button", className: "pd-btn pd-btnSm",
                onClick: function () { setDraftText(null); setEditing(true); },
              }, "编辑"),
          editing
            ? h("button", {
                type: "button", className: "pd-btn pd-btnSm pd-btnPrimary",
                onClick: function () {
                  var next = draft == null ? props.value : draft;
                  setDraftText(null); setEditing(false);
                  props.onSave(next);
                },
              }, "保存")
            : h("button", {
                type: "button", className: "pd-btn pd-btnSm",
                onClick: function () { setDraftText(null); props.onRestore(); },
              }, "恢复默认")
        ),
        editing
          ? h("textarea", {
              className: "pd-textarea", "aria-label": "全局改写纪律",
              value: value, style: { minHeight: 120 },
              onChange: function (e) { setDraftText(e.target.value); },
            })
          : h("pre", { className: "pd-readonly", "aria-readonly": "true", title: value }, value || "（空）")
      );
    }

    var SHORTCUT_FIELDS = [
      { key: "openStyle", label: "打开风格菜单" },
      { key: "openTemplate", label: "打开模板菜单" },
      { key: "rewrite", label: "改写草稿" },
    ];

    // 快捷键输入框：点进去直接按组合键，系统自动录入（不是手打字符串）。
    // 手打 "Alt+J" 极易出错：漏加号就成 "AltJ"、用连字符成 "Alt-J"、大小写错位，
    // 这些都会变成永远匹配不上的死配置。录音式录入彻底避开格式问题。
    function ShortcutInput(props) {
      var draftState = useState(null);
      var draft = draftState[0]; var setDraft = draftState[1];
      var capturingState = useState(false);
      var capturing = capturingState[0]; var setCapturing = capturingState[1];
      var shown = draft == null ? String(props.value || "") : draft;

      // 把键盘事件翻译成 "Alt+J" 这样的规范字符串。
      // 只按下修饰键时返回空串（等用户按到实际字符键再录入）。
      function eventToShortcut(e) {
        var key = String(e.key || "");
        if (!key) return "";
        if (key === "Alt" || key === "Control" || key === "Shift" || key === "Meta") return "";
        var parts = [];
        if (e.ctrlKey) parts.push("Ctrl");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        if (e.metaKey) parts.push("Cmd");
        var k = key === " " ? "Space" : (key.length === 1 ? key.toUpperCase() : key);
        parts.push(k);
        return parts.join("+");
      }

      return h("input", {
        className: "pd-input pd-shortcutInput" + (capturing ? " pd-shortcutCapturing" : ""),
        "aria-label": props.label,
        value: capturing ? "" : shown,
        placeholder: capturing ? "请按下组合键…" : "点击后按组合键",
        readOnly: true,                 // 不唤起输入法/软键盘编辑，专注按键录入
        "data-pd-shortcut-capturing": capturing ? "1" : "0",
        onClick: function () { setCapturing(true); },
        onFocus: function () { setCapturing(true); },
        onBlur: function () {
          // 还没录到组合键就离开：保持原值，不算修改
          setCapturing(false);
          setDraft(null);
        },
        onKeyDown: function (e) {
          if (!e) return;
          // Esc：放弃本次录入
          if (e.key === "Escape") {
            if (e.preventDefault) e.preventDefault();
            setCapturing(false); setDraft(null);
            return;
          }
          // Backspace/Delete：清空绑定（允许取消快捷键）
          if (e.key === "Backspace" || e.key === "Delete") {
            if (e.preventDefault) e.preventDefault();
            setCapturing(false);
            props.onCommit("");
            return;
          }
          var combo = eventToShortcut(e);
          if (!combo) return;            // 只按了修饰键，继续等
          if (e.preventDefault) e.preventDefault();
          if (e.stopPropagation) e.stopPropagation();
          setCapturing(false);
          if (!validShortcut(combo)) {
            toast("快捷键需要包含修饰键（如 Alt+J），已恢复原值");
            return;
          }
          props.onCommit(combo);
        },
      });
    }
    // 合法快捷键：必须包含「修饰键 + 至少一个字符键」，不接受单独字母或空串。
    function validShortcut(str) {
      var p = parseShortcut(str);
      if (!p.key) return false;
      if (!(p.alt || p.ctrl || p.meta)) return false;
      return p.key.length >= 1;
    }

    function PromptDockConfigCard(props) {
      ensureCss();
      var st = useStore();
      var view = (props && props.view) || "page";
      useEffect(function () { ensureConf(); }, []);
      useEffect(function () { ensureModels(); }, []);
      var conf = confOf(st);
      var styles = conf.styles;
      var templates = conf.templates;

      // 摘要视图：组合包卡片副标题只需一行
      if (view === "summary") {
        return h("span", null,
          "提示词助手：工具行风格/模板菜单与 AI 改写，共 " + styles.length + " 个风格、" + templates.length + " 条模板");
      }

      // 配置还没到（首次加载中 / 请求失败）时不能渲染空壳：
      // 否则风格库、模板库、全局纪律会同时显示为“什么都没有”，
      // 让人误以为数据丢了。这里给出明确的加载/失败态，并提供重试。
      if (!st.conf) {
        var failed = !!st.confError;
        return h("div", { className: "pd-card", "data-pd-config": "1" },
          h("div", { className: "pd-groupHead" },
            h("h3", { className: "pd-cardTitle", style: { flex: 1, margin: 0 } }, "提示词助手")
          ),
          h("div", { className: "pd-sub pd-stateBox", "data-pd-config-state": failed ? "error" : "loading" },
            h("div", { className: "pd-help" },
              failed
                ? "无法读取当前配置：" + (st.confError || "连接失败")
                : "正在读取配置…"),
            h("div", { className: "pd-cardFoot" },
              h("button", {
                type: "button", className: "pd-btn pd-btnPrimary",
                onClick: function () { retryConf(); },
              }, failed ? "重试" : "刷新")
            )
          )
        );
      }

      function patchStyles(next) { return saveConfig({ styles: next }); }
      function patchTemplates(next) { return saveConfig({ templates: next }); }
      function patchToolbar(key, value) {
        var t = {};
        t[key] = value;
        return saveConfig({ toolbar: t });
      }
      function patchShortcut(key, value) {
        var s = {};
        s[key] = value;
        return saveConfig({ shortcuts: s });
      }

      // 快捷键输入框：本地草稿 + 失焦/回车才提交。
      // 不能每按一个键就保存——保存返回后会回填 conf，把用户还没打完的内容
      // 覆盖成旧值（打字时内容被吞、光标乱跳），表现为「改不了快捷键」。
      return h("div", { className: "pd-card", "data-pd-config": "1" },        h("div", { className: "pd-groupHead" },
          h("h3", { className: "pd-cardTitle", style: { flex: 1, margin: 0 } }, "提示词助手"),
          h("button", {
            type: "button", className: "pd-btn", title: "打开配置文件",
            onClick: function () { openConfigFile(); },
          }, h(IconFolder), h("span", { className: "pd-label" }, "配置文件"))
        ),

        // 1 改写模型
        h("section", { className: "pd-group", "data-pd-group": "model" },
          h("h4", { className: "pd-groupTitle" }, "改写模型"),
          h("div", { className: "pd-sub" },
            h("div", { className: "pd-fieldRow" },
              h("span", { className: "pd-fieldLabel" }, "仅改写使用所选模型"),
              h(ModelSelect, {
                value: conf.rewriteModel,
                onChange: function (rm) { saveConfig({ rewriteModel: rm }); },
              })
            ),
            h("div", { className: "pd-help" }, "不影响主页面全局模型；未配置时跟随全局默认。")
          )
        ),

        // 2 上下文
        // 开关必须有可读的状态文字：只有一个小滑块时用户看不出开还是关。
        h("section", { className: "pd-group", "data-pd-group": "context" },
          h("h4", { className: "pd-groupTitle" }, "上下文"),
          h("div", { className: "pd-sub" },
            h("div", { className: "pd-fieldRow" },
              h("span", { className: "pd-fieldLabel" }, "改写时附带最近对话"),
              h("span", {
                className: "pd-stateText" + (conf.contextEnabled ? " pd-stateOn" : " pd-stateOff"),
                "data-pd-context-state": conf.contextEnabled ? "on" : "off",
              }, conf.contextEnabled ? "已开启" : "已关闭"),
              h(Toggle, {
                checked: conf.contextEnabled,
                title: conf.contextEnabled ? "当前已开启，点击关闭" : "当前已关闭，点击开启",
                onChange: function (on) { saveConfig({ contextEnabled: on }); },
              })
            ),
            h("div", { className: "pd-fieldRow" },
              h("span", { className: "pd-fieldLabel" }, "轮数（1–20）"),
              h("input", {
                className: "pd-input pd-inputSm", type: "number", min: 1, max: 20,
                "aria-label": "上下文轮数", value: String(conf.contextTurns),
                disabled: !conf.contextEnabled,
                onChange: function (e) {
                  var n = Math.min(20, Math.max(1, Number(e.target.value) || 6));
                  saveConfig({ contextTurns: n });
                },
              })
            ),
            h("div", { className: "pd-help" },
              conf.contextEnabled
                ? "改写时会读取最近 " + conf.contextTurns + " 轮对话，仅用于消除指代。"
                : "已关闭：改写只看当前草稿，不读取任何对话历史。")
          )
        ),

        // 3 全局改写纪律
        h("section", { className: "pd-group", "data-pd-group": "discipline" },
          h("h4", { className: "pd-groupTitle" }, "全局改写纪律"),
          h(DisciplineField, {
            value: conf.globalDiscipline,
            custom: conf.globalDisciplineCustom,
            onSave: function (text) { saveConfig({ globalDiscipline: text }); },
            onRestore: function () { saveConfig({ globalDiscipline: "" }); },
          })
        ),

        // 4 风格库
        h("section", { className: "pd-group", "data-pd-group": "styles" },
          h("h4", { className: "pd-groupTitle" }, "风格库"),
          h(StyleRows, {
            styles: styles,
            onPatch: function (i, patch) {
              var next = styles.slice();
              next[i] = Object.assign({}, styles[i], patch);
              // 本地先回显，保存成功后由宿主返回覆盖
              setStore({ conf: Object.assign({}, st.conf || {}, { styles: next }) });
              patchStyles(next);
            },
            onRemove: function (i) {
              var next = styles.slice(); next.splice(i, 1);
              setStore({ conf: Object.assign({}, st.conf || {}, { styles: next }) });
              patchStyles(next);
            },
            onAdd: function () {
              var id = "s-" + Date.now();
              var next = styles.concat([{ id: id, name: "新风格", instruction: "" }]);
              setStore({ conf: Object.assign({}, st.conf || {}, { styles: next }) });
              patchStyles(next);
            },
          })
        ),

        // 5 模板库
        h("section", { className: "pd-group", "data-pd-group": "templates" },
          h("h4", { className: "pd-groupTitle" }, "模板库"),
          h(TemplateRows, {
            templates: templates,
            onPatch: function (i, patch) {
              var next = templates.slice();
              next[i] = Object.assign({ id: templates[i].id, category: "", tags: [] }, templates[i], patch);
              setStore({ conf: Object.assign({}, st.conf || {}, { templates: next }) });
              patchTemplates(next);
            },
            onRemove: function (i) {
              var next = templates.slice(); next.splice(i, 1);
              setStore({ conf: Object.assign({}, st.conf || {}, { templates: next }) });
              patchTemplates(next);
            },
            onAdd: function () {
              var next = templates.concat([{ id: "t-" + Date.now(), name: "新模板", text: "", category: "", tags: [] }]);
              setStore({ conf: Object.assign({}, st.conf || {}, { templates: next }) });
              patchTemplates(next);
            },
          })
        ),

        // 6 工具行
        h("section", { className: "pd-group", "data-pd-group": "toolbar" },
          h("h4", { className: "pd-groupTitle" }, "工具行"),
          h("div", { className: "pd-sub" },
            h("div", { className: "pd-fieldRow" },
              h("span", { className: "pd-fieldLabel" }, "风格入口"),
              h("select", {
                className: "pd-select pd-inputSm", "aria-label": "风格入口",
                value: conf.toolbar.showStyleEntry,
                onChange: function (e) { patchToolbar("showStyleEntry", e.target.value); },
              },
                h("option", { value: "auto" }, "自动"),
                h("option", { value: "always" }, "总是显示"),
                h("option", { value: "never" }, "隐藏")
              )
            ),
            h("div", { className: "pd-fieldRow" },
              h("span", { className: "pd-fieldLabel" }, "模板入口"),
              h("select", {
                className: "pd-select pd-inputSm", "aria-label": "模板入口",
                value: conf.toolbar.showTemplateEntry,
                onChange: function (e) { patchToolbar("showTemplateEntry", e.target.value); },
              },
                h("option", { value: "auto" }, "自动"),
                h("option", { value: "always" }, "总是显示"),
                h("option", { value: "never" }, "隐藏")
              )
            ),
            h("div", { className: "pd-fieldRow" },
              h("span", { className: "pd-fieldLabel" }, "收窄阈值（px）"),
              h("input", {
                className: "pd-input pd-inputSm", type: "number", min: 160, max: 1200,
                "aria-label": "收窄阈值", value: String(conf.toolbar.compactThreshold),
                onChange: function (e) {
                  var n = Math.min(1200, Math.max(160, Number(e.target.value) || 320));
                  patchToolbar("compactThreshold", n);
                },
              })
            ),
            h("div", { className: "pd-help" }, "宽度不足阈值时收起文字，只剩图标。")
          )
        ),

        // 7 快捷键
        h("section", { className: "pd-group", "data-pd-group": "shortcuts" },
          h("h4", { className: "pd-groupTitle" }, "快捷键"),
          h("div", { className: "pd-sub" }, SHORTCUT_FIELDS.map(function (f) {
            return h("div", { key: f.key, className: "pd-fieldRow" },
              h("span", { className: "pd-fieldLabel" }, f.label),
              h(ShortcutInput, {
                field: f.key,
                label: f.label,
                value: conf.shortcuts[f.key] || "",
                onCommit: function (v) { patchShortcut(f.key, v); },
              })
            );
          }))
        ),

        h("div", { className: "pd-help" },
          "改动即时保存。" + (st.legacyPath ? "旧配置文件： " + st.legacyPath : "")),
        st.migrated ? h("div", { className: "pd-help" }, "已从旧配置文件迁入一次。") : null,
        h(Toasts, { key: "toasts" })
      );
    }

    // =====================================================================
    // 工具行
    // =====================================================================
    // 宽度 → 三级降级：L0 完整 / L1 收起文字 / L2 合并为单一两级菜单
    function computeLevel(width, cfg) {
      var toolbar = (cfg && cfg.toolbar) || {};
      if (toolbar.showStyleEntry === "never" || toolbar.showTemplateEntry === "never") return { level: 2, compact: false };
      var threshold = typeof toolbar.compactThreshold === "number" ? toolbar.compactThreshold : 320;
      var w = typeof width === "number" ? width : 0;
      if (w <= 0) return { level: 0, compact: false };
      // 极窄 → 合并；等于或窄于阈值 → 只留图标；否则完整
      if (w < threshold * 0.75) return { level: 2, compact: false };
      if (w <= threshold) return { level: 1, compact: true };
      return { level: 0, compact: false };
    }

    function Toolbar(props) {
      ensureCss();
      var st = useStore();
      var ds = useDraftState(props);
      var cfg = confOf(st);
      var styles = cfg.styles;
      var templates = cfg.templates;

      var rootRef = useRef(null);
      var styleRef = useRef(null);
      var tplRef = useRef(null);
      var mergedRef = useRef(null);
      var rewriteRef = useRef(null);
      var mergedSubRef = useRef(null);
      var probedRef = useRef(false);
      // 改写基线：用于「改写期间草稿被改动则不回填」
      var baselineRef = useRef("");
      // 结果长度提示的文字快照
      var hintRef = useRef("");

      var openState = useState(null); var openMenu = openState[0]; var setOpenMenu = openState[1];
      // 键盘高亮索引放在父级：弹层重挂载/重渲染也不丢
      var menuIndexState = useState(0); var menuIndex = menuIndexState[0]; var setMenuIndex = menuIndexState[1];
      var queryState = useState(""); var query = queryState[0]; var setQuery = queryState[1];
      var widthState = useState(typeof window !== "undefined" ? window.innerWidth : 0);
      var width = widthState[0]; var setWidth = widthState[1];
      var mergedSubState = useState(null); var mergedSub = mergedSubState[0]; var setMergedSub = mergedSubState[1];

      useEffect(function () { ensureConf(); }, []);
      // 宽度跟踪：只在挂载后测真实宽度，避免首帧误判
      useEffect(function () {
        if (typeof window === "undefined") return;
        var measure = function () {
          var el = rootRef.current;
          var w = el && typeof el.getBoundingClientRect === "function"
            ? (el.parentNode && el.parentNode.getBoundingClientRect ? el.parentNode.getBoundingClientRect().width : el.getBoundingClientRect().width)
            : window.innerWidth;
          setWidth(w || window.innerWidth);
        };
        measure();
        window.addEventListener("resize", measure);
        return function () { window.removeEventListener("resize", measure); };
      }, []);

      // 探针（开发期，仅上报结构性信息）
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
        api(API + "/probe", {
          at: Date.now(), seat: "input.right", v: "1.0.0",
          sessionId: String(props.sessionId == null ? "" : props.sessionId),
          propKeys: Object.keys(props), actionKeys: actionKeys,
          stateKeys: Object.keys(ds.inputState),
        }).catch(function () {});
      }, []);

      // 发送/清空草稿后撤销自动消失
      useEffect(function () {
        if (st.phase === PHASE.SUCCESS && ds.draft === "") setStore({ phase: PHASE.IDLE, undo: null });
      }, [ds.draft, st.phase]);

      // 卸载中断进行中的流
      useEffect(function () {
        return function () { if (currentAbort) { try { currentAbort.abort(); } catch (e) {} } };
      }, []);

      // 芯片保护
      var chip = detectChip(ds.draft, collectChipFragments(props), ds.inputState);
      var busy = st.phase === PHASE.REQUESTING || st.phase === PHASE.STREAMING;
      var canRewrite = !busy && !!ds.draft.trim() && !chip;

      function stopStream() {
        if (currentAbort) { try { currentAbort.abort(); } catch (e) {} currentAbort = null; }
      }
      function cancelRewrite() {
        var rid = store.requestId;
        stopStream();
        if (rid) api(API + "/cancel", { requestId: rid }).catch(function () {});
        setStore({ phase: PHASE.CANCELLED, requestId: "", chars: 0, hint: "" });
        // 不弹 toast：取消后按钮已回到 idle 状态，弹窗属于多余打扰。
        // 六态机里的 cancelled 态仍保留在状态里，供按钮与 aria 使用。
      }
      function dismissError() { setStore({ feedbackError: null, phase: PHASE.IDLE }); }
      function openPluginPage() {
        // 浏览器半侧没有 pluginNavigation 也必须有出路：退回到设置页的插件面板。
        // 不弹 toast：错误条本身就是这条提示的载体，再弹一次只会重复打扰。
        try {
          if (typeof window !== "undefined" && typeof window.__DSH_OPEN_SETTINGS === "function") {
            window.__DSH_OPEN_SETTINGS(); return;
          }
        } catch (e) {}
      }

      function startRewrite() {
        if (busy) { cancelRewrite(); return; }
        var draft = ds.getDraft();
        if (!draft.trim()) return;
        if (chip) { toast("草稿含引用芯片，改写会丢失它"); return; }
        var baseline = draft;
        baselineRef.current = baseline;
        hintRef.current = "";
        var requestId = "r-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

        if (typeof fetch !== "function" || typeof AbortController === "undefined") {
          setStore({ phase: PHASE.ERROR, feedbackError: errorFeedback({ code: "NETWORK" }) });
          return;
        }
        var ac = new AbortController();
        currentAbort = ac;
        setStore({
          phase: PHASE.REQUESTING, requestId: requestId, chars: 0,
          feedbackError: null, undo: null, hint: "",
        });

        function finishWithError(err) {
          var fb = errorFeedback(err);
          setStore({ phase: PHASE.ERROR, feedbackError: fb, chars: 0, requestId: "" });
        }

        request(API + "/rewrite-stream", {
          method: "POST",
          signal: ac.signal,
          stream: true,   // 显式标记：这是 SSE，body 交给 getReader 消费
          body: {
            requestId: requestId,
            text: draft,
            styleId: store.styleId,
            sessionId: String(props.sessionId == null ? "" : props.sessionId),
            useContext: cfg.contextEnabled !== false,
          },
        }).catch(function (e) {
          // 请求阶段就失败（fetch reject）：这才是真正的连接失败。
          // 注意：读流阶段的错误在下面 pump 里单独处理，不能被误判成 NETWORK。
          if (e && (e.name === "AbortError" || e.code === 20)) throw e;
          lastTransportError(e);
          finishWithError({ code: "NETWORK", message: String((e && e.message) || "") });
          throw e;
        }).then(function (r) {
          if (!r || !r.raw) return null;
          var resp = r.raw;
          if (!resp.ok) {
            // 服务端拒答（403/404/405/409 等）：没有可读的流，按 JSON 错误体处理
            if (typeof resp.json !== "function") { finishWithError({ code: "INTERNAL" }); return; }
            return resp.json().catch(function () { return null; }).then(function (j) {
              var err = (j && j.error) || { code: "INTERNAL" };
              finishWithError(err);
            });
          }
          if (!resp.body || typeof resp.body.getReader !== "function") {
            finishWithError({ code: "INTERNAL", message: "response has no readable body" });
            return;
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
            if (event === "meta") {
              setStore({
                phase: PHASE.STREAMING, chars: Number(obj.draftChars) || 0,
                timeoutMs: Number(obj.timeoutMs) || store.timeoutMs,
              });
            } else if (event === "delta") {
              acc += obj.text || "";
              setStore({ phase: PHASE.STREAMING, chars: acc.length });
            } else if (event === "done") {
              onDone(obj.text || acc);
            } else if (event === "error") {
              finishWithError(obj);
            }
          }
          function onDone(finalText) {
            var text = String(finalText || "");
            if (!text) { finishWithError({ code: "EMPTY_REPLY" }); return; }
            // 变更检测：改写期间草稿被改动 → 不回填
            var now = ds.getDraft();
            if (now !== baseline) {
              setStore({ phase: PHASE.ERROR, feedbackError: errorFeedback({ code: "DRAFT_CHANGED" }), chars: 0 });
              return;
            }
            writeDraft(props.inputActions, text, ds.getDraft).then(function (w) {
              if (!w.ok) {
                // 写回失败：归到「模型/环境」类，原因用可读的中文说明（不露内部枚举）
                setStore({
                  phase: PHASE.ERROR, chars: 0,
                  feedbackError: errorFeedback({ code: "WRITE_FAILED", message: writeDraftError(w) }),
                });
                return;
              }
              // 长度提示：结果 <80 字或 >1.2× 风格上限时给琥珀色提示，但绝不截断结果
              var styleLimit = Number(activeStyleLimit()) || 0;
              var hintText = lengthHint(text.length, styleLimit);
              hintRef.current = hintText;
              setStore({
                phase: PHASE.SUCCESS, undo: { original: baseline }, feedbackError: null,
                chars: 0, hint: hintText,
              });
              toast("改写完成，可撤销");
            });
          }
          function pump() {
            return reader.read().then(function (res) {
              if (res.done) return;
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
            // 已在上面给出网络类反馈时这里不再改文案。
            // 走到这里说明是读流/解析过程中的失败：连接是通的，只是流中断——
            // 归类为 model（上游未完成），而不是 network（连不上）。
            if (store.phase === PHASE.REQUESTING || store.phase === PHASE.STREAMING) {
              finishWithError({ code: "STREAM_BROKEN", message: String((e && e.message) || "") });
            }
          }
        }).then(function () {
          if (currentAbort === ac) currentAbort = null;
          if (store.phase === PHASE.REQUESTING || store.phase === PHASE.STREAMING) {
            setStore({ phase: PHASE.IDLE });
          }
        });
      }

      function doUndo() {
        if (!st.undo) return;
        writeDraft(props.inputActions, st.undo.original, ds.getDraft).then(function (w) {
          if (w.ok) { setStore({ phase: PHASE.IDLE, undo: null, feedbackError: null, hint: "" }); toast("已撤销"); }
          else setStore({
            phase: PHASE.ERROR,
            feedbackError: errorFeedback({ code: "WRITE_FAILED", message: writeDraftError(w) }),
          });
        });
      }

      // ---- 风格菜单项：名称 + 指令一行摘要 ----
      var styleItems = styles.map(function (s) {
        var sum = String(s.instruction || "").replace(/\s+/g, " ").trim();
        return {
          id: "style:" + s.id, label: s.name || s.id,
          summary: sum ? (sum.length > 40 ? sum.slice(0, 40) + "…" : sum) : "未设置指令",
          title: (s.name || s.id) + (sum ? "：" + sum : ""),
        };
      });
      // ---- 模板菜单项：名称 + 首行 ----
      var tplItems = templates.map(function (t, i) {
        var first = String(t.text || "").split("\n")[0].trim();
        return {
          id: "tpl:" + i, label: t.name || "未命名模板",
          summary: first.length > 40 ? first.slice(0, 40) + "…" : first,
          title: (t.name || "") + (first ? "\n" + first : ""),
          category: String(t.category || "").trim(),
          search: (String(t.name || "") + " " + first + " " + (t.tags || []).join(" ")).toLowerCase(),
        };
      });
      var needSearch = templates.length > 10;
      var q = String(query || "").trim().toLowerCase();
      var shownTpls = q ? tplItems.filter(function (it) { return it.search.indexOf(q) >= 0; }) : tplItems;
      var grouped = shownTpls.some(function (it) { return !!it.category; });

      function insertTemplate(idx) {
        var tpl = templates[idx];
        if (!tpl) return;
        var cur = ds.getDraft();
        var text = String(tpl.text || "");
        var next = cur ? (cur.slice(-1) === "\n" ? cur + text : cur + "\n" + text) : text;
        writeDraft(props.inputActions, next, ds.getDraft).then(function (w) {
          if (w.ok) { toast("已插入模板"); return; }
          setStore({
            phase: PHASE.ERROR,
            feedbackError: errorFeedback({ code: "WRITE_FAILED", message: writeDraftError(w) }),
          });
        });
      }
      function pickStyle(id) {
        setStore({ styleId: id });
        setOpenMenu(null);
      }
      function pickTemplate(item) {
        insertTemplate(Number(String(item.id).slice(4)));
        setOpenMenu(null);
      }

      // ---- 快捷键（Alt+M / Alt+T / Alt+R，可在设置里改）----
      useEffect(function () {
        if (typeof document === "undefined") return;
        function onKey(e) {
          var t = e && e.target;
          // 正在快捷键设置里录入组合时，绝不能同时触发全局快捷键
          // （否则录 "Alt+R" 会当场发起一次改写）。
          if (t && typeof t.getAttribute === "function" &&
              t.getAttribute("data-pd-shortcut-capturing") === "1") return;
          // 弹层已打开时，↑↓/Enter/Esc 由弹层接管（见 PdPopover 的 document 监听）。
          // 但「风格 / 模板」两个开关之间要能互相切换：
          //   风格开着按模板 → 直接切到模板；模板开着按风格 → 直接切到风格。
          // 只拦「与当前浮层无关」的快捷键（比如浮层开着按 Alt+R 改写），
          // 避免误触；同一个键仍然走下面的 toggle 关闭。
          if (openMenu) {
            var act2 = matchShortcut(e, cfg.shortcuts);
            var switchesMenu = (act2 === "openStyle" || act2 === "openTemplate");
            if (!switchesMenu) return;
          }
          // 纯字符键在输入框里必须让路；带 Alt/Ctrl/Meta 的组合键照常触发，
          // 否则正在输入草稿时（唯一的使用场景）快捷键永远不生效。
          if (isEditableTarget(t) && !isShortcutChord(e)) return;
          var action = matchShortcut(e, cfg.shortcuts);
          if (!action) return;
          if (typeof e.preventDefault === "function") e.preventDefault();
          // 语义（与原有行为一致，只增加互相切换）：
          //   · 按当前浮层自己的键 → 关闭（toggle）
          //   · 浮层开着时按另一个浮层的键 → 直接切过去（不先关闭再打开）
          if (action === "openStyle") {
            setOpenMenu(openMenu === "style" ? null : "style");
          } else if (action === "openTemplate") {
            setOpenMenu(openMenu === "tpl" ? null : "tpl");
          } else if (action === "rewrite") startRewrite();
        }
        document.addEventListener("keydown", onKey, true);
        return function () { document.removeEventListener("keydown", onKey, true); };
      }, [openMenu, cfg.shortcuts.openStyle, cfg.shortcuts.openTemplate, cfg.shortcuts.rewrite, ds.draft, chip, st.phase]);

      var activeStyle = styles.filter(function (s) { return s.id === st.styleId; })[0] || styles[0];
      var styleName = (activeStyle && activeStyle.name) || "风格";

      // 风格的「目标长度上限」：从 instruction 里读「不超过 N 字 / 900 字」这类表述。
      // 读不到就返回 0（不做长度上限提示，只做下限提示）。
      function activeStyleLimit() {
        var text = String((activeStyle && activeStyle.instruction) || "");
        var m = text.match(/(?:不超过|别超过|最多|上限|within|at most)\D{0,4}(\d{2,5})\s*字/i);
        if (m) return Number(m[1]);
        // 「目标长度为原文的 1.5–2.5 倍」这类按比例的上限：用草稿长度换算
        var r = text.match(/(\d+(?:\.\d+)?)\s*[–\-~—至]\s*(\d+(?:\.\d+)?)\s*倍/);
        if (r) return Math.round(ds.getDraft().length * Number(r[2]));
        return 0;
      }
      var shortcutTip = function (str) { return shortcutLabel(str); };

      var levelInfo = computeLevel(width, cfg);
      var level = levelInfo.level;
      var compact = levelInfo.compact;

      var rewriteTitle = chip
        ? "草稿含「" + chip + "」引用芯片，改写会丢失它，请先移除"
        : "改写（" + shortcutTip(cfg.shortcuts.rewrite) + "）";

      var rewriteBtn = h(FeedbackButton, {
        store: st,
        disabled: busy ? false : !canRewrite,
        title: rewriteTitle,
        onClick: startRewrite,
        onCancel: cancelRewrite,
        onUndo: doUndo,
      });

      var errorBar = h(ErrorBar, {
        key: "error",
        error: st.feedbackError,
        onRetry: function () { dismissError(); startRewrite(); },
        onOpenSettings: openPluginPage,
        onDismiss: dismissError,
      });

      // 长度提示（琥珀色）：只在成功态且有提示语时出现；不截断结果
      // 长度提示（琥珀色）：只在成功态且有提示语时出现；不截断结果。
      // 与错误条共用左侧脱离流槽位——绝不能作为 flex 子项挤动三个按钮。
      var hintBar = st.phase === PHASE.SUCCESS && st.hint
        ? h("div", { key: "hint", className: "pd-hint", "data-pd-hint": "1", title: st.hint }, st.hint)
        : null;

      var shimmer = (st.phase === PHASE.REQUESTING || st.phase === PHASE.STREAMING)
        ? h("div", { className: "pd-shimmer", "data-pd-shimmer": "1", "aria-hidden": "true" })
        : null;

      // ---- L2：合并为单一两级菜单（风格 / 模板 作为子级） ----
      if (level === 2) {
        var mergedItems = [{
          id: "style", label: "风格", submenu: styles.map(function (s) {
            return { id: "style:" + s.id, label: s.name };
          }),
        }];
        if (templates.length) {
          mergedItems.push({
            id: "tpl", label: "模板", submenu: templates.map(function (t, i) { return { id: "tpl:" + i, label: t.name }; }),
          });
        }
        var mergedTrigger = h("button", {
          key: "merged",
          ref: mergedRef,
          type: "button",
          className: "pd-btn",
          "aria-haspopup": "menu",
          "aria-expanded": openMenu === "merged",
          title: "风格与模板",
          onClick: function () { setOpenMenu(openMenu === "merged" ? null : "merged"); },
        }, h("span", { className: "pd-label" }, styleName), h(IconChevron, { open: openMenu === "merged" }));

        var mergedPanel = openMenu === "merged" ? h("div", {
          className: "pd-popover", "data-pd-popover": "1", role: "menu",
        }, mergedItems.map(function (it) {
          return h("button", {
            key: it.id, type: "button", className: "pd-option",
            onClick: function () { setMergedSub(mergedSub === it.id ? null : it.id); },
          },
            h("span", { className: "pd-optionCopy" }, h("span", { className: "pd-optionName" }, it.label)),
            h(IconChevron, { open: mergedSub === it.id })
          );
        })) : null;

        var subItems = mergedSub === "style" ? styles.map(function (s) {
          return { id: "style:" + s.id, label: s.name, active: s.id === st.styleId };
        }) : mergedSub === "tpl" ? templates.map(function (t, i) { return { id: "tpl:" + i, label: t.name }; }) : [];

        return h("div", { ref: rootRef, className: "pd-row", "data-pd-level": level },
          mergedTrigger,
          rewriteBtn,
          chip ? h("span", { className: "pd-err", title: "草稿含「" + chip + "」引用芯片，改写会丢失它" }, "含芯片") : null,
          openMenu === "merged" && subItems.length ? h(PdPopover, {
            key: "merged-sub",
            anchorRef: mergedSubRef,
            items: subItems,
            currentId: mergedSub === "style" ? "style:" + st.styleId : null,
            ariaLabel: mergedSub === "style" ? "风格" : "模板",
            onClose: function (t) { setMergedSub(null); if (t === true) setOpenMenu(null); },
            onPick: function (it) {
              setMergedSub(null); setOpenMenu(null);
              if (String(it.id).indexOf("style:") === 0) pickStyle(String(it.id).slice(6));
              else pickTemplate(it);
            },
          }) : null,
          mergedPanel,
          shimmer,
          errorBar,
          hintBar,
          h(Toasts, { key: "toasts" })
        );
      }

      // ---- L0 / L1：风格、模板两个独立一级触发器 ----
      var hideStyle = cfg.toolbar.showStyleEntry === "never";
      var hideTpl = cfg.toolbar.showTemplateEntry === "never";
      var styleTrigger = h("button", {
        key: "style-trigger",
        ref: styleRef,
        type: "button",
        className: "pd-btn" + (compact ? " pd-btnIconOnly" : ""),
        "aria-haspopup": "menu",
        "aria-expanded": openMenu === "style",
        title: compact ? "风格：" + styleName + "（" + shortcutTip(cfg.shortcuts.openStyle) + "）" : "选择改写风格（" + shortcutTip(cfg.shortcuts.openStyle) + "）",
        "aria-label": "风格：" + styleName,
        onClick: function () { setOpenMenu(openMenu === "style" ? null : "style"); },
      }, h(IconStyle),
        compact ? null : h("span", { className: "pd-label" }, styleName),
        compact ? null : h(IconChevron, { open: openMenu === "style" }));

      var tplTrigger = h("button", {
        key: "tpl-trigger",
        ref: tplRef,
        type: "button",
        className: "pd-btn" + (compact ? " pd-btnIconOnly" : ""),
        "aria-haspopup": "menu",
        "aria-expanded": openMenu === "tpl",
        title: compact ? "模板（" + shortcutTip(cfg.shortcuts.openTemplate) + "）" : "插入模板（" + shortcutTip(cfg.shortcuts.openTemplate) + "）",
        "aria-label": "模板",
        onClick: function () { setOpenMenu(openMenu === "tpl" ? null : "tpl"); },
      }, h(IconTemplate),
        compact ? null : h("span", { className: "pd-label" }, "模板"),
        compact ? null : h(IconChevron, { open: openMenu === "tpl" }));

      // 左侧旁注：同一时刻最多显示一条（错误 > 长度提示 > 芯片说明）。
      // 放在脱离文档流的槽位里，因此永远不会移动右侧三个按钮。
      function renderSideNotes() {
        var note = null;
        if (st.feedbackError) note = errorBar;
        else if (hintBar) note = hintBar;
        else if (chip) {
          note = h("span", {
            key: "chip-note", className: "pd-err", "data-pd-chip-note": "1",
            title: "草稿含「" + chip + "」引用芯片，改写会丢失它",
          }, "含芯片");
        }
        if (!note) return null;
        return h("div", {
          key: "sideNote", className: "pd-sideNote",
          "data-pd-error-slot": st.feedbackError ? "1" : undefined,
          "data-pd-side-note": "1",
        }, note);
      }

      var stylePanel = openMenu === "style" ? h(PdPopover, {        key: "style-menu",
        anchorRef: styleRef,
        items: styleItems,
        currentId: "style:" + st.styleId,
        ariaLabel: "风格",
        activeIndex: menuIndex,
        onActiveIndexChange: setMenuIndex,
        onClose: function (t) { setOpenMenu(null); if (t === true && styleRef.current && styleRef.current.focus) styleRef.current.focus(); },
        onPick: function (it) { pickStyle(String(it.id).slice(6)); },
      }) : null;

      // 模板弹层：>10 条出现搜索框；有分类时按分类分组
      // 模板弹层：>10 条出现搜索框；有分类时按 category 分组（组标题由弹层按 item.header 渲染）
      var tplPanel = openMenu === "tpl" ? (function () {
        if (!templates.length) {
          return h("div", {
            key: "tpl-menu", className: "pd-popover", "data-pd-popover": "1", role: "menu",
            style: { right: 8, bottom: (typeof window !== "undefined" ? window.innerHeight : 0) },
            "aria-label": "模板",
          }, h("div", { className: "pd-empty" }, "还没有模板，点击创建第一条"));
        }
        // 按分类分组：有 category 的排在一起，无分类的留在末尾
        var seen = {};
        var list = [];
        shownTpls.forEach(function (it) {
          var full = Object.assign({}, it);
          if (it.category && !seen[it.category]) {
            seen[it.category] = true;
            full.header = it.category;
          }
          list.push(full);
        });
        return h(PdPopover, {
          key: "tpl-menu",
          anchorRef: tplRef,
          items: list,
          currentId: null,
          ariaLabel: "模板",
          searchable: needSearch,
          query: query,
          onQueryChange: setQuery,
          emptyText: "没有匹配的模板",
          onClose: function (t) { setOpenMenu(null); if (t === true && tplRef.current && tplRef.current.focus) tplRef.current.focus(); },
          onPick: pickTemplate,
        });
      })() : null;

      return h("div", { ref: rootRef, className: "pd-row", "data-pd-level": level },
        // 左侧旁注槽位：错误提示、长度提示、芯片说明都放这里。
        // 该槽位 absolute + right:100%，不参与 flex 主轴计算，
        // 因此任何提示的出现/消失都不会移动「风格 / 模板 / 改写」。
        renderSideNotes(),
        hideStyle ? null : styleTrigger,
        hideTpl ? null : tplTrigger,
        rewriteBtn,
        stylePanel,
        tplPanel,
        shimmer,
        h(Toasts, { key: "toasts" })
      );
    }

    // =====================================================================
    // 挂载：两个座位互相独立，任一缺失都不影响另一个
    // =====================================================================
    var inject = ["slots"];
    function safeInject(ctx, slotName, register) {
      try {
        ctx.effect(function () {
          return ctx.slots.inject(slotName, register);
        }, "dsh-prompt-dock: " + slotName);
        return true;
      } catch (e) {
        return false;
      }
    }
    function apply(ctx) {
      // 1) 工具行（list，session scope）
      safeInject(ctx, "conversation.input.right", function () {
        return ctx.slots.register(
          { name: "conversation.input.right", id: "prompt-dock", order: 0, label: function () { return "提示词助手"; } },
          Toolbar
        );
      });
      // 2) 组合包详情页配置卡片（keyed，root scope，key = npm 包名）
      safeInject(ctx, "plugins.bundle.config", function () {
        return ctx.slots.register({
          name: "plugins.bundle.config",
          key: PKG_NAME,
          locale: NS,
        }, PromptDockConfigCard);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    // 供测试直接检视纯函数（不参与运行时）
    exports.__internals = {
      PKG_NAME: PKG_NAME, NS: NS, CSS_TEXT: CSS_TEXT, PHASE: PHASE, ERROR_CLASS: ERROR_CLASS,
      ERROR_COPY: ERROR_COPY, ERROR_ACTION: ERROR_ACTION, TOAST_MAX: TOAST_MAX, LENGTH_MIN: LENGTH_MIN,
      PromptDockConfigCard: PromptDockConfigCard, Toolbar: Toolbar,
      classifyError: classifyError, errorFeedback: errorFeedback, errorCopy: errorCopy,
      lengthHint: lengthHint, matchShortcut: matchShortcut, parseShortcut: parseShortcut,
      isShortcutChord: isShortcutChord, validShortcut: validShortcut, ShortcutInput: ShortcutInput,
      shortcutLabel: shortcutLabel, isEditableTarget: isEditableTarget, computeLevel: computeLevel,
      detectChip: detectChip, pickDraftText: pickDraftText, toast: toast, dismissToast: dismissToast,
      getToasts: function () { return toastState.slice(); },
      Toasts: Toasts,
      SHORTCUT_FIELDS: SHORTCUT_FIELDS,
      resetToasts: function () { toastState = []; },
      // 测试用：清掉「配置已请求」标记，让下一次 ensureConf 真的发请求
      resetConf: function () {
        confRequested = false; modelsLoading = false;
        setStore({ conf: null, confError: "", models: null, modelsGlobal: null, styleId: "concise",
          phase: PHASE.IDLE, feedbackError: null, undo: null, chars: 0, hint: "" });
        toastState = [];
      },
      getStore: function () { return store; },
      retryConf: retryConf,
      // 首次使用告知：测试可注入/重置标记
      DISCLOSURE_KEY: DISCLOSURE_KEY,
      shouldDisclose: shouldDisclose,
      ackDisclosure: ackDisclosure,
      writeFlag: writeFlag,
    };
    return module.exports;
  },
});
