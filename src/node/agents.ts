// moqi looks around the computer for other agents (Kiro, Cursor, Claude Code, ...) and offers to connect
// them over MCP, so they can read what moqi knows about the user and reach the user through moqi.
// It knows where common MCP hosts keep their config, and it also finds unknown ones by looking for an
// MCP config file in the user's dot-directories. Nothing is changed until the user says yes.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defineTool, type Plugin } from "../core/plugin.js";

/** How an agent launches `moqi mcp`. Absolute paths, so apps started from the Dock find it without a shell PATH. */
export interface McpCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface FoundAgent {
  readonly id: string;
  readonly name: string;
  /** The MCP config file moqi would change. */
  readonly path: string;
  readonly connected: boolean;
  /** Set when the file exists but cannot be read safely; moqi will not touch it. */
  readonly problem?: string;
}

interface Host {
  readonly id: string;
  readonly name: string;
  /** Exists when the agent is installed or has been used. */
  readonly marker: string;
  readonly config: string;
  /** VS Code calls the map "servers"; everyone else "mcpServers". */
  readonly key: "mcpServers" | "servers";
  /** Some hosts want the transport spelled out. */
  readonly typed: boolean;
}

function knownHosts(home: string, platform: NodeJS.Platform): Host[] {
  const appSupport = platform === "darwin" ? join(home, "Library", "Application Support") : join(home, ".config");
  return [
    {
      id: "kiro",
      name: "Kiro",
      marker: join(home, ".kiro"),
      config: join(home, ".kiro", "settings", "mcp.json"),
      key: "mcpServers",
      typed: false,
    },
    {
      id: "cursor",
      name: "Cursor",
      marker: join(home, ".cursor"),
      config: join(home, ".cursor", "mcp.json"),
      key: "mcpServers",
      typed: false,
    },
    {
      id: "claude-code",
      name: "Claude Code",
      marker: join(home, ".claude.json"),
      config: join(home, ".claude.json"),
      key: "mcpServers",
      typed: true,
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      marker: join(appSupport, "Claude"),
      config: join(appSupport, "Claude", "claude_desktop_config.json"),
      key: "mcpServers",
      typed: false,
    },
    {
      id: "vscode",
      name: "VS Code",
      marker: join(appSupport, "Code", "User"),
      config: join(appSupport, "Code", "User", "mcp.json"),
      key: "servers",
      typed: true,
    },
    {
      id: "windsurf",
      name: "Windsurf",
      marker: join(home, ".codeium", "windsurf"),
      config: join(home, ".codeium", "windsurf", "mcp_config.json"),
      key: "mcpServers",
      typed: false,
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      marker: join(home, ".gemini"),
      config: join(home, ".gemini", "settings.json"),
      key: "mcpServers",
      typed: false,
    },
  ];
}

const CANDIDATES = ["mcp.json", join("settings", "mcp.json"), "mcp_config.json"];

/** Agents nobody told moqi about: a dot-directory (or ~/.config/x) holding a JSON file with an MCP server map. */
function unknownHosts(home: string, known: readonly Host[]): Host[] {
  const taken = new Set(known.map((h) => h.config));
  const roots: { dir: string; name: string }[] = [];
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return [];
    }
  };
  for (const d of list(home)) {
    if (d.name.startsWith(".") && ![".moqi", ".config", ".Trash", ".git", ".npm", ".cache"].includes(d.name))
      roots.push({ dir: join(home, d.name), name: d.name.slice(1) });
  }
  for (const d of list(join(home, ".config"))) roots.push({ dir: join(home, ".config", d.name), name: d.name });
  const found: Host[] = [];
  for (const root of roots) {
    for (const rel of CANDIDATES) {
      const config = join(root.dir, rel);
      if (taken.has(config) || !existsSync(config)) continue;
      const parsed = readJson(config);
      if (!parsed.ok || !isRecord(parsed.data)) continue;
      const key = isRecord(parsed.data.mcpServers)
        ? "mcpServers"
        : isRecord(parsed.data.servers)
          ? "servers"
          : undefined;
      if (!key) continue;
      found.push({ id: `other:${root.name}`, name: root.name, marker: root.dir, config, key, typed: false });
      break;
    }
  }
  return found;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readJson(path: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    if (statSync(path).size > 20 * 1024 * 1024) return { ok: false, error: "文件太大，没敢改" };
    const text = readFileSync(path, "utf8");
    return { ok: true, data: text.trim() === "" ? {} : JSON.parse(text) };
  } catch {
    return { ok: false, error: "不是合法的 JSON，没敢改" };
  }
}

export const SERVER_NAME = "moqi";

export function findAgents(home: string, platform: NodeJS.Platform = process.platform): FoundAgent[] {
  const known = knownHosts(home, platform).filter((h) => existsSync(h.marker));
  return [...known, ...unknownHosts(home, knownHosts(home, platform))].map((h) => describe(h));
}

function describe(h: Host): FoundAgent {
  const base = { id: h.id, name: h.name, path: h.config };
  if (!existsSync(h.config)) return { ...base, connected: false };
  const parsed = readJson(h.config);
  if (!parsed.ok) return { ...base, connected: false, problem: parsed.error };
  if (!isRecord(parsed.data)) return { ...base, connected: false, problem: "格式不认识，没敢改" };
  const map = parsed.data[h.key];
  return { ...base, connected: isRecord(map) && SERVER_NAME in map };
}

