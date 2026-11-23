# 每日待办设计

> 2026-11-23 定稿。实现以代码和测试为准。

## 1. 目标

让 moqi 像助理一样管你每天要做的事：

- 待办可以不带时间，只进清单和早上的简报；带时间的到点提醒。
- 用户亲口定的提醒时间到点必达。
- 每晚回顾一次今天没做完的事；没做完的自动顺延，标出已拖几天。
- 待办可以从对话、控制台和其他 agent（MCP）加进来。
- 待办也是 moqi 了解用户、改进自己的材料：听出对话里没说出口的待办，把每天重复加的待办变成周期提醒，从完成和拖延里总结经验（第 12 节）。

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
  /** 谁加的。不填是用户本人；"moqi" 是 moqi 从对话里听出来、用户点了同意的；其他 agent 填它握手时报的名字，例如 "kiro-cli"。 */
  readonly by?: string;
  readonly createdAt: number;
  readonly doneAt?: number;
  /** 删除的时间。删掉的待办留在 State 里供复盘，所有视图都不显示。 */
  readonly removedAt?: number;
  /** 提醒发出的时间，保证一个提醒时间只提醒一次。 */
  readonly remindedAt?: number;
}
```

### 3.2 事件（加进 `EventBody`）

| 事件            | 字段                                                        | 作用                                                                                            |
| --------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `todo.added`    | `todo: Todo`                                                | 新建                                                                                            |
| `todo.updated`  | `todoId`，以及 `text?`、`day?`、`remindAt?: number \| null` | 改文字、改期、改提醒时间。`remindAt` 只要出现在事件里，就清掉 `remindedAt`；`null` 表示去掉提醒 |
| `todo.done`     | `todoId`                                                    | 勾掉，记 `doneAt`                                                                               |
| `todo.undone`   | `todoId`                                                    | 撤销勾选，清掉 `doneAt`                                                                         |
| `todo.removed`  | `todoId`                                                    | 删除，记 `removedAt`                                                                            |
| `todo.reminded` | `todoId`                                                    | 提醒已发出，记 `remindedAt`                                                                     |

`State` 折叠出 `readonly todos = new Map<string, Todo>()`。`todo.done` 和 `todo.removed` 也计入 `feedbackCount`：完成和删掉都是用户的反应，攒够了就触发复盘（第 12.3 节）。

### 3.3 顺延和已拖天数

- 不需要半夜跑任务。未完成且 `day` 早于今天的待办，算作今天的。
- 已拖天数 = 今天的本地日期减去 `day`，按日历天数计算。
- 自动顺延不改 `day`，所以拖延天数会累积。用户主动改期会改 `day`，拖延天数随之清零。

### 3.4 "以后"的待办

`day` 晚于今天的待办，不进今天的清单、简报和晚间回顾。到了那一天，当天早上的简报会列出它。控制台把它们单独列在"以后"一栏。

### 3.5 上限

- 未完成的待办最多 100 条。超出时 `todo_add` 和控制台接口都返回"未完成的待办已经有 100 条了，先清理一些"。
- 已完成和已删除的留在日志和 `State` 里。控制台只显示 7 天内完成的，删除的不显示。

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

`reflect.ts` 组织提示词时，加入今天和顺延过来的未完成待办，带上已拖天数。要不要建议拆开或放弃，由心思判断，不另写规则。心思还能从对话里听出待办，见第 12.1 节。

## 5. 工具（`tools.ts`）

| 工具          | 参数                                                                                                   | `effect` / 自主级别              |
| ------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `todo_add`    | `text`；`day?`：`today`、`tomorrow` 或 `YYYY-MM-DD`，默认今天；`at?`：`HH:MM`；`inMinutes?`：1 到 1440 | write，`start`/`cap` 都是 `auto` |
| `todo_list`   | 无                                                                                                     | read                             |
| `todo_done`   | `id`                                                                                                   | write，`auto`                    |
| `todo_update` | `id`，以及要改的 `text?`、`day?`、`at?: string \| null`、`inMinutes?`                                  | write，`auto`                    |
| `todo_remove` | `id`                                                                                                   | write，默认 `suggest`（先问）    |

规则：

- `at` 和 `inMinutes` 只能填一个。`at` 结合 `day` 得出 `remindAt`；`inMinutes` 从现在算起，同时把 `day` 设为提醒时刻所在的那天。
- `validate` 拒绝：过去的提醒时间（允许 1 分钟误差）、格式不对的日期或时间、`at` 和 `inMinutes` 同时填、未完成已满 100 条、`id` 不存在、对已完成的待办再调 `todo_done`。
- `todo_list` 返回三部分，每条带 id：今天（含顺延，标已拖天数和提醒时间）、以后、今天完成的。
- `todo_list` 加入托管事务和习惯识别的排除名单，和 `list_memories`、`watch_list` 一样。
- `todo_add` 另有可选参数 `by`，描述写"不用填"。只有心思生成的提议动作会填 `"moqi"`；对话里模型就算填了也只影响显示，不影响权限。
- 工具描述写明：用户说"提醒我"时用 `todo_add` 加 `at` 或 `inMinutes`；"每天"、"每周"这类周期提醒仍然用 `watch_create`。

## 6. 控制台

### 6.1 接口（`src/node/console/server.ts`）

| 接口                    | 请求体                     | 说明                                               |
| ----------------------- | -------------------------- | -------------------------------------------------- |
| `GET /api/state`        |                            | 增加 `todos`：今天、以后、7 天内完成的，带已拖天数 |
| `POST /api/todo/add`    | `{ text, day?, at?, by? }` | 和 `todo_add` 用同一套校验                         |
| `POST /api/todo/done`   | `{ id }`                   |                                                    |
| `POST /api/todo/undone` | `{ id }`                   |                                                    |
| `POST /api/todo/remove` | `{ id }`                   | 控制台上点删除就是用户的明确操作，不再二次确认     |

参数不对时返回 400，带和工具一样的中文原因。

### 6.2 页面（`src/node/console/assets/`）

- 新页签"待办"，放在"对话"和"动态"之间，角标显示今天未完成的件数，做法和"动态"的角标一样。
- 顶部一行输入框，加可选的日期和时间选择器，回车添加。控制台不调模型，自然语言请到对话里说。
- 三栏："今天"（拖过来的带"已拖 N 天"，定了时间的显示时间，其他 agent 加的显示"Kiro 加的"，`by` 是 `"moqi"` 的显示"moqi 听出来的"）、"以后"、"最近完成"（可以撤销）。每条有勾选框和删除按钮。
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
- `test/reflect.test.ts`：提示词里有未完成的待办和已拖天数；第 12.1 节的听出待办。
- `test/study.test.ts`：第 12.3 节的复盘材料和触发。
- `test/architecture.test.ts` 不改，`src/core/todo.ts` 只依赖 `./` 下的文件和 zod。

完成标准：`pnpm check`（typecheck、biome、build 加 vitest）全部通过。

## 10. 文档

- `README.md`、`README.zh-CN.md`：功能说明、控制台页签、MCP 工具表加 `moqi_todo`、配置示例加 `todoReviewAt`。
- `docs/design.md` 第 4 节加"待办"一小节，写明 `userTimed` 是送达规则的唯一例外，理由是免打扰和额度管的是 moqi 自己开口，用户亲口定的时间本身就是同意被打扰。
- `docs/design.md` 第 5 节"越用越懂"加上第 12 节的三个闭环。
- `CHANGELOG.md` 的 Unreleased 下加一条。

## 11. 不做

- 重复待办：周期提醒继续用托管事务的 `remind`。
- 通知上的按钮：macOS 的 `osascript` 通知做不到。
- 控制台里改文字或改期：通过对话完成。
- 优先级、标签、子任务。
- 和系统"提醒事项"App 或日历同步。
- 其他 agent 勾掉或删除待办。

## 12. 越用越懂，自己变好

三个闭环都套用 moqi 已有的机制（心思、习惯识别、自学复盘），不新增后台任务。

### 12.1 听出来的待办（`todo.capture`）

用户在对话里说"明天下午要交报告"，没说"提醒我"，moqi 也应该接住。这是"不要我去问"在待办上的样子。

- 心思的 `serve` 点子可以带 `todo` 字段：`{"text":"交报告","day":"tomorrow","at":"14:00"}`。
- 心思的 SYSTEM 提示加一句：用户在对话里提到自己要做、但待办里还没有的事，出一个 `serve`，title 写成一句问话（"要我明天 14:00 提醒你交报告吗？"），填 `todo`。
- `reflect()` 处理带 `todo` 的 `serve`：
  1. 参数加上 `by: "moqi"`，用 `checkTool("todo_add", …)` 校验。不通过就退回普通 `serve` 点子，不带动作，和 `watch` 校验失败的处理一样。
  2. 和未完成的待办比较：`normalize` 后相同，或者 `commonRun` 达到较短一方的 60%，就跳过，`skipped` 记"待办里已经有了"。
  3. 通过的发成 `kind: "todo.capture"` 的提议，动作是 `todo_add`。同时带了 `todo` 和 `watch` 时，以 `todo` 为准。
- 单独用 `todo.capture` 这个类型，是为了让它的门槛单独学：你总是拒绝，moqi 就少听；你常接受，它就更敢提。
- 一周内重复的判断沿用 `repeated()`，按 `todo.capture` 类型比较。
- 点"接受"后加进待办，`by` 是 `"moqi"`，控制台显示"moqi 听出来的"。

### 12.2 加了三次，第四次不用加（`todo.routine`）

和现有的习惯识别同一个思路："问了三次，第四次不用问"。

- `todo.ts` 里的纯函数 `findRepeatedTodos(state, now)`：取最近 14 天内创建的待办（包括已完成和已删除的），按 `normalize(text)` 分组。一组的 `day` 覆盖 3 个或以上不同的日子，就算一个习惯。
- 提醒时间：组里一半以上带 `remindAt` 时，取提醒时刻（当天分钟数）的中位数；否则取创建时刻的中位数，向下取整到 15 分钟。
- `tick()` 里在 `offerRoutines` 之后发提议：
  - `kind: "todo.routine"`，`title`：`以后每天提醒你「写日报」？`
  - `body`：`这 3 天你每天都加了这一条。接受后每天 18:00 提醒你，不用再加。`
  - `value: 0.6`，`urgency: "whenever"`
  - `action`：`watch_create`，参数 `{ title, schedule: { every: "day", at }, remind: text, routineKey: "todo:<normalize 后的文字>" }`
- 每个习惯只提一次：已经有同样 `routineKey` 的提议，或者已经有提醒文字 `normalize` 后相同的托管事务，就不再提。
- 只识别"每天"。每周一次的需要更长的观察窗口，这一版不做。

### 12.3 从完成和拖延里复盘（自己变好）

moqi 已有的复盘（`study.ts` 的 `reviewLessons`）只看用户对提议的反应。待办告诉它的更多：哪些时段的提醒管用，哪类事总是拖，听出来的待办是不是真的会做。

- `todo.ts` 里的纯函数 `todoStats(state, now)`，统计最近 14 天，输出一段中文：
  - 加了几条（自己加的、moqi 听出来的、其他 agent 加的分开计数），完成几条，删掉几条，还开着几条；
  - 当天完成的几条；拖过才完成的，平均拖了几天；
  - 定了时间的提醒按时段（上午 12 点前、下午 12 到 18 点、晚上 18 点后）分别列出：提醒几次，提醒后 2 小时内完成几次；
  - 最近完成的 5 条，拖得最久的 3 条（文字和已拖天数）。
- `reviewLessons` 的输入加一节"## 待办的情况（最近 14 天）"，内容就是 `todoStats` 的输出；没有待办时省略。
- `LESSONS_SYSTEM` 的例子加一条：「晚上 8 点后的提醒，用户多半拖到第二天；提醒尽量定在下午」。
- `todo.done` 和 `todo.removed` 计入 `feedbackCount`（第 3.2 节），所以用户勾掉或删掉几件事之后，下一次自学就会复盘。
- 复盘得出的经验照旧进入对话和心思的提示词，也在控制台「记忆」页显示，可以删除。
- 对话的 GUIDE 加两句：
  - 用户要你"提醒我"某件事，用 `todo_add` 并填 `at` 或 `inMinutes`；"每天"、"每周"这类周期提醒用 `watch_create`。
  - 用户加待办没说时间时，照「你总结的经验」建议一个时间，问一句，用户同意再用 `todo_update` 填上。

这样形成闭环：用户怎么处理待办 → 复盘成经验 → 经验改变 moqi 提议的时间和方式 → 用户的新反应再进入下一次复盘。

### 12.4 测试

- `test/reflect.test.ts`：带 `todo` 的 `serve` 点子变成 `todo.capture` 提议，接受后待办的 `by` 是 `"moqi"`；和已有待办重复时跳过，`skipped` 是"待办里已经有了"；`todo` 参数无效时退回普通点子，不带动作。
- `test/todo.test.ts`：3 个不同日子加了同样文字的待办，`tick()` 发一条 `todo.routine`，接受后生成每天的 `remind` 托管事务；只有 2 天时不发；同一个习惯不提第二次；已有同样提醒的托管事务时不发。
- `test/study.test.ts`：复盘的输入里有"待办的情况"和按时段的统计；勾掉 3 件待办后 `lessonsDue` 为真。
