// The host side of coding tasks: a git worktree per task, outside the project, and the coding agent run there in
// the background under rules made for this task: edit this worktree only, run only the project's listed commands,
// in the agent's own sandbox. Jobs live here, not in a moqi, so a rebuild of moqi (a settings change, an MCP server
// starting) does not lose them.
import { execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { CodeProject, CodeResult, CodeRunner, CodeStart } from "../core/code.js";
import type { CodeTask } from "../core/types.js";
import { expandHome } from "./config.js";

export type AgentName = "kiro" | "claude";
const BIN: Record<AgentName, string> = { kiro: "kiro-cli", claude: "claude" };
const LABEL: Record<AgentName, string> = { kiro: "Kiro", claude: "Claude Code" };
const EXTRA_DIRS = [join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
const OUTPUT_MAX = 4 * 1024 * 1024;
const DIFF_MAX = 100 * 1024;
const KIRO_AGENT = "moqi-task";

export interface AgentRun {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export type Launch = (
  run: AgentRun,
  signal: AbortSignal,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export interface CodeSettings {
  readonly timeoutMinutes: number;
  readonly projects: readonly {
    readonly path: string;
    readonly agent: AgentName;
    readonly commands: readonly string[];
    readonly network: boolean;
  }[];
}

export interface CodeRunnerOptions {
  /** moqi's home; worktrees go under `<home>/code`. */
  readonly home: string;
  /** The current settings, read each time so a change applies at once. */
  readonly settings: () => CodeSettings | undefined;
  readonly onFinished: (taskId: string, result: CodeResult) => void;
  readonly find?: (bin: string) => string | undefined;
  readonly launch?: Launch;
  /** The `env` block of ~/.claude/settings.json, where Claude Code keeps a gateway login. */
  readonly claudeEnv?: () => Record<string, string>;
}

export function codeRunner(options: CodeRunnerOptions): CodeRunner {
  const find = options.find ?? ((bin: string) => findBin(bin));
  const launch = options.launch ?? launchAgent;
  const claudeEnv = options.claudeEnv ?? readClaudeEnv;
  const jobs = new Map<string, AbortController>();
  const agent = (name: string): AgentName => (name === "claude" ? "claude" : "kiro");

  return {
    projects: () =>
      (options.settings()?.projects ?? []).flatMap((p) => {
        try {
          return [{ path: realpathSync(expandHome(p.path)), agent: p.agent, commands: p.commands, network: p.network }];
        } catch {
          return [];
        }
      }),
    label: (name) => LABEL[agent(name)],
    available: (name) => find(BIN[agent(name)]) !== undefined,
    running: () => [...jobs.keys()],
    stop: (id) => {
      const job = jobs.get(id);
      if (!job) return false;
      job.abort("stop");
      return true;
    },
    currentBranch: (project) => {
      try {
        return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: project, encoding: "utf8" }).trim();
      } catch {
        return "当前分支";
      }
    },
    diff: async (task) => {
      const diff = await git(["diff", `${task.base}..${task.branch}`], task.project);
      return diff.length > DIFF_MAX ? `${diff.slice(0, DIFF_MAX)}\n…（后面还有，太长没显示）` : diff;
    },
    merge: async (task) => {
      if ((await git(["status", "--porcelain", "--untracked-files=no"], task.project)).trim())
        throw new Error("你的目录里有没提交的改动，先提交或暂存再合并");
      const into = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: task.project,
        encoding: "utf8",
      }).trim();
      try {
        await git(["merge", "--no-ff", "--no-edit", task.branch], task.project);
      } catch {
        await git(["merge", "--abort"], task.project).catch(() => "");
        throw new Error(`有冲突，没有合并；分支 ${task.branch} 还在，可以自己合并`);
      }
      await git(["worktree", "remove", "--force", task.dir], task.project).catch(() => "");
      await git(["branch", "-d", task.branch], task.project).catch(() => "");
      return `已合并到 ${into}：${task.branch}`;
    },
    discard: async (task) => {
      await git(["worktree", "remove", "--force", task.dir], task.project).catch(() => "");
      rmSync(task.dir, { recursive: true, force: true });
      await git(["worktree", "prune"], task.project).catch(() => "");
      await git(["branch", "-D", task.branch], task.project).catch(() => "");
    },
    start: async (input: CodeStart) => {
      const name = agent(input.agent);
      const bin = find(BIN[name]);
      if (!bin) throw new Error(`这台电脑上找不到 ${LABEL[name]}`);
      const base = (await git(["rev-parse", "HEAD"], input.project.path)).trim();
      const branch = `moqi/${stamp(input.now)}-${input.id}`;
      const dir = join(options.home, "code", input.id);
      mkdirSync(join(options.home, "code"), { recursive: true, mode: 0o700 });
      await git(["worktree", "add", "-q", "-b", branch, dir, base], input.project.path);
      const task: CodeTask = {
        id: input.id,
        agent: name,
        project: input.project.path,
        task: input.task,
        branch,
        dir,
        base,
        startedAt: input.now,
      };
      const env = agentEnv(name === "claude" ? claudeEnv() : {});
      if (name === "kiro") {
        mkdirSync(join(dir, ".kiro", "agents"), { recursive: true });
        writeFileSync(
          join(dir, ".kiro", "agents", `${KIRO_AGENT}.json`),
          JSON.stringify(kiroAgent(input.project), null, 2),
        );
      }
      const run =
        name === "claude"
          ? claudeRun(input.project, input.prompt, bin, dir, env)
          : kiroRun(input.prompt, bin, dir, env);
      const minutes = options.settings()?.timeoutMinutes ?? 30;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("timeout"), minutes * 60_000);
      jobs.set(input.id, controller);
      void (async () => {
        let result: CodeResult;
        try {
          const out = await launch(run, controller.signal);
          const read = name === "claude" ? claudeResult(out.stdout) : { summary: out.stdout.trim() };
          const stopped = controller.signal.aborted
            ? controller.signal.reason === "timeout"
              ? `超过 ${minutes} 分钟，停下了`
              : "你让它停下了"
            : undefined;
          const failed =
            stopped ??
            read.error ??
            (out.code !== 0 ? `${LABEL[name]} 退出了（${out.code ?? "信号"}）${tail(out.stderr)}` : undefined);
          if (name === "kiro") rmSync(join(dir, ".kiro", "agents", `${KIRO_AGENT}.json`), { force: true });
          const changes = await commit(task, LABEL[name]);
          result = { ok: failed === undefined, summary: read.summary, ...changes, ...(failed && { error: failed }) };
        } catch (error) {
          result = {
            ok: false,
            summary: "",
            files: [],
            stat: "",
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          clearTimeout(timer);
          jobs.delete(input.id);
        }
        options.onFinished(input.id, result);
      })();
      return task;
    },
  };
}

