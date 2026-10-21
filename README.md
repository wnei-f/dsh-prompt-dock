# dsh-prompt-dock（提示词修改助手）

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2f6fed)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-4d6bfe)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![version](https://img.shields.io/badge/version-1.1.0-2f6fed)](https://github.com/wnei-f/dsh-prompt-dock/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

DSH 插件，挂在**输入框工具行**（`conversation.input.right`，模型选择左侧），对输入框草稿做两件事：

- **AI 改写**：更简洁 / 更详细 / 结构化 / 译成英文 / 自定义；SSE 流式输出、可取消、写入后可撤销
- **模板插入**：常用提示词模板一键追加到草稿

> 改写结果为 AI 辅助生成，请自行核实内容。

工具行从左到右是「风格 / 模板 / 改写」三个独立控件：风格与模板各自是一级触发器、互不嵌套；「改写」是本插件这一行最靠右的控件，紧邻官方模型选择器。**设置已从工具行移入 DSH 官方「插件」页**。下拉箭头、选中态、开关沿用官方主题令牌，选中项用底色 + 细阴影描边而不是打勾。「改写」为纯图标（官方 sparkle 形状，文案在 tooltip），进行中显示转圈 + 已接收字符数，完成后同一槽位变成「↩ 撤销」。

模型默认走 DSH 全局默认模型（`agentDefaultModel`），也可在插件配置里固定为某个模型；改写在宿主半调用 `ctx.llm.stream`。

---

## 目录

- [界面交互](#界面交互)
- [设置](#设置)
- [提示词设计](#提示词设计)
- [隐私与版权](#隐私与版权)
- [安全与边界](#安全与边界)
- [兼容性](#兼容性)
- [路由与错误码](#路由与错误码)
- [安装](#安装)
- [开发](#开发)

---

## 界面交互

### 工具行三级降级

按可用宽度自动切换布局，避免在窄容器里挤压官方控件：

| 层级 | 条件 | 布局 |
| --- | --- | --- |
| L0 完整 | 宽度 > `compactThreshold`（默认 320px） | 风格 / 模板 / 改写三个独立控件 |
| L1 紧凑 | 宽度 ≤ 阈值 | 风格与模板只显示图标 + tooltip |
| L2 合并 | 宽度 < 阈值 × 0.75 | 回退为单一两级菜单 |

若配置里把 `showStyleEntry` 或 `showTemplateEntry` 设为 `never`，直接进入 L2。

### 快捷键

默认 `Alt+M` 打开风格、`Alt+T` 打开模板、`Alt+R` 改写，可在插件配置的「快捷键」分组修改。

**输入框里也能用**：带 `Alt` / `Ctrl` / `Cmd` 的组合键即使焦点在输入框中也会触发；单独按字符键仍交还给输入框，不会吞掉正在打的字。

**修改方式**：点击设置里的快捷键输入框 → 直接按下想要的组合键，自动录入为规范格式（如 `Alt+J`），不需要手打字符串。

| 操作 | 行为 |
| --- | --- |
| `Esc` | 放弃本次录入 |
| `Backspace` / `Delete` | 清空该绑定 |
| 只按修饰键 | 继续等待，不提交 |
| 未包含修饰键 | 拒绝提交并提示 |

### 浮层键盘导航

浮层打开时焦点仍在输入框，因此插件在 `document` 捕获阶段接管方向键：

| 按键 | 行为 |
| --- | --- |
| `↑` / `↓` | 逐项切换高亮（实时跟随，首尾不越界，连按不丢步） |
| `Home` / `End` | 跳到第一项 / 最后一项 |
| `Enter` | 选中当前项，**不会发送输入框内容** |
| `Esc` | 关闭浮层并把焦点交还触发器 |

当前键盘项用品牌色内描边标出（`.pd-optionActive`），与「已选中的风格」（底色 + 细描边）是两个不同的视觉状态，可以同时出现。中文输入法组合中（`isComposing`）不拦截回车，避免与候选词确认冲突。

### 风格 / 模板互相切换

两个浮层共用一套快捷键，可以互相直接切换，不需要先关闭：

| 当前状态 | 按下 | 结果 |
| --- | --- | --- |
| 浮层关闭 | `Alt+M` / `Alt+T` | 打开对应浮层 |
| 风格开着 | `Alt+T` | 直接切到模板 |
| 模板开着 | `Alt+M` | 直接切到风格 |
| 风格开着 | `Alt+M` | 关闭（原有 toggle 语义） |
| 模板开着 | `Alt+T` | 关闭（原有 toggle 语义） |
| 浮层开着 | `Alt+R` | 拦下，避免误触发改写 |

### 反馈

改写走一个六态状态机，所有提示由同一套组件渲染：

| 状态 | 表现 |
| --- | --- |
| idle | sparkle 图标 + 主按钮填充 |
| requesting | 转圈，按钮禁用，tooltip「正在连接…」 |
| streaming | 转圈 + 「改写中 N 字」，输入框上缘 2px 流光条 |
| success | 同槽位变成「↩ 撤销」，1.5s 绿色高亮，toast「改写完成，可撤销」 |
| error | 恢复 sparkle，1px 危险色描边，左侧错误条 + 重试 |
| cancelled | 回到 idle |

**六类错误**各有固定文案，**不展示原始错误文本**：网络失败、超时、认证/配置、模型返回错误、空结果、用户取消。错误日志只记录类型与耗时，原始信息写入浏览器控制台。

**提示显示位置**：错误提示、长度提示、芯片说明统一显示在**工具行左侧**（绝对定位的旁注槽位），出现和消失都不会挪动「风格 / 模板 / 改写」三个按钮。同一时刻只显示一条，优先级：错误 > 长度提示 > 芯片说明。窄视口（< 640px）左侧放不下时自动改挂到工具行下方，仍不影响按钮位置。

**Toast** 位于底部居中，最多 2 条，2.8s 自动消失，尊重 `prefers-reduced-motion`。

### 设置卡片

- **风格库 / 模板库默认折叠**：每条只显示「名称 + 摘要」，点击标题栏才展开编辑，避免一屏塞满输入框。
- **上下文开关**旁显示「已开启 / 已关闭」文字，下方说明随状态变化，不只依赖滑块颜色。
- **加载态**：配置尚未读到时显示「正在读取配置…」；读取失败则显示原因 + 重试，不会渲染成空白卡片。
- **首次使用告知**：首次点击「改写」时提示「点击改写会将当前草稿发送至你配置的模型」，关闭后不再出现。

---

## 设置

设置不是插件自己的 JSON 文件，而是 DSH 官方的插件配置：

- **入口**：侧栏 **插件** → 找到 `dsh-prompt-dock` → 打开它的页面，配置区在页面里（`plugins.bundle.config` 插槽，以**包名** `dsh-prompt-dock` 为 key）。
- **存储**：写入当前 profile 的 `cordis.patch.yml`，由 DSH 的 `configEditor` 管理，插件本身不直接读写该文件。
- **生效**：每个字段都是 Config 的 `.volatile()` 字段，保存后无需重启，改写行为立即变化。

### 配置分组

| 分组 | 内容 |
| --- | --- |
| 改写模型 | 跟随全局默认，或固定为某个 `provider/model`（同名模型按 provider 区分显示） |
| 上下文 | 是否附带最近对话、附带轮数（1–20） |
| 全局改写纪律 | system prompt 的共同纪律；默认只读，可解锁编辑，也可一键恢复默认 |
| 风格库 | 每个风格的 `name` / `instruction` 可编辑 |
| 模板库 | 每条模板的 `text` / `category` / `tags` 可编辑，可增删 |
| 工具行 | `showStyleEntry` / `showTemplateEntry`（auto / always / never）、`compactThreshold` |
| 快捷键 | 三个快捷键，点击后直接按组合键录入 |

### 配置字段

对应 `cordis.patch.yml` 里 `dsh-prompt-dock` 行的 `config`：

```yaml
- id: dsh-prompt-dock
  name: dsh-prompt-dock
  config:
    rewriteProvider: deepseek-official   # 空串 = 跟随全局默认
    rewriteModel: deepseek-chat          # 空串 = 跟随全局默认
    timeoutMs: 90000                     # 5000–300000
    useContext: true
    contextRounds: 6                     # 1–20
    globalDiscipline: ""                 # 空串 = 用内置默认
    styles: { concise: { name: 更简洁, instruction: "……" } }
    templates: { t-review: { name: 代码审查, text: "……", category: 代码, tags: [review] } }
    showStyleEntry: auto                 # auto | always | never
    showTemplateEntry: auto
    compactThreshold: 320                # 160–1200
    shortcutStyle: Alt+M
    shortcutTemplate: Alt+T
    shortcutRewrite: Alt+R
```

字段约束：模板 ≤ 100 条，`name` ≤ 60 字、`text` ≤ 4000 字；风格 `name` ≤ 40 字、`instruction` ≤ 2000 字；共同纪律 ≤ 4000 字。超限在保存时截断。

### 从旧版迁移

旧版把设置放在 `~/.dsh/prompt-dock/settings.json`。升级后首次启动会自动：

1. 读取旧文件，转换成官方配置字段；
2. **只回填官方配置里尚未由用户设置过的字段**（已设过的值不会被旧文件覆盖）；
3. 把旧文件原子改名为 `settings.json.migrated`，此后不再读写（超过 30 天自动清理）。

回填以 `settings.describe()` 返回的 `user` 层区分「用户设过」与「用了默认值」，因此重复启动是幂等的。

---

## 提示词设计

改写分两条**互不相干**的链路：

- **共同纪律 + 风格 instruction** → 改写请求的 `system` prompt（纪律在前，风格在后）
- **模板 text** → 直接插入输入框的正文，**不进 system prompt**

### 共同纪律（system prompt 主体）

内置默认文案的核心是「**改写器不是需求生成器**」：只让草稿更可用，不新增草稿里没有的事实、数据、案例或结论。改写前先做**性质判断**：

- 草稿若是确认、道谢、闲聊、简单提问或纯情绪表达 → 原样返回或只修正明显语病，**不按任何风格扩写**
- 草稿若是可执行的任务请求 → 再按风格约束改写

六条共同约定：

1. 只输出改写后的正文，不输出解释、前言、问候、改写说明
2. 逐字保留：反引号内代码、文件路径、命令行参数、函数/变量/类名、URL、`@引用`、`/命令`、Markdown 结构
3. 逐字保留：专有名词、规范术语、直接引语中的措辞、具体数字与版本号
4. 不把用户的观察改写成结论（「我觉得它有点慢」不得变成「它性能不足」）
5. 不替用户做草稿未做的决定；不确定处保留原表述
6. 控制长度：不低于 80 字；超限先收敛，仍超则保持原样并提示

第 6 条是**软约束**：代码层不自动截断，而是在预览区加琥珀色提示。纪律在设置里默认只读，可解锁编辑，也可一键「恢复默认」（存为空串，后续版本改进默认文案会自动生效）。

### 四个风格 instruction

| 风格 | 实际约束 |
| --- | --- |
| 更简洁 | 删重复、修饰、客套；必须原样保留全部约束与否定条件、失败路径与异常处理要求、数字与阈值、文件/接口/字段名、验收标准；不得把含义不同的两句合并、不得把并列要求压成一个；目标 **50%–70% 且不低于 80 字** |
| 更详细 | 只补草稿已隐含的目标/输入/输出/边界/验证方式；**禁止**引入未提及的技术选型、第三方库、数据结构或数据；判断强度不变；目标 **1.5–2.5 倍且不超过 800 字**，草稿不足三行时按内容补全而不做比例扩写 |
| 结构化 | 固定章节序：目标 / 上下文 / 任务步骤 / 约束 / 输出格式；缺失章节写「未指定」而非编造；步骤以动词开头按序排列；标识符/路径/数字保留原形；只重组不新增需求 |
| 译成英文 | 地道英文技术写作；逐字保留代码、路径、命令行参数、标识符、URL、术语、直接引语、数字与版本号；保留 Markdown 与 `@引用` `/命令`；保持判断强度，不扩写不解释不补充建议；无公认译法时保留原文并括号注明 |

「自定义」风格的 instruction 为空串，改写时读取**该风格自身**的 `instruction`（在设置卡片「风格库」里编辑）；若该指令为空且请求未提供一次性覆盖，报 `NO_INSTRUCTION`。

### 三个模板 text

三个模板统一遵循「**任务 + 禁止项 + 兜底**」结构——先说做什么，再说不能做什么，最后规定信息不足或没有发现时怎么办，避免模型硬凑内容。

| 模板 | 任务 | 禁止项 | 兜底 |
| --- | --- | --- | --- |
| 代码审查 | 按严重程度降序，每条给「位置 / 问题类型 / 触发条件 / 最小修复方向」 | 只报能定位的问题；不假设未展示代码有问题；不评价命名与格式偏好 | 无问题则输出「未发现可定位问题」，并列未覆盖部分 |
| 解释代码 | 依次说明：整体职责、数据流、边界与失败路径、对调用方的约束 | 标识符/路径/数字不意译；不评价好坏、不提改进建议 | 无法确认处标「未验证」，不推测 |
| 写测试 | 每个用例给「名称 / 输入 / 预期结果 / 覆盖路径」 | 不修改被测代码、不改签名、不重命名、不引入新测试框架、不 mock 被测逻辑本身 | 无法确定预期行为时列为待确认问题，不编造断言 |

> 以上都是**默认值**。在插件配置里保存过风格或模板后，config 中的值会覆盖内置默认。

---

## 隐私与版权

- **草稿不落日志、不落磁盘**：草稿原文只用于当次改写调用，从不写入日志、探针文件或任何持久化文件。错误日志只记录错误类型、耗时与字符数。开发期探针接口在写盘前会剔除 `draft` / `text` / `content` 等草稿字段，仅保留字符数。
- **不接触凭据**：插件不读取任何 API Key，模型凭据由宿主 `llm` 服务持有；配置里也不保存凭据。
- **无外网出口**：改写不直接发起网络请求，而是走宿主 `llm` 服务；插件自身没有明文 HTTP 出口，也不提供可降级到 http 的配置项。
- **AI 辅助告知**：首次点击「改写」时提示草稿会发送到你配置的模型，关闭后不再出现。
- **许可证**：MIT，覆盖插件代码、内置模板正文与风格指令，见 [LICENSE](LICENSE)。

---

## 安全与边界

- **回环围栏**：所有 `/api/prompt-dock/*` 只接受本机来源（校验 socket 地址、`Host`、`Origin`，并拒绝带 `X-Forwarded-For` / `Forwarded` 的请求）。`*.localhost` 与非 http(s) 的自定义 scheme（桌面壳 `app://`、`tauri://`、`file://`）放行，http(s) 必须是回环。**不要**把 dsh web 暴露在反向代理后还期望这道围栏生效。
- **改写限流**：同一宿主进程内并发改写上限 2，每分钟成功调用上限 10（失败调用不占配额）。
- **芯片保护**：草稿含 `@文件` / `/命令` 引用芯片时，「改写」置灰并提示。判据取自宿主真实发布状态——`InputState.occurrences` 非空即视为含芯片。
- **变更检测**：改写期间若草稿被改动，结果不会回填，避免覆盖新输入。
- **只走 `inputActions.setDraft`**：不猜测其它方法名。宿主不支持时显式报错，而不是静默换一条未知路径。

### 权限清单（与 `package.json` 的 `dsh.permissions` 一致）

| 能力 | 声明值 | 实际用途 |
| --- | --- | --- |
| `network.fetch` / `network.socket` | `false` / `false` | 不发起任何外部网络请求；改写经宿主 `llm` 服务 |
| `process.child_process` | `true` | 仅「打开配置文件」：调用系统文件管理器（`explorer.exe` / `open` / `xdg-open`）定位当前 profile 的 `cordis.patch.yml` |
| `filesystem.read` / `fs.write` | `$DSH_HOME/prompt-dock` | 仅旧配置目录：读取一次旧 `settings.json` 做回填、改名为 `.migrated`、清理 30 天前过期文件。官方设置由 DSH 官方 `configEditor` 写入 |
| `env.read` | `DSH_HOME`、`DSH_PROMPT_DOCK_DISABLE_OPEN` | 前者定位旧配置目录；后者为 `1` 时不弹文件管理器（无头环境）。**不读取任何凭据类环境变量** |

### 与宿主 API 的对应关系（已核对 dsh 0.2.1-rc.2 运行时）

| 宿主事实 | 本插件的处理 |
| --- | --- |
| `SessionInputShell.compose()` 发布 `{ draft: projection.clipboardText, draftRev, phase, occurrences, ... }` | `pickDraftText` 读 `draft`；`chipFromState` 读 `occurrences` |
| `inputActions.setDraft(text)` 是单参数，内部 `text.replace(REFERENCE_PLACEHOLDER_RE, "")` 并重建段落 | 回填只调用 `setDraft(text)`；含芯片时直接禁用改写 |
| 芯片占位符为 `[\uE100-\uE11D\uFFFC]`，`setDraft` 会清掉它们 | `detectChip` 额外检测这些字符作为兜底 |
| 设置表单只接受 volatile 字段：`settings.mutate(ns, ops)` 校验路径后经 `configEditor.edit()` 写 YAML | 所有可编辑项都声明为 Config 的 `.volatile()` 字段；写入走 `settings.mutate` |
| volatile 字段只有 `.get()`，值由 Loader 从 `cordis.patch.yml` 重新解析产生 | 插件不在内存里改配置；回填与保存都写存储，读时重新取 |
| `plugins.bundle.config` 是以包名为 key 的 keyed slot，只在组合包详情页以 `view: 'page'` 渲染 | 配置卡片注册为 `key: "dsh-prompt-dock"` |

> 说明：早期设计文档提到的 `settings.plugin.item` / `installSection` / `SettingsScope` 在 DSH 0.2.1-rc.2 中不存在，本插件按上述真实 API 实现。

---

## 兼容性

- dsh `>=0.2.0-rc.2 <0.3.0 || >=0.2.1-0 <0.3.0`（已在 `0.2.1-rc.2` 上核对 API 与行为；区间用并集是因为 semver 的预发布门控要求同 `major.minor.patch` 的比较器）。
- 宿主未提供 `inputActions.setDraft` 时，改写会明确报「当前宿主不支持改写回填」。
- 宿主未提供 `settings` 服务时，配置保存会明确失败（`SAVE_FAILED`），不会假装成功。

---

## 路由与错误码

| 路由 | 说明 |
| --- | --- |
| `GET/POST /api/prompt-dock/config` | 读取（规范化后的）设置；POST 接受**部分字段**补丁，未提交的字段保持现值 |
| `GET /api/prompt-dock/models` | 模型目录 + 全局默认 |
| `POST /api/prompt-dock/open-config` | 在文件管理器中定位 profile 的 `cordis.patch.yml` |
| `POST /api/prompt-dock/rewrite` | `{text, styleId, customInstruction?, sessionId, useContext}` → `{ok, text}` |
| `POST /api/prompt-dock/rewrite-stream` | 同上，`text/event-stream`：`meta` / `delta` / `done` / `error`；`meta` 带 `draftChars` 与 `timeoutMs` |
| `POST /api/prompt-dock/cancel` | `{requestId}` 中断进行中的流式改写 |
| `POST /api/prompt-dock/probe` | 开发期探针（`~/.dsh/prompt-dock/probe.json`，写入前剔除草稿原文） |

错误码：`AUTH` / `RATE_LIMIT`（含 `retryAfter`）/ `CONCURRENCY_LIMIT` / `QUOTA` / `CONTEXT_WINDOW` / `TIMEOUT` / `EMPTY_TEXT` / `TEXT_OVER` / `NO_INSTRUCTION` / `NO_MODEL` / `NO_LLM` / `LLM_FAILED` / `EMPTY_REPLY` / `BAD_JSON` / `BODY_OVER_SIZE` / `METHOD` / `SAVE_FAILED` / `NO_DOCUMENT`。

---

## 安装

从 GitHub 安装（`lib/` 为已提交产物，无需本地构建）：

```bash
dsh plugin --profile web add github:wnei-f/dsh-prompt-dock
# 重启 dsh web 后生效
```

从本地目录安装（开发迭代用）：

```bash
dsh plugin install <本目录绝对路径>
```

也可以在 GUI 插件管理里安装。**改完代码必须重启 DSH**：客户端 bundle 的 `rev` 由宿主进程按文件元数据计算并注入页面，只刷新页面拿不到新代码。

---

## 开发

```bash
npm test        # 宿主路由/迁移/隐私 + 客户端纯逻辑 + 组件挂载
```

测试只用 Node 内置模块，但**宿主半依赖 DSH 自带的 `@deepseek-ai/schemastery`**（Config schema 是官方设置表单读取 volatile 字段的唯一接口），因此它是 `peerDependencies`，不随包发布拷贝。

`npm test` 之前会自动运行 `scripts/link-dsh-deps.mjs`，在 `~/.dsh/profiles/*/node_modules` 里找到 DSH 安装后，把 `schemastery` / `cosmokit` 软链进本仓库的 `node_modules`（不复制）。找不到时会打印提示但不中断，此时手动指定：

```bash
DSH_NODE_MODULES=/path/to/node_modules npm test
```

Node 版本要求见 `package.json` 的 `engines`。

---

## 标识

| 项目 | 值 |
| --- | --- |
| GitHub topic | `dsh-plugin`（插件市场按此 topic 自动收录） |
| 兼容 DSH | `0.2.x`（已在 `0.2.1-rc.2` 上核对） |
| 许可证 | MIT |
| 挂载插槽 | `conversation.input.right`（工具行）、`plugins.bundle.config`（配置卡片，key = `dsh-prompt-dock`） |
| 仓库 | https://github.com/wnei-f/dsh-prompt-dock |
