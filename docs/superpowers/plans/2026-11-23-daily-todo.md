# 每日待办 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 moqi 加上每日待办：清单、到点必达的提醒、晚间回顾、自动顺延，并让待办进入 moqi 的三个学习闭环（听出待办、重复变周期提醒、复盘完成和拖延）。

**Architecture:** 待办放进内核，和托管事务同级。`src/core/todo.ts` 只放纯函数，事件进 `types.ts`，`State` 折叠出 `todos`；`Moqi.tick()` 负责提醒、回顾和习惯识别；`decide()` 对 `userTimed` 的提议开唯一的例外。外层是控制台页签、接口和 MCP 工具。

**Tech Stack:** TypeScript（strict、`noUncheckedIndexedAccess`）、zod 4、vitest 5（`TZ=Asia/Shanghai`）、biome 2、无框架的控制台页面。

**Spec:** `docs/superpowers/specs/2026-11-23-daily-todo-design.md`

## Global Constraints

- `src/core` 只能 import `./*.js`、`taugraph`、`zod`；不能用 `process.`、`Buffer`、`require(`（`test/architecture.test.ts` 检查）。
- 运行时依赖仍然只有 `taugraph` 和 `zod`。
- 面向用户的文字用简体中文；代码注释用英文，和现有代码一致。
- 未完成的待办最多 100 条；待办文字最多 200 字。
- 晚到超过 30 分钟的提醒不再是 `userTimed`；准时的提醒 `value: 0.9`、`urgency: "now"`，晚到的 `value: 0.85`、`urgency: "today"`。
- `todoReviewAt` 默认 `"21:00"`，`null` 关闭。
- 每个任务结束时 `pnpm typecheck && pnpm lint` 通过；最后 `pnpm check` 全部通过。biome 也格式化 Markdown，改了 `.md` 先跑 `pnpm exec biome check --write <文件>`。
- 测试命令：`pnpm build && TZ=Asia/Shanghai pnpm exec vitest run <文件>`（MCP 测试依赖 `dist`，所以先 build）。

## File Structure

| 文件                                     | 职责                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/core/todo.ts`（新）                 | 待办的纯函数：日期解析、列表、描述、提醒和回顾的提议、简报段落、心思上下文、习惯、统计    |
| `src/core/types.ts`                      | `Todo` 类型、`todo.*` 事件、`Offer.userTimed`                                             |
| `src/core/state.ts`                      | 折叠 `todos`，完成和删除计入 `feedbackCount`，`userTimed` 不计每日通知                    |
| `src/core/tools.ts`                      | `todo_add`、`todo_list`、`todo_done`、`todo_undone`（隐藏）、`todo_update`、`todo_remove` |
| `src/core/proactive.ts`                  | `decide()` 的 `userTimed` 例外                                                            |
| `src/core/moqi.ts`                       | `todoReviewAt` 选项，`tick()` 里的提醒、回顾、待办习惯                                    |
| `src/core/briefing.ts`                   | "今天要做"一段，"替你留意"排除提醒和回顾                                                  |
| `src/core/reflect.ts`                    | 心思看到待办，`serve` 点子可带 `todo`                                                     |
| `src/core/study.ts`                      | 复盘加入待办统计                                                                          |
| `src/core/agent.ts`                      | 对话 GUIDE                                                                                |
| `src/core/index.ts`                      | 导出 `todo.ts`                                                                            |
| `src/node/config.ts`、`src/node/home.ts` | `todoReviewAt` 配置                                                                       |
| `src/node/console/server.ts`             | `/api/state` 的 `todos`，四个 `/api/todo/*` 接口                                          |
| `src/node/console/assets/*`              | 待办页签、动态卡片、设置项                                                                |
| `src/node/mcp.ts`                        | `moqi_todo`                                                                               |
| `test/todo.test.ts`（新）                | 待办的单元和流程测试                                                                      |
| 文档                                     | `README.md`、`README.zh-CN.md`、`docs/design.md`、`CHANGELOG.md`                          |

---

### Task 1: 数据模型和日期

**Files:**

- Create: `src/core/todo.ts`
- Modify: `src/core/types.ts`、`src/core/state.ts`、`src/core/index.ts`
- Test: `test/todo.test.ts`（新）

**Interfaces:**

- Produces: `Todo`；事件 `todo.added | todo.updated | todo.done | todo.undone | todo.removed | todo.reminded`；`Offer.userTimed?: true`；`State.todos: Map<string, Todo>`；`TODO`、`TODO_KIND`、`WhenInput`、`TodoChange`、`resolveWhen(input, now)`、`todoChange(t, input, now)`、`isOpen(t)`、`openTodos(state)`、`todayTodos(state, now)`、`laterTodos(state, now)`、`recentlyDone(state, now)`、`dueReminders(state, now)`、`daysLate(t, now)`、`daysBetween(from, to)`、`timeOf(at)`、`dayLabel(day, now)`、`describeTodo(t, now)`、`describeAdded(t, now)`、`endOfDay(now)`。

- [ ] **Step 1: 写失败的测试** `test/todo.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { State } from "../src/core/state.js";
import { daysLate, describeTodo, laterTodos, resolveWhen, todayTodos, todoChange } from "../src/core/todo.js";
import type { EventBody, MoqiEvent, Todo } from "../src/core/types.js";

const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-11-20T10:00:00+08:00"); // a Friday
const todo = (over: Partial<Todo> = {}): Todo => ({
  id: "t_1",
  text: "交报告",
  day: "2026-11-20",
  createdAt: NOW,
  ...over,
});
let n = 0;
const ev = (body: EventBody, when = NOW) => ({ ...body, id: `e_${++n}`, at: when }) as MoqiEvent;

describe("when a todo is for", () => {
  it("reads today, tomorrow, a date, a time and minutes from now", () => {
    expect(resolveWhen({}, NOW)).toEqual({ day: "2026-11-20" });
    expect(resolveWhen({ day: "tomorrow", at: "15:00" }, NOW)).toEqual({
      day: "2026-11-21",
      remindAt: at("2026-11-21T15:00:00+08:00"),
    });
    expect(resolveWhen({ day: "2026-11-25" }, NOW)).toEqual({ day: "2026-11-25" });
    expect(resolveWhen({ inMinutes: 30 }, NOW)).toEqual({ day: "2026-11-20", remindAt: NOW + 30 * 60_000 });
    expect(resolveWhen({ inMinutes: 15 * 60 }, NOW)).toEqual({ day: "2026-11-21", remindAt: NOW + 15 * 3_600_000 });
    expect(resolveWhen({ at: "10:00" }, NOW + 30_000)).toEqual({ day: "2026-11-20", remindAt: NOW }); // "now" is fine
  });

  it("says what is wrong instead of guessing", () => {
    expect(resolveWhen({ day: "next week" }, NOW)).toBe("day 要写成 today、tomorrow 或 YYYY-MM-DD");
    expect(resolveWhen({ day: "2026-02-30" }, NOW)).toBe("day 要写成 today、tomorrow 或 YYYY-MM-DD");
    expect(resolveWhen({ day: "2026-11-19" }, NOW)).toBe("2026-11-19 已经过去了");
    expect(resolveWhen({ at: "25:00" }, NOW)).toBe("at 要写成 HH:MM，例如 15:00");
    expect(resolveWhen({ at: "09:00" }, NOW)).toBe("今天 09:00 已经过了");
    expect(resolveWhen({ at: "15:00", inMinutes: 5 }, NOW)).toBe("at 和 inMinutes 只能填一个");
  });
});

describe("todos in the state", () => {
  it("are added, changed, done, undone and removed by events, and deleted ones stay for review", () => {
    const s = State.from([
      ev({ type: "todo.added", todo: todo({ remindAt: at("2026-11-20T15:00:00+08:00") }) }),
      ev({ type: "todo.reminded", todoId: "t_1" }),
      ev({ type: "todo.updated", todoId: "t_1", text: "交季度报告", remindAt: at("2026-11-20T16:00:00+08:00") }),
    ]);
    expect(s.todos.get("t_1")).toMatchObject({ text: "交季度报告", remindAt: at("2026-11-20T16:00:00+08:00") });
    expect(s.todos.get("t_1")?.remindedAt).toBeUndefined(); // a new time is reminded again
    s.apply(ev({ type: "todo.updated", todoId: "t_1", remindAt: null }));
    expect(s.todos.get("t_1")?.remindAt).toBeUndefined();
    s.apply(ev({ type: "todo.done", todoId: "t_1" }, NOW + 1000));
    expect(s.todos.get("t_1")?.doneAt).toBe(NOW + 1000);
    s.apply(ev({ type: "todo.undone", todoId: "t_1" }));
    expect(s.todos.get("t_1")?.doneAt).toBeUndefined();
    s.apply(ev({ type: "todo.removed", todoId: "t_1" }, NOW + 2000));
    expect(s.todos.get("t_1")?.removedAt).toBe(NOW + 2000);
    expect(todayTodos(s, NOW)).toEqual([]);
    expect(s.feedbackCount).toBe(2); // finishing and deleting are reactions too
  });

  it("rolls unfinished todos over to today and counts the days they were put off", () => {
    const s = State.from([
      ev({ type: "todo.added", todo: todo({ id: "t_old", day: "2026-11-18" }) }),
      ev({ type: "todo.added", todo: todo({ id: "t_now", text: "开会", remindAt: at("2026-11-20T15:00:00+08:00") }) }),
      ev({ type: "todo.added", todo: todo({ id: "t_next", text: "续费", day: "2026-11-21" }) }),
    ]);
    expect(todayTodos(s, NOW).map((t) => describeTodo(t, NOW))).toEqual(["15:00 开会", "交报告（已拖 2 天）"]);
    expect(laterTodos(s, NOW).map((t) => describeTodo(t, NOW))).toEqual(["明天 续费"]);
    const old = s.todos.get("t_old") as Todo;
    expect(daysLate(old, NOW)).toBe(2);
    // Moving it is the user's plan, not putting it off: the count starts again.
    expect(todoChange(old, { day: "2026-11-23" }, NOW)).toEqual({ day: "2026-11-23" });
    expect(daysLate({ ...old, day: "2026-11-23" }, NOW)).toBe(0);
  });

  it("keeps a reminder's time of day when a todo moves to another day", () => {
    const t = todo({ remindAt: at("2026-11-20T15:00:00+08:00") });
    expect(todoChange(t, { day: "tomorrow" }, NOW)).toEqual({
      day: "2026-11-21",
      remindAt: at("2026-11-21T15:00:00+08:00"),
    });
    expect(todoChange(t, { at: null }, NOW)).toEqual({ day: "2026-11-20", remindAt: null });
    expect(todoChange(t, {}, NOW)).toBe("没有要改的");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/todo.test.ts`
Expected: FAIL，`Cannot find module '../src/core/todo.js'`。

- [ ] **Step 3: 改 `src/core/types.ts`**

在 `Offer` 的 `links` 字段之后加：

```ts
  /** The user asked to be told at this time (a todo reminder): it notifies whatever the rules, and costs no budget. */
  readonly userTimed?: true;
```

在 `// Events` 分隔注释之前加：

```ts
// ---------------------------------------------------------------------------
// Todos (待办)
// ---------------------------------------------------------------------------

/** Something the user means to do on a day, sometimes at a set time. */
export interface Todo {
  readonly id: string;
  readonly text: string;
  /** The local day it is planned for, YYYY-MM-DD. Unfinished todos from earlier days count as today's. */
  readonly day: string;
  /** When to remind the user. Without it, the todo is only on the list and in the briefing. */
  readonly remindAt?: number;
  /** Who added it: absent for the user, "moqi" for one moqi heard in conversation, else another agent's name. */
  readonly by?: string;
  readonly createdAt: number;
  readonly doneAt?: number;
  /** Deleted todos stay in the state for review; nothing shows them. */
  readonly removedAt?: number;
  /** When the reminder went out, so each reminder time is used once. */
  readonly remindedAt?: number;
}
```

在 `EventBody` 里 `watch.cancelled` 之后加：

