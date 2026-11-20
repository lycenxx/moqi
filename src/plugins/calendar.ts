// Calendar from iCalendar (.ics) text: exported calendars, or a subscription URL the host downloads.
// Parsing is pure; the host decides how to load the text (file on desktop, fetch on phone).
import { z } from "zod";
import { defineTool, type Plugin } from "../core/plugin.js";
import { dayKey } from "../core/schedule.js";

export interface CalendarEvent {
  readonly uid: string;
  readonly summary: string;
  readonly start: number;
  readonly end?: number;
  readonly allDay: boolean;
  readonly location?: string;
}

/** Single (non-repeating) events. RRULE repeats are not expanded in this version. */
export function parseIcs(text: string): CalendarEvent[] {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const events: CalendarEvent[] = [];
  let current: Record<string, { value: string; params: string }> | undefined;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") current = {};
    else if (line === "END:VEVENT" && current) {
      const start = current.DTSTART && parseDate(current.DTSTART.value, current.DTSTART.params);
      if (start && !current.RRULE) {
        const end = current.DTEND && parseDate(current.DTEND.value, current.DTEND.params);
        events.push({
          uid: current.UID?.value ?? `${start.at}-${current.SUMMARY?.value ?? ""}`,
          summary: unescapeText(current.SUMMARY?.value ?? "（无标题）"),
          start: start.at,
          ...(end && { end: end.at }),
          allDay: start.allDay,
          ...(current.LOCATION && { location: unescapeText(current.LOCATION.value) }),
        });
      }
      current = undefined;
    } else if (current) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const [name, ...params] = line.slice(0, colon).split(";");
      if (name) current[name.toUpperCase()] = { value: line.slice(colon + 1), params: params.join(";") };
    }
  }
  return events.sort((a, b) => a.start - b.start);
}

function parseDate(value: string, params: string): { at: number; allDay: boolean } | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || params.includes("VALUE=DATE")) {
    return { at: new Date(Number(y), Number(mo) - 1, Number(d)).getTime(), allDay: true };
  }
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)] as const;
  // TZID times are treated as the device's local time; UTC times are converted.
  const at = z ? Date.UTC(...parts) : new Date(...parts).getTime();
  return { at, allDay: false };
}

function unescapeText(text: string): string {
  return text.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function describeEvent(e: CalendarEvent): string {
  return `${e.allDay ? "全天" : clock(e.start)} ${e.summary}${e.location ? `（${e.location}）` : ""}`;
}

export interface CalendarOptions {
  /** Returns the current .ics text. */
  readonly load: () => Promise<string> | string;
  /** Minutes before a timed event to remind the user. Default 30. */
  readonly remindBefore?: number;
}

export function calendarPlugin(options: CalendarOptions): Plugin {
  const lead = (options.remindBefore ?? 30) * 60_000;
  const on = async (day: string) => parseIcs(await options.load()).filter((e) => dayKey(e.start) === day);
  return {
    name: "calendar",
    tools: [
      defineTool({
        name: "calendar",
        description: "The user's calendar events for today or tomorrow.",
        input: z.object({ day: z.enum(["today", "tomorrow"]).default("today") }),
        effect: "read",
        run: async ({ day }, ctx) => {
          const at = ctx.now() + (day === "tomorrow" ? 86_400_000 : 0);
          const events = await on(dayKey(at));
          return events.length ? events.map(describeEvent).join("\n") : `${day === "today" ? "今天" : "明天"}没有日程`;
        },
      }),
    ],
    async briefing(ctx) {
      const events = await on(dayKey(ctx.now()));
      return events.length ? { title: "今天的日程", lines: events.map(describeEvent) } : undefined;
    },
    async tick(ctx) {
      // Unasked: shortly before a timed event, say it is coming. Once per event.
      const now = ctx.now();
      const reminded = new Set(
        [...ctx.state.offers.values()].filter((r) => r.offer.kind === "calendar.soon").map((r) => r.offer.title),
      );
      for (const e of await on(dayKey(now))) {
        if (e.allDay || e.start <= now || e.start - now > lead) continue;
        const title = `${clock(e.start)} ${e.summary}`;
        if (reminded.has(title)) continue;
        ctx.offer({
          kind: "calendar.soon",
          title,
          body: `${Math.round((e.start - now) / 60_000)} 分钟后开始${e.location ? `，在${e.location}` : ""}`,
          value: 0.85,
          urgency: "now",
          expiresAt: e.start,
        });
      }
    },
  };
}
