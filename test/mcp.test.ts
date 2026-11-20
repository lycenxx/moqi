// Other agents talk to moqi over MCP. These tests drive `moqi mcp` with the official MCP client, the way
// Kiro, Cursor or Claude Code would, against a real background moqi.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileEventStore, lockHolder } from "../src/node/file-store.js";
import { handleMcp, type MoqiLink } from "../src/node/mcp.js";

const cli = join(import.meta.dirname, "..", "dist", "node", "cli.js");
const home = mkdtempSync(join(tmpdir(), "moqi-mcp-"));
const env = { ...process.env, MOQI_HOME: home, MOQI_BASE_URL: "", MOQI_MODEL: "", MOQI_NO_OPEN: "1" } as Record<
  string,
  string
>;
let client: Client;

beforeAll(async () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ briefingAt: null, news: { feeds: [] } }));
  // Something moqi already knows, written before it starts.
  const store = fileEventStore(join(home, "events.jsonl"));
  const fact = {
    id: "f_1",
    kind: "basic",
    content: "住在深圳南山",
    confirmations: 1,
    createdAt: 1,
    lastSeenAt: Date.now(),
    term: "short",
  };
  store.append({ type: "fact.added", fact, id: "e_1", at: Date.now() } as never);
  client = new Client({ name: "test-agent", version: "1.0.0" });
  // moqi is not running yet: the first call starts it in the background.
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], env, stderr: "ignore" }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  spawnSync(process.execPath, [cli, "stop"], { env, encoding: "utf8" });
  const pid = lockHolder(home);
  if (pid) process.kill(pid, "SIGTERM");
});

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "") as string;

describe("moqi over MCP", () => {
  it("introduces itself and lists its tools with read-only hints", async () => {
    expect(client.getServerVersion()?.name).toBe("moqi");
    expect(client.getInstructions()).toContain("moqi_profile");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "moqi_profile",
      "moqi_remember",
      "moqi_tell",
      "moqi_ask",
      "moqi_feed",
      "moqi_briefing",
    ]);
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(hints).toMatchObject({ moqi_profile: true, moqi_remember: false, moqi_tell: false, moqi_feed: true });
  });

  it("starts moqi when needed, shares the profile, and learns from other agents", async () => {
    expect(text(await client.callTool({ name: "moqi_profile", arguments: {} }))).toContain("住在深圳南山");
    expect(lockHolder(home)).toBeGreaterThan(0); // the background moqi owns the log
    const added = await client.callTool({
      name: "moqi_remember",
      arguments: { content: "在做一个开源的 TypeScript agent 框架", kind: "ongoing" },
    });
    expect(text(added)).toContain("记住了");
    const again = await client.callTool({
      name: "moqi_remember",
      arguments: { content: "在做一个开源的 TypeScript agent 框架" },
    });
    expect(text(again)).toContain("又印证了一次");
    expect(text(await client.callTool({ name: "moqi_profile", arguments: {} }))).toContain(
      "开源的 TypeScript agent 框架（印证 2/3）",
    );
  });

  it("reaches the user through moqi's attention rules, per agent", async () => {
    const told = await client.callTool({
      name: "moqi_tell",
      arguments: { title: "构建跑完了", body: "全部测试通过", urgency: "whenever", from: "Cursor IDE" },
    });
    expect(text(told)).toContain("已放进用户的动态");
    expect(text(await client.callTool({ name: "moqi_feed", arguments: {} }))).toContain("构建跑完了：全部测试通过");
    const s = (await (await fetch(stateUrl(), { headers: headers() })).json()) as { offers: { kind: string }[] };
    expect(s.offers.map((o) => o.kind)).toContain("agent.cursor-ide"); // the user can mute one agent alone
  });

  it("reports moqi's own errors as tool errors, not protocol failures", async () => {
    const r = await client.callTool({ name: "moqi_ask", arguments: { text: "你好" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("还没配置模型");
    expect(text(await client.callTool({ name: "moqi_briefing", arguments: {} }))).toMatch(/今天的简报/);
  });
});

function stateUrl() {
  const info = JSON.parse(spawnSync("cat", [join(home, "console.json")], { encoding: "utf8" }).stdout);
  return `http://127.0.0.1:${info.port}/api/state`;
}
function headers() {
  const info = JSON.parse(spawnSync("cat", [join(home, "console.json")], { encoding: "utf8" }).stdout);
  return { "x-moqi-token": info.token };
}

describe("MCP protocol details", () => {
  const link: MoqiLink = { call: async () => ({}) };
  it("negotiates the protocol version, ignores notifications and rejects unknown methods", async () => {
    const init = (v: string) =>
      handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } }, link, "9");
    expect(((await init("2024-11-05")) as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      "2024-11-05",
    );
    expect(((await init("1999-01-01")) as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      "2025-11-25",
    );
    expect(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, link, "9")).toBeUndefined();
    expect(await handleMcp({ jsonrpc: "2.0", id: 2, method: "resources/list" }, link, "9")).toMatchObject({
      error: { code: -32601 },
    });
    expect(
      await handleMcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope" } }, link, "9"),
    ).toMatchObject({
      error: { code: -32602 },
    });
  });
});
