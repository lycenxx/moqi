// Todos: what the user means to do, on a day and sometimes at a time. Pure functions over the state;
// the Moqi class turns them into offers and events. Unfinished todos roll over by themselves: one planned
// for an earlier day counts as today's, and how many days late it is shows how long it has been put off.
import type { OfferInput } from "./plugin.js";
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
