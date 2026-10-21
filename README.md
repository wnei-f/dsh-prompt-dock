# dsh-prompt-dock（提示词修改助手）

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2f6fed)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-4d6bfe)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![version](https://img.shields.io/badge/version-1.0.0-2f6fed)](https://github.com/wnei-f/dsh-prompt-dock/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

DSH 插件：挂在**输入框工具行**（`conversation.input.right`，模型选择左侧），对输入框草稿做：

- **AI 改写**：更简洁 / 更详细 / 结构化 / 译成英文 / 自定义指令；**SSE 流式**输出、可**取消**、写入后 **↩ 撤销**
- **模板插入**：自定义常用提示词模板，一键追加到草稿

> 改写结果为 AI 辅助生成，请自行核实内容。

工具行从左到右为「风格 / 模板 / 改写」三个独立控件：风格与模板各自是一个一级触发器、互不嵌套；「改写」是这一行最靠右的控件，紧邻官方模型选择器。**设置已从工具行移入 DSH 官方「插件」页**，见下节。下拉箭头、选中态、开关均沿用官方视觉与主题令牌（选中项用底色 + 细阴影描边，不打勾）。「改写」为纯图标（官方 sparkle 形状，文案在 tooltip），进行中显示转圈 + 已接收字符数，完成后**同一槽位**变成 **↩ 撤销**。

模型默认走 DSH 全局默认模型（`agentDefaultModel`），可在插件配置里固定为某个模型；改写调用宿主半 `ctx.llm.stream`。

## 设置（DSH 官方配置）

设置不再是插件自己的 JSON 文件，而是 DSH 官方的插件配置：

- **入口**：侧栏 **插件** → 找到 `dsh-prompt-dock` → 打开它的页面，配置区就在页面里（`plugins.bundle.config` 插槽，以**包名** `dsh-prompt-dock` 为 key）。
- **存储**：写入当前 profile 的 `cordis.patch.yml`（由 DSH 的 `configEditor` 管理），插件本身不直接读写该文件。
- **生效**：每个字段都是 Config 的 `.volatile()` 字段，保存后无需重启，改写行为立即变化。

配置分组（7 组）：

| 分组 | 内容 |
| --- | --- |
| 改写模型 | 跟随全局默认，或固定为某个 `provider/model` |
| 上下文 | 是否附带最近对话、附带轮数（1–20） |
| 全局改写纪律 | 改写链路 system prompt 的共同纪律；默认只读，可解锁编辑，也可一键恢复默认 |
| 风格库 | 每个风格的 `name` / `instruction` 可编辑（`custom` 提供「自定义」风格） |
| 模板库 | 每条模板的 `text` / `category` / `tags` 可编辑，可增删 |
| 工具行 | `showStyleEntry` / `showTemplateEntry`（auto/always/never）、`compactThreshold` |
| 快捷键 | 风格 / 模板 / 改写的快捷键（默认 Alt+M / Alt+T / Alt+R） |

对应的配置字段（`cordis.patch.yml` 里 `dsh-prompt-dock` 行的 `config`）：

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

> 字段约束：模板 ≤ 100 条，`name` ≤ 60 字、`text` ≤ 4000 字；风格 `name` ≤ 40 字、`instruction` ≤ 2000 字；共同纪律 ≤ 4000 字。超限在保存时截断。

### 从旧版迁移

旧版把设置放在 `~/.dsh/prompt-dock/settings.json`。升级后首次启动会自动：

1. 读取旧文件，把它转换成官方配置字段；
2. **只回填官方配置里尚未由用户设置过的字段**（已在官方存储里设过的值不会被旧文件覆盖）；
3. 把旧文件原子改名为 `settings.json.migrated`，此后不再读写它（超过 30 天自动清理）。

回填以 `settings.describe()` 返回的 `user` 层为准来区分「用户设过」与「用了默认值」，因此重复启动是幂等的。`

## 内置风格与模板

风格指令的共同约定：只输出改写后的正文；写清「必须保留什么」与「禁止做什么」；给出目标长度区间，避免模型为凑长度而丢约束或编造。每条都可在设置里改。

| 风格 | 关键约束 |
| --- | --- |
| 更简洁 | 保留全部硬性约束、数字与阈值、文件/接口/字段名、验收标准与否定条件；不得为缩短删要求；目标 50%–70% |
| 更详细 | 只补草稿已隐含的信息；不得编造事实/接口/数字；缺失信息写「待补充：…」；目标 1.5–3 倍 |
| 结构化 | 固定章节顺序：目标 / 上下文 / 任务步骤 / 约束 / 输出格式；只重组不新增需求；空章节省略 |
| 译成英文 | 代码标识符、路径、命令行参数、产品名不译；Markdown 结构保留；不增删信息 |
| 自定义 | 指令为空，取设置里的「自定义改写指令」；两者都空时报 `NO_INSTRUCTION` |

模板（插入草稿末尾）：代码审查（按严重程度分类 + 文件:行号 + 修复建议）、解释代码（职责/控制流/边界/坑点，禁止逐行复述）、写测试（正常/边界/失败路径，不 mock 被测逻辑，注明框架与命令）。

> 这些是**默认值**。一旦在插件配置里保存过风格或模板，config 里对应的值会覆盖内置默认；共同纪律在设置里点「恢复默认」即可回到内置文案（此时存为空串，后续版本改进默认文案会自动生效）。

## 安全、隐私与版权

- **草稿不落日志、不落磁盘**：改写请求的草稿原文只用于这一次改写调用，从不写入日志、探针文件或任何持久化文件。错误日志只记录错误类型、耗时与字符数。开发期探针接口在写盘前会剔除 `draft` / `text` / `content` 等草稿字段，仅保留字符数。
- **不接触凭据**：插件不读取任何 API Key，模型凭据由宿主的 `llm` 服务持有；配置里也不保存凭据。
- **HTTPS 强制**：改写不直接发起外网请求，而是走宿主 `llm` 服务；插件自身没有明文 HTTP 出口，也不提供任何可降级到 http 的配置项。
- **回环围栏**：见下方「安全与边界」。
- **权限声明**：`package.json` 的 `dsh.permissions` 显式列出本插件使用的网络、文件系统、环境变量与子进程能力，与实现保持一一对应（见「权限清单」）。
- **AI 辅助告知**：首次点击「改写」时会以一条可关闭的轻提示告知「点击改写会将当前草稿发送至你配置的模型」，关闭后不再出现。
- **许可证**：MIT，覆盖插件代码、内置模板正文与风格指令，见 [LICENSE](LICENSE)。改写结果为 AI 辅助生成，请自行核实内容。

---

## 安全与边界

- **回环围栏**：所有 `/api/prompt-dock/*` 只接受本机来源（校验 socket 地址、`Host`、`Origin`，并拒绝带 `X-Forwarded-For` / `Forwarded` 的请求）。`*.localhost` 与非 http(s) 的自定义 scheme（桌面壳 `app://`、`tauri://`、`file://`）放行，http(s) 必须是回环。**不要**把 dsh web 暴露在反向代理后还期望这道围栏生效。
- **改写限流**：同一宿主进程内并发改写上限 2，每分钟成功调用上限 10（失败调用不占配额）。
- **芯片保护**：草稿含 `@文件` / `/命令` 引用芯片时，「改写」置灰并提示。判据取自宿主真实发布状态——`InputState.occurrences` 非空即视为含芯片（见下）。
- **变更检测**：改写期间若草稿被改动，结果不会回填，避免覆盖新输入。
- **只走 `inputActions.setDraft`**：不再猜测其它方法名。宿主不支持时显式报错，而不是静默换一条未知路径。

### 权限清单（与 `package.json` 的 `dsh.permissions` 一致）

| 能力 | 声明值 | 实际用途 |
| --- | --- | --- |
| `network.fetch` / `network.socket` | `false` / `false` | 插件不发起任何外部网络请求；改写经宿主 `llm` 服务 |
| `process.child_process` | `true` | 仅「打开配置文件」：调用系统文件管理器（`explorer.exe` / `open` / `xdg-open`）定位当前 profile 的 `cordis.patch.yml` |
| `filesystem.read` / `fs.write` | `$DSH_HOME/prompt-dock` | 仅旧配置目录：读取一次旧 `settings.json` 做回填、改名为 `.migrated`、清理 30 天前的过期文件。官方设置由 DSH 官方 `configEditor` 写入，插件不直接读写 |
| `env.read` | `DSH_HOME`、`DSH_PROMPT_DOCK_DISABLE_OPEN` | 前者定位旧配置目录；后者为 `1` 时不弹文件管理器（无头环境）。**不读取任何凭据类环境变量** |

### 与宿主 API 的对应关系（已核对 dsh 0.2.1-rc.2 运行时）

| 宿主事实 | 本插件的处理 |
| --- | --- |
| `SessionInputShell.compose()` 发布 `{ draft: projection.clipboardText, draftRev, phase, occurrences, ... }` | `pickDraftText` 读 `draft`；`chipFromState` 读 `occurrences` |
| `inputActions.setDraft(text)` 是**单参数**，内部 `text.replace(REFERENCE_PLACEHOLDER_RE, "")` 并重建段落 | 回填只调用 `setDraft(text)`；含芯片时直接禁用改写 |
| 芯片占位符为 `[\uE100-\uE11D\uFFFC]`，`setDraft` 会清掉它们 | `detectChip` 额外检测这些字符作为兜底 |
| 设置表单只接受 **volatile**字段：`settings.mutate(ns, ops)` 校验路径后经 `configEditor.edit()` 写 YAML | 所有可编辑项都声明为 Config 的 `.volatile()` 字段；写入走 `settings.mutate` |
| volatile 字段只有 `.get()`，值由 Loader 从 `cordis.patch.yml` 重新解析产生 | 插件不在内存里改配置；回填与保存都写存储，读时重新取 |
| `plugins.bundle.config` 是**以包名为 key** 的 keyed slot，只在组合包详情页以 `view: 'page'` 渲染 | 配置卡片注册为 `key: "dsh-prompt-dock"` |

## 兼容性

- dsh `>=0.2.0-rc.2 <0.3.0 || >=0.2.1-0 <0.3.0`（已在 `0.2.1-rc.2` 上核对 API 与行为；区间用并集是因为 semver 的预发布门控要求同 `major.minor.patch` 的比较器）。
- 宿主未提供 `inputActions.setDraft` 时，改写会明确报「当前宿主不支持改写回填」。
- 宿主未提供 `settings` 服务时，配置保存会明确失败（`SAVE_FAILED`），而不是静默假装成功。

## 路由

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

## 安装

从 GitHub 安装（推荐，`lib/` 为已提交产物，无需本地构建）：

```bash
dsh plugin --profile web add github:wnei-f/dsh-prompt-dock
# 重启 dsh web 后生效
```

从本地目录安装（开发迭代用）：

```bash
dsh plugin install <本目录绝对路径>
```

也可在 GUI 插件管理里安装。开发迭代：改码 → 重新 install → 刷新页面。

## 开发

```bash
npm test        # 宿主路由/迁移/隐私 + 客户端纯逻辑 + 组件挂载
```

测试只用 Node 内置模块，但**宿主半依赖 DSH 自带的 `@deepseek-ai/schemastery`**（Config schema
是官方设置表单读取 volatile 字段的唯一接口），因此它是 `peerDependencies` 而不是随包发布的拷贝。
`npm test` 之前会自动运行 `scripts/link-dsh-deps.mjs`，在 `~/.dsh/profiles/*/node_modules`
里找到 DSH 安装后把 `schemastery` / `cosmokit` 软链进本仓库的 `node_modules`（不复制）。

找不到 DSH 安装时，脚本会打印提示但不中断；此时需要手动指定位置再跑测试：

```bash
DSH_NODE_MODULES=/path/to/node_modules npm test
```

Node 版本要求见 `package.json` 的 `engines`。

## 标识

| 项目 | 值 |
| --- | --- |
| GitHub topic | `dsh-plugin`（插件市场按此 topic 自动收录） |
| 兼容 DSH | `0.2.x`（已在 `0.2.1-rc.2` 上核对） |
| 许可证 | MIT |
| 挂载插槽 | `conversation.input.right`（工具行）、`plugins.bundle.config`（配置卡片，key = `dsh-prompt-dock`） |
| 仓库 | https://github.com/wnei-f/dsh-prompt-dock |
