// The user model's rules. The reducer in state.ts applies them; this file decides which events to emit.
import { RULES, type State } from "./state.js";
import { type Clock, type EventBody, type Fact, type FactKind, newId } from "./types.js";

export const FACT_KINDS: readonly FactKind[] = ["basic", "preference", "ongoing", "relation", "routine", "other"];
export const MAX_FACT_CHARS = 120;
export const PROMPT_FACTS = 30;
/** `Fact.by` for what moqi took in while it was reading outside content, or from another agent's words. */
export const OUTSIDE = "外部内容";

/** Equal after case, whitespace and punctuation are ignored ("住在深圳。" == "住在 深圳"). */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

export interface RememberInput {
  readonly kind: FactKind;
  readonly content: string;
  /** id of an existing fact this statement contradicts. */
  readonly contradicts?: string;
  /** Who said it, when not the user. A fact with one makes a conversation turn count as having read outside content. */
  readonly by?: string;
}

/** What remembering something produces: a new fact, a confirmation, or a conflict for the user. */
export function rememberEvents(state: State, input: RememberInput, clock: Clock): EventBody[] {
  const content = input.content.trim().slice(0, MAX_FACT_CHARS);
  if (content === "") return [];
  if (input.contradicts) {
    const old = state.facts.get(input.contradicts);
    if (old && normalize(old.content) !== normalize(content)) {
      if (state.conflicts.has(old.id)) return [];
      return [{ type: "fact.contradicted", factId: old.id, content }];
    }
  }
  const key = normalize(content);
  const same = [...state.facts.values()].find((f) => normalize(f.content) === key);
  if (same) return [{ type: "fact.confirmed", factId: same.id }];
  const now = clock.now();
  const fact: Fact = {
    id: newId("f", clock),
    kind: FACT_KINDS.includes(input.kind) ? input.kind : "other",
    content,
    confirmations: 1,
    createdAt: now,
    lastSeenAt: now,
    term: "short",
    ...(input.by && { by: input.by.slice(0, 40) }),
  };
  return [{ type: "fact.added", fact }];
}

export function isFaded(fact: Fact, now: number): boolean {
  return fact.term === "short" && now - fact.lastSeenAt > RULES.fadeAfterMs;
}

/** Facts that enter the prompt: not faded, long-term first, then the most confirmed, capped. */
export function activeFacts(state: State, now: number): Fact[] {
  return [...state.facts.values()]
    .filter((f) => !isFaded(f, now))
    .sort((a, b) =>
      a.term === b.term ? b.confirmations - a.confirmations || b.lastSeenAt - a.lastSeenAt : a.term === "long" ? -1 : 1,
    )
    .slice(0, PROMPT_FACTS);
}

const KIND_LABEL: Record<FactKind, string> = {
  basic: "基本情况",
  preference: "偏好",
  ongoing: "近期在做",
  relation: "关系",
  routine: "习惯",
  other: "其他",
};

export function promptSection(state: State, now: number): string {
  const facts = activeFacts(state, now);
  if (facts.length === 0) return "";
  const lines = facts.map(
    (f) => `- [${f.id}] ${KIND_LABEL[f.kind]}：${f.content}${f.term === "long" ? "" : "（待印证）"}`,
  );
  return `## 你对用户的了解\n${lines.join("\n")}`;
}
