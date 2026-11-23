import type { BriefingSection } from "./plugin.js";
import { dayKey, describeSchedule } from "./schedule.js";
import type { State } from "./state.js";
import { TODO_KIND, todoSection } from "./todo.js";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export interface Briefing {
  readonly title: string;
  readonly body: string;
  /** Sections with content. A briefing with none is not worth an interruption. */
  readonly sections: number;
}

/** The morning briefing: plugin sections, today's todos, things moqi kept for you, decisions waiting, today's watches. */
export function composeBriefing(state: State, now: number, plugins: readonly BriefingSection[]): Briefing {
  const d = new Date(now);
  const title = `今天的简报 · ${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
  const sections: BriefingSection[] = plugins.filter((s) => s.lines.length > 0);
  const todos = todoSection(state, now);
  if (todos) sections.push(todos);

  const kept = state
    .openOffers(now)
    .filter(
      (o) =>
        o.kind !== "briefing" &&
        o.kind !== "memory.conflict" &&
        o.kind !== TODO_KIND.remind && // the todos are listed above
        o.kind !== TODO_KIND.review &&
        state.offers.get(o.id)?.surface === "feed",
    )
    .slice(0, 5)
    .map((o) => `${o.title}${o.body ? `：${firstLine(o.body)}` : ""}（/accept ${o.id}）`);
  if (kept.length > 0) sections.push({ title: "替你留意", lines: kept });

  const conflicts = [...state.conflicts.values()].map((c) => `你之前说「${c.old}」，后来说「${c.new}」，以哪个为准？`);
  if (conflicts.length > 0) sections.push({ title: "需要你定", lines: conflicts });

  const today = dayKey(now);
  const due = [...state.watches.values()]
    .filter((w) => dayKey(w.nextAt) === today)
    .sort((a, b) => a.nextAt - b.nextAt)
    .map((w) => `${w.title}（${describeSchedule(w.schedule)}）${w.last ? `，上次：${w.last.headline}` : ""}`);
  if (due.length > 0) sections.push({ title: "今天替你盯着", lines: due });

  const body = sections.map((s) => `【${s.title}】\n${s.lines.map((l) => `· ${l}`).join("\n")}`).join("\n\n");
  return { title, body: body || "今天没有需要你操心的事。", sections: sections.length };
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? "";
}
