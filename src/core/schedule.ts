import type { Schedule } from "./types.js";

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseTime(at: string): { hours: number; minutes: number } {
  const match = HHMM.exec(at);
  if (!match) throw new Error(`Time must be HH:MM, got "${at}"`);
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

export function validateSchedule(schedule: Schedule): Schedule {
  if (schedule.every === "hours") {
    if (!Number.isInteger(schedule.hours) || schedule.hours < 1 || schedule.hours > 24 * 7) {
      throw new Error("hours must be an integer between 1 and 168");
    }
    return schedule;
  }
  parseTime(schedule.at);
  if (schedule.every === "week") {
    if (schedule.days.length === 0 || schedule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new Error("days must be 0 (Sunday) to 6 (Saturday)");
    }
  }
  return schedule;
}

/** The first time strictly after `after`, in the device's local time zone. */
export function nextRun(schedule: Schedule, after: number): number {
  if (schedule.every === "hours") return after + schedule.hours * 3_600_000;
  const { hours, minutes } = parseTime(schedule.at);
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setHours(hours, minutes);
  for (let i = 0; i < 8; i++) {
    const ok = schedule.every === "day" || schedule.days.includes(candidate.getDay());
    if (ok && candidate.getTime() > after) return candidate.getTime();
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hours, minutes, 0, 0);
  }
  throw new Error("No run within a week; check the schedule");
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.every === "hours") return `每 ${schedule.hours} 小时`;
  if (schedule.every === "day") return `每天 ${schedule.at}`;
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  return `每周${schedule.days.map((d) => names[d]).join("、")} ${schedule.at}`;
}

/** Local calendar day as YYYY-MM-DD. */
export function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Minutes since local midnight. */
export function minuteOfDay(at: number): number {
  const d = new Date(at);
  return d.getHours() * 60 + d.getMinutes();
}
