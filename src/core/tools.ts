import { z } from "zod";
import { LEVELS } from "./autonomy.js";
import { FACT_KINDS } from "./memory.js";
import { defineTool, type Tool } from "./plugin.js";
import { describeSchedule, nextRun, validateSchedule } from "./schedule.js";
import { newId, type Schedule, type Watch } from "./types.js";

/** What built-in tools need from moqi. */
export interface Kernel {
  now(): number;
  remember(input: { kind: (typeof FACT_KINDS)[number]; content: string; contradicts?: string }): string;
  emit: (body: import("./types.js").EventBody) => void;
  readonly state: import("./state.js").State;
  toolNames(): string[];
  isReadTool(name: string): boolean;
  readTools(): string[];
}

export const ScheduleInput = z.discriminatedUnion("every", [
  z.object({ every: z.literal("day"), at: z.string().describe("HH:MM, local time") }),
  z.object({
    every: z.literal("week"),
    days: z.array(z.number().int().min(0).max(6)).min(1).describe("0 = Sunday"),
    at: z.string(),
  }),
  z.object({ every: z.literal("hours"), hours: z.number().int().min(1).max(168) }),
]);

const WatchInput = z.object({
  title: z.string().min(1).describe("What this watch is for, e.g. 每天早上的天气"),
  schedule: ScheduleInput,
  tool: z.string().optional().describe("A read tool to call each time, e.g. weather. Omit for a plain reminder."),
  args: z.record(z.string(), z.unknown()).default({}).describe("Arguments for the tool"),
  remind: z.string().optional().describe("Reminder text, when there is no tool"),
  notify: z.enum(["on-change", "always"]).default("on-change"),
});

// biome-ignore lint/suspicious/noExplicitAny: each built-in tool has its own argument type
export function builtinTools(k: Kernel): Tool<any>[] {
  return [
    defineTool({
      name: "remember",
      description:
        "Remember one fact about the user that will matter later. One fact per call, as a full sentence that names the relation, e.g. 住在深圳南山 / 在一家互联网公司做产品 / 女儿叫朵朵，5 岁.",
      input: z.object({
        kind: z.enum(FACT_KINDS as [string, ...string[]]),
        content: z.string().min(1).max(200),
        contradicts: z.string().optional().describe("id of a remembered fact this replaces"),
      }),
      effect: "write",
      start: "auto",
      cap: "auto",
      run: (a) => k.remember(a as never),
    }),
    defineTool({
      name: "list_memories",
      description: "List what you remember about the user, with ids.",
      input: z.object({}),
      effect: "read",
      run: () => [...k.state.facts.values()].map((f) => `[${f.id}] ${f.content}`).join("\n") || "（还没有记住任何事）",
    }),
    defineTool({
      name: "forget",
      description: "Forget a remembered fact by id, when the user asks to.",
      input: z.object({ id: z.string() }),
      effect: "write",
      cap: "suggest",
      describe: ({ id }) => `忘掉「${k.state.facts.get(id)?.content ?? id}」`,
      run: ({ id }) => {
        const fact = k.state.facts.get(id);
        if (!fact) return `没有 ${id} 这一条`;
        k.emit({ type: "fact.forgotten", factId: id });
        return `已忘掉：${fact.content}`;
      },
    }),
    defineTool({
      name: "watch_create",
      description:
        "Keep an eye on something for the user on a schedule (daily weather, a price, a reminder). moqi runs it in the background and speaks up when the result changes, or every time with notify=always.",
      input: WatchInput,
      effect: "write",
      describe: (a) => {
        try {
          const when = describeSchedule(validateSchedule(a.schedule as Schedule));
          if (!a.tool) return `${when}提醒你「${a.remind ?? a.title}」`;
          return `${when}替你查「${a.title}」${a.notify === "always" ? "并告诉你" : "，有变化时告诉你"}`;
        } catch {
          return `替你留意「${a.title}」`;
        }
      },
      validate: (a) => {
        try {
          validateSchedule(a.schedule as Schedule);
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        if (!a.tool && !a.remind) return "要么填 tool（定时查的只读工具），要么填 remind（提醒的话）";
        if (a.tool && !k.isReadTool(a.tool))
          return `没有叫 ${a.tool} 的只读工具，可用的有：${k.readTools().join("、") || "无"}`;
        if (k.state.watches.size >= 20) return "托管的事已经有 20 件了，先停掉一些";
        return undefined;
      },
      run: (a) => {
        const schedule = validateSchedule(a.schedule as Schedule);
        const watch: Watch = {
          id: newId("w"),
          title: a.title,
          schedule,
          check: a.tool ? { tool: a.tool, args: a.args } : { remind: a.remind as string },
          notify: a.tool ? a.notify : "always",
          nextAt: nextRun(schedule, k.now()),
        };
        k.emit({ type: "watch.created", watch });
        return `好，${describeSchedule(schedule)}替你${a.tool ? "看" : "提醒"}「${a.title}」（${watch.id}）`;
      },
    }),
    defineTool({
      name: "watch_list",
      description: "List the things you keep an eye on for the user.",
      input: z.object({}),
      effect: "read",
      run: () =>
        [...k.state.watches.values()]
          .map(
            (w) => `[${w.id}] ${w.title}，${describeSchedule(w.schedule)}${w.last ? `，上次：${w.last.headline}` : ""}`,
          )
          .join("\n") || "（没有托管的事）",
    }),
    defineTool({
      name: "watch_cancel",
      description: "Stop keeping an eye on something, by id.",
      input: z.object({ id: z.string() }),
      effect: "write",
      describe: ({ id }) => `停掉「${k.state.watches.get(id)?.title ?? id}」`,
      run: ({ id }) => {
        const w = k.state.watches.get(id);
        if (!w) return `没有 ${id}`;
        k.emit({ type: "watch.cancelled", watchId: id });
        return `已停掉「${w.title}」`;
      },
    }),
    defineTool({
      name: "set_level",
      description: "Change how freely moqi may do one kind of action.",
      input: z.object({ kind: z.string(), level: z.enum(LEVELS as [string, ...string[]]) }),
      effect: "write",
      hidden: true,
      run: ({ kind, level }) => {
        k.emit({ type: "level.changed", kind, level: level as never });
        return `以后「${kind}」这类事：${level === "auto-undo" ? "直接办，办完告诉你" : level}`;
      },
    }),
    defineTool({
      name: "resolve_conflict",
      description: "Settle a contradiction in the user model.",
      input: z.object({ id: z.string(), keep: z.enum(["old", "new"]) }),
      effect: "write",
      hidden: true,
      run: ({ id, keep }) => {
        const c = k.state.conflicts.get(id);
        if (!c) return "这条已经定过了";
        k.emit({ type: "fact.resolved", factId: id, keep });
        return `记下了：${keep === "new" ? c.new : c.old}`;
      },
    }),
  ];
}
