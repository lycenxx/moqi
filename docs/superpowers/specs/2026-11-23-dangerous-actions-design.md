# 危险动作的安全底座设计

> 2026-11-23 定稿。实现以代码和测试为准。

## 1. 背景和目标

用户希望 moqi 能操作电脑、操作网页、交给编程 agent 写代码。这三件事拆成三个子项目，本文是第一个：安全底座。后两个（电脑和网页操作、委派编程 agent）都建立在它上面，各自另写设计。

目标：

- 执行命令、改删文件、提交表单、付款、把内容发给别人这类危险动作，默认每次都问。
- 只有用户能在设置里放开某个危险工具；moqi 自己永远不提议放开。
- 就算放开了，只要这一轮对话读进过外部内容，危险动作照样先问。
- 确认框显示要执行的完整内容和为什么问。
- 提议附带的危险动作，点"好"之后仍要确认一次。

## 2. 防什么，不防什么

- **防提示注入**：网页、文章、文件、日历邀请、别的 agent 的消息里藏着指令，诱导模型去做用户没想做的事。
- **不防恶意的 MCP 服务器**：用户装的服务器以用户的权限在本机运行，想做坏事不需要经过 moqi。所以 MCP 工具自己标的"只读"（`readOnlyHint`）照旧采信，只读工具照常随时可用，也能用在托管事务里。"写工具不危险"这件事只由用户判定，不看服务器的 `destructiveHint`。

## 3. 做法

放进内核的信任关口，所有工具调用都经过 `Moqi.callTool` 这一个关口。

没有选的两种做法：

- **在 MCP 和 A2A 插件里包一层**：插件看不到这一轮对话读过什么，外部内容规则做不了，确认逻辑也会分散。
- **单独的策略引擎**：规则只有几条，用不着通用引擎。

## 4. 工具上的标记（`src/core/plugin.ts`）

`Tool` 加三个可选字段：

```ts
  /** Hard to undo: runs commands, changes or deletes files, submits forms, pays, sends the user's words elsewhere. */
  readonly danger?: boolean;
  /** Its result is moqi's own state (memories, todos, watches), never outside content. */
  readonly local?: true;
  /** Who provides it, for the confirmation and the settings: an MCP server or A2A agent name. */
  readonly source?: string;
```

- `src/node/mcp-client.ts`：写工具（没有 `readOnlyHint: true` 的）标 `danger: true`；所有 MCP 工具都带 `source: <服务器名>`。
- `src/plugins/a2a.ts`：`ask_<名字>` 标 `danger: true`，`source: <agent 名>`。
- `src/core/tools.ts`：内置工具都标 `local: true`，都不标 `danger`。`forget` 仍然封顶 `suggest`。
- 天气、日历、新闻插件的工具不标 `local`，它们的结果算外部内容。
- 来源显示：`tool.source` 有值就用它，否则用提供它的插件名，内置工具显示 `moqi`。`Moqi` 在构造时记下每个工具属于哪个插件。

## 5. 用户的决定（事件和状态）

- 新事件 `{ type: "tool.policy"; tool: string; policy: "ask" | "auto" | "normal" }`。
- `State.toolPolicies: Map<string, "ask" | "auto" | "normal">`，按工具名记。没有记录等于 `ask`。
- 三种状态只对 `danger` 工具有意义：
  - `ask`（默认）：每次都问。
  - `auto`：放开，直接办；但这一轮读过外部内容时先问。
  - `normal`：用户判定它不危险，按普通写工具走现有的信任阶梯，连续同意 3 次后 moqi 会提议升级。
- 已知边界：状态按工具名记。MCP 服务器升级后同名工具的行为变了，之前的放开仍然有效。设置页显示每个工具的来源，提醒用户留意。

## 6. 判断规则（`src/core/autonomy.ts`）

`ActionPolicy` 加 `danger: boolean`，`actionPolicy(tool)` 从 `tool.danger` 取值。

`needsConfirmation(state, kind, policy, tainted = false)`：

| 工具   | `toolPolicies` | 读过外部内容 | 结果               |
| ------ | -------------- | ------------ | ------------------ |
| 危险   | `ask` 或没有   | 任意         | 问                 |
| 危险   | `auto`         | 否           | 不问               |
| 危险   | `auto`         | 是           | 问                 |
| 危险   | `normal`       | 任意         | 按信任阶梯（现状） |
| 不危险 | 无关           | 任意         | 按信任阶梯（现状） |

`promotionDue`：危险工具、状态不是 `normal` 时返回 `undefined`，所以 moqi 不会对它弹"以后这类事直接办？"。

`set_level` 和 `tool.policy` 是两套东西：前者是信任阶梯（moqi 提议、用户同意），后者是用户对危险工具的决定。危险工具状态不是 `normal` 时，`level.changed` 对它不起作用。

## 7. "本轮读过外部内容"（`src/core/agent.ts`、`src/core/moqi.ts`）

