import { dayKey } from "./schedule.js";
import type { Conflict, Fact, Level, MoqiEvent, Offer, Surface, Verdict, Watch } from "./types.js";

export const RULES = {
  /** Separate confirmations that make a fact long-term. */
  longTermAfter: 3,
  /** A short-term fact not seen for this long stops entering the prompt. */
  fadeAfterMs: 30 * 24 * 3_600_000,
  /** Consecutive approvals before moqi offers to do a kind of action on its own. */
  trustAfter: 3,
  thresholdStart: 0.5,
  thresholdMin: 0.2,
  thresholdMax: 0.95,
  onAccepted: -0.05,
  onDismissed: 0.1,
  onIgnored: 0.03,
} as const;

export interface OfferRecord {
  readonly offer: Offer;
  surface?: Surface;
  verdict?: Verdict;
}

export interface KindStats {
  threshold: number;
  muted: boolean;
  accepted: number;
  dismissed: number;
  ignored: number;
}

export interface Trust {
  level: Level;
  streak: number;
}

export interface ToolUse {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly at: number;
}

/** Everything derived from the log. Rebuild it any time with `State.from(events)`. */
export class State {
  readonly facts = new Map<string, Fact>();
  readonly conflicts = new Map<string, Conflict>();
  readonly offers = new Map<string, OfferRecord>();
  readonly kinds = new Map<string, KindStats>();
  readonly trust = new Map<string, Trust>();
  readonly watches = new Map<string, Watch>();
  readonly notifiedPerDay = new Map<string, number>();
  readonly userToolUses: ToolUse[] = [];
  userMessages = 0;
  lastEventAt = 0;

  static from(events: readonly MoqiEvent[]): State {
    const state = new State();
    for (const event of events) state.apply(event);
    return state;
  }

  kind(name: string): KindStats {
    let stats = this.kinds.get(name);
    if (!stats) {
      stats = { threshold: RULES.thresholdStart, muted: false, accepted: 0, dismissed: 0, ignored: 0 };
      this.kinds.set(name, stats);
    }
    return stats;
  }

  apply(e: MoqiEvent): void {
    this.lastEventAt = e.at;
    switch (e.type) {
      case "message":
        if (e.role === "user") this.userMessages++;
        break;
      case "fact.added":
        this.facts.set(e.fact.id, e.fact);
        break;
      case "fact.confirmed": {
        const f = this.facts.get(e.factId);
        if (!f) break;
        const confirmations = f.confirmations + 1;
        const term = confirmations >= RULES.longTermAfter ? "long" : f.term;
        this.facts.set(e.factId, { ...f, confirmations, lastSeenAt: e.at, term });
        break;
      }
      case "fact.contradicted": {
        const f = this.facts.get(e.factId);
        if (f) this.conflicts.set(e.factId, { factId: e.factId, old: f.content, new: e.content, at: e.at });
        break;
      }
      case "fact.resolved": {
        const c = this.conflicts.get(e.factId);
        const f = this.facts.get(e.factId);
        this.conflicts.delete(e.factId);
        // Keeping the new statement replaces the content; the user's decision counts as a confirmation.
        if (c && f && e.keep === "new")
          this.facts.set(e.factId, { ...f, content: c.new, lastSeenAt: e.at, confirmations: 1, term: "short" });
        if (c && f && e.keep === "old") this.facts.set(e.factId, { ...f, lastSeenAt: e.at });
        break;
      }
      case "fact.forgotten":
        this.facts.delete(e.factId);
        this.conflicts.delete(e.factId);
        break;
      case "offer.created":
        this.offers.set(e.offer.id, { offer: e.offer });
        break;
      case "offer.delivered": {
        const r = this.offers.get(e.offerId);
        if (!r) break;
        r.surface = e.surface;
        if (e.surface === "notify") {
          const day = dayKey(e.at);
          this.notifiedPerDay.set(day, (this.notifiedPerDay.get(day) ?? 0) + 1);
        }
        break;
      }
      case "offer.feedback": {
        const r = this.offers.get(e.offerId);
        if (!r || r.verdict) break;
        r.verdict = e.verdict;
        const k = this.kind(r.offer.kind);
        if (e.verdict === "accepted") {
          k.accepted++;
          k.threshold += RULES.onAccepted;
        } else if (e.verdict === "dismissed") {
          k.dismissed++;
          k.threshold += RULES.onDismissed;
        } else if (e.verdict === "ignored") {
          k.ignored++;
          k.threshold += RULES.onIgnored;
        } else {
          k.muted = true;
        }
        k.threshold = Math.min(RULES.thresholdMax, Math.max(RULES.thresholdMin, k.threshold));
        break;
      }
      case "kind.unmuted":
        this.kind(e.kind).muted = false;
        break;
      case "tool.called":
        if (e.byUser && e.ok) this.userToolUses.push({ tool: e.tool, args: e.args, at: e.at });
        break;
      case "approval": {
        const t = this.trust.get(e.kind) ?? { level: "suggest", streak: 0 };
        this.trust.set(e.kind, e.approved ? { ...t, streak: t.streak + 1 } : { level: "suggest", streak: 0 });
        break;
      }
      case "level.changed":
        this.trust.set(e.kind, { level: e.level, streak: 0 });
        break;
      case "watch.created":
        this.watches.set(e.watch.id, e.watch);
        break;
      case "watch.ran": {
        const w = this.watches.get(e.watchId);
        if (w)
          this.watches.set(e.watchId, {
            ...w,
            nextAt: e.nextAt,
            last: { at: e.at, value: e.value, headline: e.headline },
          });
        break;
      }
      case "watch.cancelled":
        this.watches.delete(e.watchId);
        break;
      case "observation":
        break;
    }
  }

  /** Offers created but not yet answered, newest first. */
  openOffers(now: number): Offer[] {
    return [...this.offers.values()]
      .filter((r) => !r.verdict && (r.offer.expiresAt === undefined || r.offer.expiresAt > now))
      .map((r) => r.offer)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  notifiedOn(at: number): number {
    return this.notifiedPerDay.get(dayKey(at)) ?? 0;
  }
}