```ts
  | { type: "todo.added"; todo: Todo }
  | { type: "todo.updated"; todoId: string; text?: string; day?: string; remindAt?: number | null }
  | { type: "todo.done"; todoId: string }
  | { type: "todo.undone"; todoId: string }
  | { type: "todo.removed"; todoId: string }
  | { type: "todo.reminded"; todoId: string }
```

- [ ] **Step 4: 改 `src/core/state.ts`**

import 里加 `Todo`。`State` 的字段里，`watches` 之后加 `readonly todos = new Map<string, Todo>();`。`feedbackCount` 的注释改成 `/** Every answer the user gave to an offer, ignoring included, and every todo they finished or deleted. */`。`offer.delivered` 里把 `if (e.surface === "notify") {` 改成 `if (e.surface === "notify" && !r.offer.userTimed) {`（Task 3 会测它）。`switch` 里 `watch.cancelled` 之后加：

```ts
      case "todo.added":
        this.todos.set(e.todo.id, e.todo);
        break;
      case "todo.updated": {
        const t = this.todos.get(e.todoId);
        if (!t) break;
        let next: Todo = {
          ...t,
          ...(e.text !== undefined && { text: e.text }),
          ...(e.day !== undefined && { day: e.day }),
        };
        if (e.remindAt !== undefined) {
          // A new reminder time is reminded again.
          const { remindAt: _old, remindedAt: _sent, ...rest } = next;
          next = e.remindAt === null ? rest : { ...rest, remindAt: e.remindAt };
        }
        this.todos.set(e.todoId, next);
        break;
      }
      case "todo.done": {
        const t = this.todos.get(e.todoId);
        if (!t || t.doneAt !== undefined || t.removedAt !== undefined) break;
        this.todos.set(e.todoId, { ...t, doneAt: e.at });
        this.feedbackCount++; // finishing something is a reaction too; enough of them start a review
        break;
      }
      case "todo.undone": {
        const t = this.todos.get(e.todoId);
        if (!t || t.doneAt === undefined) break;
        const { doneAt: _done, ...rest } = t;
        this.todos.set(e.todoId, rest);
        break;
      }
      case "todo.removed": {
        const t = this.todos.get(e.todoId);
        if (!t || t.removedAt !== undefined) break;
        this.todos.set(e.todoId, { ...t, removedAt: e.at });
        this.feedbackCount++;
        break;
      }
      case "todo.reminded": {
        const t = this.todos.get(e.todoId);
        if (t) this.todos.set(e.todoId, { ...t, remindedAt: e.at });
        break;
      }
```

- [ ] **Step 5: 新建 `src/core/todo.ts`**

```ts
// Todos: what the user means to do, on a day and sometimes at a time. Pure functions over the state;
// the Moqi class turns them into offers and events. Unfinished todos roll over by themselves: one planned
// for an earlier day counts as today's, and how many days late it is shows how long it has been put off.
import { dayKey, parseTime } from "./schedule.js";
import type { State } from "./state.js";
import type { Todo } from "./types.js";

export const TODO = {
  maxOpen: 100,
  maxText: 200,
  /** Later than this, a reminder is no longer at the time the user set: it goes through the usual rules. */
  lateMs: 30 * 60_000,
  /** A reminder time this far in the past is still taken, e.g. "now". */
  graceMs: 60_000,
  /** Done todos the console still lists. */
  doneShownMs: 7 * 86_400_000,
  /** The evening review is sent within this long after its time, not later in the night. */
  reviewWindowMs: 2 * 3_600_000,
  /** The same todo on this many different days becomes a daily reminder offer. */
  routineDays: 3,
  /** How far back repeats and statistics look. */
  windowMs: 14 * 86_400_000,
  /** A reminder counts as working when the todo is done within this long after it. */
  doneSoonMs: 2 * 3_600_000,
} as const;

/** Offer kinds about todos. Each learns its own threshold from the user's reactions. */
export const TODO_KIND = {
  remind: "todo.remind",
  review: "todo.review",
  capture: "todo.capture",
  routine: "todo.routine",
} as const;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight of a YYYY-MM-DD day, or undefined when it is not a real date. */
function dayStart(day: string): number | undefined {
  const m = DAY.exec(day);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dayKey(d.getTime()) === day ? d.getTime() : undefined;
}

/** Whole calendar days from one YYYY-MM-DD day to another. */
export function daysBetween(from: string, to: string): number {
  const a = dayStart(from);
  const b = dayStart(to);
  return a === undefined || b === undefined ? 0 : Math.round((b - a) / 86_400_000);
}

export function endOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

export function timeOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "今天", "明天", or "11月25日". */
export function dayLabel(day: string, now: number): string {
  const diff = daysBetween(dayKey(now), day);
  if (diff === 0) return "今天";
  if (diff === 1) return "明天";
  const m = DAY.exec(day);
  return m ? `${Number(m[2])}月${Number(m[3])}日` : day;
}

export function isOpen(t: Todo): boolean {
  return t.doneAt === undefined && t.removedAt === undefined;
}

/** How many days an unfinished todo has been put off; 0 for today's and later ones. */
export function daysLate(t: Todo, now: number): number {
  return Math.max(0, daysBetween(t.day, dayKey(now)));
}

export function openTodos(state: State): Todo[] {
  return [...state.todos.values()].filter(isOpen);
}

const byTime = (a: Todo, b: Todo) =>
  (a.remindAt ?? Number.POSITIVE_INFINITY) - (b.remindAt ?? Number.POSITIVE_INFINITY) || a.createdAt - b.createdAt;

/** Unfinished todos for today, the rolled-over ones included: timed first, by time, then the rest. */
export function todayTodos(state: State, now: number): Todo[] {
  const today = dayKey(now);
  return openTodos(state)
    .filter((t) => t.day <= today)
    .sort(byTime);
}

/** Unfinished todos planned for a later day, soonest first. */
export function laterTodos(state: State, now: number): Todo[] {
  const today = dayKey(now);
  return openTodos(state)
    .filter((t) => t.day > today)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : byTime(a, b)));
}

/** Done in the last week, newest first. */
export function recentlyDone(state: State, now: number): Todo[] {
  return [...state.todos.values()]
    .filter((t) => t.doneAt !== undefined && t.removedAt === undefined && now - t.doneAt <= TODO.doneShownMs)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));
}

/** Reminders whose time has come and that have not gone out yet. */
export function dueReminders(state: State, now: number): Todo[] {
  return openTodos(state)
    .filter((t) => t.remindAt !== undefined && t.remindAt <= now && t.remindedAt === undefined)
    .sort(byTime);
}

/** One line for lists and prompts: "15:00 交报告（已拖 2 天）", "明天 续费". Past days' times are left out. */
export function describeTodo(t: Todo, now: number): string {
  const today = dayKey(now);
  const day = t.day > today ? `${dayLabel(t.day, now)} ` : "";
  const time = t.remindAt !== undefined && dayKey(t.remindAt) >= today ? `${timeOf(t.remindAt)} ` : "";
  const late = daysLate(t, now);
  return `${day}${time}${t.text}${late > 0 ? `（已拖 ${late} 天）` : ""}`;
}

/** For replies: "明天 15:00 提醒你「交报告」" or "今天要做「买牛奶」". */
export function describeAdded(t: Todo, now: number): string {
  const day = dayLabel(t.day, now);
  return t.remindAt !== undefined ? `${day} ${timeOf(t.remindAt)} 提醒你「${t.text}」` : `${day}要做「${t.text}」`;
}

export interface WhenInput {
  readonly day?: string | undefined;
  readonly at?: string | null | undefined;
  readonly inMinutes?: number | undefined;
}

/** Turns "tomorrow" / "15:00" / "in 30 minutes" into a day and a reminder time, or says what is wrong. */
export function resolveWhen(input: WhenInput, now: number): { day: string; remindAt?: number } | string {
  if (typeof input.at === "string" && input.inMinutes !== undefined) return "at 和 inMinutes 只能填一个";
  if (input.inMinutes !== undefined) {
    const remindAt = now + input.inMinutes * 60_000;
    return { day: dayKey(remindAt), remindAt };
  }
  const day = resolveDay(input.day ?? "today", now);
  if (day === undefined) return "day 要写成 today、tomorrow 或 YYYY-MM-DD";
  if (day < dayKey(now)) return `${day} 已经过去了`;
  if (typeof input.at !== "string") return { day };
  let hm: { hours: number; minutes: number };
  try {
    hm = parseTime(input.at.trim());
  } catch {
    return "at 要写成 HH:MM，例如 15:00";
  }
  const d = new Date(dayStart(day) ?? now);
  d.setHours(hm.hours, hm.minutes, 0, 0);
  const remindAt = d.getTime();
  if (remindAt < now - TODO.graceMs) return `${dayLabel(day, now)} ${timeOf(remindAt)} 已经过了`;
  return { day, remindAt };
}

function resolveDay(day: string, now: number): string | undefined {
  const d = day.trim().toLowerCase();
  if (d === "today" || d === "今天") return dayKey(now);
  if (d === "tomorrow" || d === "明天") {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    return dayKey(t.getTime());
  }
  return dayStart(d) === undefined ? undefined : d;
}

export interface TodoChange {
  text?: string;
  day?: string;
  remindAt?: number | null;
}

/** What an edit changes. Moving a todo to another day keeps its reminder's time of day. */
export function todoChange(
  t: Todo,
  input: WhenInput & { readonly text?: string | undefined },
  now: number,
): TodoChange | string {
  const change: TodoChange = {};
  if (input.text !== undefined) change.text = input.text;
  if (input.at !== undefined || input.inMinutes !== undefined || input.day !== undefined) {
    const keepTime = input.at === undefined && input.inMinutes === undefined && t.remindAt !== undefined;
    const w = resolveWhen(
      {
        day: input.day ?? (t.day < dayKey(now) ? "today" : t.day),
        at: keepTime && t.remindAt !== undefined ? timeOf(t.remindAt) : input.at,
        inMinutes: input.inMinutes,
      },
      now,
    );
    if (typeof w === "string") return w;
    change.day = w.day;
    if (w.remindAt !== undefined) change.remindAt = w.remindAt;
    else if (input.at === null) change.remindAt = null;
  }
  return Object.keys(change).length === 0 ? "没有要改的" : change;
}
```

- [ ] **Step 6: 导出** 在 `src/core/index.ts` 的 `export * from "./types.js";` 之前加 `export * from "./todo.js";`。

- [ ] **Step 7: 跑测试确认通过**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/todo.test.ts && pnpm typecheck && pnpm format && pnpm lint`
Expected: 6 个测试 PASS；typecheck、lint 无错。

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/core/state.ts src/core/todo.ts src/core/index.ts test/todo.test.ts
git commit -m "feat(todo): todos in the log and state, with days that roll over"
```

---

### Task 2: 待办工具和对话

**Files:**

- Modify: `src/core/tools.ts`、`src/core/moqi.ts`（两处排除名单）、`src/core/agent.ts`（GUIDE）
- Test: `test/todo.test.ts`

**Interfaces:**

- Consumes: Task 1 的 `TODO`、`resolveWhen`、`todoChange`、`describeAdded`、`describeTodo`、`openTodos`、`todayTodos`、`laterTodos`、`recentlyDone`。
- Produces: 工具 `todo_add {text, day?, at?, inMinutes?, by?}`（auto）、`todo_list {}`（read）、`todo_done {id}`（auto）、`todo_undone {id}`（auto，hidden）、`todo_update {id, text?, day?, at?: string|null, inMinutes?}`（auto）、`todo_remove {id}`（write，先问）。返回文字：`记下了：<describeAdded>（<id>）`、`勾掉了「<text>」，今天还剩 N 件` 或 `…，今天的都做完了`、`改好了：<describeAdded>`、`删掉了「<text>」`、`「<text>」改回没做完`。

- [ ] **Step 1: 在 `test/todo.test.ts` 追加失败的测试**

文件顶部 import 改为：

