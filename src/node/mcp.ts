// `moqi mcp`: lets other agents (Kiro, Cursor, Claude Code, ...) talk to the user's moqi over the Model
// Context Protocol. It is a small stdio bridge to the running moqi, so the log keeps a single writer:
// the agents read what moqi knows about the user, tell it what they learned, and reach the user through
// moqi's attention rules instead of their own. JSON-RPC over stdio is written out here to keep moqi at two
// runtime dependencies.
import { createInterface } from "node:readline";

export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** Talks to the running moqi; `ensure` starts it when it is not running. */
export interface MoqiLink {
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>>;
}

interface ToolDef {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly readOnly: boolean;
  run(args: Record<string, unknown>, link: MoqiLink, client: string | undefined): Promise<string>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length && { required }),
  additionalProperties: false,
});

type Fact = { content: string; kind: string; term: string; confirmations: number; faded: boolean };
type OfferView = { id: string; kind: string; title: string; body: string; answer: boolean; links: { url: string }[] };

export const TOOLS: readonly ToolDef[] = [
  {
    name: "moqi_profile",
    title: "What moqi knows about the user",
    description:
      "The user's own profile kept by moqi, their personal agent: where they live, work, family, preferences, routines, what they are busy with, and what moqi watches for them. Read it before personalizing anything for the user.",
    inputSchema: obj({}),
    readOnly: true,
    run: async (_args, link) => {
      const s = (await link.call("GET", "/api/state")) as {
        facts: Fact[];
        watches: { title: string; schedule: string }[];
        lessons?: { content: string }[];
      };
      const facts = s.facts.filter((f) => !f.faded);
      const lines = facts.map((f) => `- ${f.content}${f.term === "long" ? "" : `（印证 ${f.confirmations}/3）`}`);
      const watches = s.watches.map((w) => `- ${w.title}（${w.schedule}）`);
      const lessons = (s.lessons ?? []).map((l) => `- ${l.content}`);
      return [
        facts.length ? `moqi 对用户的了解：\n${lines.join("\n")}` : "moqi 对用户还没有了解。",
        lessons.length ? `和用户相处的经验：\n${lessons.join("\n")}` : "",
        watches.length ? `moqi 正在替用户盯着：\n${watches.join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
    },
  },
  {
    name: "moqi_remember",
    title: "Tell moqi something about the user",
    description:
      "Record one lasting fact about the user that you learned while working with them (e.g. 'works on an open-source TypeScript agent framework', 'prefers answers in Chinese'). One fact per call, a full sentence. Not for one-off requests or secrets. moqi confirms repeated facts and asks the user when facts conflict.",
    inputSchema: obj(
      {
        content: { type: "string", description: "The fact, one sentence", maxLength: 200 },
        kind: { type: "string", enum: ["basic", "preference", "ongoing", "relation", "routine", "other"] },
      },
      ["content"],
    ),
    readOnly: false,
    run: async (args, link, client) =>
      String(
        (await link.call("POST", "/api/remember", { content: args.content, kind: args.kind, from: client })).message,
      ),
  },
  {
    name: "moqi_tell",
    title: "Tell the user something through moqi",
    description:
      "Ask moqi to tell the user something, e.g. that a long task finished or needs their decision. moqi decides how: a system notification if it is worth an interruption now, otherwise its feed; it respects quiet hours, a daily budget and what the user muted. Use urgency 'now' only when the user should act right away.",
    inputSchema: obj(
      {
        title: { type: "string", description: "One line the user sees first", maxLength: 120 },
        body: { type: "string", description: "Details", maxLength: 2000 },
        urgency: { type: "string", enum: ["now", "today", "whenever"], default: "today" },
        from: { type: "string", description: "Your name, e.g. cursor or kiro, so the user can mute you alone" },
      },
      ["title"],
    ),
    readOnly: false,
    run: async (args, link, client) => {
      const r = await link.call("POST", "/api/tell", { ...args, from: args.from ?? client });
      if (r.surface === "notify") return `已通知用户（${String(r.reason)}）`;
      if (r.surface === "feed") return `已放进用户的动态，没有打扰（${String(r.reason)}）`;
      return `moqi 没有转告：${String(r.reason)}`;
    },
  },
  {
    name: "moqi_todo",
    title: "Put something on the user's todo list",
    description:
      "Add a task the user needs to do to their todo list in moqi, e.g. 'review PR #12' tomorrow. With `at`, moqi reminds them at that time for sure, not only in its feed. Only for things the user would agree to; moqi shows that you added it.",
    inputSchema: obj(
      {
        text: { type: "string", description: "What to do, one line", maxLength: 200 },
        day: { type: "string", description: "today, tomorrow or YYYY-MM-DD; default today" },
        at: { type: "string", description: "HH:MM local time to remind the user; leave out for no reminder" },
      },
      ["text"],
    ),
    readOnly: false,
    run: async (args, link, client) => {
      const r = await link.call("POST", "/api/todo/add", {
        text: args.text,
        day: args.day,
        at: args.at,
        by: client ?? "另一个 agent",
      });
      return `已加进用户的待办。${String(r.message)}`;
    },
  },
  {
    name: "moqi_ask",
    title: "Talk to moqi",
    description:
      "Send a message to moqi, the user's personal agent, and get its reply. It answers from what it knows about the user and can use its tools (weather, calendar, news, reminders). The message becomes part of the user's conversation with moqi, so write it as yourself, e.g. '我是 Cursor，用户今天的日程忙吗？'. Actions that change something still wait for the user's approval in moqi's console.",
    inputSchema: obj({ text: { type: "string", maxLength: 4000 } }, ["text"]),
    readOnly: false,
    run: async (args, link, client) =>
      String((await link.call("POST", "/api/chat", { text: args.text, from: client ?? "另一个 agent" })).reply),
  },
  {
    name: "moqi_feed",
    title: "What moqi wants to tell the user",
    description: "What moqi is waiting to tell the user or ask them: ideas, questions, news, reminders.",
    inputSchema: obj({}),
    readOnly: true,
    run: async (_args, link) => {
      const s = (await link.call("GET", "/api/state")) as { offers: OfferView[] };
      if (s.offers.length === 0) return "moqi 现在没有要告诉用户的事。";
      return s.offers
        .map(
          (o) =>
            `- ${o.answer ? "【问题】" : ""}${o.title}${o.body ? `：${o.body}` : ""}${o.links[0] ? ` ${o.links[0].url}` : ""}`,
        )
        .join("\n");
    },
  },
  {
    name: "moqi_briefing",
    title: "Today's briefing",
    description:
      "The user's briefing for today from moqi: calendar, weather, things moqi keeps for them, decisions waiting.",
    inputSchema: obj({}),
    readOnly: true,
    run: async (_args, link) => {
      const b = await link.call("GET", "/api/briefing");
      return `${String(b.title)}\n${String(b.body)}`;
    },
  },
];

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** Handles one JSON-RPC message; returns the reply, or undefined for notifications. */
export interface McpSession {
  /** The calling agent's name from its handshake, e.g. "cursor" or "kiro-cli". */
  client?: string;
}

export async function handleMcp(
  message: Rpc,
  link: MoqiLink,
  version: string,
  session: McpSession = {},
): Promise<Record<string, unknown> | undefined> {
  const { id, method, params } = message;
  if (id === undefined || id === null) return undefined; // a notification, e.g. notifications/initialized
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, msg: string) => ({ jsonrpc: "2.0", id, error: { code, message: msg } });
  switch (method) {
    case "initialize": {
      const asked = String(params?.protocolVersion ?? "");
      const info = params?.clientInfo as { name?: unknown } | undefined;
      if (typeof info?.name === "string" && info.name.trim()) session.client = info.name.trim().slice(0, 40);
      return ok({
        protocolVersion: (MCP_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "moqi", title: "moqi", version },
        instructions:
          "moqi is the user's personal agent and keeps a profile of them. Read moqi_profile to personalize your work; when you learn a lasting fact about the user, record it with moqi_remember; to reach the user when they are away, use moqi_tell; to put a task on their list, use moqi_todo.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnly, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(params?.name)}`);
      try {
        const text = await tool.run((params?.arguments ?? {}) as Record<string, unknown>, link, session.client);
        return ok({ content: [{ type: "text", text }] });
      } catch (error) {
        return ok({
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${String(method)}`);
  }
}

/** Reads newline-delimited JSON-RPC from stdin and answers on stdout. Logs go to stderr only. */
export async function serveMcp(link: MoqiLink, version: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const pending = new Set<Promise<void>>();
  const session: McpSession = {};
  const write = (reply: unknown) => process.stdout.write(`${JSON.stringify(reply)}\n`);
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let message: Rpc;
    try {
      message = JSON.parse(line) as Rpc;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    // Calls run side by side: a long moqi_ask must not hold up a ping.
    const job: Promise<void> = handleMcp(message, link, version, session)
      .then((reply) => {
        if (reply) write(reply);
      })
      .finally(() => pending.delete(job));
    pending.add(job);
  }
  await Promise.all(pending);
}
