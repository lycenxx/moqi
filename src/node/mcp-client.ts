// moqi as an MCP client: the MCP servers the user configures become moqi's tools, in chat and, for
// read-only ones, in watches. Tools a server marks read-only run freely; the rest go through moqi's
// trust ladder and are asked first. JSON-RPC over stdio is written out here, like the server side.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { defineTool, type Plugin, type Tool } from "../core/plugin.js";

export interface McpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface McpServerStatus {
  readonly name: string;
  readonly state: "starting" | "ready" | "failed" | "stopped";
  readonly tools: readonly string[];
  readonly error?: string;
}

interface RemoteTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly title?: string };
}

const PROTOCOL = "2025-06-18";
const CALL_TIMEOUT_MS = 120_000;

/** OpenAI-style function names: letters, digits, _ and -, at most 64 characters. */
export function toolName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

class Connection {
  status: McpServerStatus;
  tools: Tool[] = [];
  private child: ChildProcess | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    readonly name: string,
    readonly config: McpServerConfig,
    private readonly version: string,
    private readonly changed: () => void,
  ) {
    this.status = { name, state: "starting", tools: [] };
  }

  async start(): Promise<void> {
    try {
      const child = spawn(this.config.command, [...(this.config.args ?? [])], {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, ...this.config.env },
        ...(this.config.cwd && { cwd: this.config.cwd }),
      });
      this.child = child;
      child.on("error", (error) => this.fail(error.message));
      child.on("exit", (code) => {
        if (this.status.state !== "stopped") this.fail(`进程退出了（${code ?? "信号"}）`);
      });
      createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => this.onLine(line));
      await this.request("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "moqi", version: this.version },
      });
      this.notify("notifications/initialized");
      await this.loadTools();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  stop(): void {
    this.status = { ...this.status, state: "stopped" };
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("MCP 服务器已停止"));
    }
    this.pending.clear();
    this.child?.kill();
  }

  private fail(error: string): void {
    if (this.status.state === "stopped") return;
    this.status = { name: this.name, state: "failed", tools: [], error };
    this.tools = [];
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(error));
    }
    this.pending.clear();
    this.changed();
  }

  private async loadTools(): Promise<void> {
    const remote: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: RemoteTool[];
        nextCursor?: string;
      };
      remote.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    this.tools = remote.map((t) => this.wrap(t));
    this.status = { name: this.name, state: "ready", tools: this.tools.map((t) => t.name) };
    this.changed();
  }

  private wrap(t: RemoteTool): Tool {
    const readOnly = t.annotations?.readOnlyHint === true;
    return defineTool({
      name: toolName(this.name, t.name),
      description: `[${this.name}] ${t.description ?? t.annotations?.title ?? t.name}`.slice(0, 1000),
      input: z.record(z.string(), z.unknown()),
      parameters:
        t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
      // Only what the server itself calls read-only runs without asking.
      effect: readOnly ? "read" : "write",
      describe: (args) =>
        `用 ${this.name} 的「${t.name}」${Object.keys(args).length ? `（${JSON.stringify(args).slice(0, 80)}）` : ""}`,
      run: async (args) => {
        const result = (await this.request("tools/call", { name: t.name, arguments: args })) as {
          content?: { type: string; text?: string }[];
          structuredContent?: unknown;
          isError?: boolean;
        };
        const text =
          (result.content ?? [])
            .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
            .join("\n")
            .trim() || (result.structuredContent ? JSON.stringify(result.structuredContent) : "（没有返回内容）");
        if (result.isError) throw new Error(text.slice(0, 500));
        return text.slice(0, 8000);
      },
    });
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: { id?: number | string; method?: string; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method !== undefined) {
      if (msg.id !== undefined) {
        // A request from the server (ping, roots, sampling...): moqi offers none of these but ping.
        const reply =
          msg.method === "ping"
            ? { jsonrpc: "2.0", id: msg.id, result: {} }
            : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `moqi does not support ${msg.method}` } };
        this.child?.stdin?.write(`${JSON.stringify(reply)}\n`);
      } else if (msg.method === "notifications/tools/list_changed") {
        void this.loadTools().catch(() => {});
      }
      return;
    }
    const pending = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!pending) return;
    this.pending.delete(msg.id as number);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP 服务器出错了"));
    else pending.resolve(msg.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string): void {
    this.child?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }
}

/** The MCP servers moqi uses. Their tools change as servers start, so moqi is rebuilt when they do. */
export class McpHub {
  private readonly connections = new Map<string, Connection>();
  private onChange: () => void = () => {};

  constructor(private readonly version: string) {}

  /** Called when servers start, fail or change their tools. */
  watch(onChange: () => void): void {
    this.onChange = onChange;
  }

  /** Starts new servers, restarts changed ones, stops removed ones. Unchanged ones keep running. */
  reconcile(servers: Readonly<Record<string, McpServerConfig>> = {}): void {
    for (const [name, conn] of this.connections) {
      if (!servers[name] || JSON.stringify(servers[name]) !== JSON.stringify(conn.config)) {
        conn.stop();
        this.connections.delete(name);
      }
    }
    for (const [name, config] of Object.entries(servers)) {
      if (this.connections.has(name)) continue;
      const conn = new Connection(name, config, this.version, () => this.onChange());
      this.connections.set(name, conn);
      void conn.start();
    }
  }

  plugin(): Plugin {
    const tools = [...this.connections.values()].flatMap((c) => c.tools);
    return { name: "mcp", tools };
  }

  status(): McpServerStatus[] {
    return [...this.connections.values()].map((c) => c.status);
  }

  /** Resolves when no server is still starting. */
  async ready(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    while (this.status().some((s) => s.state === "starting") && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
  }

  stop(): void {
    for (const conn of this.connections.values()) conn.stop();
    this.connections.clear();
  }
}
