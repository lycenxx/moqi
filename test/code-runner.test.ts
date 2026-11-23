import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CodeResult } from "../src/core/code.js";
import { type AgentRun, type CodeSettings, codeRunner, findBin, type Launch } from "../src/node/code.js";

// Like CI: no git identity on the machine, only the one a test gives its own commits.
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  for (const [key, value] of [
    ["GIT_CONFIG_GLOBAL", saved.global],
    ["GIT_CONFIG_NOSYSTEM", saved.nosystem],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "moqi-repo-")));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function setup(agent: "kiro" | "claude" = "kiro", over: { hang?: boolean; timeoutMinutes?: number } = {}) {
  const project = repo();
  const home = mkdtempSync(join(tmpdir(), "moqi-home-"));
  const launched: { run: AgentRun; agentFile?: unknown }[] = [];
  const finished: { id: string; result: CodeResult }[] = [];
  let resolve: () => void = () => {};
  const ended = new Promise<void>((r) => {
    resolve = r;
  });
  const launch: Launch = async (run, signal) => {
    const file = join(run.cwd, ".kiro", "agents", "moqi-task.json");
    launched.push({ run, ...(existsSync(file) && { agentFile: JSON.parse(readFileSync(file, "utf8")) }) });
    writeFileSync(join(run.cwd, "NEW.md"), "hello\n");
    if (over.hang) await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
    const stdout = run.file.endsWith("claude")
      ? JSON.stringify({ result: "加了 NEW.md", is_error: false })
      : "加了 NEW.md\n";
    return { code: 0, stdout, stderr: "" };
  };
  const settings: CodeSettings = {
    timeoutMinutes: over.timeoutMinutes ?? 30,
    projects: [{ path: project, agent, commands: ["pnpm test"], network: false }],
  };
  const runner = codeRunner({
    home,
    settings: () => settings,
    onFinished: (id, result) => {
      finished.push({ id, result });
      resolve();
    },
    find: (bin) => `/bin/${bin}`,
    launch,
    claudeEnv: () => ({ ANTHROPIC_BASE_URL: "https://gw.test" }),
  });
  const [p] = runner.projects();
  const start = (task = "加一个 NEW.md") =>
    runner.start({
      id: "c_1",
      project: p as never,
      agent,
      task,
      prompt: `做：${task}`,
      now: Date.parse("2026-11-23T14:30:00+08:00"),
    });
  return { project, home, runner, launched, finished, ended, start };
}

afterEach(() => {
  delete process.env.MOQI_TEST_SECRET;
});