```ts
import { describe, expect, it } from "vitest";
import type { Moqi } from "../src/core/moqi.js";
import { State } from "../src/core/state.js";
import { daysLate, describeTodo, laterTodos, resolveWhen, TODO, todayTodos, todoChange } from "../src/core/todo.js";
import type { EventBody, MoqiEvent, Todo } from "../src/core/types.js";
import { call, harness, scriptedModel } from "./helpers.js";
```

在常量后加：

```ts
const add = (moqi: Moqi, args: Record<string, unknown>) => moqi.callTool("todo_add", args, { byUser: true });
const todos = (moqi: Moqi) => [...moqi.state.todos.values()];
```

文件末尾加：

```ts
describe("todo tools", () => {
  it("adds without asking, and says when", async () => {
    const { moqi, asked } = harness({ start: "2026-11-20T10:00:00+08:00" });
    expect(await add(moqi, { text: "交报告", day: "tomorrow", at: "15:00" })).toMatch(
      /^记下了：明天 15:00 提醒你「交报告」（t_/,
    );
    expect(await add(moqi, { text: "买牛奶" })).toMatch(/^记下了：今天要做「买牛奶」/);
    expect(asked).toEqual([]);
    expect(await add(moqi, { text: "开会", at: "09:00" })).toBe("参数不对：今天 09:00 已经过了");
    expect(todos(moqi).map((t) => t.text)).toEqual(["交报告", "买牛奶"]);
  });

  it("lists, ticks off, moves and deletes, and asks before deleting", async () => {
    const { moqi, asked } = harness({ start: "2026-11-20T10:00:00+08:00" });
    await add(moqi, { text: "交报告", at: "15:00" });
    await add(moqi, { text: "买牛奶" });
    await add(moqi, { text: "续费", day: "2026-11-25" });
    const [report, milk, renew] = todos(moqi) as [Todo, Todo, Todo];
    const list = () => moqi.callTool("todo_list", {}, { byUser: true });
    expect(await list()).toBe(
      `今天：\n[${report.id}] 15:00 交报告\n[${milk.id}] 买牛奶\n以后：\n[${renew.id}] 11月25日 续费`,
    );
    expect(await moqi.callTool("todo_done", { id: milk.id }, { byUser: true })).toBe("勾掉了「买牛奶」，今天还剩 1 件");
    expect(await moqi.callTool("todo_done", { id: milk.id }, { byUser: true })).toBe("参数不对：这件已经做完了");
    expect(await list()).toContain(`今天做完的：\n[${milk.id}] 买牛奶`);
    expect(await moqi.callTool("todo_undone", { id: milk.id }, { byUser: true })).toBe("「买牛奶」改回没做完");
    expect(await moqi.callTool("todo_update", { id: report.id, day: "tomorrow" }, { byUser: true })).toBe(
      "改好了：明天 15:00 提醒你「交报告」",
    );
    expect(asked).toEqual([]);
    expect(await moqi.callTool("todo_remove", { id: renew.id }, { byUser: true })).toBe("删掉了「续费」");
    expect(asked).toEqual(["要我删掉待办「续费」吗？"]);
    expect(await moqi.callTool("todo_done", { id: renew.id }, { byUser: true })).toBe(
      `参数不对：没有 ${renew.id} 这件待办`,
    );
  });

  it("caps the open list at 100", async () => {
    const { moqi } = harness();
    for (let i = 0; i < TODO.maxOpen; i++)
      moqi.emit({ type: "todo.added", todo: { id: `t_${i}`, text: `事 ${i}`, day: "2026-11-20", createdAt: 0 } });
    expect(await add(moqi, { text: "再一件" })).toBe("参数不对：未完成的待办已经有 100 条了，先清理一些");
  });

  it("takes 提醒我 in chat without asking first", async () => {
    const model = scriptedModel((r) =>
      r.messages.at(-1)?.role === "tool" ? "好，半小时后提醒你" : call("todo_add", { text: "关火", inMinutes: 30 }),
    );
    const { moqi, asked, clock } = harness({ model });
    expect(await moqi.chat("半小时后提醒我关火")).toBe("好，半小时后提醒你");
    expect(asked).toEqual([]);
    expect(todos(moqi)).toMatchObject([{ text: "关火", remindAt: clock.now() + 30 * 60_000 }]);
  });

  it("keeps the list out of watches and routines, and undoing off the model's tools", () => {
    const { moqi } = harness();
    expect(moqi.watchableTools().map((t) => t.name)).not.toContain("todo_list");
    expect(moqi.visibleTools().map((t) => t.name)).not.toContain("todo_undone");
    expect(moqi.visibleTools().map((t) => t.name)).toContain("todo_add");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/todo.test.ts`
Expected: 新测试 FAIL，返回 `没有工具 todo_add`。

- [ ] **Step 3: 在 `src/core/tools.ts` 加工具**

import 改为（`pnpm format` 会排序）：

```ts
import { dayKey, describeSchedule, nextRun, validateSchedule } from "./schedule.js";
import {
  describeAdded,
  describeTodo,
  laterTodos,
  openTodos,
  recentlyDone,
  resolveWhen,
  TODO,
  todayTodos,
  todoChange,
} from "./todo.js";
import { newId, type Schedule, type Todo, type Watch } from "./types.js";
```

在 `WatchInput` 之后加：

```ts
const When = {
  day: z.string().optional().describe("today, tomorrow or YYYY-MM-DD (local). Default today"),
  at: z.string().optional().describe("HH:MM local time to remind the user. Leave out for no reminder"),
  inMinutes: z.number().int().min(1).max(1440).optional().describe("Remind this many minutes from now, instead of at"),
};

function todoProblem(k: Kernel, id: string, mustBeOpen = true): string | undefined {
  const t = k.state.todos.get(id);
  if (!t || t.removedAt !== undefined) return `没有 ${id} 这件待办`;
  if (mustBeOpen && t.doneAt !== undefined) return "这件已经做完了";
  return undefined;
}
```

在 `builtinTools` 返回的数组里，`watch_cancel` 之后加：

```ts
    defineTool({
      name: "todo_add",
      description:
        "Put something the user means to do on their todo list, for a day (default today), and remind them at a time if they want (at, or inMinutes). Use it for 提醒我…, 记一下…, and things the user says they have to do. Repeating reminders (every day, every week) are watch_create.",
      input: z.object({
        text: z.string().trim().min(1).max(TODO.maxText),
        ...When,
        by: z.string().max(40).optional().describe("Leave out"),
      }),
      effect: "write",
      start: "auto", // the user asked for it, and it is undone with one tap
      cap: "auto",
      describe: (a) => `记下待办「${a.text}」`,
      validate: (a) => {
        if (openTodos(k.state).length >= TODO.maxOpen) return `未完成的待办已经有 ${TODO.maxOpen} 条了，先清理一些`;
        const w = resolveWhen(a, k.now());
        return typeof w === "string" ? w : undefined;
      },
      run: (a) => {
        const now = k.now();
        const w = resolveWhen(a, now);
        if (typeof w === "string") return w;
        const todo: Todo = {
          id: newId("t"),
          text: a.text,
          day: w.day,
          ...(w.remindAt !== undefined && { remindAt: w.remindAt }),
          ...(a.by && { by: a.by }),
          createdAt: now,
        };
        k.emit({ type: "todo.added", todo });
        return `记下了：${describeAdded(todo, now)}（${todo.id}）`;
      },
    }),
    defineTool({
      name: "todo_list",
      description: "The user's todo list with ids: today (including what was put off), later, and done today.",
      input: z.object({}),
      effect: "read",
      run: () => {
        const now = k.now();
        const line = (t: Todo) => `[${t.id}] ${describeTodo(t, now)}`;
        const today = todayTodos(k.state, now).map(line);
        const later = laterTodos(k.state, now).map(line);
        const done = recentlyDone(k.state, now)
          .filter((t) => t.doneAt !== undefined && dayKey(t.doneAt) === dayKey(now))
          .map((t) => `[${t.id}] ${t.text}`);
        if (today.length + later.length + done.length === 0) return "（没有待办）";
        return [
          `今天：\n${today.join("\n") || "（没有）"}`,
          later.length ? `以后：\n${later.join("\n")}` : "",
          done.length ? `今天做完的：\n${done.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    }),
    defineTool({
      name: "todo_done",
      description: "Mark one of the user's todos done, by id.",
      input: z.object({ id: z.string() }),
      effect: "write",
      start: "auto",
      cap: "auto",
      describe: ({ id }) => `勾掉「${k.state.todos.get(id)?.text ?? id}」`,
      validate: ({ id }) => todoProblem(k, id),
      run: ({ id }) => {
        const text = k.state.todos.get(id)?.text ?? id;
        k.emit({ type: "todo.done", todoId: id });
        const left = todayTodos(k.state, k.now()).length;
        return `勾掉了「${text}」${left ? `，今天还剩 ${left} 件` : "，今天的都做完了"}`;
      },
    }),
    defineTool({
      name: "todo_undone",
      description: "Mark a done todo as not done again.",
      input: z.object({ id: z.string() }),
      effect: "write",
      start: "auto",
      cap: "auto",
      hidden: true, // the console's checkbox; the model has todo_add for anything new
      validate: ({ id }) =>
        todoProblem(k, id, false) ?? (k.state.todos.get(id)?.doneAt === undefined ? "这件还没做完" : undefined),
      run: ({ id }) => {
        k.emit({ type: "todo.undone", todoId: id });
        return `「${k.state.todos.get(id)?.text ?? id}」改回没做完`;
      },
    }),
    defineTool({
      name: "todo_update",
      description:
        "Change one of the user's todos by id: its text, its day (moving it keeps the reminder's time of day), or its reminder (at, inMinutes, or at: null to drop it).",
      input: z.object({
        id: z.string(),
        text: z.string().trim().min(1).max(TODO.maxText).optional(),
        day: When.day,
        at: z.string().nullable().optional().describe("HH:MM local time to remind, or null to drop the reminder"),
        inMinutes: When.inMinutes,
      }),
      effect: "write",
      start: "auto",
      cap: "auto",
      describe: ({ id }) => `改待办「${k.state.todos.get(id)?.text ?? id}」`,
      validate: (a) => {
        const problem = todoProblem(k, a.id);
        const t = k.state.todos.get(a.id);
        if (problem || !t) return problem;
        const change = todoChange(t, a, k.now());
        return typeof change === "string" ? change : undefined;
      },
      run: (a) => {
        const now = k.now();
        const t = k.state.todos.get(a.id);
        if (!t) return `没有 ${a.id} 这件待办`;
        const change = todoChange(t, a, now);
        if (typeof change === "string") return change;
        k.emit({ type: "todo.updated", todoId: a.id, ...change });
        const after = k.state.todos.get(a.id) ?? t;
        return `改好了：${describeAdded(after, now)}`;
      },
    }),
    defineTool({
      name: "todo_remove",
      description: "Delete one of the user's todos by id, when they no longer mean to do it.",
      input: z.object({ id: z.string() }),
      effect: "write",
      describe: ({ id }) => `删掉待办「${k.state.todos.get(id)?.text ?? id}」`,
      validate: ({ id }) => todoProblem(k, id, false),
      run: ({ id }) => {
        const text = k.state.todos.get(id)?.text ?? id;
        k.emit({ type: "todo.removed", todoId: id });
        return `删掉了「${text}」`;
      },
    }),
```

- [ ] **Step 4: `src/core/moqi.ts` 的排除名单**

在 `export interface MoqiOptions` 之前加：

```ts
/** Read tools that make no sense on a schedule: they list moqi's own state. */
const UNWATCHABLE = ["list_memories", "watch_list", "todo_list"];
```

把 `isWatchable` 和 `offerRoutines` 里的 `!["list_memories", "watch_list"].includes(name)` 都改成 `!UNWATCHABLE.includes(name)`。

- [ ] **Step 5: `src/core/agent.ts` 的 GUIDE**

把 GUIDE 里 `watch_create` 那一行替换为下面三行：

```ts
- 用户要你"提醒我"某件事，或说了自己要做的事想记下，用 todo_add：到点提醒填 at（HH:MM，配合 day）或 inMinutes（几分钟后）；不说时间就只进待办清单。查改待办先用 todo_list 拿 id。
- "每天"、"每周"这类反复的提醒，或要你定时去查的事（每天的天气、某个价格），用 watch_create；有工具能查的填 tool，纯提醒填 remind。
- 用户加待办没说时间时，参照「你总结的经验」建议一个时间问一句，用户同意再用 todo_update 填上。
```

- [ ] **Step 6: 跑测试确认通过**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/todo.test.ts test/agent.test.ts test/routines.test.ts && pnpm typecheck && pnpm format && pnpm lint`
Expected: 全部 PASS。

