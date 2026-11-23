// macOS, through a few fixed actions and the Shortcuts the user picked. Every command runs directly with its
// arguments, never through a shell, and text only travels as an argument, stdin or a temp file, so nothing
// the model writes can become a command.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { defineTool, type Plugin, type Tool } from "../core/plugin.js";
import { expandHome } from "./config.js";

export type Exec = (
  file: string,
  args: readonly string[],
  options?: { readonly input?: string; readonly timeoutMs?: number },
) => Promise<string>;

export const runCommand: Exec = (file, args, options = {}) =>
  new Promise((done, fail) => {
    const timeout = options.timeoutMs ?? 15_000;
    const child = execFile(file, [...args], { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return done(String(stdout));
      const killed = (error as { killed?: boolean }).killed === true;
      fail(new Error(killed ? `超过 ${Math.round(timeout / 1000)} 秒没完成` : String(stderr || error.message).trim()));
    });
    child.stdin?.end(options.input ?? "");
  });

export interface MacOptions {
  /** Shortcuts the user picked in Settings; only these become tools. */
  readonly shortcuts: readonly string[];
  readonly exec?: Exec;
  readonly desktop?: string;
  readonly tmp?: string;
  readonly now?: () => number;
}

const TEXT_MAX = 20_000;

export function macPlugin(options: MacOptions): Plugin {
  const exec = options.exec ?? runCommand;
  const desktop = options.desktop ?? join(homedir(), "Desktop");
  const now = options.now ?? Date.now;
  // biome-ignore lint/suspicious/noExplicitAny: each tool has its own argument type
  const fixed: Tool<any>[] = [
    defineTool({
      name: "mac_open_app",
      description: "Open an app on this Mac by its name, e.g. 日历 or Safari.",
      input: z.object({ name: z.string().min(1).max(100) }),
      effect: "write",
      local: true,
      start: "auto", // the user asked, and it hardly changes anything
      describe: ({ name }) => `打开 ${name}`,
      validate: ({ name }) => (name.includes("/") ? "只能写 App 的名字，不能写路径" : undefined),
      run: async ({ name }) => {
        await exec("open", ["-a", name]);
        return `打开了 ${name}`;
      },
    }),
    defineTool({
      name: "mac_reveal",
      description: "Show a file or folder in Finder.",
      input: z.object({ path: z.string().min(1).describe("Absolute or ~/ path") }),
      effect: "write",
      local: true,
      start: "auto",
      describe: ({ path }) => `在访达里显示 ${path}`,
      validate: ({ path }) => (path.startsWith("/") || path.startsWith("~/") ? undefined : "路径要以 / 或 ~/ 开头"),
      run: async ({ path }) => {
        await exec("open", ["-R", expandHome(path)]);
        return `在访达里显示了 ${path}`;
      },
    }),
    defineTool({
      name: "mac_screenshot",
      description: "Take a screenshot of the whole screen and save it on the Desktop. Returns where it is.",
      input: z.object({}),
      effect: "write",
      local: true,
      start: "auto",
      describe: () => "截一张屏幕，存到桌面",
      run: async () => {
        const file = join(desktop, `moqi-截图-${stamp(now())}.png`);
        await exec("screencapture", ["-x", file]);
        return `截好了：${file}`;
      },
    }),
    defineTool({
      name: "mac_volume",
      description: "Set the output volume (0 to 100) and/or mute or unmute.",
      input: z.object({ level: z.number().int().min(0).max(100).optional(), muted: z.boolean().optional() }),
      effect: "write",
      local: true,
      start: "auto",
      describe: ({ level, muted }) =>
        [level !== undefined ? `把音量调到 ${level}` : "", muted !== undefined ? (muted ? "静音" : "取消静音") : ""]
          .filter(Boolean)
          .join("，"),
      validate: ({ level, muted }) =>
        level === undefined && muted === undefined ? "level 和 muted 至少填一个" : undefined,
      run: async ({ level, muted }) => {
        const said: string[] = [];
        if (level !== undefined) {
          await exec("osascript", [
            "-e",
            "on run argv",
            "-e",
            "set volume output volume (item 1 of argv as integer)",
            "-e",
            "end run",
            "--",
            String(level),
          ]);
          said.push(`音量调到 ${level}`);
        }
        if (muted !== undefined) {
          await exec("osascript", ["-e", `set volume output muted ${muted ? "true" : "false"}`]);
          said.push(muted ? "已静音" : "取消静音了");
        }
        return said.join("，");
      },
    }),
    defineTool({
      name: "mac_clipboard_read",
      description: "Read the text on the clipboard.",
      input: z.object({}),
      effect: "read",
      start: "suggest", // it may hold a password, and what is read goes to the model
      noWatch: true,
      describe: () => "读剪贴板里的文字",
      run: async () => {
        const text = await exec("pbpaste", []);
        return text ? text.slice(0, TEXT_MAX) : "剪贴板里没有文字";
      },
    }),
    defineTool({
      name: "mac_clipboard_write",
      description: "Put text on the clipboard.",
      input: z.object({ text: z.string().max(1_000_000) }),
      effect: "write",
      local: true,
      describe: ({ text }) => `把「${text.slice(0, 40)}${text.length > 40 ? "…" : ""}」复制到剪贴板`,
      run: async ({ text }) => {
        await exec("pbcopy", [], { input: text });
        return `复制到剪贴板了（${text.length} 字）`;
      },
    }),
  ];
  const shortcut = (name: string) =>
    defineTool({
      name: shortcutName(name),
      description: `运行快捷指令「${name}」。input 是交给它的文字，可以不填。`,
      input: z.object({ input: z.string().max(TEXT_MAX).optional() }),
      effect: "write",
      danger: true,
      source: "快捷指令",
      describe: () => `运行快捷指令「${name}」`,
      run: async ({ input }) => {
        const dir = mkdtempSync(join(options.tmp ?? tmpdir(), "moqi-shortcut-"));
        try {
          const out = join(dir, "output");
          const args = ["run", name];
          if (input) {
            const file = join(dir, "input.txt");
            writeFileSync(file, input);
            args.push("--input-path", file);
          }
          args.push("--output-path", out);
          try {
            await exec("shortcuts", args, { timeoutMs: 60_000 });
          } catch (error) {
            throw new Error(`快捷指令「${name}」没跑完：${error instanceof Error ? error.message : String(error)}`);
          }
          const text = existsSync(out) ? readFileSync(out, "utf8") : "";
          return text.trim() ? text.slice(0, TEXT_MAX) : `快捷指令「${name}」跑完了`;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      },
    });
  return { name: "mac", tools: [...fixed, ...options.shortcuts.map(shortcut)] };
}

/** A tool name for a shortcut: names are ASCII only, so a hash of its own name, stable while it keeps the name. */
export function shortcutName(name: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(name)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `shortcut_${hash.toString(16).padStart(8, "0")}`;
}

/** The user's shortcuts, or undefined where there is no `shortcuts` command (not macOS, or before macOS 12). */
export async function listShortcuts(
  exec: Exec = runCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<string[] | undefined> {
  if (platform !== "darwin") return undefined;
  try {
    return (await exec("shortcuts", ["list"], { timeoutMs: 5000 }))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
