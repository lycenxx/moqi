// Everything moqi knows is an event in an append-only log. State is a fold over events.

export interface Clock {
  /** Milliseconds since epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

// ---------------------------------------------------------------------------
// User model
// ---------------------------------------------------------------------------

export type FactKind = "basic" | "preference" | "ongoing" | "relation" | "routine" | "other";

export interface Fact {
  readonly id: string;
  readonly kind: FactKind;
  readonly content: string;
  /** How many separate times this was stated or observed. 3 makes it long-term. */
  readonly confirmations: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly term: "short" | "long";
}

export interface Conflict {
  readonly factId: string;
  readonly old: string;
  readonly new: string;
  readonly at: number;
}

// ---------------------------------------------------------------------------
// Proactivity
// ---------------------------------------------------------------------------

export type Urgency = "now" | "today" | "whenever";
export type Verdict = "accepted" | "dismissed" | "ignored" | "muted";

/** Something moqi wants to tell or offer the user without being asked. */
export interface Offer {
  readonly id: string;
  /** Feedback is learned per kind, e.g. "briefing", "watch.alert", "routine.automate". */
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  /** 0..1, how much this is worth the user's attention. */
  readonly value: number;
  readonly urgency: Urgency;
  readonly createdAt: number;
  readonly expiresAt?: number;
  /** What accepting it does. Absent: it is information only. */
  readonly action?: { readonly tool: string; readonly args: Record<string, unknown> };
}

export type Surface = "notify" | "feed";

// ---------------------------------------------------------------------------
// Autonomy
// ---------------------------------------------------------------------------

export type Level = "inform" | "suggest" | "auto-undo" | "auto";

// ---------------------------------------------------------------------------
// Watches (托管事务)
// ---------------------------------------------------------------------------

export type Schedule =
  | { readonly every: "day"; readonly at: string }
  | { readonly every: "week"; readonly days: readonly number[]; readonly at: string }
  | { readonly every: "hours"; readonly hours: number };

export interface Watch {
  readonly id: string;
  readonly title: string;
  readonly schedule: Schedule;
  /** A tool to call, or a plain reminder. */
  readonly check: { readonly tool: string; readonly args: Record<string, unknown> } | { readonly remind: string };
  readonly notify: "on-change" | "always";
  readonly nextAt: number;
  readonly last?: { readonly at: number; readonly value: string; readonly headline: string };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventBody =
  | { type: "message"; role: "user" | "assistant"; text: string }
  | { type: "observation"; source: string; data: unknown }
  | { type: "fact.added"; fact: Fact }
  | { type: "fact.confirmed"; factId: string }
  | { type: "fact.contradicted"; factId: string; content: string }
  | { type: "fact.resolved"; factId: string; keep: "old" | "new" }
  | { type: "fact.forgotten"; factId: string }
  | { type: "offer.created"; offer: Offer }
  | { type: "offer.delivered"; offerId: string; surface: Surface }
  | { type: "offer.feedback"; offerId: string; verdict: Verdict }
  | { type: "tool.called"; tool: string; args: Record<string, unknown>; byUser: boolean; ok: boolean }
  | { type: "approval"; kind: string; approved: boolean }
  | { type: "level.changed"; kind: string; level: Level }
  | { type: "watch.created"; watch: Watch }
  | { type: "watch.ran"; watchId: string; value: string; headline: string; changed: boolean; nextAt: number }
  | { type: "watch.cancelled"; watchId: string }
  | { type: "kind.unmuted"; kind: string };

export type MoqiEvent = EventBody & { readonly id: string; readonly at: number };

/** Compile-time guard: a body field named like the envelope would be silently overwritten. */
type Collides = Extract<EventBody, { id: unknown } | { at: unknown }>;
const noEnvelopeCollision: [Collides] extends [never] ? true : never = true;
void noEnvelopeCollision;

/** Append-only. Hosts persist it; the core never edits an event. */
export interface EventStore {
  append(event: MoqiEvent): void;
  all(): readonly MoqiEvent[];
}

export function memoryEventStore(initial: readonly MoqiEvent[] = []): EventStore {
  const events = [...initial];
  return { append: (e) => void events.push(e), all: () => events };
}

let counter = 0;
/** Runtime-neutral id (no crypto dependency, so it works in React Native too). */
export function newId(prefix: string, clock: Clock = systemClock): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${clock.now().toString(36)}${counter.toString(36).padStart(4, "0")}${Math.random().toString(36).slice(2, 6)}`;
}
