// moqi as an A2A client: other agents the user names become tools moqi can ask. Speaking to another
// agent shares what moqi says with it, so these tools are asked first until the user trusts them.
// Works with A2A 1.0 (SendMessage) and 0.3 (message/send) agents, chosen from their agent card.
import { z } from "zod";
import { defineTool, type Plugin } from "../core/plugin.js";

export interface RemoteAgent {
  readonly name: string;
  /** The agent's base URL, or the URL of its agent card. */
  readonly url: string;
  /** Sent as `Authorization: Bearer …` when the agent asks for one. */
  readonly key?: string;
}

interface Endpoint {
  readonly url: string;
  readonly legacy: boolean;
  readonly description: string;
}

type Part = { text?: unknown; kind?: unknown };

function texts(parts: unknown): string {
  return Array.isArray(parts)
    ? (parts as Part[])
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n")
    : "";
}

/** The text of whatever an agent answered: a message, or a task's status message and artifacts. */
export function replyText(result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  const message = (r.message ?? (r.kind === "message" || Array.isArray(r.parts) ? r : undefined)) as
    | Record<string, unknown>
    | undefined;
  if (message) return texts(message.parts);
  const task = (r.task ?? (r.kind === "task" || r.status ? r : undefined)) as Record<string, unknown> | undefined;
  if (task) {
    const status = (task.status ?? {}) as Record<string, unknown>;
    const said = texts((status.message as Record<string, unknown> | undefined)?.parts);
    const made = Array.isArray(task.artifacts)
      ? (task.artifacts as { parts?: unknown }[]).map((a) => texts(a.parts)).join("\n")
      : "";
    const state = typeof status.state === "string" ? status.state : "";
    return [said, made].filter(Boolean).join("\n") || (state ? `（对方的任务状态：${state}）` : "");
  }
  return "";
}

export function a2aPlugin(agents: readonly RemoteAgent[], fetchImpl: typeof fetch = fetch): Plugin {
  const endpoints = new Map<string, Endpoint>();

  const resolve = async (agent: RemoteAgent): Promise<Endpoint> => {
    const known = endpoints.get(agent.name);
    if (known) return known;
    const cardUrl = /agent(-card)?\.json$/.test(agent.url)
      ? agent.url
      : `${agent.url.replace(/\/+$/, "")}/.well-known/agent-card.json`;
    const response = await fetchImpl(cardUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`读不到 ${agent.name} 的 agent card（HTTP ${response.status}）`);
    const card = (await response.json()) as Record<string, unknown>;
    const interfaces = Array.isArray(card.supportedInterfaces)
      ? (card.supportedInterfaces as Record<string, unknown>[])
      : [];
    const rpc = interfaces.filter((i) => i.protocolBinding === "JSONRPC" && typeof i.url === "string");
    const v1 = rpc.find((i) => String(i.protocolVersion ?? "").startsWith("1"));
    const pick = v1 ?? rpc[0];
    let endpoint: Endpoint;
    if (pick) {
      endpoint = { url: String(pick.url), legacy: !v1, description: String(card.description ?? "") };
    } else if (typeof card.url === "string" && (card.preferredTransport ?? "JSONRPC") === "JSONRPC") {
      endpoint = { url: card.url, legacy: true, description: String(card.description ?? "") };
    } else {
      throw new Error(`${agent.name} 没有 JSON-RPC 接口，moqi 还不会用别的方式`);
    }
    endpoints.set(agent.name, endpoint);
    return endpoint;
  };

  return {
    name: "a2a",
    tools: agents.map((agent) =>
      defineTool({
        name: `ask_${agent.name}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
        description: `Ask the agent "${agent.name}" over A2A and return its answer. What you send is shared with that agent, so send only what it needs.`,
        input: z.object({ text: z.string().min(1).max(4000).describe("The message for that agent") }),
        effect: "write",
        danger: true, // what moqi sends leaves the computer
        source: agent.name,
        describe: ({ text }) => `问 ${agent.name}：「${text.slice(0, 60)}${text.length > 60 ? "…" : ""}」`,
        run: async ({ text }) => {
          const endpoint = await resolve(agent);
          const messageId = `moqi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const params = endpoint.legacy
            ? {
                message: {
                  kind: "message",
                  messageId,
                  role: "user",
                  parts: [{ kind: "text", text }],
                  metadata: { from: "moqi" },
                },
              }
            : { message: { messageId, role: "ROLE_USER", parts: [{ text }], metadata: { from: "moqi" } } };
          const response = await fetchImpl(endpoint.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(!endpoint.legacy && { "a2a-version": "1.0" }),
              ...(agent.key && { authorization: `Bearer ${agent.key}` }),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: messageId,
              method: endpoint.legacy ? "message/send" : "SendMessage",
              params,
            }),
            signal: AbortSignal.timeout(300_000),
          });
          const data = (await response.json().catch(() => ({}))) as { result?: unknown; error?: { message?: string } };
          if (!response.ok || data.error)
            throw new Error(data.error?.message ?? `${agent.name} 回答了 HTTP ${response.status}`);
          return replyText(data.result) || `（${agent.name} 没有回答文字）`;
        },
      }),
    ),
  };
}
