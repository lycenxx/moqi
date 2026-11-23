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