- [ ] **Step 7: Commit**

```bash
git add src/core/tools.ts src/core/moqi.ts src/core/agent.ts test/todo.test.ts
git commit -m "feat(todo): tools to add, list, tick off, move and delete todos"
```

---

### Task 3: 到点必达的提醒

**Files:**

- Modify: `src/core/todo.ts`（`reminderOffer`）、`src/core/proactive.ts`、`src/core/moqi.ts`（`remindTodos`）
- Test: `test/todo.test.ts`、`test/proactive.test.ts`

**Interfaces:**

- Consumes: `dueReminders`、`daysLate`、`timeOf`、`dayLabel`、`endOfDay`、`TODO`、`TODO_KIND`；Task 1 里 `State` 已经让 `userTimed` 不计入 `notifiedPerDay`。
- Produces: `reminderOffer(t: Todo, now: number): OfferInput`；`decide()` 对 `userTimed` 返回 `{ surface: "notify", reason: "你定的时间到了" }`；`tick()` 每次在托管事务之后发到点的提醒，并记 `todo.reminded`。

- [ ] **Step 1: 写失败的测试**

`test/proactive.test.ts` 末尾（`describe` 内）加：

```ts
it("always lets through a reminder at the time the user set, and does not count it", async () => {
  const { moqi } = harness({ start: "2026-11-20T23:30:00+08:00" });
  await moqi.feedback((await moqi.offer(news())).id, "muted");
  const timed = { ...news({ value: 0.1, urgency: "whenever", userTimed: true }), id: "x", createdAt: 0 };
  const policy = { ...moqi.policy, dailyBudget: 0 };
  expect(decide(moqi.state, policy, timed, moqi.clock.now())).toEqual({
    surface: "notify",
    reason: "你定的时间到了",
  });
});
```

`test/todo.test.ts`：import 加 `import { Moqi } from "../src/core/moqi.js";`（替换原来的 `import type { Moqi }`），helpers 的 import 加 `DAY`。末尾加：

```ts
describe("reminders", () => {
  const news = { kind: "n", title: "新闻", body: "", value: 0.8, urgency: "today" } as const;
  const reminders = (d: { offer: { kind: string } }[]) => d.filter((x) => x.offer.kind === "todo.remind");

  it("reminds once at the time, even after a restart, and accepting ticks it off", async () => {
    const { moqi, clock, delivered } = harness({ start: "2026-11-20T14:00:00+08:00" });
    await add(moqi, { text: "交报告", at: "15:00" });
    clock.set("2026-11-20T14:59:00+08:00");
    await moqi.tick();
    expect(reminders(delivered)).toHaveLength(0);
    clock.set("2026-11-20T15:00:20+08:00");
    await moqi.tick();
    await moqi.tick();
    expect(reminders(delivered)).toEqual([
      expect.objectContaining({
        surface: "notify",
        offer: expect.objectContaining({ title: "交报告", body: "你定的 15:00", userTimed: true, urgency: "now" }),
      }),
    ]);
    const again = new Moqi({
      store: moqi.store,
      clock,
      briefingAt: null,
      reflect: false,
      study: false,
      deliver: (offer, surface) => void delivered.push({ offer, surface }),
    });
    await again.tick();
    expect(reminders(delivered)).toHaveLength(1);
    const offer = reminders(delivered)[0]?.offer as { id: string };
    expect(await again.feedback(offer.id, "accepted")).toBe("勾掉了「交报告」，今天的都做完了");
    expect(todos(again)[0]?.doneAt).toBe(clock.now());
  });

  it("reminds in quiet hours and with the day's budget spent, and costs no budget", async () => {
    const { moqi, clock, delivered } = harness({ start: "2026-11-20T10:00:00+08:00" });
    await add(moqi, { text: "开会", at: "10:30" });
    for (let i = 0; i < 4; i++) await moqi.offer(news);
    clock.set("2026-11-20T10:30:00+08:00");
    await moqi.tick();
    expect(delivered.map((d) => `${d.offer.kind}:${d.surface}`)).toEqual([
      "n:notify",
      "n:notify",
      "n:notify",
      "n:feed",
      "todo.remind:notify",
    ]);
    expect(moqi.state.notifiedOn(clock.now())).toBe(3);

    const night = harness({ start: "2026-11-20T22:00:00+08:00" });
    await add(night.moqi, { text: "吃药", at: "23:00" });
    night.clock.set("2026-11-20T23:00:00+08:00");
    await night.moqi.tick();
    const [sent] = reminders(night.delivered);
    expect(sent?.surface).toBe("notify");
    expect(night.moqi.state.offers.get((sent?.offer as { id: string }).id)?.reason).toBe("你定的时间到了");
  });

  it("treats a reminder more than half an hour late as an ordinary offer", async () => {
    const { moqi, clock, delivered } = harness({ start: "2026-11-20T14:00:00+08:00" });
    await add(moqi, { text: "交报告", at: "15:00" });
    clock.set("2026-11-20T23:10:00+08:00"); // the computer was asleep; now it is quiet hours
    await moqi.tick();
    const [late] = reminders(delivered);
    expect(late?.surface).toBe("feed");
    expect(late?.offer).toMatchObject({ body: "本来 15:00 提醒你", value: 0.85, urgency: "today" });
    expect(late?.offer).not.toHaveProperty("userTimed");
  });

  it("reminds again at a new time, and says how long it was put off", async () => {
    const { moqi, clock, delivered } = harness({ start: "2026-11-19T09:00:00+08:00" });
    await add(moqi, { text: "交报告" });
    clock.advance(DAY); // 11-20 09:00, rolled over
    const id = todos(moqi)[0]?.id as string;
    await moqi.callTool("todo_update", { id, inMinutes: 10 }, { byUser: true });
    clock.advance(10 * 60_000);
    await moqi.tick();
    await moqi.callTool("todo_update", { id, inMinutes: 5 }, { byUser: true });
    clock.advance(5 * 60_000);
    await moqi.tick();
    expect(reminders(delivered).map((d) => d.offer.body)).toEqual(["你定的 09:10", "你定的 09:15"]);
  });
});
```

说明：最后一个测试里 `todo_update` 只改时间不改日期，`todoChange` 把已拖的待办的 `day` 设为今天（用户重新安排了它），所以正文不带"已拖"。

- [ ] **Step 2: 跑测试确认失败**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/todo.test.ts test/proactive.test.ts`
Expected: FAIL，没有 `todo.remind` 提议；`decide` 返回 `drop`。

- [ ] **Step 3: `src/core/proactive.ts`**

`decide()` 的第一行（`const stats = …` 之前）加：

```ts
  // The user set this time themselves: the rules that guard against moqi's own initiative do not apply.
  if (offer.userTimed) return { surface: "notify", reason: "你定的时间到了" };
```

- [ ] **Step 4: `src/core/todo.ts` 加 `reminderOffer`**

import 加 `import type { OfferInput } from "./plugin.js";`，文件末尾加：

```ts
/** The reminder for a todo whose time has come. On time it is the user's own appointment; late, an ordinary offer. */
export function reminderOffer(t: Todo, now: number): OfferInput {
  const at = t.remindAt ?? now;
  const late = now - at > TODO.lateMs;
  const set = dayKey(at) === dayKey(now) ? timeOf(at) : `${dayLabel(dayKey(at), now)} ${timeOf(at)}`;
  const lag = daysLate(t, now);
  return {
    kind: TODO_KIND.remind,
    title: t.text,
    body: `${late ? `本来 ${set} 提醒你` : `你定的 ${set}`}${lag > 0 ? `，已拖 ${lag} 天` : ""}`,
    value: late ? 0.85 : 0.9,
    urgency: late ? "today" : "now",
    expiresAt: endOfDay(now),
    action: { tool: "todo_done", args: { id: t.id } },
    ...(!late && { userTimed: true as const }),
  };
}
```

- [ ] **Step 5: `src/core/moqi.ts`**

import 加 `import { dueReminders, reminderOffer } from "./todo.js";`。`tick()` 里 `const watchesRun = await this.runDueWatches(now);` 之后加 `await this.remindTodos(now);`。在 `runDueWatches` 之后加方法：

```ts
  /** Todos whose reminder time has come. The offer goes first: a reminder twice beats none. */
  private async remindTodos(now: number): Promise<void> {
    for (const todo of dueReminders(this.state, now)) {
      await this.offer(reminderOffer(todo, now));
      this.emit({ type: "todo.reminded", todoId: todo.id });
    }
  }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/todo.test.ts test/proactive.test.ts && pnpm typecheck && pnpm format && pnpm lint`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/core/todo.ts src/core/proactive.ts src/core/moqi.ts test/todo.test.ts test/proactive.test.ts
git commit -m "feat(todo): reminders arrive at the time the user set"
```

---

### Task 4: 晚间回顾和简报

**Files:**

- Modify: `src/core/todo.ts`（`reviewOffer`、`todoSection`）、`src/core/moqi.ts`（选项和 `maybeReviewTodos`）、`src/core/briefing.ts`
- Test: `test/todo.test.ts`、`test/briefing.test.ts`

**Interfaces:**

- Consumes: `todayTodos`、`describeTodo`、`endOfDay`、`TODO`、`TODO_KIND`。
- Produces: `reviewOffer(state, now): OfferInput | undefined`；`todoSection(state, now): BriefingSection | undefined`（标题"今天要做"）；`MoqiOptions.todoReviewAt?: string | null`（默认 `"21:00"`）。

- [ ] **Step 1: 写失败的测试**

`test/todo.test.ts` 末尾加：

```ts
describe("evening review", () => {
  const reviews = (d: { offer: { kind: string } }[]) => d.filter((x) => x.offer.kind === "todo.review");

  it("lists what is left at 21:00, once a day, and stays quiet when everything is done", async () => {
    const { moqi, clock, delivered } = harness({ start: "2026-11-20T09:00:00+08:00" });
    await add(moqi, { text: "交报告" });
    await add(moqi, { text: "买牛奶" });
    await add(moqi, { text: "续费", day: "2026-11-25" });
    clock.set("2026-11-20T20:59:00+08:00");
    await moqi.tick();
    expect(reviews(delivered)).toHaveLength(0);
    clock.set("2026-11-20T21:00:30+08:00");
    await moqi.tick();
    await moqi.tick();
    expect(reviews(delivered)).toEqual([
      expect.objectContaining({
        surface: "notify",
        offer: expect.objectContaining({
          title: "今天还有 2 件没做完",
          body: "· 交报告\n· 买牛奶\n没做完的明天接着排。",
        }),
      }),
    ]);
    clock.set("2026-11-21T10:00:00+08:00");
    for (const t of todayTodos(moqi.state, clock.now()))
      await moqi.callTool("todo_done", { id: t.id }, { byUser: true });
    clock.set("2026-11-21T21:00:00+08:00");
    await moqi.tick();
    expect(reviews(delivered)).toHaveLength(1);
  });

  it("follows the configured time, can be turned off, and is skipped late at night", async () => {
    const moved = harness({ todoReviewAt: "19:30", start: "2026-11-20T09:00:00+08:00" });
    await add(moved.moqi, { text: "交报告" });
    moved.clock.set("2026-11-20T19:30:00+08:00");
    await moved.moqi.tick();
    expect(reviews(moved.delivered)).toHaveLength(1);

    const off = harness({ todoReviewAt: null, start: "2026-11-20T09:00:00+08:00" });
    await add(off.moqi, { text: "交报告" });
    off.clock.set("2026-11-20T21:00:00+08:00");
    await off.moqi.tick();
    expect(reviews(off.delivered)).toHaveLength(0);

    const late = harness({ start: "2026-11-20T09:00:00+08:00" });
    await add(late.moqi, { text: "交报告" });
    late.clock.set("2026-11-20T23:15:00+08:00"); // moqi was off all evening
    await late.moqi.tick();
    expect(reviews(late.delivered)).toHaveLength(0);
  });
});
```

