// moqi using other agents' tools and agents: MCP servers become its tools, and A2A agents can be asked.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Console, confirmQueue, startConsole } from "../src/node/console/server.js";
import { type Home, openHome } from "../src/node/home.js";
import { replyText } from "../src/plugins/a2a.js";

const fixture = join(import.meta.dirname, "fixtures", "echo-mcp.mjs");
const homes: Home[] = [];
const consoles: Console[] = [];

afterEach(async () => {
  for (const ui of consoles.splice(0)) await ui.close();
  for (const home of homes.splice(0)) {
    await home.moqi.idle();
    home.close();
  }
});

/** A model that calls one tool with the given arguments, then answers with what the tool said. */
function oneToolModel(tool: string, args: Record<string, unknown>) {
  const asked: { messages: { role: string; content: string }[] }[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    asked.push(body);
    const last = body.messages.at(-1);
    if (last.role === "tool") return Response.json({ choices: [{ message: { content: `结果：${last.content}` } }] });
    if (last.role === "user" && body.tools)
      return Response.json({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "c1", function: { name: tool, arguments: JSON.stringify(args) } }],
            },
          },
        ],
      });
    return Response.json({ choices: [{ message: { content: "好" } }] });
  }) as typeof fetch;
  return { impl, asked };
}

function home(
  config: Record<string, unknown>,
  fetchImpl?: typeof fetch,
  confirm: (q: string) => Promise<boolean> = async () => true,
) {
  const dir = mkdtempSync(join(tmpdir(), "moqi-interop-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ briefingAt: null, news: { feeds: [] }, ...config }));
  const h = openHome({
    home: dir,
    notifier: async () => {},
    agents: false,
    lock: false,
    confirm,
    ...(fetchImpl && { fetch: fetchImpl }),
  });
  homes.push(h);
  return h;
}

const MODEL = { baseURL: "http://model.test/v1", model: "m" };
const ECHO = { echo: { command: process.execPath, args: [fixture] } };

describe("moqi uses MCP servers", () => {
  it("turns a server's tools into its own, read-only ones free and the rest asked first", async () => {
    const h = home({ mcp: { servers: ECHO } });
    await waitFor(() => h.mcpStatus()[0]?.state === "ready");
    expect(h.mcpStatus()[0]).toMatchObject({
      name: "echo",
      state: "ready",
      tools: ["echo__echo", "echo__save_note", "echo__broken", "echo__crash"],
    });
    expect(h.moqi.tool("echo__echo")?.effect).toBe("read");
    expect(h.moqi.tool("echo__save_note")?.effect).toBe("write");
    expect(h.moqi.tool("echo__save_note")).toMatchObject({ danger: true, source: "echo" });
    expect(h.moqi.tool("echo__echo")?.danger).toBeUndefined();
    expect(h.moqi.dangerousTools().map((t) => t.name)).toEqual(["echo__save_note", "echo__broken", "echo__crash"]);
    expect(h.moqi.watchableTools().map((t) => t.name)).toContain("echo__echo"); // a watch can use it

    expect(await h.moqi.callTool("echo__echo", { text: "你好" }, { byUser: false })).toBe("echo: 你好");
    expect(await h.moqi.callTool("echo__broken", {}, { byUser: false })).toBe("出错了：disk full");
  });

  it("lets the model call them in chat with the server's own schema", async () => {
    const model = oneToolModel("echo__echo", { text: "天气" });
    const h = home({ model: MODEL, mcp: { servers: ECHO } }, model.impl);
    await waitFor(() => h.mcpStatus()[0]?.state === "ready");
    expect(await h.moqi.chat("帮我回声一下")).toBe("结果：echo: 天气");
    const spec = model.asked[0] as unknown as {
      tools: { function: { name: string; parameters: { properties: object } } }[];
    };
    const echo = spec.tools.find((t) => t.function.name === "echo__echo");
    expect(Object.keys(echo?.function.parameters.properties ?? {})).toEqual(["text"]);
  });

  it("asks before a tool the server does not call read-only", async () => {
    const asked: string[] = [];
    const h = home({ mcp: { servers: ECHO } }, undefined, async (q: string) => {
      asked.push(q);
      return false;
    });
    await waitFor(() => h.mcpStatus()[0]?.state === "ready");
    expect(await h.moqi.callTool("echo__save_note", { note: "x" }, { byUser: false })).toBe("用户没有同意，这一步没做");
    expect(asked[0]).toContain("用 echo 的「save note」");
  });

  it("reports a server that dies, and stops servers removed from the config", async () => {
    const h = home({ mcp: { servers: { ...ECHO, bad: { command: "/nonexistent/mcp-server" } } } });
    await waitFor(() => h.mcpStatus().every((s) => s.state !== "starting"));
    expect(h.mcpStatus().find((s) => s.name === "bad")).toMatchObject({ state: "failed" });
    await h.moqi.callTool("echo__crash", {}, { byUser: false });
    await waitFor(() => h.mcpStatus().find((s) => s.name === "echo")?.state === "failed");
    expect(h.moqi.tool("echo__echo")).toBeUndefined(); // its tools are gone once moqi notices

    await h.reconfigure({ ...h.config, mcp: { servers: {} } });
    expect(h.mcpStatus()).toEqual([]);
  });

  it("survives a server that stops reading what moqi writes", async () => {
    const deaf = join(import.meta.dirname, "fixtures", "deaf-mcp.mjs");
    const h = home({ mcp: { servers: { deaf: { command: process.execPath, args: [deaf] } } } });
    await waitFor(() => h.mcpStatus().every((s) => s.state !== "starting"));
    expect(h.mcpStatus()).toMatchObject([{ name: "deaf", state: "failed" }]);
  });
});

describe("moqi asks other agents over A2A", () => {
  it("one moqi asks another, which answers from what it knows", async () => {
    // Bob: a moqi that knows something and serves A2A.
    const bobFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const q = body.messages.at(-1).content as string;
      return Response.json({
        choices: [{ message: { content: `Bob 说：${q.includes("几点") ? "下午三点开会" : "不知道"}` } }],
      });
    }) as typeof fetch;
    const bob = home({ model: MODEL }, bobFetch);
    const ui = await startConsole({
      home: bob,
      asker: confirmQueue(),
      token: "t".repeat(32),
      a2aKey: "b".repeat(32),
      version: "1",
      port: 0,
      env: {},
    });
    consoles.push(ui);
    const bobUrl = `http://127.0.0.1:${ui.port}`;

    // Alice: a moqi that knows Bob as an A2A agent.
    const aliceModel = oneToolModel("ask_bob", { text: "明天几点开会？" });
    const alice = home({ model: MODEL, a2a: { agents: [{ name: "bob", url: bobUrl, key: "b".repeat(32) }] } }, (async (
      url,
      init,
    ) =>
      String(url).startsWith("http://model.test") ? aliceModel.impl(url, init) : fetch(url, init)) as typeof fetch);
    expect(alice.moqi.tool("ask_bob")).toMatchObject({ danger: true, source: "bob" });
    expect(await alice.moqi.chat("问问 Bob 明天几点开会")).toBe("结果：Bob 说：下午三点开会");
    const bobHeard = bob.moqi.store.all().flatMap((e) => (e.type === "message" && e.role === "user" ? [e.text] : []));
    expect(bobHeard).toEqual(["【moqi】明天几点开会？"]);
  });

  it("reads answers from 0.3 agents and from tasks", () => {
    expect(replyText({ kind: "message", parts: [{ kind: "text", text: "旧版" }] })).toBe("旧版");
    expect(replyText({ message: { parts: [{ text: "新版" }] } })).toBe("新版");
    expect(
      replyText({
        task: {
          status: { state: "TASK_STATE_COMPLETED", message: { parts: [{ text: "做完了" }] } },
          artifacts: [{ parts: [{ text: "报告" }] }],
        },
      }),
    ).toBe("做完了\n报告");
    expect(replyText({ kind: "task", status: { state: "working" } })).toBe("（对方的任务状态：working）");
  });
});

async function waitFor(ok: () => boolean, ms = 10_000) {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 30)); // let moqi rebuild with the new tools
}