function hostOf(id: string, home: string, platform: NodeJS.Platform): Host | undefined {
  const known = knownHosts(home, platform);
  return known.find((h) => h.id === id) ?? unknownHosts(home, known).find((h) => h.id === id);
}

/** Adds (or updates) the moqi entry, keeping everything else in the file. Backs the file up the first time. */
export function connectAgent(
  id: string,
  command: McpCommand,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const host = hostOf(id, home, platform);
  if (!host) throw new Error(`没找到 ${id}`);
  const entry = {
    ...(host.typed && { type: "stdio" }),
    command: command.command,
    args: [...command.args],
    ...(command.env && Object.keys(command.env).length > 0 && { env: { ...command.env } }),
  };
  return editConfig(host, (map) => ({ ...map, [SERVER_NAME]: entry }));
}

export function disconnectAgent(id: string, home: string, platform: NodeJS.Platform = process.platform): string {
  const host = hostOf(id, home, platform);
  if (!host) throw new Error(`没找到 ${id}`);
  if (!existsSync(host.config)) return host.config;
  return editConfig(host, (map) => {
    const { [SERVER_NAME]: _gone, ...rest } = map;
    return rest;
  });
}

function editConfig(host: Host, change: (map: Record<string, unknown>) => Record<string, unknown>): string {
  let data: Record<string, unknown> = {};
  let mode = 0o600;
  if (existsSync(host.config)) {
    const parsed = readJson(host.config);
    if (!parsed.ok) throw new Error(`${host.config} ${parsed.error}`);
    if (!isRecord(parsed.data)) throw new Error(`${host.config} 格式不认识，没敢改`);
    data = parsed.data;
    mode = statSync(host.config).mode & 0o777;
    const backup = `${host.config}.moqi-backup`;
    if (!existsSync(backup)) copyFileSync(host.config, backup);
  }
  const map = isRecord(data[host.key]) ? (data[host.key] as Record<string, unknown>) : {};
  const next = { ...data, [host.key]: change(map) };
  mkdirSync(dirname(host.config), { recursive: true });
  const tmp = `${host.config}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  renameSync(tmp, host.config);
  return host.config;
}

export interface AgentsPluginOptions {
  readonly home: string;
  readonly command: McpCommand;
  readonly platform?: NodeJS.Platform;
  /** How often to look around. Default 10 minutes. */
  readonly everyMs?: number;
}

const short = (path: string, home: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);

/**
 * Looks for agents on each heartbeat (at most every 10 minutes) and offers once per agent to connect the
 * ones not connected yet. Accepting the offer is the user's yes; nothing is written before it.
 */
export function agentsPlugin(options: AgentsPluginOptions): Plugin {
  const { home, command } = options;
  const platform = options.platform ?? process.platform;
  const everyMs = options.everyMs ?? 10 * 60_000;
  let lastLook = Number.NEGATIVE_INFINITY;
  return {
    name: "agents",
    tools: [
      defineTool({
        name: "connect_agents",
        description: "Connect other agents on this computer to moqi over MCP, by id.",
        input: z.object({ ids: z.array(z.string()).min(1).max(20) }),
        effect: "write",
        cap: "suggest", // changing another app's settings is always asked
        hidden: true,
        describe: ({ ids }) => `把 ${ids.join("、")} 接入 moqi`,
        run: ({ ids }) => {
          const lines = ids.map((id) => {
            try {
              const path = connectAgent(id, command, home, platform);
              return `- ${findAgents(home, platform).find((a) => a.id === id)?.name ?? id}：已接入（${short(path, home)}）`;
            } catch (error) {
              return `- ${id}：没接上，${error instanceof Error ? error.message : String(error)}`;
            }
          });
          return `${lines.join("\n")}\n改之前都备份成了 .moqi-backup。新开一个会话，或在它的 MCP 设置里刷新一下，就能用了。`;
        },
      }),
    ],
    tick: (ctx) => {
      const now = ctx.now();
      if (now - lastLook < everyMs) return;
      lastLook = now;
      const offered = new Set<string>();
      for (const { offer } of ctx.state.offers.values()) {
        if (offer.kind === "agent.connect")
          for (const id of (offer.action?.args.ids as string[] | undefined) ?? []) offered.add(id);
      }
      const fresh = findAgents(home, platform).filter((a) => !a.connected && !a.problem && !offered.has(a.id));
      if (fresh.length === 0) return;
      const names = fresh.map((a) => a.name).join("、");
      ctx.offer({
        kind: "agent.connect",
        title: `发现你电脑上有 ${names}，要接入 moqi 吗？`,
        body: `接入后，它们能读到 moqi 对你的了解、把了解到的告诉 moqi，也能通过 moqi 提醒你。\n会在这些文件里加一项 moqi，改之前先备份：\n${fresh.map((a) => `- ${short(a.path, home)}`).join("\n")}`,
        value: 0.6,
        urgency: "whenever",
        action: { tool: "connect_agents", args: { ids: fresh.map((a) => a.id) } },
      });
    },
  };
}
