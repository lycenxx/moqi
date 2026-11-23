# 每日待办设计

> 2026-11-23 定稿。实现以代码和测试为准。

## 1. 目标

让 moqi 像助理一样管你每天要做的事：

- 待办可以不带时间，只进清单和早上的简报；带时间的到点提醒。
- 用户亲口定的提醒时间到点必达。
- 每晚回顾一次今天没做完的事；没做完的自动顺延，标出已拖几天。
- 待办可以从对话、控制台和其他 agent（MCP）加进来。

## 2. 做法

待办放进内核，和托管事务（watch）同级：

- 新文件 `src/core/todo.ts`，只放纯函数：哪些提醒到点了、晚间回顾的内容、每条已拖几天、简报的"今天要做"一段。
- 改动 `types.ts`、`state.ts`、`tools.ts`、`moqi.ts`、`proactive.ts`、`briefing.ts`、`reflect.ts`。
- 外层改动 `src/node/config.ts`、`src/node/console/`（服务端和页面）、`src/node/mcp.ts`。

没有选的两种做法：

- **做成插件**：`PluginContext` 只有 `observe` 和 `offer`，插件写不了自己的事件，也绕不过送达关卡。为待办给插件接口开口子，会让所有插件都能绕过关卡。
- **扩展托管事务**：watch 是"定时查一个工具，有变化才说"，待办是"清单里的一件事，可以没有时间，会顺延"。硬放在一起，两边都别扭，watch 还有 20 件的上限。

## 3. 数据模型

### 3.1 `Todo`（`types.ts`）

```ts
export interface Todo {
  readonly id: string;
  /** 最多 200 字。 */
  readonly text: string;
  /** 计划哪天做，本地日期 YYYY-MM-DD。 */
  readonly day: string;
  /** 到点必达的提醒时间（毫秒时间戳）。没有就只进清单。 */
  readonly remindAt?: number;
  /** 谁加的。不填是用户本人；其他 agent 填它握手时报的名字，例如 "kiro-cli"。 */
  readonly by?: string;
  readonly createdAt: number;
  readonly doneAt?: number;
  /** 提醒发出的时间，保证一个提醒时间只提醒一次。 */
  readonly remindedAt?: number;
}
```

### 3.2 事件（加进 `EventBody`）

| 事件            | 字段                                                  | 作用                                                         |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| `todo.added`    | `todo: Todo`                                          | 新建                                                         |
| `todo.updated`  | `todoId`，以及 `text?`、`day?`、`remindAt?: number \| null` | 改文字、改期、改提醒时间。`remindAt` 只要出现在事件里，就清掉 `remindedAt`；`null` 表示去掉提醒 |
| `todo.done`     | `todoId`                                              | 勾掉，记 `doneAt`                                            |
| `todo.undone`   | `todoId`                                              | 撤销勾选，清掉 `doneAt`                                      |
| `todo.removed`  | `todoId`                                              | 删除                                                         |
| `todo.reminded` | `todoId`                                              | 提醒已发出，记 `remindedAt`                                  |

`State` 折叠出 `readonly todos = new Map<string, Todo>()`。

### 3.3 顺延和已拖天数

- 不需要半夜跑任务。未完成且 `day` 早于今天的待办，算作今天的。
- 已拖天数 = 今天的本地日期减去 `day`，按日历天数计算。
- 自动顺延不改 `day`，所以拖延天数会累积。用户主动改期会改 `day`，拖延天数随之清零。

### 3.4 "以后"的待办

`day` 晚于今天的待办，不进今天的清单、简报和晚间回顾。到了那一天，当天早上的简报会列出它。控制台把它们单独列在"以后"一栏。

### 3.5 上限

- 未完成的待办最多 100 条。超出时 `todo_add` 和控制台接口都返回"未完成的待办已经有 100 条了，先清理一些"。
- 已完成的留在日志和 `State` 里，控制台只显示 7 天内完成的。

## 4. 提醒和晚间回顾

### 4.1 到点提醒

`tick()` 在 `runDueWatches` 之后找出这样的待办：未完成、有 `remindAt`、`remindAt <= now`，并且 `remindedAt` 为空。逐条处理：

1. 发一个提议：
   - `kind: "todo.remind"`
   - `title`：待办内容
   - `body`：`你定的 15:00`；拖过的加上 `，已拖 2 天`；晚到的写成 `本来 15:00 提醒你`
   - 准时（`now - remindAt <= 30 分钟`）：`userTimed: true`，`value: 0.9`，`urgency: "now"`
   - 晚到（超过 30 分钟）：不带 `userTimed`，`value: 0.85`，`urgency: "today"`
   - `expiresAt`：当天本地 24:00
   - `action: { tool: "todo_done", args: { id } }`：在动态里点"完成"就会勾掉这条待办
2. 记 `todo.reminded`。

先发提议、再记事件。如果进程在两者之间退出，重启后会再提醒一次；重复一次比漏掉好。

