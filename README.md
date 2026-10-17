# dsh-prompt-dock（提示词修改助手）

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2f6fed)](https://github.com/topics/dsh-plugin)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-4d6bfe)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![version](https://img.shields.io/badge/version-1.0.0-2f6fed)](https://github.com/wnei-f/dsh-prompt-dock/releases)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

DSH 插件：挂在**输入框工具行**（`conversation.input.right`，模型选择左侧），对输入框草稿做：

- **AI 改写**：更简洁 / 更详细 / 结构化 / 译成英文 / 自定义指令；**SSE 流式**输出、可**取消**、写入后 **↩ 撤销**
- **模板插入**：自定义常用提示词模板，一键追加到草稿

工具行从左到右为「设置 / 风格菜单 / 改写」：**风格与模板合并进一个二级菜单**（触发器显示当前风格名；分类在右侧以**树形浮层**展开，父级保留不替换，空间不足时自动改为向左展开），因此「改写」成为本插件这一行最靠右的控件，紧邻官方模型选择器（再往右是官方模型选择与发送按钮，插件无法越过它们）。下拉箭头、选中态、开关、标签页均沿用官方视觉与主题令牌（选中项用底色 + 细阴影描边，不再打勾）。「改写」为纯图标（官方 sparkle 形状，文案在 tooltip），进行中在原位显示「改写中…」，完成后**同一槽位**变成 **↩ 撤销**。设置面板与输入框同一中轴居中。

模型默认走 DSH 全局默认模型（`agentDefaultModel`），可在设置里固定为某个模型；改写调用宿主半 `ctx.llm.stream`。

## 配置文件

界面与配置文件是**同一份 JSON**，两种方式等价：

- 路径：`~/.dsh/prompt-dock/settings.json`（遵循 `DSH_HOME`）
- 入口：设置面板标题栏的**文件夹图标**（「打开配置文件」），会在系统文件管理器中定位到该文件；文件不存在时会先按默认值生成
- **打开设置面板即重新读取**该文件，所以手工编辑后无需刷新页面即可看到

```json
{
  "styles": [{ "id": "concise", "name": "更简洁", "instruction": "……" }],
  "templates": [{ "id": "t-review", "name": "代码审查", "text": "……" }],
  "customInstruction": "",
  "contextEnabled": true,
  "contextTurns": 6,
  "rewriteModel": { "provider": "deepseek-official", "model": "deepseek-chat" }
}
```

字段说明：

| 字段 | 含义 | 约束 |
| --- | --- | --- |
| `styles` | 风格列表（`id` 用于菜单与记忆，`name` 显示） | 缺省时用内置 5 条；`custom` 的 `instruction` 应为空 |
| `templates` | 模板列表，插入草稿末尾 | ≤ 100 条；`name` ≤ 60 字，`text` ≤ 4000 字 |
| `customInstruction` | 「自定义」风格的改写要求 | ≤ 2000 字 |
| `contextEnabled` | 改写时是否附带最近对话 | 布尔 |
| `contextTurns` | 附带最近多少轮 | 1–20 |
| `rewriteModel` | 固定改写模型；`null` 表示跟随全局默认 | `{ provider, model }` 或 `null` |

> 注意：在界面里点「保存」会用当前界面内容**整份覆盖**该文件；手工编辑后若界面里还留着旧状态，请先重新打开面板再保存。

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

> 这些是**默认值**。一旦在设置里保存过风格或模板，`~/.dsh/prompt-dock/settings.json` 会覆盖默认值，后续版本改默认文案不会自动生效——需手动改或在设置里恢复。

## 安全与边界

- **回环围栏**：所有 `/api/prompt-dock/*` 只接受本机来源（校验 socket 地址、`Host`、`Origin`，并拒绝带 `X-Forwarded-For` / `Forwarded` 的请求）。`*.localhost` 与非 http(s) 的自定义 scheme（桌面壳 `app://`、`tauri://`、`file://`）放行，http(s) 必须是回环。**不要**把 dsh web 暴露在反向代理后还期望这道围栏生效。
- **改写限流**：同一宿主进程内并发改写上限 2，每分钟成功调用上限 10（失败调用不占配额）。
- **芯片保护**：草稿含 `@文件` / `/命令` 引用芯片时，「改写」置灰并提示。判据取自宿主真实发布状态——`InputState.occurrences` 非空即视为含芯片（见下）。
- **变更检测**：改写期间若草稿被改动，结果不会回填，避免覆盖新输入。
- **只走 `inputActions.setDraft`**：不再猜测其它方法名。宿主不支持时显式报错，而不是静默换一条未知路径。

### 与宿主 API 的对应关系（已核对 dsh 0.2.1-rc.2 运行时）

| 宿主事实 | 本插件的处理 |
| --- | --- |
| `SessionInputShell.compose()` 发布 `{ draft: projection.clipboardText, draftRev, phase, occurrences, ... }` | `pickDraftText` 读 `draft`；`chipFromState` 读 `occurrences` |
| `inputActions.setDraft(text)` 是**单参数**，内部 `text.replace(REFERENCE_PLACEHOLDER_RE, "")` 并重建段落 | 回填只调用 `setDraft(text)`；含芯片时直接禁用改写 |
| 芯片占位符为 `[\uE100-\uE11D\uFFFC]`，`setDraft` 会清掉它们 | `detectChip` 额外检测这些字符作为兜底 |

## 兼容性

- dsh `>=0.2.0-rc.2 <0.3.0 || >=0.2.1-0 <0.3.0`（已在 `0.2.1-rc.2` 上核对 API 与行为；区间用并集是因为 semver 的预发布门控要求同 `major.minor.patch` 的比较器）。
- 宿主未提供 `inputActions.setDraft` 时，改写会明确报「当前宿主不支持改写回填」。

## 路由

| 路由 | 说明 |
| --- | --- |
| `GET/POST /api/prompt-dock/config` | 读写设置 |
| `GET /api/prompt-dock/models` | 模型目录 + 全局默认 |
| `POST /api/prompt-dock/rewrite` | `{text, styleId, customInstruction, sessionId, useContext}` → `{ok, text}` |
| `POST /api/prompt-dock/rewrite-stream` | 同上，`text/event-stream`：`meta` / `delta` / `done` / `error` |
| `POST /api/prompt-dock/cancel` | `{requestId}` 中断进行中的流式改写 |
| `POST /api/prompt-dock/probe` | 开发期探针（`~/.dsh/prompt-dock/probe.json`） |

错误码：`AUTH` / `RATE_LIMIT`（含 `retryAfter`）/ `CONCURRENCY_LIMIT` / `QUOTA` / `CONTEXT_WINDOW` / `TIMEOUT` / `EMPTY_TEXT` / `TEXT_OVER` / `NO_INSTRUCTION` / `NO_MODEL` / `NO_LLM` / `LLM_FAILED` / `EMPTY_REPLY` / `BAD_JSON` / `BODY_OVER_SIZE` / `METHOD`。

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
npm test        # 160 项断言：宿主路由、客户端纯逻辑、组件挂载
```

无需安装依赖（测试只用 Node 内置模块）；Node 版本要求见 `package.json` 的 `engines`。

## 标识

| 项目 | 值 |
| --- | --- |
| GitHub topic | `dsh-plugin`（插件市场按此 topic 自动收录） |
| 兼容 DSH | `0.2.x`（已在 `0.2.1-rc.2` 上核对） |
| 许可证 | MIT |
| 挂载插槽 | `conversation.input.right` |
| 仓库 | https://github.com/wnei-f/dsh-prompt-dock |
