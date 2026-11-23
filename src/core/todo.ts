// Todos: what the user means to do, on a day and sometimes at a time. Pure functions over the state;
// the Moqi class turns them into offers and events. Unfinished todos roll over by themselves: one planned
// for an earlier day counts as today's, and how many days late it is shows how long it has been put off.
import { normalize } from "./memory.js";
import type { BriefingSection, OfferInput } from "./plugin.js";
import { dayKey, minuteOfDay, parseTime } from "./schedule.js";
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
  // Other agents' words are counted, never quoted: a lesson must not carry them into every conversation.
  const own = (t: Todo) => t.by === undefined || t.by === "moqi";
  const lastDone = [...done]
    .filter(own)
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    .slice(0, 5)
    .map((t) => t.text);
  if (lastDone.length) lines.push(`- 最近完成：${lastDone.join("、")}`);
  const stuck = open
    .filter(own)
    .map((t) => ({ text: t.text, late: daysLate(t, now) }))
    .filter((x) => x.late > 0)
    .sort((a, b) => b.late - a.late)
    .slice(0, 3)
    .map((x) => `${x.text}（已拖 ${x.late} 天）`);
  if (stuck.length) lines.push(`- 拖得最久：${stuck.join("、")}`);
  return lines.join("\n");
}