**晚到**：电脑睡眠或者 moqi 没在跑时，提醒会晚发。晚到超过 30 分钟的作为普通提议过关。它的价值 0.85 低于免打扰的放行线 0.9，紧急程度也不是 `now`，所以电脑半夜醒来时，不会冒出一串白天的提醒。

### 4.2 `decide()` 的例外

- `Offer` 加可选字段 `readonly userTimed?: true`，表示用户要求在这个时间被告知。
- `decide()` 第一条判断：`offer.userTimed` 为真时，直接返回 `{ surface: "notify", reason: "你定的时间到了" }`。静音、`whenever`、门槛、免打扰、每日额度都不看。
- `State` 处理 `offer.delivered` 时，`userTimed` 的提议不计入 `notifiedPerDay`，所以不占每日额度。
- 只有 `todo.remind` 会设置 `userTimed`。其他 agent 通过 `moqi_tell` 发来的消息不能设置它。

### 4.3 晚间回顾

- 新选项 `MoqiOptions.todoReviewAt`，本地 `"HH:MM"`，默认 `"21:00"`，`null` 表示关闭。配置文件里的同名字段写法照搬 `briefingAt`。
- `tick()` 里的 `maybeReviewTodos(now)`：当天本地时间过了 `todoReviewAt`，当天还没有 `todo.review` 类的提议，而且今天还有未完成的待办（包括顺延过来的），就发一条：
  - `kind: "todo.review"`
  - `title`：`今天还有 3 件没做完`
  - `body`：逐条列出，每行 `· 交报告（已拖 2 天）`
  - `value: 0.7`，`urgency: "today"`，`expiresAt`：当天本地 24:00
  - 没有 `action`，也不带 `userTimed`，走正常关卡
- 每天最多一条。今天的都做完了就不发。

### 4.4 简报

- `composeBriefing` 增加"今天要做"一段：今天和顺延过来的未完成待办，定了时间的按时间排在前面，其余按创建时间排在后面。每行格式：`15:00 交报告（已拖 2 天）`、`买牛奶`。
- 现有"替你留意"一段排除 `todo.remind` 和 `todo.review`，避免同一件事出现两次。
- "今天要做"有内容时，计入 `Briefing.sections`。

### 4.5 心思（reflection）

`reflect.ts` 组织提示词时，加入今天和顺延过来的未完成待办，带上已拖天数。要不要建议拆开或放弃，由心思判断，不另写规则。

## 5. 工具（`tools.ts`）

| 工具          | 参数                                                                                     | `effect` / 自主级别           |
| ------------- | ---------------------------------------------------------------------------------------- | ----------------------------- |
| `todo_add`    | `text`；`day?`：`today`、`tomorrow` 或 `YYYY-MM-DD`，默认今天；`at?`：`HH:MM`；`inMinutes?`：1 到 1440 | write，`start`/`cap` 都是 `auto` |
| `todo_list`   | 无                                                                                       | read                          |
| `todo_done`   | `id`                                                                                     | write，`auto`                 |
| `todo_update` | `id`，以及要改的 `text?`、`day?`、`at?: string \| null`、`inMinutes?`                     | write，`auto`                 |
| `todo_remove` | `id`                                                                                     | write，默认 `suggest`（先问） |

规则：

- `at` 和 `inMinutes` 只能填一个。`at` 结合 `day` 得出 `remindAt`；`inMinutes` 从现在算起，同时把 `day` 设为提醒时刻所在的那天。
- `validate` 拒绝：过去的提醒时间（允许 1 分钟误差）、格式不对的日期或时间、`at` 和 `inMinutes` 同时填、未完成已满 100 条、`id` 不存在、对已完成的待办再调 `todo_done`。
- `todo_list` 返回三部分，每条带 id：今天（含顺延，标已拖天数和提醒时间）、以后、今天完成的。
- `todo_list` 加入托管事务和习惯识别的排除名单，和 `list_memories`、`watch_list` 一样。
- 工具描述写明：用户说"提醒我"时用 `todo_add` 加 `at` 或 `inMinutes`；"每天"、"每周"这类周期提醒仍然用 `watch_create`。

## 6. 控制台

### 6.1 接口（`src/node/console/server.ts`）

| 接口                     | 请求体                         | 说明                                               |
| ------------------------ | ------------------------------ | -------------------------------------------------- |
| `GET /api/state`         |                                | 增加 `todos`：今天、以后、7 天内完成的，带已拖天数 |
| `POST /api/todo/add`     | `{ text, day?, at?, by? }`     | 和 `todo_add` 用同一套校验                         |
| `POST /api/todo/done`    | `{ id }`                       |                                                    |
| `POST /api/todo/undone`  | `{ id }`                       |                                                    |
| `POST /api/todo/remove`  | `{ id }`                       | 控制台上点删除就是用户的明确操作，不再二次确认     |

