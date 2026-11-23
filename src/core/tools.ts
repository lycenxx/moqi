import { z } from "zod";
import { LEVELS } from "./autonomy.js";
import { FACT_KINDS, OUTSIDE } from "./memory.js";
import { defineTool, type Tool } from "./plugin.js";
import { dayKey, describeSchedule, nextRun, validateSchedule } from "./schedule.js";
import {
  describeAdded,
  describeTodo,
  laterTodos,
  openTodos,
  recentlyDone,
  resolveWhen,
  TODO,
  todayTodos,
  todoChange,
} from "./todo.js";
import { newId, type Schedule, type Todo, type Watch } from "./types.js";

/** What built-in tools need from moqi. */
export interface Kernel {
  now(): number;
  remember(input: { kind: (typeof FACT_KINDS)[number]; content: string; contradicts?: string; by?: string }): string;
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

const When = {
  day: z.string().optional().describe("today, tomorrow or YYYY-MM-DD (local). Default today"),
  at: z.string().optional().describe("HH:MM local time to remind the user. Leave out for no reminder"),
  inMinutes: z.number().int().min(1).max(1440).optional().describe("Remind this many minutes from now, instead of at"),
};

function todoProblem(k: Kernel, id: string, mustBeOpen = true): string | undefined {
  const t = k.state.todos.get(id);
  if (!t || t.removedAt !== undefined) return `没有 ${id} 这件待办`;
  if (mustBeOpen && t.doneAt !== undefined) return "这件已经做完了";
  return undefined;
}

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
      local: true,
      start: "auto",
      cap: "auto",
      // Kept after reading outside content, it is marked: it may be what a page told the model to remember.
      run: (a, ctx) => k.remember({ ...(a as Parameters<Kernel["remember"]>[0]), ...(ctx.tainted && { by: OUTSIDE }) }),
    }),
    defineTool({
      // Not local: memories, todos and watch results can hold other agents' words and fetched text.
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
      local: true,
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
      local: true,
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
      local: true,
      describe: ({ id }) => `停掉「${k.state.watches.get(id)?.title ?? id}」`,
      run: ({ id }) => {
        const w = k.state.watches.get(id);
        if (!w) return `没有 ${id}`;
        k.emit({ type: "watch.cancelled", watchId: id });
        return `已停掉「${w.title}」`;
      },
    }),
    defineTool({
      name: "todo_add",
      description:
        "Put something the user means to do on their todo list, for a day (default today), and remind them at a time if they want (at, or inMinutes). Use it for 提醒我…, 记一下…, and things the user says they have to do. Repeating reminders (every day, every week) are watch_create.",
      input: z.object({
        text: z.string().trim().min(1).max(TODO.maxText),
        ...When,
        by: z.string().max(40).optional().describe("Leave out"),
      }),
      effect: "write",
      local: true,
      start: "auto", // the user asked for it, and it is undone with one tap
      cap: "auto",
      describe: (a) => `记下待办「${a.text}」`,
      validate: (a) => {
        if (openTodos(k.state).length >= TODO.maxOpen) return `未完成的待办已经有 ${TODO.maxOpen} 条了，先清理一些`;
        const w = resolveWhen(a, k.now());
        return typeof w === "string" ? w : undefined;
      },
      run: (a) => {
        const now = k.now();
        const w = resolveWhen(a, now);
        if (typeof w === "string") return w;
        const todo: Todo = {
          id: newId("t"),
          text: a.text,
          day: w.day,
          ...(w.remindAt !== undefined && { remindAt: w.remindAt }),
          ...(a.by && { by: a.by }),
          createdAt: now,
        };
        k.emit({ type: "todo.added", todo });
        return `记下了：${describeAdded(todo, now)}（${todo.id}）`;
      },
    }),
    defineTool({
      name: "todo_list",
      description: "The user's todo list with ids: today (including what was put off), later, and done today.",
      input: z.object({}),
      effect: "read",
      run: () => {
        const now = k.now();
        const line = (t: Todo) => `[${t.id}] ${describeTodo(t, now)}`;
        const today = todayTodos(k.state, now).map(line);
        const later = laterTodos(k.state, now).map(line);
        const done = recentlyDone(k.state, now)
          .filter((t) => t.doneAt !== undefined && dayKey(t.doneAt) === dayKey(now))
          .map((t) => `[${t.id}] ${t.text}`);
        if (today.length + later.length + done.length === 0) return "（没有待办）";
        return [
          `今天：\n${today.join("\n") || "（没有）"}`,
          later.length ? `以后：\n${later.join("\n")}` : "",
          done.length ? `今天做完的：\n${done.join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      },
    }),
    defineTool({
      name: "todo_done",
      description: "Mark one of the user's todos done, by id.",
      input: z.object({ id: z.string() }),
      effect: "write",
      local: true,
      start: "auto",
      cap: "auto",
      describe: ({ id }) => `勾掉「${k.state.todos.get(id)?.text ?? id}」`,
      validate: ({ id }) => todoProblem(k, id),
      run: ({ id }) => {
        const text = k.state.todos.get(id)?.text ?? id;
        k.emit({ type: "todo.done", todoId: id });
        const left = todayTodos(k.state, k.now()).length;
        return `勾掉了「${text}」${left ? `，今天还剩 ${left} 件` : "，今天的都做完了"}`;
      },
    }),
    defineTool({
      name: "todo_undone",
      description: "Mark a done todo as not done again.",
      input: z.object({ id: z.string() }),
      effect: "write",
      local: true,
      start: "auto",
      cap: "auto",
      hidden: true, // the console's checkbox; the model has todo_add for anything new
      validate: ({ id }) =>
        todoProblem(k, id, false) ?? (k.state.todos.get(id)?.doneAt === undefined ? "这件还没做完" : undefined),
      run: ({ id }) => {
        k.emit({ type: "todo.undone", todoId: id });
        return `「${k.state.todos.get(id)?.text ?? id}」改回没做完`;
      },
    }),
    defineTool({
      name: "todo_update",
      description:
        "Change one of the user's todos by id: its text, its day (moving it keeps the reminder's time of day), or its reminder (at, inMinutes, or at: null to drop it).",
      input: z.object({
        id: z.string(),
        text: z.string().trim().min(1).max(TODO.maxText).optional(),
        day: When.day,
        at: z.string().nullable().optional().describe("HH:MM local time to remind, or null to drop the reminder"),
        inMinutes: When.inMinutes,
      }),
      effect: "write",
      local: true,
      start: "auto",
      cap: "auto",
      describe: ({ id }) => `改待办「${k.state.todos.get(id)?.text ?? id}」`,
      validate: (a) => {
        const problem = todoProblem(k, a.id);
        const t = k.state.todos.get(a.id);
        if (problem || !t) return problem;
        const change = todoChange(t, a, k.now());
        return typeof change === "string" ? change : undefined;
      },
      run: (a) => {
        const now = k.now();
        const t = k.state.todos.get(a.id);
        if (!t) return `没有 ${a.id} 这件待办`;
        const change = todoChange(t, a, now);
        if (typeof change === "string") return change;
        k.emit({ type: "todo.updated", todoId: a.id, ...change });
        const after = k.state.todos.get(a.id) ?? t;
        return `改好了：${describeAdded(after, now)}`;
      },
    }),
    defineTool({
      name: "todo_remove",
      description: "Delete one of the user's todos by id, when they no longer mean to do it.",
      input: z.object({ id: z.string() }),
      effect: "write",
      local: true,
      describe: ({ id }) => `删掉待办「${k.state.todos.get(id)?.text ?? id}」`,
      validate: ({ id }) => todoProblem(k, id, false),
      run: ({ id }) => {
        const text = k.state.todos.get(id)?.text ?? id;
        k.emit({ type: "todo.removed", todoId: id });
        return `删掉了「${text}」`;
      },
    }),
    defineTool({
      name: "set_level",
      description: "Change how freely moqi may do one kind of action.",
      input: z.object({ kind: z.string(), level: z.enum(LEVELS as [string, ...string[]]) }),
      effect: "write",
      local: true,
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
      local: true,
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
