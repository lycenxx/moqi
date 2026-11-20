// When to speak up. Pure decisions over State; the Moqi class turns them into events and delivery.
import { minuteOfDay, parseTime } from "./schedule.js";
import type { State } from "./state.js";
import type { Offer, Surface } from "./types.js";

export interface Policy {
  /** Local "HH:MM". Inside the window only urgent, valuable offers may notify. */
  readonly quietFrom: string;
  readonly quietTo: string;
  /** System notifications per local day. */
  readonly dailyBudget: number;
  /** In quiet hours, an offer needs urgency "now" and at least this value. */
  readonly quietOverride: number;
}

export const defaultPolicy: Policy = { quietFrom: "22:30", quietTo: "08:00", dailyBudget: 3, quietOverride: 0.9 };

export function inQuietHours(policy: Policy, at: number): boolean {
  const m = minuteOfDay(at);
  const from = toMinutes(policy.quietFrom);
  const to = toMinutes(policy.quietTo);
  return from <= to ? m >= from && m < to : m >= from || m < to;
}

function toMinutes(hhmm: string): number {
  const { hours, minutes } = parseTime(hhmm);
  return hours * 60 + minutes;
}

export interface Decision {
  readonly surface: Surface | "drop";
  readonly reason: string;
}

/** Where an offer goes: an interruption, the feed (seen in the briefing or when the user looks), or nowhere. */
export function decide(state: State, policy: Policy, offer: Offer, at: number): Decision {
  const stats = state.kind(offer.kind);
  // Reasons are shown to the user in the console, so they are plain Chinese.
  if (stats.muted) return { surface: "drop", reason: "你关掉了这类事" };
  if (offer.urgency === "whenever") return { surface: "feed", reason: "不急，放进动态" };
  if (offer.value < stats.threshold) {
    return {
      surface: "feed",
      reason: `值 ${offer.value.toFixed(2)}，低于这类的门槛 ${stats.threshold.toFixed(2)}，放进动态`,
    };
  }
  if (inQuietHours(policy, at) && !(offer.urgency === "now" && offer.value >= policy.quietOverride)) {
    return { surface: "feed", reason: "免打扰时段，放进动态" };
  }
  if (state.notifiedOn(at) >= policy.dailyBudget) return { surface: "feed", reason: "今天的打扰额度用完了，放进动态" };
  return { surface: "notify", reason: "值得现在告诉你" };
}
