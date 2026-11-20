import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentsPlugin, connectAgent, disconnectAgent, findAgents, type McpCommand } from "../src/node/agents.js";
import { harness } from "./helpers.js";

const COMMAND: McpCommand = { command: "/usr/bin/node", args: ["/opt/moqi/cli.js", "mcp"] };

/** A pretend home directory with some agents installed. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "moqi-agents-"));
  const put = (rel: string, text: string, mode = 0o644) => {
    mkdirSync(join(home, rel, ".."), { recursive: true });
    writeFileSync(join(home, rel), text, { mode });
  };
  mkdirSync(join(home, ".kiro", "settings"), { recursive: true }); // Kiro installed, no MCP config yet
  put(
    ".cursor/mcp.json",
    JSON.stringify({ mcpServers: { blender: { command: "uvx", args: ["blender-mcp"] } } }),
    0o600,
  );
  put(".claude.json", JSON.stringify({ numStartups: 7, projects: { "/x": { allowedTools: [] } } }));
  put(".gemini/settings.json", "{ not json");
  put(".zed/settings/mcp.json", JSON.stringify({ mcpServers: {} })); // an agent moqi has never heard of
  put(".npmrc-like/mcp.json", JSON.stringify({ something: "else" })); // not an MCP config
  return { home, read: (rel: string) => JSON.parse(readFileSync(join(home, rel), "utf8")) };
}

describe("finding other agents", () => {
  it("finds known agents by where they live, and unknown ones by their MCP config", () => {
    const { home } = fakeHome();
    const found = findAgents(home, "darwin");
    expect(found.map((a) => [a.id, a.connected, a.problem ?? ""])).toEqual([
      ["kiro", false, ""],
      ["cursor", false, ""],
      ["claude-code", false, ""],
      ["gemini", false, "不是合法的 JSON，没敢改"],
      ["other:zed", false, ""],
    ]);
    expect(found.find((a) => a.id === "kiro")?.path).toBe(join(home, ".kiro", "settings", "mcp.json"));
  });

  it("connects without losing anything, backs the file up once, and keeps its permissions", () => {
    const { home, read } = fakeHome();
    connectAgent("cursor", COMMAND, home, "darwin");
    expect(read(".cursor/mcp.json").mcpServers).toEqual({
      blender: { command: "uvx", args: ["blender-mcp"] },
      moqi: { command: "/usr/bin/node", args: ["/opt/moqi/cli.js", "mcp"] },
    });
    expect(read(".cursor/mcp.json.moqi-backup").mcpServers.moqi).toBeUndefined();
    expect(statSync(join(home, ".cursor", "mcp.json")).mode & 0o777).toBe(0o600);

    connectAgent("kiro", { ...COMMAND, env: { MOQI_HOME: "/tmp/h" } }, home, "darwin"); // no file yet: created
    expect(read(".kiro/settings/mcp.json")).toEqual({
      mcpServers: {
        moqi: { command: "/usr/bin/node", args: ["/opt/moqi/cli.js", "mcp"], env: { MOQI_HOME: "/tmp/h" } },
      },
    });
    expect(existsSync(join(home, ".kiro", "settings", "mcp.json.moqi-backup"))).toBe(false);

    connectAgent("claude-code", COMMAND, home, "darwin"); // Claude Code wants the transport named
    const claude = read(".claude.json");
    expect(claude.numStartups).toBe(7);
    expect(claude.projects).toEqual({ "/x": { allowedTools: [] } });
    expect(claude.mcpServers.moqi).toEqual({
      type: "stdio",
      command: "/usr/bin/node",
      args: ["/opt/moqi/cli.js", "mcp"],
    });
    expect(statSync(join(home, ".claude.json")).mode & 0o777).toBe(0o644); // its own permissions, not moqi's

    expect(
      findAgents(home, "darwin")
        .filter((a) => a.connected)
        .map((a) => a.id),
    ).toEqual(["kiro", "cursor", "claude-code"]);

    disconnectAgent("cursor", home, "darwin");
    expect(read(".cursor/mcp.json").mcpServers).toEqual({ blender: { command: "uvx", args: ["blender-mcp"] } });
    expect(read(".cursor/mcp.json.moqi-backup").mcpServers.moqi).toBeUndefined(); // the first backup is kept
  });

  it("never writes to a file it cannot read safely", () => {
    const { home } = fakeHome();
    expect(() => connectAgent("gemini", COMMAND, home, "darwin")).toThrow("不是合法的 JSON");
    expect(readFileSync(join(home, ".gemini", "settings.json"), "utf8")).toBe("{ not json");
    expect(() => connectAgent("nobody", COMMAND, home, "darwin")).toThrow("没找到");
  });

  it("uses VS Code's own format", () => {
    const home = mkdtempSync(join(tmpdir(), "moqi-agents-"));
    mkdirSync(join(home, ".config", "Code", "User"), { recursive: true });
    expect(findAgents(home, "linux").map((a) => a.id)).toEqual(["vscode"]);
    connectAgent("vscode", COMMAND, home, "linux");
    const file = JSON.parse(readFileSync(join(home, ".config", "Code", "User", "mcp.json"), "utf8"));
    expect(file).toEqual({
      servers: { moqi: { type: "stdio", command: "/usr/bin/node", args: ["/opt/moqi/cli.js", "mcp"] } },
    });
  });
});

describe("tools other agents have", () => {
  it("offers once to use other agents' MCP servers, and adds them on yes", async () => {
    const { home } = fakeHome();
    const added: string[][] = [];
    const own: string[] = [];
    const plugin = agentsPlugin({
      home,
      command: COMMAND,
      platform: "darwin",
      ownServers: () => own,
      useServers: (servers) => {
        added.push(servers.map((s) => s.name));
        own.push(...servers.map((s) => s.name));
        return "好";
      },
    });
    const { moqi, clock } = harness({ plugins: [plugin] });
    await moqi.tick();
    const offer = [...moqi.state.offers.values()].map((r) => r.offer).find((o) => o.kind === "mcp.import");
    expect(offer?.title).toBe("其他 agent 里有 1 个 MCP 工具，让 moqi 也能用吗？");
    expect(offer?.body).toContain("blender（来自 Cursor）：uvx blender-mcp");
    expect(added).toEqual([]); // nothing before the user says yes
    await moqi.feedback(offer?.id ?? "", "accepted");
    expect(added).toEqual([["blender"]]);
    clock.advance(11 * 60_000);
    await moqi.tick();
    expect([...moqi.state.offers.values()].filter((r) => r.offer.kind === "mcp.import")).toHaveLength(1);
  });

  it("does not offer again servers the user said no to", async () => {
    const { home } = fakeHome();
    const plugin = agentsPlugin({
      home,
      command: COMMAND,
      platform: "darwin",
      ownServers: () => [],
      useServers: () => "好",
    });
    const { moqi, clock } = harness({ plugins: [plugin] });
    await moqi.tick();
    const offer = [...moqi.state.offers.values()].map((r) => r.offer).find((o) => o.kind === "mcp.import");
    await moqi.feedback(offer?.id ?? "", "dismissed");
    clock.advance(11 * 60_000);
    await moqi.tick();
    expect([...moqi.state.offers.values()].filter((r) => r.offer.kind === "mcp.import")).toHaveLength(1);
  });
});

describe("moqi finds agents on its own", () => {
  it("offers once to connect what it found, connects on yes, and offers again only for new ones", async () => {
    const { home, read } = fakeHome();
    const { moqi, clock, delivered } = harness({
      plugins: [agentsPlugin({ home, command: COMMAND, platform: "darwin" })],
    });
    await moqi.tick();
    const offers = [...moqi.state.offers.values()].map((r) => r.offer).filter((o) => o.kind === "agent.connect");
    expect(offers).toHaveLength(1);
    const offer = offers[0];
    expect(offer?.title).toBe("发现你电脑上有 Kiro、Cursor、Claude Code、zed，要接入 moqi 吗？");
    expect(offer?.body).toContain("~/.cursor/mcp.json");
    expect(offer?.action).toEqual({
      tool: "connect_agents",
      args: { ids: ["kiro", "cursor", "claude-code", "other:zed"] },
    });
    expect(delivered.map((d) => d.surface)).toEqual(["feed"]); // found agents wait in the feed
    expect(read(".cursor/mcp.json").mcpServers.moqi).toBeUndefined(); // nothing changes before the user says yes

    const result = await moqi.feedback(offer?.id ?? "", "accepted");
    expect(result).toContain("Cursor：已接入（~/.cursor/mcp.json）");
    expect(result).toContain("新开一个会话");
    expect(read(".cursor/mcp.json").mcpServers.moqi.command).toBe("/usr/bin/node");
    expect(read(".zed/settings/mcp.json").mcpServers.moqi.args).toEqual(["/opt/moqi/cli.js", "mcp"]);

    clock.advance(11 * 60_000);
    await moqi.tick();
    expect([...moqi.state.offers.values()].filter((r) => r.offer.kind === "agent.connect")).toHaveLength(1);

    mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true }); // installed later
    clock.advance(11 * 60_000);
    await moqi.tick();
    const latest = [...moqi.state.offers.values()].filter((r) => r.offer.kind === "agent.connect").at(-1)?.offer;
    expect(latest?.action?.args.ids).toEqual(["windsurf"]);
  });

  it("does not offer an agent that is already connected", async () => {
    const { home } = fakeHome();
    connectAgent("cursor", COMMAND, home, "darwin");
    const { moqi } = harness({ plugins: [agentsPlugin({ home, command: COMMAND, platform: "darwin" })] });
    await moqi.tick();
    const offer = [...moqi.state.offers.values()][0]?.offer;
    expect(offer?.action?.args.ids).toEqual(["kiro", "claude-code", "other:zed"]);
  });

  it("does not offer again what the user said no to, and the tool is never offered to the model", async () => {
    const { home } = fakeHome();
    const { moqi, clock } = harness({ plugins: [agentsPlugin({ home, command: COMMAND, platform: "darwin" })] });
    await moqi.tick();
    const offer = [...moqi.state.offers.values()][0]?.offer;
    await moqi.feedback(offer?.id ?? "", "dismissed");
    clock.advance(60 * 60_000);
    await moqi.tick();
    expect(moqi.state.offers.size).toBe(1);
    expect(moqi.visibleTools().map((t) => t.name)).not.toContain("connect_agents");
  });
});
