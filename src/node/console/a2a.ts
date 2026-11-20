// A2A (Agent2Agent): other agents find moqi through its agent card and send it messages over JSON-RPC.
// moqi speaks A2A 1.0 (SendMessage) and still understands 0.3 clients (message/send). It answers with a
// message, never a long-running task: a question for the user waits in moqi's console, so the reply
// may take a while.

export const A2A_PATH = "/a2a";
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";

export function agentCard(origin: string, version: string): Record<string, unknown> {
  return {
    name: "moqi",
    description:
      "The user's personal agent. It knows the user (where they live and work, family, preferences, routines, what they are busy with) and what is going on for them (calendar, weather, news), and it reaches them through their own attention rules. Ask it about the user before personalizing your work, or tell it something the user should know.",
    version,
    supportedInterfaces: [{ url: `${origin}${A2A_PATH}`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    provider: { organization: "moqi", url: "https://github.com/wangcao-hub/moqi" },
    documentationUrl: "https://github.com/wangcao-hub/moqi#readme",
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: {
      moqiKey: { httpAuthSecurityScheme: { scheme: "Bearer", description: "Run `moqi a2a` to get the key." } },
    },
    securityRequirements: [{ schemes: { moqiKey: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "about-the-user",
        name: "About the user",
        description: "Answers questions about the user from what moqi knows: profile, routines, today's plans.",
        tags: ["personal", "profile", "context"],
        examples: ["用户今天下午忙吗？", "What city does the user live in?"],
      },
      {
        id: "tell-the-user",
        name: "Tell the user",
        description: "Takes a message for the user and delivers it when it is worth their attention.",
        tags: ["notify", "attention"],
        examples: ["告诉用户：部署完成了"],
      },
    ],
  };
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export interface A2AHandler {
  /** One turn with moqi; `from` names the calling agent when it said who it is. */
  chat(text: string, from: string | undefined): Promise<string>;
  newId(): string;
}

const ERR = {
  parse: -32700,
  invalid: -32600,
  method: -32601,
  params: -32602,
  taskNotFound: -32001,
  unsupported: -32004,
};

/** Handles one A2A JSON-RPC request and returns the response body. */
export async function handleA2A(body: unknown, handler: A2AHandler): Promise<Record<string, unknown>> {
  const req = (body ?? {}) as Rpc;
  const id = req.id ?? null;
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return fail(ERR.invalid, "Invalid Request");
  const legacy = req.method.includes("/");
  switch (req.method) {
    case "SendMessage":
    case "message/send": {
      const message = (req.params?.message ?? {}) as Record<string, unknown>;
      const parts = Array.isArray(message.parts) ? (message.parts as Record<string, unknown>[]) : [];
      const text = parts
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("\n")
        .trim();
      if (!text) return fail(ERR.params, "The message needs a text part");
      const meta = (message.metadata ?? req.params?.metadata ?? {}) as Record<string, unknown>;
      const from = typeof meta.from === "string" ? meta.from : typeof meta.agent === "string" ? meta.agent : undefined;
      let reply: string;
      try {
        reply = await handler.chat(text, from);
      } catch (error) {
        return fail(-32603, error instanceof Error ? error.message : String(error));
      }
      const contextId =
        typeof message.contextId === "string" && message.contextId ? message.contextId : handler.newId();
      const out = legacy
        ? {
            kind: "message",
            messageId: handler.newId(),
            contextId,
            role: "agent",
            parts: [{ kind: "text", text: reply }],
          }
        : { messageId: handler.newId(), contextId, role: "ROLE_AGENT", parts: [{ text: reply }] };
      return { jsonrpc: "2.0", id, result: legacy ? out : { message: out } };
    }
    case "GetTask":
    case "CancelTask":
    case "SubscribeToTask":
    case "tasks/get":
    case "tasks/cancel":
    case "tasks/resubscribe":
      return fail(ERR.taskNotFound, "moqi answers with messages and keeps no tasks");
    case "SendStreamingMessage":
    case "message/stream":
    case "ListTasks":
    case "CreateTaskPushNotificationConfig":
    case "GetTaskPushNotificationConfig":
    case "ListTaskPushNotificationConfigs":
    case "DeleteTaskPushNotificationConfig":
    case "GetExtendedAgentCard":
      return fail(ERR.unsupported, `${req.method} is not supported by moqi`);
    default:
      return fail(ERR.method, `Method not found: ${req.method}`);
  }
}
