// Other agents talk to moqi over A2A. The official A2A client finds moqi by its agent card and sends it
// messages, the way an agent built on any A2A SDK would.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { afterEach, describe, expect, it } from "vitest";
import { type Console, confirmQueue, startConsole } from "../src/node/console/server.js";
import { type Home, openHome } from "../src/node/home.js";

const KEY = "k".repeat(32);
const open: { home: Home; ui: Console }[] = [];

async function start(reply: (text: string) => string = (t) => `收到：${t}`) {
  const dir = mkdtempSync(join(tmpdir(), "moqi-a2a-"));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ model: { baseURL: "http://model.test/v1", model: "m" }, briefingAt: null, news: { feeds: [] } }),
  );
  const seen: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const last = body.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    seen.push(last);
    return Response.json({ choices: [{ message: { content: reply(last) } }] });
  }) as typeof fetch;
  const asker = confirmQueue();
  const home = openHome({
    home: dir,
    notifier: async () => {},
    fetch: fetchImpl,
    confirm: (q) => asker.ask(q),
    agents: false,
  });
  const ui = await startConsole({
    home,
    asker,
    token: "t".repeat(32),
    a2aKey: KEY,
    version: "9.9.9",
    port: 0,
    env: {},
  });
  open.push({ home, ui });
  return { home, ui, seen, base: `http://127.0.0.1:${ui.port}` };
}

afterEach(async () => {
  for (const { home, ui } of open.splice(0)) {
    await ui.close();
    await home.moqi.idle();
    home.close();
  }
});

const rpc = (base: string, body: unknown, key = KEY) =>
  fetch(`${base}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  }) // biome-ignore lint/suspicious/noExplicitAny: tests read whatever shape each reply has
    .then(async (r) => ({ status: r.status, data: (await r.json()) as Record<string, any> }));

describe("moqi over A2A", () => {
  it("publishes an agent card that the official client reads and talks to (A2A 1.0)", async () => {
    const { base, seen, home } = await start();
    const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
    expect(card).toMatchObject({
      name: "moqi",
      version: "9.9.9",
      supportedInterfaces: [{ url: `${base}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: false },
    });
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(["about-the-user", "tell-the-user"]);

    const withKey: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${KEY}`);
      return fetch(input, { ...init, headers });
    };
    const client = await new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: withKey })],
    }).createFromUrl(base);
    const reply = (await client.sendMessage({
      message: {
        messageId: "m1",
        contextId: "c1",
        role: 1,
        parts: [{ content: { $case: "text", value: "用户住在哪？" } }],
      },
    } as never)) as { contextId: string; role: number; parts: { content: { $case: string; value: string } }[] };
    expect(reply.contextId).toBe("c1");
    expect(reply.role).toBe(2); // ROLE_AGENT
    expect(reply.parts[0]?.content).toEqual({ $case: "text", value: "收到：【另一个 agent】用户住在哪？" });
    expect(seen).toEqual(["【另一个 agent】用户住在哪？"]); // marked as another agent's words, not the user's
    const said = home.moqi.store.all().flatMap((e) => (e.type === "message" ? [e.text] : []));
    expect(said[0]).toBe("【另一个 agent】用户住在哪？");
  });

  it("still understands A2A 0.3 clients, and names the agent when it says who it is", async () => {
    const { base } = await start((t) => `好：${t}`);
    const r = await rpc(base, {
      jsonrpc: "2.0",
      id: 7,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: "x",
          role: "user",
          parts: [{ kind: "text", text: "部署完了" }],
          metadata: { from: "deploy-bot" },
        },
      },
    });
    expect(r.data).toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: { kind: "message", role: "agent", parts: [{ kind: "text", text: "好：【deploy-bot】部署完了" }] },
    });
    expect(typeof r.data.result.contextId).toBe("string");
  });

  it("needs its own key, and answers what it does not support with A2A errors", async () => {
    const { base } = await start();
    expect((await rpc(base, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: {} }, "t".repeat(32))).status).toBe(
      401,
    ); // the console key opens nothing here
    const call = (method: string, params: unknown = {}) => rpc(base, { jsonrpc: "2.0", id: 1, method, params });
    expect((await call("GetTask", { id: "t1" })).data.error.code).toBe(-32001);
    expect((await call("SendStreamingMessage")).data.error.code).toBe(-32004);
    expect((await call("Nope")).data.error.code).toBe(-32601);
    expect((await call("SendMessage", { message: { parts: [] } })).data.error.code).toBe(-32602);
  });

  it("is off without a key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moqi-a2a-"));
    const home = openHome({ home: dir, notifier: async () => {}, agents: false, lock: false });
    const ui = await startConsole({ home, asker: confirmQueue(), token: "t".repeat(32), port: 0, env: {} });
    open.push({ home, ui });
    expect((await fetch(`http://127.0.0.1:${ui.port}/.well-known/agent-card.json`)).status).toBe(404);
  });
});
