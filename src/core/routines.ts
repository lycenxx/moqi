// "You asked three times; the fourth time you shouldn't have to."
import { dayKey, minuteOfDay } from "./schedule.js";
import type { State, ToolUse } from "./state.js";
import type { Schedule } from "./types.js";

export const ROUTINE = {
  /** Distinct days with the same request. */
  minDays: 3,
  windowMs: 14 * 24 * 3_600_000,
  /** How close the times of day must be. */
  toleranceMinutes: 60,
} as const;

export interface Routine {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly schedule: Schedule;
  readonly days: number;
  /** Stable key, so the same routine is offered once. */
  readonly key: string;
}

/**
 * Finds requests the user makes at about the same time on several days: the same tool with the
 * same arguments. Each routine is suggested as a daily watch at the median time, rounded down to
 * a quarter hour, a little before the user usually asks.
 */
export function findRoutines(state: State, now: number, automatable: (tool: string) => boolean): Routine[] {
  const recent = state.userToolUses.filter((u) => now - u.at <= ROUTINE.windowMs && automatable(u.tool));
  const groups = new Map<string, ToolUse[]>();
  for (const use of recent) {
    const key = `${use.tool}:${stableJson(use.args)}`;
    groups.set(key, [...(groups.get(key) ?? []), use]);
  }
  const routines: Routine[] = [];
  for (const [key, uses] of groups) {
    const perDay = new Map<string, number>();
    for (const u of uses) if (!perDay.has(dayKey(u.at))) perDay.set(dayKey(u.at), minuteOfDay(u.at));
    const minutes = [...perDay.values()].sort((a, b) => a - b);
    if (minutes.length < ROUTINE.minDays) continue;
    const median = minutes[Math.floor(minutes.length / 2)] as number;
    if (minutes.some((m) => Math.abs(m - median) > ROUTINE.toleranceMinutes)) continue;
    const at = Math.max(0, Math.floor((median - 15) / 15) * 15);
    const first = uses[0] as ToolUse;
    routines.push({
      tool: first.tool,
      args: first.args,
      schedule: {
        every: "day",
        at: `${String(Math.floor(at / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`,
      },
      days: minutes.length,
      key,
    });
  }
  return routines;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