`test/briefing.test.ts` 的 `describe` 里加：

```ts
it("lists today's todos with how long each was put off, and does not repeat reminders kept in the feed", async () => {
  const { moqi, clock } = harness({ start: "2026-11-19T09:00:00+08:00" });
  const add = (args: Record<string, unknown>) => moqi.callTool("todo_add", args, { byUser: true });
  await add({ text: "交报告" });
  clock.set("2026-11-20T07:00:00+08:00");
  await add({ text: "开会", at: "15:00" });
  await add({ text: "续费", day: "tomorrow" });
  await moqi.offer({ kind: "todo.remind", title: "吃药", body: "本来 22:00 提醒你", value: 0.3, urgency: "today" });
  clock.set("2026-11-20T08:00:00+08:00");
  const b = await moqi.briefing();
  expect(b.body).toContain("【今天要做】\n· 15:00 开会\n· 交报告（已拖 1 天）");
  expect(b.body).not.toContain("续费");
  expect(b.body).not.toContain("吃药");
  expect(b.sections).toBe(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/todo.test.ts test/briefing.test.ts`
Expected: FAIL；`todoReviewAt` 是未知选项（typecheck 报错），简报里没有"今天要做"。

- [ ] **Step 3: `src/core/todo.ts` 加两个函数**

import 改为 `import type { BriefingSection, OfferInput } from "./plugin.js";`，文件末尾加：

```ts
/** The evening look at what is left today, or undefined when nothing is. */
export function reviewOffer(state: State, now: number): OfferInput | undefined {
  const open = todayTodos(state, now);
  if (open.length === 0) return undefined;
  const lines = open.slice(0, 10).map((t) => `· ${describeTodo(t, now)}`);
  if (open.length > 10) lines.push(`…还有 ${open.length - 10} 件`);
  return {
    kind: TODO_KIND.review,
    title: `今天还有 ${open.length} 件没做完`,
    body: `${lines.join("\n")}\n没做完的明天接着排。`,
    value: 0.7,
    urgency: "today",
    expiresAt: endOfDay(now),
  };
}

/** "今天要做" for the morning briefing. */
export function todoSection(state: State, now: number): BriefingSection | undefined {
  const open = todayTodos(state, now);
  return open.length ? { title: "今天要做", lines: open.map((t) => describeTodo(t, now)) } : undefined;
}
```

- [ ] **Step 4: `src/core/briefing.ts`**

import 加 `import { TODO_KIND, todoSection } from "./todo.js";`。`const sections …` 之后加：

```ts
const todos = todoSection(state, now);
if (todos) sections.push(todos);
```

`kept` 的 `filter` 改为：

```ts
    .filter(
      (o) =>
        o.kind !== "briefing" &&
        o.kind !== "memory.conflict" &&
        o.kind !== TODO_KIND.remind && // the todos are listed above
        o.kind !== TODO_KIND.review &&
        state.offers.get(o.id)?.surface === "feed",
    )
```

函数注释改为 `/** The morning briefing: plugin sections, today's todos, things moqi kept for you, decisions waiting, today's watches. */`。

- [ ] **Step 5: `src/core/moqi.ts`**

`MoqiOptions` 的 `briefingAt` 之后加：

```ts
  /** Local "HH:MM" for the evening look at unfinished todos; null turns it off. Default "21:00". */
  readonly todoReviewAt?: string | null;
```

import 从 `./todo.js` 再加 `reviewOffer`、`TODO`、`TODO_KIND`。`tick()` 里 `await this.maybeBrief(now);` 之后加 `await this.maybeReviewTodos(now);`。在 `maybeBrief` 之后加：

```ts
  /** In the evening, what is left today. Within a while after the set time only, never deep into the night. */
  private async maybeReviewTodos(now: number): Promise<void> {
    const at = this.options.todoReviewAt === undefined ? "21:00" : this.options.todoReviewAt;
    if (at === null) return;
    const { hours, minutes } = parseTime(at);
    const since = (minuteOfDay(now) - (hours * 60 + minutes)) * 60_000;
    if (since < 0 || since >= TODO.reviewWindowMs) return;
    const today = dayKey(now);
    const done = [...this.state.offers.values()].some(
      (r) => r.offer.kind === TODO_KIND.review && dayKey(r.offer.createdAt) === today,
    );
    if (done) return;
    const offer = reviewOffer(this.state, now);
    if (offer) await this.offer(offer);
  }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/todo.test.ts test/briefing.test.ts && pnpm typecheck && pnpm format && pnpm lint`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/core/todo.ts src/core/briefing.ts src/core/moqi.ts test/todo.test.ts test/briefing.test.ts