/** Claude Code's rules for one task: edits in the worktree, the listed commands, a sandbox without the network. */
export function claudeSettings(project: CodeProject) {
  return {
    permissions: {
      defaultMode: "acceptEdits",
      allow: project.commands.flatMap((c) => [`Bash(${c})`, `Bash(${c} *)`]),
      deny: ["WebFetch", "WebSearch"],
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: project.network ? ["*"] : [] },
    },
  };
}

export function claudeRun(
  project: CodeProject,
  prompt: string,
  bin: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): AgentRun {
  return {
    file: bin,
    args: [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--setting-sources",
      "project", // the user's own settings would bring their broad allows and hooks along
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--settings",
      JSON.stringify(claudeSettings(project)),
    ],
    cwd,
    env,
  };
}

export function claudeResult(stdout: string): { summary: string; error?: string } {
  try {
    const last = stdout.trim().split("\n").at(-1) ?? "";
    const out = JSON.parse(last) as { result?: unknown; is_error?: unknown };
    const text = typeof out.result === "string" ? out.result : "";
    return out.is_error === true ? { summary: text, error: text || "Claude Code 报错了" } : { summary: text };
  } catch {
    return { summary: "", error: `读不懂 Claude Code 的输出：${stdout.slice(0, 200)}` };
  }
}

