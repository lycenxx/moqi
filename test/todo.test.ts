import { describe, expect, it } from "vitest";
import type { Moqi } from "../src/core/moqi.js";
import { State } from "../src/core/state.js";
import { daysLate, describeTodo, laterTodos, resolveWhen, TODO, todayTodos, todoChange } from "../src/core/todo.js";
import type { EventBody, MoqiEvent, Todo } from "../src/core/types.js";
import { call, harness, scriptedModel } from "./helpers.js";

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
const add = (moqi: Moqi, args: Record<string, unknown>) => moqi.callTool("todo_add", args, { byUser: true });
const todos = (moqi: Moqi) => [...moqi.state.todos.values()];

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