- `Moqi.chat(text, signal?, how?: { fromAgent?: boolean })`。原来的 `chat(text, signal)` 照常能用。
- `chatTurn` 开头 `let tainted = how?.fromAgent === true`。
- 每次工具调用都把 `tainted` 传给 `callTool`；调用的工具不是 `local` 的，调用之后（不管成功与否）`tainted = true`。调用不存在的工具不改变标记。
- 标记只管当前这一轮，对话历史不算。
- `callTool(name, args, how: { byUser; preApproved?; tainted? })`，`tainted` 传给 `needsConfirmation`。
- 控制台 `POST /api/chat` 带 `from` 时、A2A 入口，都传 `{ fromAgent: true }`。`moqi_ask` 走 `/api/chat` 并带 `from`，所以也算。

## 8. 接受提议（`Moqi.feedback`）

提议附带的动作是危险工具、且状态不是 `normal` 时，点"好"不算预先批准，改为 `callTool(tool, args, { byUser: true, tainted: true })`：`ask` 状态会问，`auto` 状态因为 `tainted` 也会问。其他动作照旧预先批准。

## 9. 确认框（`Moqi.callTool`、`MoqiOptions.confirm`）

- `MoqiOptions.confirm(question: string, details?: string)`。只传一个参数的旧实现照常能用。
- 危险工具的确认：
  - `question`：`要我用「<来源>」的 <工具名> 吗？`。工具自己有 `describe` 时用 `要我<describe 的结果>吗？`。
  - `details`：第一行写为什么问，`这是会改动东西的外部工具，每次都要你确认。` 或 `这一轮读过网页或工具结果，所以再确认一次。`；空一行后是 `JSON.stringify(args, null, 2)`，超过 2000 字截断，末尾写 `…还有 N 字没显示`。
- 不危险的工具确认保持现状，不传 `details`。
- 控制台 `confirmQueue.ask(text, details?)`，`pending()` 返回 `{ id, text, details? }`；`/api/state` 的 `question` 带上 `details`。页面在问题下面用可滚动的等宽文本块显示（`<pre class="ask-details">`，最高约 16 行）。
- 终端 `moqi chat` 的 `confirm` 把 `details` 打印在问题上面。

## 10. 设置页和接口（`src/node/console/`）

- `GET /api/tools`：列出所有 `danger` 工具：`{ name, source, description, policy }`，`policy` 没有记录时是 `"ask"`。
- `POST /api/tool-policy {tool, policy}`：`policy` 必须是三种之一、工具必须存在且是危险工具，否则 400；成功后记一条 `tool.policy` 事件，立刻生效。通过 `Moqi.setToolPolicy(name, policy)` 完成。
- 页面："MCP 工具"那一组下面加"会改动东西的工具"，每行显示工具名、来源和一个下拉框：`每次都问` / `放开（读过外部内容时仍会问）` / `普通`。没有危险工具时显示一句说明。

## 11. 出错处理

- `tool.policy` 指向的工具已经不存在（服务器被删了）：状态留在日志里不影响别的；工具回来时沿用。
- 确认超时（控制台 5 分钟没回答）：按"不"处理，和现在一样。
- 没有传 `confirm` 的宿主：需要确认的动作一律拒绝，和现在一样。

## 12. 测试

- `test/autonomy.test.ts`：第 6 节表格的每一行；危险工具连续同意 3 次后 `promotionDue` 为 `undefined`，状态改成 `normal` 后恢复。
- `test/safety.test.ts`（新）：
  - 一轮对话先调用新闻（外部）工具、再调用已放开的危险工具，会问，`details` 写着"这一轮读过网页或工具结果"。
  - 只调用内置工具后再调用已放开的危险工具，不问。
  - `chat(text, undefined, { fromAgent: true })` 里第一次调用已放开的危险工具就问。
  - 危险工具连续同意 3 次，没有 `trust.promote` 提议。
  - 带危险动作的提议点"好"之后会确认，`details` 里有完整参数；状态为 `auto` 时也会确认。
  - 参数超过 2000 字时截断并写明剩余字数。
- `test/interop.test.ts`：MCP 写工具带 `danger: true` 和 `source`，只读工具不带 `danger`。
- `test/plugins.test.ts` 或 `test/a2a.test.ts`：`ask_<名字>` 带 `danger: true`。
- `test/console.test.ts`：`/api/tools`、`/api/tool-policy`（含 400 的情况）、`question.details`。
- 完成标准：`pnpm check` 全部通过。

## 13. 文档

- README（中英文）"设计取舍"加一行：危险动作默认每次都问，只由你放开；读过外部内容后照样先问。
- README 的 MCP 小节改写"其余的先问"那句，说明危险工具的规则和设置位置。
- `docs/design.md` 第 1 节的信任阶梯后加"危险动作"一段，写明防什么、不防什么。
- `CHANGELOG.md` 的 Unreleased 加一条。

## 14. 不做

- 不按参数内容判断危险程度（比如只把 `rm` 当危险）。
- 不做网络或目录沙箱；那属于第二个子项目里具体的内置动作。
- 不跨轮追踪外部内容。
- 不允许 moqi 或其他 agent 修改 `tool.policy`；只有控制台的设置页能改。