参数不对时返回 400，带和工具一样的中文原因。

### 6.2 页面（`src/node/console/assets/`）

- 新页签"待办"，放在"对话"和"动态"之间，角标显示今天未完成的件数，做法和"动态"的角标一样。
- 顶部一行输入框，加可选的日期和时间选择器，回车添加。控制台不调模型，自然语言请到对话里说。
- 三栏："今天"（拖过来的带"已拖 N 天"，定了时间的显示时间，其他 agent 加的显示"Kiro 加的"）、"以后"、"最近完成"（可以撤销）。每条有勾选框和删除按钮。
- 动态里：`todo.remind` 卡片的"接受"按钮改叫"完成"，并去掉"静音"；`todo.review` 卡片加"打开待办"按钮，切到待办页签。
- 设置页加"晚间回顾"：一个开关和一个时间输入，写入 `todoReviewAt`，保存后立即生效。

### 6.3 配置（`src/node/config.ts`）

- 新字段 `todoReviewAt: string | null`，默认 `"21:00"`，校验 `HH:MM`。
- 已有的配置文件没有这个字段时，按默认值处理。

## 7. MCP（`src/node/mcp.ts`）

新工具 `moqi_todo`：

- 参数：`text`（必填，最多 200 字）、`day`、`at`，含义同 `todo_add`。
- 调用 `POST /api/todo/add`，`by` 取 MCP 握手时的客户端名字，和 `moqi_tell` 一样。
- 返回 `已加进用户的待办：明天 15:00 提醒「review PR #12」`。
- `readOnly: false`。

其他 agent 读待办用现有的 `moqi_briefing`，因为简报里已经有"今天要做"。这一版不提供勾掉或删除。

## 8. 出错处理

- 参数错误：工具把原因返回给模型自己修正，不拿去问用户；控制台接口返回 400。
- 系统通知失败：`desktopNotifier` 已经吞掉错误，提醒仍然在动态里。
- 旧日志没有待办事件，重放后待办为空，不需要迁移。
- 改了提醒时间（`todo.updated` 带 `remindAt`）会清掉 `remindedAt`，新的时间到了会再提醒一次。

## 9. 测试

新建 `test/todo.test.ts`，用 `harness` 和 `fakeClock`（时区 Asia/Shanghai）：

- 跨天自动顺延，已拖天数正确；`todo_update` 改 `day` 后拖延天数清零。
- 提醒到点只发一次；用 `State.from(events)` 重放后建的新 `Moqi` 再 `tick()` 也不会重发。
- 23:00 的提醒在免打扰时段照样 `notify`。
- 当天 3 次额度用完后，提醒照样 `notify`；提醒不计入 `notifiedOn`，之后的普通提议照常判断。
- 晚到 30 分钟以上的提醒不带 `userTimed`，落在免打扰时段时进动态。
- 在 `todo.remind` 上 `feedback(id, "accepted")` 会勾掉对应待办。
- 晚间回顾：有未完成的待办才发；同一天只发一条；`todoReviewAt: null` 时不发；"以后"的待办不算。
- 简报有"今天要做"和已拖天数；"替你留意"里没有 `todo.*`。
- `validate`：过去的时间、错误的日期格式、`at` 和 `inMinutes` 同时填、第 101 条，都被拒绝。
- 用 `scriptedModel` 模拟对话调用 `todo_add`（带 `inMinutes: 30`），`asked` 为空，`remindAt` 为 30 分钟后。

补充现有测试：

- `test/proactive.test.ts`：`decide()` 对 `userTimed` 的例外。
- `test/console.test.ts`：四个新接口，`/api/state` 里的 `todos`，400 的情况。
- `test/mcp.test.ts`：`moqi_todo` 出现在 `tools/list` 里，`by` 取自握手名字。
- `test/reflect.test.ts`：提示词里有未完成的待办和已拖天数。
- `test/architecture.test.ts` 不改，`src/core/todo.ts` 只依赖 `./` 下的文件和 zod。

完成标准：`pnpm check`（typecheck、biome、build 加 vitest）全部通过。

## 10. 文档

- `README.md`、`README.zh-CN.md`：功能说明、控制台页签、MCP 工具表加 `moqi_todo`、配置示例加 `todoReviewAt`。
- `docs/design.md` 第 4 节加"待办"一小节，写明 `userTimed` 是送达规则的唯一例外，理由是免打扰和额度管的是 moqi 自己开口，用户亲口定的时间本身就是同意被打扰。
- `CHANGELOG.md` 的 Unreleased 下加一条。

## 11. 不做

- 重复待办：周期提醒继续用托管事务的 `remind`。
- 通知上的按钮：macOS 的 `osascript` 通知做不到。
- 控制台里改文字或改期：通过对话完成。
- 优先级、标签、子任务。
- 和系统"提醒事项"App 或日历同步。
- 其他 agent 勾掉或删除待办。
