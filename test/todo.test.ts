import { describe, expect, it } from "vitest";
import { Moqi } from "../src/core/moqi.js";
import { State } from "../src/core/state.js";
import {
  daysLate,
  describeTodo,
  findRepeatedTodos,
  laterTodos,
  resolveWhen,
  TODO,
  todayTodos,
  todoChange,
} from "../src/core/todo.js";
import type { EventBody, MoqiEvent, Todo } from "../src/core/types.js";
import { call, DAY, harness, scriptedModel } from "./helpers.js";

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

describe("reminders", () => {
  const news = { kind: "n", title: "新闻", body: "", value: 0.8, urgency: "today" } as const;
  const reminders = <T extends { offer: { kind: string } }>(d: T[]) => d.filter((x) => x.offer.kind === "todo.remind");

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
    const offerId = reminders(delivered)[0]?.offer.id ?? "";
    expect(await again.feedback(offerId, "accepted")).toBe("勾掉了「交报告」，今天的都做完了");
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
    expect(night.moqi.state.offers.get(sent?.offer.id ?? "")?.reason).toBe("你定的时间到了");
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

describe("evening review", () => {
  const reviews = <T extends { offer: { kind: string } }>(d: T[]) => d.filter((x) => x.offer.kind === "todo.review");

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

describe("todos that repeat", () => {
  const routines = <T extends { offer: { kind: string } }>(d: T[]) => d.filter((x) => x.offer.kind === "todo.routine");

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
    await moqi.feedback(offer?.offer.id ?? "", "accepted");
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
    expect(routines(delivered).map((d) => d.offer.title)).toEqual(["以后每天提醒你「背单词」？"]);
  });
});