describe("coding tasks on this computer", () => {
  it("runs Kiro in a worktree with an agent file of its own, commits, and leaves the project alone", async () => {
    process.env.MOQI_TEST_SECRET = "s";
    const s = setup("kiro");
    const task = await s.start();
    expect(task).toMatchObject({
      branch: "moqi/20261123-1430-c_1",
      dir: join(s.home, "code", "c_1"),
      project: s.project,
    });
    await s.ended;
    const { run, agentFile } = s.launched[0] ?? ({} as never);
    expect(run.file).toBe("/bin/kiro-cli");
    expect(run.args).toEqual([
      "chat",
      "--v3",
      "--no-interactive",
      "--agent",
      "moqi-task",
      "--output-format",
      "text",
      "做：加一个 NEW.md",
    ]);
    expect(run.cwd).toBe(task.dir);
    expect(run.env.MOQI_TEST_SECRET).toBeUndefined();
    expect(agentFile).toMatchObject({
      name: "moqi-task",
      mcpServers: {},
      includeMcpJson: false,
      permissions: {
        rules: expect.arrayContaining([
          { capability: "fs_write", match: ["./**"], effect: "allow" },
          { capability: "shell", match: ["pnpm test", "pnpm test *"], effect: "allow" },
          { capability: "shell", match: ["*"], exclude: ["pnpm test", "pnpm test *"], effect: "deny" },
        ]),
      },
    });
    expect(s.finished[0]?.result).toMatchObject({ ok: true, summary: "加了 NEW.md", files: ["NEW.md"] });
    expect(s.finished[0]?.result.stat).toContain("NEW.md");
    expect(existsSync(join(task.dir, ".kiro", "agents", "moqi-task.json"))).toBe(false);
    expect(git(task.dir, "show", "--stat", "--format=%s", "HEAD")).toMatch(/^moqi: 加一个 NEW\.md\n[\s\S]*NEW\.md/);
    expect(existsSync(join(s.project, "NEW.md"))).toBe(false);

    expect(s.runner.currentBranch(s.project)).toBe("main");
    expect(await s.runner.merge(task)).toBe(`已合并到 main：${task.branch}`);
    const head = s.finished[0]?.result.head;
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await s.runner.diff(task, head)).toContain("+hello"); // the branch is gone, the commit is not
    expect(git(s.project, "log", "-1", "--format=%an %P").split(" ")).toHaveLength(3);
    expect(git(s.project, "log", "-1", "--format=%an")).toBe("moqi\n");
    expect(readFileSync(join(s.project, "NEW.md"), "utf8")).toBe("hello\n");
    expect(existsSync(task.dir)).toBe(false);
    expect(git(s.project, "branch", "--list", "moqi/*").trim()).toBe("");
  });

  it("runs Claude Code with settings of its own, the user's login and nothing else of theirs", async () => {
    const s = setup("claude");
    await s.start();
    await s.ended;
    const { run } = s.launched[0] ?? ({} as never);
    expect(run.file).toBe("/bin/claude");
    expect(run.args.slice(0, 2)).toEqual(["-p", "做：加一个 NEW.md"]);
    expect(run.args).toEqual(
      expect.arrayContaining(["--output-format", "json", "--setting-sources", "", "--strict-mcp-config"]),
    );
    const settings = JSON.parse(run.args[run.args.indexOf("--settings") + 1] as string);
    expect(settings).toEqual({
      disableAllHooks: true,
      permissions: {
        defaultMode: "acceptEdits",
        allow: ["Bash(pnpm test)", "Bash(pnpm test *)"],
        deny: ["WebFetch", "WebSearch"],
      },
      sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: [] } },
    });
    expect(run.env.ANTHROPIC_BASE_URL).toBe("https://gw.test");
    expect(s.finished[0]?.result).toMatchObject({ ok: true, summary: "加了 NEW.md" });
  });

  it("will not merge over uncommitted work or through a conflict, and discards cleanly", async () => {
    const s = setup();
    const task = await s.start();
    await s.ended;
    writeFileSync(join(s.project, "README.md"), "# changed\n");
    await expect(s.runner.merge(task)).rejects.toThrow("你的目录里有没提交的改动，先提交或暂存再合并");
    git(s.project, "checkout", "README.md");
    writeFileSync(join(s.project, "NEW.md"), "mine\n");
    git(s.project, "add", ".");
    git(s.project, "commit", "-qm", "mine");
    await expect(s.runner.merge(task)).rejects.toThrow(`有冲突，没有合并；分支 ${task.branch} 还在，可以自己合并`);
    expect(existsSync(join(s.project, ".git", "MERGE_HEAD"))).toBe(false);
    expect(await s.runner.diff(task)).toContain("+hello");
    await s.runner.discard(task);
    expect(existsSync(task.dir)).toBe(false);
    expect(git(s.project, "branch", "--list", "moqi/*").trim()).toBe("");
  });

  it("stops on request or after the time limit, and still keeps what was done", async () => {
    const stopped = setup("kiro", { hang: true });
    await stopped.start();
    expect(stopped.runner.running()).toEqual(["c_1"]);
    expect(stopped.runner.stop("c_1")).toBe(true);
    await stopped.ended;
    expect(stopped.finished[0]?.result).toMatchObject({ ok: false, error: "你让它停下了", files: ["NEW.md"] });
    expect(stopped.runner.running()).toEqual([]);

    const slow = setup("kiro", { hang: true, timeoutMinutes: 0.001 });
    await slow.start();
    await slow.ended;
    expect(slow.finished[0]?.result.error).toMatch(/^超过 .* 分钟，停下了$/);
  });

  it("finds the agents where a Dock-started moqi would not look", () => {
    const dir = mkdtempSync(join(tmpdir(), "moqi-bin-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "kiro-cli"), "#!/bin/sh\n");
    chmodSync(join(dir, "kiro-cli"), 0o755);
    writeFileSync(join(dir, "claude"), "not executable");
    expect(findBin("kiro-cli", [dir])).toBe(join(dir, "kiro-cli"));
    expect(findBin("claude", [dir])).toBeUndefined();
  });
});
