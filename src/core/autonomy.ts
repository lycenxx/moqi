// Trust is earned one kind of action at a time.
import { RULES, type State } from "./state.js";
import type { Level } from "./types.js";

export const LEVELS: readonly Level[] = ["inform", "suggest", "auto-undo", "auto"];

export interface ActionPolicy {
  /** Starting level. Read-only tools usually start at "auto", anything that changes the world at "suggest". */
  readonly start: Level;
  /** Never above this, however often the user approves. Deleting memories or paying stays at "suggest". */
  readonly cap: Level;
}

export function levelOf(state: State, kind: string, policy: ActionPolicy): Level {
  const earned = state.trust.get(kind)?.level;
  const level = earned ?? policy.start;
  return rank(level) > rank(policy.cap) ? policy.cap : level;
}

/** Whether moqi has to ask before doing this kind of action now. */
export function needsConfirmation(state: State, kind: string, policy: ActionPolicy): boolean {
  return rank(levelOf(state, kind, policy)) <= rank("suggest");
}

/** After enough consecutive approvals, the next level up, if the cap allows it. */
export function promotionDue(state: State, kind: string, policy: ActionPolicy): Level | undefined {
  const trust = state.trust.get(kind);
  if (!trust || trust.streak < RULES.trustAfter) return undefined;
  const current = levelOf(state, kind, policy);
  const next = LEVELS[rank(current) + 1];
  return next && rank(next) <= rank(policy.cap) ? next : undefined;
}

export function rank(level: Level): number {
  return LEVELS.indexOf(level);
}