git commit -m "feat(todo): evening review of what is left, and today's todos in the briefing"
```

---

### Task 5: 心思看见待办，从对话里听出待办

**Files:**

- Modify: `src/core/todo.ts`（`todoContext`）、`src/core/reflect.ts`
- Test: `test/reflect.test.ts`

**Interfaces:**

- Consumes: `todayTodos`、`laterTodos`、`describeTodo`、`openTodos`、`TODO_KIND`；`moqi.checkTool`。
- Produces: `todoContext(state, now): string`；心思的 `serve` 点子可带 `todo: {text, day?, at?, inMinutes?}`，合格的变成 `kind: "todo.capture"`、动作 `todo_add`（参数加 `by: "moqi"`）的提议；和未完成待办重复的，点子记 `skipped: "待办里已经有了"`。

- [ ] **Step 1: 写失败的测试** `test/reflect.test.ts` 的第一个 `describe` 里加：

```ts
it("hears a todo in conversation and offers to put it on the list, unless it is there already", async () => {
  const model = scriptedModel(() =>
    ideas(
      {
        type: "serve",
        title: "要我明天 14:00 提醒你交报告吗？",
        value: 0.7,
        todo: { text: "交报告", day: "tomorrow", at: "14:00" },
      },
      { type: "serve", title: "要我记下买牛奶吗？", value: 0.5, todo: { text: "买牛奶", at: null } },
      { type: "serve", title: "早上 7 点提醒你开会？", value: 0.5, todo: { text: "开会", at: "07:00" } },
    ),
  );
  const { moqi } = harness({ model }); // 08:20
  await moqi.callTool("todo_add", { text: "买牛奶" }, { byUser: true });

  const result = await moqi.reflect("user");
  expect(result.map((i) => i.skipped ?? "")).toEqual(["", "待办里已经有了", ""]);
  const offers = [...moqi.state.offers.values()].map((r) => r.offer);
  const capture = offers.find((o) => o.kind === "todo.capture");
  expect(capture?.action).toEqual({
    tool: "todo_add",
    args: { text: "交报告", day: "tomorrow", at: "14:00", by: "moqi" },
  });
  // 07:00 has passed today: it stays a plain suggestion without a broken action.
  const past = offers.find((o) => o.title === "早上 7 点提醒你开会？");
  expect(past).toMatchObject({ kind: IDEA_KIND.serve });
  expect(past?.action).toBeUndefined();

  await moqi.feedback(capture?.id as string, "accepted");
  expect([...moqi.state.todos.values()].find((t) => t.text === "交报告")).toMatchObject({ by: "moqi" });
  expect(String(model.requests[0]?.messages[1]?.content)).toContain("## 用户的待办\n今天：\n- 买牛奶");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/reflect.test.ts`
Expected: FAIL，找不到 `todo.capture` 提议。

- [ ] **Step 3: `src/core/todo.ts` 加 `todoContext`**

```ts
/** The todo list as reflection sees it. */
export function todoContext(state: State, now: number): string {
  const line = (t: Todo) => `- ${describeTodo(t, now)}${t.by === "moqi" ? "（你听出来的）" : ""}`;
  const today = todayTodos(state, now).map(line);
  const later = laterTodos(state, now).slice(0, 5).map(line);
  if (today.length + later.length === 0) return "（没有）";
  return [`今天：\n${today.join("\n") || "（没有）"}`, later.length ? `以后：\n${later.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 4: `src/core/reflect.ts`**

import 加 `import { openTodos, TODO_KIND, todoContext } from "./todo.js";`。

`IdeaFields` 的 `watch` 之后加 `todo: z.record(z.string(), z.unknown()).nullish(),`。

`SYSTEM` 里 serve 那一条之后加一行：

```
- 用户在对话里提到自己要做、但「用户的待办」里还没有的事（比如"明天下午要交报告"），出一个 serve，title 写成一句问话，填 todo：{"text":"交报告","day":"tomorrow","at":"14:00"}；day 填 today、tomorrow 或 YYYY-MM-DD，没说时间就不填 at。
```

`reflect()` 循环里，把

```ts
const kind = IDEA_KIND[idea.type];
```

改为

```ts
const todo = idea.type === "serve" && idea.todo ? todoArgs(moqi, idea.todo) : undefined;
const kind = todo ? TODO_KIND.capture : IDEA_KIND[idea.type];
```

在 `repeated(...)` 那段 `continue` 之后加：

```ts
    if (todo && alreadyListed(moqi, String(todo.text))) {
      ideas.push({ ...base, skipped: "待办里已经有了" });
      continue;
    }
```

把 `} else if (idea.type === "serve" && idea.watch) {` 之前插入一个分支：

```ts
    } else if (todo) {
      offer = { ...input, action: { tool: "todo_add", args: todo } };
```

文件里 `repeated` 函数之后加：

```ts
/** A todo the model heard in conversation, as todo_add arguments; undefined when it would not work. */
function todoArgs(moqi: Moqi, raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const args: Record<string, unknown> = { by: "moqi" };
  for (const key of ["text", "day", "at", "inMinutes"]) {
    const v = raw[key];
    if (v !== null && v !== undefined && v !== "") args[key] = v;
  }
  return moqi.checkTool("todo_add", args) ? undefined : args;
}

/** The same todo is already on the list, or nearly: "交报告" and "交季度报告". */
function alreadyListed(moqi: Moqi, text: string): boolean {
  const key = normalize(text);
  return openTodos(moqi.state).some((t) => {
    const other = normalize(t.text);
    return other === key || commonRun(key, other) >= Math.max(2, 0.6 * Math.min(key.length, other.length));
  });
}
```

`briefOf` 里 `## 正在替用户盯着的事` 那一项之后加：

```ts
    `## 用户的待办\n${todoContext(moqi.state, now)}`,
```

- [ ] **Step 5: 跑测试确认通过**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/reflect.test.ts && pnpm typecheck && pnpm format && pnpm lint`
Expected: PASS（原有的心思测试也通过）。

- [ ] **Step 6: Commit**

```bash
git add src/core/todo.ts src/core/reflect.ts test/reflect.test.ts
git commit -m "feat(todo): reflection sees the todo list and hears todos the user did not ask to keep"
```

---

### Task 6: 加了三次，第四次不用加

**Files:**

- Modify: `src/core/todo.ts`（`findRepeatedTodos`）、`src/core/moqi.ts`（`offerTodoRoutines`）
- Test: `test/todo.test.ts`

**Interfaces:**

- Consumes: `normalize`（`memory.ts`）、`minuteOfDay`、`TODO`、`TODO_KIND`。
- Produces: `interface TodoRoutine { key: string; text: string; at: string; days: number }`；`findRepeatedTodos(state, now): TodoRoutine[]`；`tick()` 发 `todo.routine` 提议，动作是带 `remind` 的 `watch_create`。

- [ ] **Step 1: 写失败的测试** `test/todo.test.ts`：import 从 `../src/core/todo.js` 再加 `findRepeatedTodos`。末尾加：

```ts
describe("todos that repeat", () => {
  const routines = (d: { offer: { kind: string } }[]) => d.filter((x) => x.offer.kind === "todo.routine");

  it("offers a daily reminder once the same todo was added for three days, and sets it up on yes", async () => {
    const { moqi, clock, delivered } = harness({ start: "2026-11-18T17:40:00+08:00" });
    for (const day of ["18", "19", "20"]) {
      clock.set(`2026-11-${day}T17:40:00+08:00`);
      await add(moqi, { text: "写日报", at: "18:00" });
      await moqi.tick();
    }
    const [offer] = routines(delivered);
    expect(routines(delivered)).toHaveLength(1);
    expect(offer?.offer).toMatchObject({
      title: "以后每天提醒你「写日报」？",
      body: "这 3 天你每天都加了这一条。接受后每天 18:00 提醒你，不用再加。",
      urgency: "whenever",
    });
    await moqi.feedback((offer?.offer as { id: string }).id, "accepted");
    expect([...moqi.state.watches.values()]).toMatchObject([
      { title: "写日报", schedule: { every: "day", at: "18:00" }, check: { remind: "写日报" } },
    ]);
    clock.set("2026-11-21T17:40:00+08:00");
    await add(moqi, { text: "写日报", at: "18:00" });
    await moqi.tick();
    expect(routines(delivered)).toHaveLength(1);
  });

  it("needs three days, skips what a watch already reminds of, and times untimed ones by when they were added", async () => {
    const { moqi, clock, delivered } = harness({ start: "2026-11-18T09:00:00+08:00" });
    await moqi.callTool(
      "watch_create",
      { title: "喝水", schedule: { every: "day", at: "10:00" }, remind: "喝水" },
      { byUser: true, preApproved: true },
    );
    for (const [day, time] of [
      ["18", "09:10"],
      ["19", "09:40"],
      ["20", "09:20"],
    ] as const) {
      clock.set(`2026-11-${day}T${time}:00+08:00`);
      await add(moqi, { text: "喝水！" });
      await add(moqi, { text: "背单词" });
    }
    clock.set("2026-11-20T09:30:00+08:00");
    await add(moqi, { text: "跑步" });
    clock.set("2026-11-21T09:30:00+08:00");
    await add(moqi, { text: "跑步" });
    expect(findRepeatedTodos(moqi.state, clock.now())).toEqual([
      { key: "todo:喝水", text: "喝水！", at: "09:15", days: 3 },
      { key: "todo:背单词", text: "背单词", at: "09:15", days: 3 },
    ]);
    await moqi.tick();
    expect(routines(delivered).map((d) => (d.offer as { title: string }).title)).toEqual([
      "以后每天提醒你「背单词」？",
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/todo.test.ts`
Expected: FAIL，`findRepeatedTodos` 不存在。

- [ ] **Step 3: `src/core/todo.ts`**

import 改为：

```ts
import { normalize } from "./memory.js";
import type { BriefingSection, OfferInput } from "./plugin.js";
import { dayKey, minuteOfDay, parseTime } from "./schedule.js";
```

文件末尾加：

```ts
export interface TodoRoutine {
  /** Stable, so the same habit is offered once: "todo:" and the normalized text. */
  readonly key: string;
  readonly text: string;
  /** Local "HH:MM" for a daily reminder. */
  readonly at: string;
  readonly days: number;
}

/**
 * The same todo added for 3 or more different days lately: worth a daily reminder instead. The time is
 * the usual reminder time when most of them had one, else when the user usually adds it, to the quarter hour.
 */
export function findRepeatedTodos(state: State, now: number): TodoRoutine[] {
  const groups = new Map<string, Todo[]>();
  for (const t of state.todos.values()) {
    if (now - t.createdAt > TODO.windowMs) continue;
    const key = normalize(t.text);
    if (key) groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const routines: TodoRoutine[] = [];
  for (const [key, list] of groups) {
    const days = new Set(list.map((t) => t.day)).size;
    const last = list.at(-1);
    if (days < TODO.routineDays || !last) continue;
    const timed = list.flatMap((t) => (t.remindAt === undefined ? [] : [minuteOfDay(t.remindAt)]));
    const byReminder = timed.length * 2 > list.length;
    const minutes = (byReminder ? timed : list.map((t) => minuteOfDay(t.createdAt))).sort((a, b) => a - b);
    const median = minutes[Math.floor(minutes.length / 2)] ?? 9 * 60;
    const at = byReminder ? median : Math.floor(median / 15) * 15;
    routines.push({ key: `todo:${key}`, text: last.text, at: hhmm(at), days });
  }
  return routines;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
```

- [ ] **Step 4: `src/core/moqi.ts`**

import 加 `import { normalize } from "./memory.js";`（和已有的 `memory.js` import 合并），`./todo.js` 再加 `findRepeatedTodos`。`tick()` 里 `await this.offerRoutines(now);` 之后加 `await this.offerTodoRoutines(now);`。`offerRoutines` 之后加：

```ts
  /** "You added it three times; the fourth time you shouldn't have to." Each habit is offered once. */
  private async offerTodoRoutines(now: number): Promise<void> {
    const offered = new Set(
      [...this.state.offers.values()]
        .filter((r) => r.offer.kind === TODO_KIND.routine)
        .map((r) => String(r.offer.action?.args.routineKey)),
    );
    const reminded = new Set(
      [...this.state.watches.values()].flatMap((w) => ("remind" in w.check ? [normalize(w.check.remind)] : [])),
    );
    for (const r of findRepeatedTodos(this.state, now)) {
      if (offered.has(r.key) || reminded.has(r.key.slice("todo:".length))) continue;
      await this.offer({
        kind: TODO_KIND.routine,
        title: `以后每天提醒你「${r.text}」？`,
        body: `这 ${r.days} 天你每天都加了这一条。接受后每天 ${r.at} 提醒你，不用再加。`,
        value: 0.6,
        urgency: "whenever",
        action: {
          tool: "watch_create",
          args: { title: r.text, schedule: { every: "day", at: r.at }, remind: r.text, routineKey: r.key },
        },
      });
    }
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/todo.test.ts test/routines.test.ts && pnpm typecheck && pnpm format && pnpm lint`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/core/todo.ts src/core/moqi.ts test/todo.test.ts
git commit -m "feat(todo): a todo added for three days becomes a daily reminder offer"
```

---

### Task 7: 从完成和拖延里复盘

**Files:**

- Modify: `src/core/todo.ts`（`todoStats`）、`src/core/study.ts`
- Test: `test/study.test.ts`

**Interfaces:**

- Consumes: `isOpen`、`daysLate`、`daysBetween`、`minuteOfDay`、`TODO`；Task 1 的 `feedbackCount` 计数。
- Produces: `todoStats(state, now): string`（没有待办时为空字符串）；复盘输入多一节 `## 待办的情况（最近 14 天）`。

- [ ] **Step 1: 写失败的测试** `test/study.test.ts`：import 加 `lessonsDue`（从 `../src/core/study.js`）。`describe("study", …)` 里加：

```ts
it("reviews how the user handles todos, and a few ticked off start a review", async () => {
  const model = scriptedModel((r) =>
    kindOf(r) === "lessons" ? JSON.stringify({ lessons: ["晚上的提醒常被拖到第二天，尽量定在下午"] }) : "{}",
  );
  const { moqi, clock } = harness({ model, start: "2026-11-18T09:00:00+08:00" });
  const call = (tool: string, args: Record<string, unknown>) => moqi.callTool(tool, args, { byUser: true });
  await call("todo_add", { text: "交报告", at: "20:30" });
  await call("todo_add", { text: "买牛奶" });
  await call("todo_add", { text: "开会", at: "10:00" });
  const [report, milk, meeting] = [...moqi.state.todos.values()].map((t) => t.id);
  clock.set("2026-11-18T10:00:00+08:00");
  await moqi.tick();
  clock.set("2026-11-18T10:30:00+08:00");
  await call("todo_done", { id: meeting });
  clock.set("2026-11-18T20:30:00+08:00");
  await moqi.tick();
  clock.set("2026-11-19T12:00:00+08:00");
  expect(lessonsDue(moqi.state)).toBe(false);
  await call("todo_done", { id: report });
  await call("todo_done", { id: milk });
  expect(lessonsDue(moqi.state)).toBe(true);

  expect(await moqi.study()).toBe(1);
  const prompt = String(model.requests.find((r) => kindOf(r) === "lessons")?.messages[1]?.content);
  expect(prompt).toContain("## 待办的情况（最近 14 天）");
  expect(prompt).toContain("- 加了 3 条（自己加的 3，你听出来的 0，其他 agent 加的 0）；完成 3，删掉 0，还开着 0");
  expect(prompt).toContain("- 当天完成 1 条；拖过才完成的 2 条，平均拖 1.0 天");
  expect(prompt).toContain("- 上午的提醒 1 次，提醒后 2 小时内完成 1 次");
  expect(prompt).toContain("- 晚上的提醒 1 次，提醒后 2 小时内完成 0 次");
  expect([...moqi.state.lessons.values()].map((l) => l.content)).toEqual(["晚上的提醒常被拖到第二天，尽量定在下午"]);
});
```

说明：两次提醒的提议都还没过期也没人回应，所以 `feedbackCount` 只来自 3 次 `todo.done`。

- [ ] **Step 2: 跑测试确认失败**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/study.test.ts`
Expected: FAIL，复盘输入里没有"待办的情况"。

- [ ] **Step 3: `src/core/todo.ts` 加 `todoStats`**

```ts
function bandOf(minute: number): string {
  return minute < 12 * 60 ? "上午" : minute < 18 * 60 ? "下午" : "晚上";
}

/** How the user dealt with their todos lately, for moqi's review of how to help. Empty without todos. */
export function todoStats(state: State, now: number): string {
  const recent = [...state.todos.values()].filter((t) => now - t.createdAt <= TODO.windowMs);
  if (recent.length === 0) return "";
  const self = recent.filter((t) => t.by === undefined).length;
  const heard = recent.filter((t) => t.by === "moqi").length;
  const done = recent.filter((t) => t.doneAt !== undefined && t.removedAt === undefined);
  const removed = recent.filter((t) => t.removedAt !== undefined).length;
  const open = recent.filter(isOpen);
  const lines = [
    `- 加了 ${recent.length} 条（自己加的 ${self}，你听出来的 ${heard}，其他 agent 加的 ${recent.length - self - heard}）；完成 ${done.length}，删掉 ${removed}，还开着 ${open.length}`,
  ];
  const lags = done.map((t) => Math.max(0, daysBetween(t.day, dayKey(t.doneAt ?? now))));
  const late = lags.filter((l) => l > 0);
  const average = late.length ? `，平均拖 ${(late.reduce((a, b) => a + b, 0) / late.length).toFixed(1)} 天` : "";
  lines.push(`- 当天完成 ${lags.length - late.length} 条；拖过才完成的 ${late.length} 条${average}`);
  const reminded = recent.filter((t) => t.remindAt !== undefined && t.remindedAt !== undefined);
  for (const band of ["上午", "下午", "晚上"]) {
    const inBand = reminded.filter((t) => bandOf(minuteOfDay(t.remindAt ?? 0)) === band);
    if (inBand.length === 0) continue;
    const soon = inBand.filter((t) => t.doneAt !== undefined && t.doneAt - (t.remindAt ?? 0) <= TODO.doneSoonMs).length;
    lines.push(`- ${band}的提醒 ${inBand.length} 次，提醒后 2 小时内完成 ${soon} 次`);
  }
  const lastDone = [...done]
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    .slice(0, 5)
    .map((t) => t.text);
  if (lastDone.length) lines.push(`- 最近完成：${lastDone.join("、")}`);
  const stuck = open
    .map((t) => ({ text: t.text, late: daysLate(t, now) }))
    .filter((x) => x.late > 0)
    .sort((a, b) => b.late - a.late)
    .slice(0, 3)
    .map((x) => `${x.text}（已拖 ${x.late} 天）`);
  if (stuck.length) lines.push(`- 拖得最久：${stuck.join("、")}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: `src/core/study.ts`**

import 加 `import { todoStats } from "./todo.js";`。

`LESSONS_SYSTEM` 第一句改为 `现在用户不在，你在复盘：回看你最近为用户做的事、提的建议、TA 的反应和 TA 怎么处理待办，总结以后怎样更好地帮 TA。`；例子里加一条 `「晚上 8 点后的提醒，用户多半拖到第二天；提醒尽量定在下午」`。

`reviewLessons` 里 `const existing = …` 之后加 `const todos = todoStats(state, now);`，并在输入数组里 `failed.length ? … : ""` 之后加：

```ts
          todos ? `## 待办的情况（最近 14 天）\n${todos}` : "",
```

- [ ] **Step 5: 跑测试确认通过**

Run: `TZ=Asia/Shanghai pnpm exec vitest run test/study.test.ts && pnpm typecheck && pnpm format && pnpm lint`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/core/todo.ts src/core/study.ts test/study.test.ts
git commit -m "feat(todo): study reviews how todos get done and put off"
```

---

### Task 8: 配置、控制台接口和 MCP

**Files:**

- Modify: `src/node/config.ts`、`src/node/home.ts`、`src/node/console/server.ts`、`src/node/mcp.ts`
- Test: `test/console.test.ts`、`test/mcp.test.ts`

**Interfaces:**

- Consumes: 工具 `todo_add`、`todo_done`、`todo_undone`、`todo_remove`；`todayTodos`、`laterTodos`、`recentlyDone`、`daysLate`；`MoqiOptions.todoReviewAt`。
- Produces: 配置字段 `todoReviewAt: string | null`（默认 `"21:00"`）；`GET /api/state` 的 `todos: { today, later, done }`，每项 `{ id, text, day, remindAt: number|null, by: string|null, late: number, doneAt: number|null }`；`POST /api/todo/add {text, day?, at?, by?}`、`/api/todo/done {id}`、`/api/todo/undone {id}`、`/api/todo/remove {id}`，返回 `{ message }`，参数不对时 400；MCP 工具 `moqi_todo {text, day?, at?}`。

- [ ] **Step 1: 写失败的测试**

`test/console.test.ts` 在 `describe("console: other agents", …)` 之前加：

```ts
describe("console: todos", () => {
  it("adds, ticks off, reopens and deletes todos for the user, and says what is wrong", async () => {
    const { home, api } = await start({ briefingAt: null });
    const added = await api("POST", "/api/todo/add", { text: "交报告", day: "tomorrow", at: "15:00" });
    expect(added.status).toBe(200);
    expect(added.data.message).toContain("明天 15:00 提醒你「交报告」");
    expect((await api("POST", "/api/todo/add", { text: "买牛奶" })).status).toBe(200);
    expect((await api("POST", "/api/todo/add", { text: "  " })).status).toBe(400);
    const bad = await api("POST", "/api/todo/add", { text: "开会", at: "25:00" });
    expect(bad).toMatchObject({ status: 400, data: { error: "at 要写成 HH:MM，例如 15:00" } });

    const s = await api("GET", "/api/state");
    expect(s.data.todos.today).toMatchObject([{ text: "买牛奶", late: 0, by: null, remindAt: null, doneAt: null }]);
    expect(s.data.todos.later).toMatchObject([{ text: "交报告" }]);
    const milk = s.data.todos.today[0].id;
    expect((await api("POST", "/api/todo/done", { id: milk })).data.message).toContain("勾掉了「买牛奶」");
    expect((await api("GET", "/api/state")).data.todos.done).toMatchObject([{ id: milk }]);
    expect((await api("POST", "/api/todo/done", { id: milk })).status).toBe(400);
    expect((await api("POST", "/api/todo/undone", { id: milk })).status).toBe(200);
    expect((await api("POST", "/api/todo/remove", { id: milk })).data.message).toBe("删掉了「买牛奶」");
    const after = await api("GET", "/api/state");
    expect(after.data.todos.today).toEqual([]);
    expect(after.data.question).toBeNull(); // deleting on the page does not ask again
    expect(home.moqi.state.todos.get(milk)?.removedAt).toBeDefined();
    expect((await api("GET", "/api/config")).data.config.todoReviewAt).toBe("21:00");
  });
});
```

`test/mcp.test.ts`：工具名列表改为 `["moqi_profile", "moqi_remember", "moqi_tell", "moqi_todo", "moqi_ask", "moqi_feed", "moqi_briefing"]`，`hints` 的断言里加 `moqi_todo: false`。在 `"reports moqi's own errors …"` 之前加：

```ts
it("puts a task on the user's todo list, marked as the agent's", async () => {
  const r = await client.callTool({
    name: "moqi_todo",
    arguments: { text: "review PR #12", day: "tomorrow", at: "15:00" },
  });
  expect(text(r)).toContain("明天 15:00 提醒你「review PR #12」");
  const s = (await (await fetch(stateUrl(), { headers: headers() })).json()) as {
    todos: { later: { text: string; by: string }[] };
  };
  expect(s.todos.later).toContainEqual(expect.objectContaining({ text: "review PR #12", by: "test-agent" }));
  const bad = await client.callTool({ name: "moqi_todo", arguments: { text: "x", at: "99:99" } });
  expect(bad.isError).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/console.test.ts test/mcp.test.ts`
Expected: FAIL，`/api/todo/add` 返回 404，工具列表里没有 `moqi_todo`。

- [ ] **Step 3: `src/node/config.ts`**

`briefingAt` 之后加 `todoReviewAt: time.nullable().default("21:00"),`；`TEMPLATE` 的 `briefingAt` 之后加 `todoReviewAt: "21:00",`。

- [ ] **Step 4: `src/node/home.ts`**

`build()` 里 `briefingAt: config.briefingAt,` 之后加 `todoReviewAt: config.todoReviewAt,`。

- [ ] **Step 5: `src/node/console/server.ts`**

import 加：

```ts
import { daysLate, laterTodos, recentlyDone, todayTodos } from "../../core/todo.js";
import type { FactKind, Todo, Urgency, Verdict } from "../../core/types.js";
```

（替换原来的 `import type { FactKind, Urgency, Verdict } …`。）

`"GET /api/state"` 里 `const watches = …` 之后加：

```ts
const todo = (t: Todo) => ({
  id: t.id,
  text: t.text,
  day: t.day,
  remindAt: t.remindAt ?? null,
  by: t.by ?? null,
  late: daysLate(t, now),
  doneAt: t.doneAt ?? null,
});
const todos = {
  today: todayTodos(moqi.state, now).map(todo),
  later: laterTodos(moqi.state, now).map(todo),
  done: recentlyDone(moqi.state, now).map(todo),
};
```

返回对象里 `watches,` 之后加 `todos,`。

在 `updateConfig` 之后加：

```ts
/** The page's todo buttons. What is wrong comes back as a 400 with the same words the model would get. */
const todoCall = async (tool: string, args: Record<string, unknown>) => {
  const problem = home.moqi.checkTool(tool, args);
  if (problem) throw new HttpError(400, problem);
  // Deleting on the page is the user's own decision, so it does not ask again.
  const how = { byUser: true, ...(tool === "todo_remove" && { preApproved: true }) };
  return { message: await home.serial(() => home.moqi.callTool(tool, args, how)) };
};
```

`routes` 里 `"POST /api/watch/cancel"` 之后加：

```ts
    "POST /api/todo/add": (body) =>
      todoCall("todo_add", {
        text: str(body.text, "text"),
        ...(typeof body.day === "string" && body.day && { day: body.day }),
        ...(typeof body.at === "string" && body.at && { at: body.at }),
        ...(typeof body.by === "string" && body.by.trim() && { by: body.by.trim().slice(0, 40) }),
      }),
    "POST /api/todo/done": (body) => todoCall("todo_done", { id: str(body.id, "id") }),
    "POST /api/todo/undone": (body) => todoCall("todo_undone", { id: str(body.id, "id") }),
    "POST /api/todo/remove": (body) => todoCall("todo_remove", { id: str(body.id, "id") }),
```

- [ ] **Step 6: `src/node/mcp.ts`**

`TOOLS` 里 `moqi_tell` 之后加：

```ts
  {
    name: "moqi_todo",
    title: "Put something on the user's todo list",
    description:
      "Add a task the user needs to do to their todo list in moqi, e.g. 'review PR #12' tomorrow. With `at`, moqi reminds them at that time for sure, not only in its feed. Only for things the user would agree to; moqi shows that you added it.",
    inputSchema: obj(
      {
        text: { type: "string", description: "What to do, one line", maxLength: 200 },
        day: { type: "string", description: "today, tomorrow or YYYY-MM-DD; default today" },
        at: { type: "string", description: "HH:MM local time to remind the user; leave out for no reminder" },
      },
      ["text"],
    ),
    readOnly: false,
    run: async (args, link, client) => {
      const r = await link.call("POST", "/api/todo/add", {
        text: args.text,
        day: args.day,
        at: args.at,
        by: client ?? "另一个 agent",
      });
      return `已加进用户的待办。${String(r.message)}`;
    },
  },
```

`initialize` 的 `instructions` 末尾改为 `…to reach the user when they are away, use moqi_tell; to put a task on their list, use moqi_todo.`。

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/console.test.ts test/mcp.test.ts test/interop.test.ts test/node.test.ts && pnpm typecheck && pnpm format && pnpm lint`
Expected: PASS。

- [ ] **Step 8: Commit**

```bash
git add src/node/config.ts src/node/home.ts src/node/console/server.ts src/node/mcp.ts test/console.test.ts test/mcp.test.ts
git commit -m "feat(todo): console API, evening review setting, and moqi_todo for other agents"
```

---

### Task 9: 控制台页面

**Files:**

- Modify: `src/node/console/assets/index.html`、`src/node/console/assets/app.js`、`src/node/console/assets/app.css`
- Test: `test/console.test.ts`（页面里有待办页签和晚间回顾设置）

**Interfaces:**

- Consumes: Task 8 的 `state.todos`、`/api/todo/*`、`config.todoReviewAt`；动态卡片的 `o.kind`。

- [ ] **Step 1: 写失败的测试** `test/console.test.ts` 第一个测试里，`expect(await page.text()).toContain('<script src="/app.js"');` 改为：

```ts
const html = await page.text();
expect(html).toContain('<script src="/app.js"');
expect(html).toContain('id="view-todo"');
expect(html).toContain('id="r-at"');
```

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/console.test.ts`
Expected: FAIL。

- [ ] **Step 2: `index.html`**

页签：在 `tab-chat` 按钮之后加

```html
          <button type="button" role="tab" id="tab-todo" data-view="todo" aria-controls="view-todo" aria-selected="false" tabindex="-1">
            待办<span class="count" id="todo-count" hidden></span>
          </button>
```

在 `view-chat` 的 `</section>` 之后加

```html
      <section class="view" id="view-todo" role="tabpanel" aria-labelledby="tab-todo" hidden>
        <h1 class="title">待办</h1>
        <p class="lead">定了时间的到点一定提醒你，没做完的明天接着排。也可以在对话里说「明天下午三点提醒我交报告」。</p>
        <form class="todo-add" id="todo-form">
          <label for="todo-text" class="sr-only">要做的事</label>
          <input id="todo-text" type="text" maxlength="200" autocomplete="off" placeholder="要做什么" />
          <label for="todo-day" class="sr-only">哪天</label>
          <input id="todo-day" type="date" />
          <label for="todo-at" class="sr-only">几点提醒（可不填）</label>
          <input id="todo-at" type="time" />
          <button type="submit" class="btn primary" id="todo-add">添加</button>
        </form>
        <h2 class="subtitle">今天</h2>
        <div class="list" id="todo-today"></div>
        <h2 class="subtitle">以后</h2>
        <div class="list" id="todo-later"></div>
        <h2 class="subtitle">最近完成</h2>
        <div class="list" id="todo-done"></div>
      </section>
```

设置里"每日简报"那个 `.field` 之后加

```html
            <div class="field">
              <div class="legend-row">
                <label for="r-at">晚间回顾</label>
                <label class="switch"><input type="checkbox" id="r-on" /><span class="sr-only">开启晚间回顾</span></label>
              </div>
              <input id="r-at" type="time" class="short" />
              <p class="hint">这个时间列出今天还没做完的事。你自己定了时间的提醒，不受免打扰和每天条数的限制。</p>
            </div>
```

- [ ] **Step 3: `app.js`**

1. 状态变量里 `let memoryKey = "";` 之后加 `let todosKey = "";`。
2. `const TABS = ["chat", "feed", "memory", "settings"];` 改为 `const TABS = ["chat", "todo", "feed", "memory", "settings"];`。
3. `render()` 里 `feed-count` 两行之后加：

```js
const left = state.todos.today.length;
$("todo-count").hidden = left === 0;
$("todo-count").textContent = String(left);
```

并在 `if (view === "feed") renderFeed();` 之前加 `if (view === "todo") renderTodos();`。

4. 在 `renderMemory` 之前加：

```js
/* Todos */

function dayOf(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hm(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(day) {
  const today = dayOf(Date.now());
  if (day === today) return "今天";
  if (day === dayOf(Date.now() + 86_400_000)) return "明天";
  const [, m, d] = day.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

function renderTodos() {
  const key = JSON.stringify(state.todos);
  if (key === todosKey) return; // keeps a half-done two-step delete as it is
  todosKey = key;
  fillTodos($("todo-today"), state.todos.today, "今天没有要做的事。");
  fillTodos($("todo-later"), state.todos.later, "以后的事也可以先记下来。");
  fillTodos($("todo-done"), state.todos.done, "这 7 天还没勾掉过什么。");
}

function fillTodos(list, todos, empty) {
  list.replaceChildren();
  if (todos.length === 0) list.append(h("p", { class: "none", text: empty }));
  for (const t of todos) list.append(todoItem(t));
}

function todoItem(t) {
  const done = t.doneAt !== null;
  const box = h("input", { type: "checkbox", class: "todo-check" });
  box.checked = done;
  box.addEventListener("change", async () => {
    box.disabled = true;
    try {
      const r = await api("POST", done ? "/api/todo/undone" : "/api/todo/done", { id: t.id });
      toast(r.message);
    } catch (error) {
      toast(error.message);
    }
    refresh();
  });
  const meta = [];
  if (done) meta.push(`完成于${when(t.doneAt)}`);
  else {
    const today = dayOf(Date.now());
    if (t.day > today) meta.push(dayLabel(t.day));
    if (t.remindAt !== null && dayOf(t.remindAt) >= today) meta.push(`${hm(t.remindAt)} 提醒`);
    if (t.late > 0) meta.push(`已拖 ${t.late} 天`);
  }
  if (t.by) meta.push(t.by === "moqi" ? "moqi 听出来的" : `${t.by} 加的`);
  return h(
    "div",
    { class: `item todo${done ? " done" : ""}${t.late > 0 ? " late" : ""}` },
    h(
      "label",
      { class: "item-main todo-label" },
      box,
      h(
        "span",
        { class: "todo-words" },
        h("span", { class: "item-text", text: t.text }),
        meta.length ? h("span", { class: "item-meta", text: meta.join(" · ") }) : null,
      ),
    ),
    removeButton("删除这件待办", "确定删除", () => api("POST", "/api/todo/remove", { id: t.id })),
  );
}

$("todo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("todo-text").value.trim();
  if (!text) return $("todo-text").focus();
  const body = { text };
  if ($("todo-day").value) body.day = $("todo-day").value;
  if ($("todo-at").value) body.at = $("todo-at").value;
  $("todo-add").disabled = true;
  try {
    const r = await api("POST", "/api/todo/add", body);
    toast(r.message);
    $("todo-text").value = "";
    $("todo-day").value = "";
    $("todo-at").value = "";
  } catch (error) {
    toast(error.message);
  }
  $("todo-add").disabled = false;
  $("todo-text").focus();
  refresh();
});
```

5. `offerCard` 末尾的普通卡片（`return h("article", { class: "card" }, …)`）改为：

```js
  const remind = o.kind === "todo.remind";
  return h(
    "article",
    { class: "card" },
    head,
    body,
    linkList,
    h(
      "div",
      { class: "actions" },
      h("button", {
        type: "button",
        class: "btn primary",
        text: remind ? "完成" : o.action ? "好" : "有用",
        onclick: respond("accepted"),
      }),
      h("button", {
        type: "button",
        class: "btn",
        text: remind ? "还没做" : o.action ? "不用" : "不需要",
        onclick: respond("dismissed"),
      }),
      o.kind === "todo.review"
        ? h("button", { type: "button", class: "btn", text: "打开待办", onclick: () => show("todo") })
        : null,
      h("span", { class: "spacer" }),
      // One stray tap must never silence every reminder the user set.
      remind ? null : h("button", { type: "button", class: "btn ghost", text: "不再提这类", onclick: respond("muted") }),
    ),
  );
```

6. 设置：在 `$("b-on").addEventListener(…)` 之后加

```js
$("r-on").addEventListener("change", () => {
  $("r-at").disabled = !$("r-on").checked;
});
```

`loadSettings` 里 `$("b-at").disabled = …` 之后加

```js
$("r-on").checked = config.todoReviewAt !== null;
$("r-at").value = config.todoReviewAt || "21:00";
$("r-at").disabled = config.todoReviewAt === null;
```

保存的 `config` 对象里 `briefingAt` 之后加 `todoReviewAt: $("r-on").checked ? $("r-at").value : null,`。

- [ ] **Step 4: `app.css`**

在 `.item.faded .item-text` 规则之后加：

```css
.todo-add {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.todo-add #todo-text {
  flex: 1 1 220px;
}

.todo-add input[type="date"],
.todo-add input[type="time"] {
  width: auto;
}

input[type="date"] {
  min-height: 44px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
}

.todo-label {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  cursor: pointer;
}

.todo-check {
  flex: none;
  width: 20px;
  height: 20px;
  margin: 2px 0 0;
  accent-color: var(--accent);
}

.todo-words {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.item.todo.done .item-text {
  color: var(--faint);
  text-decoration: line-through;
}

.item.todo.late .item-meta {
  color: var(--danger);
}
```

- [ ] **Step 5: 验证**

Run: `node --check src/node/console/assets/app.js && pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/console.test.ts && pnpm format && pnpm lint`
Expected: PASS。再用 `MOQI_HOME=$(mktemp -d) node dist/node/cli.js daemon` 起一个临时 moqi，用 `curl` 带 token 调 `/api/todo/add` 和 `/api/state` 看接口正常，然后停掉。

- [ ] **Step 6: Commit**

```bash
git add src/node/console/assets test/console.test.ts
git commit -m "feat(console): a todo tab, reminder cards and the evening review setting"
```

---

### Task 10: 文档和全量检查

**Files:**

- Modify: `README.md`、`README.zh-CN.md`、`docs/design.md`、`CHANGELOG.md`

- [ ] **Step 1: `CHANGELOG.md`**，在 `## [Unreleased]` 下第一条加：

```md
- Todos: a list of what you mean to do, by day, with reminders at a time you set. Those reminders always arrive, in quiet hours and past the daily budget, without using it; a reminder more than half an hour late is treated as an ordinary offer. Unfinished todos roll over and show how many days they were put off; at 21:00 (`todoReviewAt`) moqi lists what is left. Add them in chat ("明天下午三点提醒我交报告"), in the console's new 待办 tab, or from other agents with `moqi_todo`. moqi also learns from them: reflection hears todos you mentioned without asking and offers to keep them, a todo added for three days becomes a daily reminder offer, and study reviews which reminders get done and which get put off.
```

- [ ] **Step 2: `README.md`**

- "Design choices" 表里 "Speaking up has a cost" 那一行之后加一行：`| **Your own times are kept.** A todo with a time you set reminds you then, in quiet hours and past the daily budget, and does not use it up. Unfinished todos roll over and show how long they were put off; at 21:00 moqi lists what is left. | Quiet hours and the budget hold moqi's own initiative back. A time you chose is your consent to be interrupted. |`
- Quick start 里 "It has four tabs" 那段改为五个页签，加上 `**Todos** (today, later and recently done; tick off, add with an optional day and time)`。
- MCP 工具表 `moqi_tell` 之后加：`| \`moqi_todo\` | Put a task on your todo list ("review PR #12" tomorrow at 15:00); moqi shows which agent added it |`
- 配置示例 JSON 里 `"briefingAt": "08:00",` 之后加 `"todoReviewAt": "21:00",`；字段表 `briefingAt` 之后加：`| \`todoReviewAt\` | \`"21:00"\` | Time of the evening look at unfinished todos; \`null\` turns it off. |`
- "What it does unasked" 表加三行：
  - `| At the time you set for a todo | Reminds you, whatever the quiet hours and budget | core (todos) |`
  - `| In the evening (\`todoReviewAt\`) | Lists today's unfinished todos; they roll over to tomorrow | core (todos) |`
  - `| You add the same todo on three days | Offers to remind you every day instead | core (todos) |`

- [ ] **Step 3: `README.zh-CN.md`** 做相同的改动，用中文：
  - 设计取舍：`| **你定的时间一定算数。** 你给待办定了时间，就在那个时间提醒你，免打扰时段和每天的条数限制都拦不住，也不占条数。没做完的自动顺延，标出拖了几天；每晚 21:00 列出还剩什么。 | 免打扰和条数限制管的是 moqi 自己开口；你亲口定的时间，本身就是同意被打扰。 |`
  - 快速开始的页签说明加上 **待办**。
  - MCP 表：`| \`moqi_todo\` | 往你的待办里加一件事（"明天 15:00 review PR #12"），moqi 会标明是哪个 agent 加的 |`
  - 配置：示例加 `"todoReviewAt": "21:00",`，字段表加 `| \`todoReviewAt\` | \`"21:00"\` | 晚间回顾的时间，列出今天还没做完的待办；\`null\` 关闭 |`
  - 主动做的事表加三行：`| 到了你给待办定的时间 | 提醒你，不受免打扰和条数限制 | 内核（待办） |`、`| 每晚（\`todoReviewAt\`） | 列出今天没做完的待办，没做完的顺延到明天 | 内核（待办） |`、`| 你连续三天加同一件待办 | 问你要不要改成每天提醒 | 内核（待办） |`

- [ ] **Step 4: `docs/design.md`**

第 4 节的送达规则列表之后加一段：

```md
唯一的例外是**用户亲口定的时间**：待办到了用户定的提醒时间，提议带 `userTimed`，直接弹通知，不看静音、门槛、免打扰和每日额度，也不占额度。免打扰和额度管的是 moqi 自己开口，用户定的时间本身就是同意被打扰。晚了半小时以上的提醒（比如电脑睡着了）不再算数，按普通提议过关。
```

第 4 节"自学"之后加小节：

```md
### 待办

待办是用户自己要做的事，按天排，可以带一个提醒时间。没做完的自动算作今天的，并标出拖了几天；用户主动改期时重新计算。每晚 21:00（`todoReviewAt`）列出今天还剩的事，这条是 moqi 主动开口，照常过关。

待办也是 moqi 了解用户、改进自己的材料：

- **听出来的待办**：心思看到对话里提到、但待办里没有的事，问一句要不要记下（`todo.capture`），这一类的门槛单独学；
- **加了三次，第四次不用加**：同一件待办 14 天内排了 3 个不同的日子，就问要不要改成每天提醒，接受后生成一件托管事务；
- **复盘**：完成和删除待办也算用户的反应，攒够了就复盘：哪个时段的提醒管用、哪类事总是拖，总结成经验，进入对话和心思。
```

第 5 节"习惯识别"之后加一句：`同样的规则也用在待办上：同一件待办连着几天都加，就提议改成每天提醒。`

- [ ] **Step 5: 格式化和全量检查**

Run: `pnpm exec biome check --write README.md README.zh-CN.md docs/design.md CHANGELOG.md docs/superpowers && pnpm check`
Expected: typecheck、lint、build、全部测试通过（原有 132 个加上新增的）。

- [ ] **Step 6: Commit**

```bash
git add README.md README.zh-CN.md docs/design.md CHANGELOG.md docs/superpowers
git commit -m "docs: todos, reminders at your own times, and what moqi learns from them"
```