/** Kiro's agent for one task (Kiro CLI v3 permissions): this worktree, the listed commands, no web, no MCP. */
export function kiroAgent(project: CodeProject) {
  const allowed = project.commands.flatMap((c) => [c, `${c} *`]);
  return {
    name: KIRO_AGENT,
    description: "A task moqi handed over: this worktree only, the listed commands only",
    prompt: "You work only inside the current directory, a git worktree moqi made for this task.",
    tools: ["read", "write", "shell"],
    excludedTools: ["web"],
    mcpServers: {},
    includeMcpJson: false,
    includePowers: false,
    permissions: {
      rules: [
        { capability: "fs_read", match: ["./**"], effect: "allow" },
        { capability: "fs_write", match: ["./**"], effect: "allow" },
        ...(allowed.length > 0 ? [{ capability: "shell", match: allowed, effect: "allow" }] : []),
        { capability: "shell", match: ["*"], exclude: allowed, effect: "deny" },
        { capability: "web_fetch", effect: "deny" },
        { capability: "web_search", effect: "deny" },
        { capability: "mcp", effect: "deny" },
      ],
    },
  };
}

export function kiroRun(prompt: string, bin: string, cwd: string, env: NodeJS.ProcessEnv): AgentRun {
  // No --trust flag of any kind: what the agent file does not allow is denied in a run nobody watches.
  return {
    file: bin,
    args: ["chat", "--v3", "--no-interactive", "--agent", KIRO_AGENT, "--output-format", "text", prompt],
    cwd,
    env,
  };
}

/** Where an agent's command is, also in the places a moqi started from the Dock has no PATH for. */
export function findBin(
  bin: string,
  dirs: readonly string[] = [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_DIRS],
): string | undefined {
  for (const dir of dirs) {
    if (!dir) continue;
    const file = join(dir, bin);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Runs an agent in a process group of its own, so stopping it stops what it started too. */
export const launchAgent: Launch = (run, signal) =>
  new Promise((done) => {
    const child = spawn(run.file, [...run.args], {
      cwd: run.cwd,
      env: run.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      if (stdout.length < OUTPUT_MAX) stdout += d;
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < OUTPUT_MAX) stderr += d;
    });
    const kill = () => {
      const pid = child.pid;
      if (!pid) return;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        // already gone
      }
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }, 5000).unref();
    };
    if (signal.aborted) kill();
    else signal.addEventListener("abort", kill, { once: true });
    child.on("error", (error) => done({ code: -1, stdout, stderr: error.message }));
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      done({ code, stdout, stderr });
    });
  });

async function commit(task: CodeTask, label: string): Promise<{ files: string[]; stat: string }> {
  await git(["add", "-A"], task.dir);
  if ((await git(["diff", "--cached", "--name-only"], task.dir)).trim()) {
    const known = (await git(["config", "user.email"], task.dir).catch(() => "")).trim() !== "";
    const who = known ? [] : ["-c", "user.name=moqi", "-c", "user.email=moqi@localhost"];
    const subject = `moqi: ${(task.task.split("\n")[0] ?? "").slice(0, 72)}`;
    await git([...who, "commit", "-q", "-m", subject, "-m", `由 ${label} 完成，moqi 代为提交`], task.dir);
  }
  const files = (await git(["diff", "--name-only", `${task.base}..HEAD`], task.dir)).split("\n").filter(Boolean);
  const stat = (await git(["diff", "--stat", `${task.base}..HEAD`], task.dir)).trimEnd();
  return { files, stat };
}

function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", [...args], { cwd, maxBuffer: OUTPUT_MAX }, (error, stdout, stderr) => {
      if (error) fail(new Error(String(stderr || error.message).trim()));
      else done(String(stdout));
    });
  });
}

/** The environment an agent gets: moqi's own variables taken out, the usual tool places added to PATH. */
function agentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MOQI_")));
  const path = [env.PATH, ...EXTRA_DIRS, dirname(process.execPath)].filter(Boolean).join(delimiter);
  return { ...env, PATH: path, ...extra };
}

function readClaudeEnv(): Record<string, string> {
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")) as { env?: unknown };
    const env = settings.env && typeof settings.env === "object" ? settings.env : {};
    return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function tail(text: string): string {
  const t = text.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return t ? `：${t}` : "";
}
