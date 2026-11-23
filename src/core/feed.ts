// What the user has already seen in the feed: cards they reacted to or let expire, kept with their links.
import type { CodeTaskState, OfferRecord, State } from "./state.js";

export const FEED = { historyDays: 30, historyMax: 100 } as const;

export interface Seen {
  readonly record: OfferRecord;
  readonly decidedAt: number;
  /** What became of it, in the user's words. */
  readonly outcome: string;
  readonly task?: CodeTaskState;
}

/** Cards shown and done with (a reaction, or expired) in the last 30 days, the latest first, at most 100. */
export function seenOffers(state: State, now: number): Seen[] {
  const since = now - FEED.historyDays * 86_400_000;
  return [...state.offers.values()]
    .filter((r) => r.surface !== undefined && r.offer.createdAt >= since)
    .flatMap((r) => {
      const expired = r.offer.expiresAt !== undefined && r.offer.expiresAt <= now;
      if (!r.verdict && !expired) return [];
      const about = r.offer.kind === "code.done" && r.offer.about ? state.codeTasks.get(r.offer.about) : undefined;
      return [
        {
          record: r,
          decidedAt: r.decidedAt ?? r.offer.expiresAt ?? r.offer.createdAt,
          outcome: outcomeOf(r, about),
          ...(about && { task: about }),
        },
      ];
    })
    .sort((a, b) => b.decidedAt - a.decidedAt)
    .slice(0, FEED.historyMax);
}

function outcomeOf(r: OfferRecord, task: CodeTaskState | undefined): string {
  if (task?.status === "merged") return `已合并到 ${task.into ?? "当前分支"}`;
  if (task?.status === "discarded") return "已丢弃";
  const o = r.offer;
  if (r.verdict === "accepted")
    return o.kind === "todo.remind" ? "完成了" : o.answer === "text" ? "回答了" : o.action ? "好" : "有用";
  if (r.verdict === "dismissed")
    return o.kind === "todo.remind" ? "还没做" : o.answer === "text" ? "不想说" : "你说不用";
  if (r.verdict === "ignored") return "你没理";
  if (r.verdict === "muted") return "你关掉了这类";
  return "没理会，过期了";
}
