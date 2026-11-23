# 交给编程 agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户在对话里把编程任务交给 Kiro 或 Claude Code，任务在单独的 git 工作区和分支里做，做完在动态里给结果，用户合并或丢弃。

**Architecture:** 内核 `src/core/code.ts` 定义 `CodeRunner` 接口、三个工具（`code_delegate`、`code_merge`、`code_discard`）、偏好挑选、交给 agent 的话和结果提议；事件 `code.*` 折叠成 `State.codeTasks`。Node 端 `src/node/code.ts` 实现 `CodeRunner`：git 工作区、两个适配器、后台进程、超时和停止。任务进程挂在 home 上，不随 moqi 重建而丢失；跑完通过 `home.serial(() => home.moqi.codeFinished(...))` 交回当前的 moqi。

**Tech Stack:** TypeScript strict、zod 4、vitest 5、Node 22 `child_process`、git。

**Spec:** `docs/superpowers/specs/2026-11-23-coding-agents-design.md`

## Global Constraints

- `src/core` 不碰 Node API；git 和进程全在 `src/node/code.ts`。
- 运行时依赖仍然只有 `taugraph` 和 `zod`。
- 命令一律 `execFile`/`spawn` 参数列表，不经过 shell。
- agent 进程的环境去掉 `MOQI_` 开头的变量；Claude 只额外读 `~/.claude/settings.json` 的 `env`。
- 面向用户的文字用简体中文；代码注释用英文。
- 每个任务结束 `pnpm typecheck && pnpm lint` 通过；最后 `pnpm check` 全部通过。

## File Structure

| 文件                            | 职责                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `src/core/code.ts`（新）        | `CodeRunner` 接口、偏好挑选、交给 agent 的话、结果提议、三个工具                        |
| `src/core/types.ts`             | `CodeTask`、`code.*` 事件                                                               |
| `src/core/state.ts`             | `State.codeTasks`                                                                       |
| `src/core/plugin.ts`            | `Tool.explain`                                                                          |
| `src/core/moqi.ts`              | `MoqiOptions.code`、注册工具、`codeFinished`、`recoverCode`、确认详情附 `explain`       |
| `src/node/code.ts`（新）        | `codeRunner()`：git 工作区、Claude 和 Kiro 适配器、后台进程                             |
| `src/node/config.ts`、`home.ts` | `code` 配置；runner 挂在 home 上                                                        |
| `src/node/console/server.ts`    | `/api/code/*`、`/api/state` 的 `code`、项目路径校验                                     |
| `src/node/console/assets/*`     | 动态里正在跑的任务和结果卡片、设置里的项目列表                                          |
| 测试                            | `test/code.test.ts`（内核）、`test/code-runner.test.ts`（Node）、`test/console.test.ts` |

---

### Task 1: 内核：任务、工具和提议

**Files:** Create `src/core/code.ts`；Modify `src/core/types.ts`、`src/core/state.ts`、`src/core/plugin.ts`、`src/core/moqi.ts`、`src/core/index.ts`；Test `test/code.test.ts`（新）

**Interfaces — Produces:**

- `types.ts`：`interface CodeTask { id; agent; project; task; branch; dir; base; startedAt }`；事件 `code.started { task }`、`code.finished { taskId, ok, summary, files, stat, error? }`、`code.merged { taskId }`、`code.discarded { taskId }`。
- `state.ts`：`interface CodeTaskState { task: CodeTask; status: "running" | "done" | "failed" | "merged" | "discarded"; summary?; files?; stat?; error?; finishedAt? }`；`State.codeTasks: Map<string, CodeTaskState>`。
- `plugin.ts`：`Tool.explain?(args): string`。
- `code.ts`：`CodeProject`、`CodeResult`、`CodeStart`、`CodeRunner`；`codePreferences(state, now)`、`codePrompt(task, prefs, project)`、`codeOffer(task, result, label, now)`、`findProject(projects, name)`、`codeTools(k, runner)`。
- `moqi.ts`：`MoqiOptions.code?: CodeRunner`；`Moqi.codeFinished(taskId, result)`；`Moqi.recoverCode()`。

- [ ] **Step 1: 失败的测试** `test/code.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
  type CodeProject,
  type CodeResult,
  type CodeRunner,
  type CodeStart,
  codePreferences,
  codePrompt,
} from "../src/core/code.js";
import { harness } from "./helpers.js";

const MOQI: CodeProject = { path: "/work/moqi", agent: "kiro", commands: ["pnpm test"], network: false };

function fakeRunner(projects: CodeProject[] = [MOQI], agents = ["kiro", "claude"]) {
  const started: CodeStart[] = [];
  const merged: string[] = [];
  const discarded: string[] = [];
  const live = new Set<string>();
  const runner: CodeRunner = {
    projects: () => projects,
    label: (agent) => (agent === "claude" ? "Claude Code" : "Kiro"),
    available: (agent) => agents.includes(agent),
    start: async (input) => {
      started.push(input);
      live.add(input.id);
      return {
        id: input.id,
        agent: input.agent,
        project: input.project.path,
        task: input.task,
        branch: `moqi/20261120-0820-${input.id}`,
        dir: `/home/.moqi/code/${input.id}`,
        base: "abc123",
        startedAt: input.now,
      };
    },
    running: () => [...live],
    stop: (id) => live.delete(id),
    diff: async () => "diff --git a/README.md b/README.md",
    currentBranch: () => "main",
    merge: async (task) => {
      merged.push(task.id);
      return `已合并到 main：${task.branch}`;
    },
    discard: async (task) => {
      discarded.push(task.id);
    },
  };
  return { runner, started, merged, discarded, live };
}

const done: CodeResult = {
  ok: true,
  summary: "升级了 3 个依赖，pnpm test 通过。",
  files: ["package.json", "pnpm-lock.yaml"],
  stat: " 2 files changed, 10 insertions(+)",
};

describe("coding tasks", () => {
  it("asks with what it may run and what it passes on, then hands the task over and returns at once", async () => {
    const f = fakeRunner();
    const { moqi, asked, details } = harness({ code: f.runner });
    moqi.remember({ kind: "preference", content: "提交信息用英文写" });
    moqi.remember({ kind: "preference", content: "喜欢喝燕麦拿铁" });
    moqi.remember({ kind: "preference", content: "Go 写得少，多用 TypeScript" });
    const reply = await moqi.callTool(
      "code_delegate",
      { project: "moqi", task: "把依赖升级到最新，跑一遍测试" },
      { byUser: true },
    );
    expect(reply).toMatch(/^已经交给 Kiro 了（任务 c_.+），做完会在动态里告诉你。$/);
    expect(asked).toEqual(["要我让 Kiro 在 moqi 里做「把依赖升级到最新，跑一遍测试」吗？"]);
    expect(details[0]).toContain("能跑的命令：pnpm test");
    expect(details[0]).toContain("联网：不能");
    expect(details[0]).toContain("- 提交信息用英文写");
    expect(details[0]).toContain("- Go 写得少，多用 TypeScript");
    expect(details[0]).not.toContain("燕麦拿铁");
    expect(f.started[0]?.prompt).toContain("## 关于用户（来自 moqi）\n- 提交信息用英文写");
    expect(f.started[0]?.prompt).toContain("- 能跑的命令只有：pnpm test；其他命令会被拒绝。命令连不上网。");
    expect([...moqi.state.codeTasks.values()]).toMatchObject([
      { status: "running", task: { project: "/work/moqi", agent: "kiro" } },
    ]);
  });

  it("refuses unknown projects, missing agents and a second task in the same project", async () => {
    const f = fakeRunner(undefined, ["kiro"]);
    const { moqi } = harness({ code: f.runner });
    const run = (args: Record<string, unknown>) => moqi.callTool("code_delegate", args, { byUser: true });
    expect(await run({ project: "other", task: "x" })).toBe("参数不对：没有登记 other 这个项目；能用的有：moqi");
    expect(await run({ project: "moqi", task: "x", agent: "claude" })).toBe("参数不对：这台电脑上找不到 Claude Code");
    await run({ project: "/work/moqi", task: "第一件" });
    expect(await run({ project: "moqi", task: "第二件" })).toBe("参数不对：moqi 已经有一个任务在跑，等它做完再交");
  });

  it("tells the user once when it is done, and merges on their word with what it changed", async () => {
    const f = fakeRunner();
    const { moqi, delivered, asked, details } = harness({ code: f.runner, start: "2026-11-20T10:00:00+08:00" });
    await moqi.callTool("code_delegate", { project: "moqi", task: "把依赖升级到最新" }, { byUser: true });
    const id = f.started[0]?.id as string;
    moqi.codeFinished(id, done);
    moqi.codeFinished(id, done);
    const offers = delivered.filter((d) => d.offer.kind === "code.done");
    expect(offers).toHaveLength(1);
    expect(offers[0]?.surface).toBe("notify");
    expect(offers[0]?.offer).toMatchObject({
      title: "Kiro 做完了：把依赖升级到最新",
      action: { tool: "code_merge", args: { id } },
    });
    expect(offers[0]?.offer.body).toContain(
      `改了 2 个文件：package.json、pnpm-lock.yaml\n在分支 moqi/20261120-0820-${id}`,
    );
    expect(await moqi.feedback(offers[0]?.offer.id ?? "", "accepted")).toBe(`已合并到 main：moqi/20261120-0820-${id}`);
    expect(asked.at(-1)).toBe(`要我把 moqi/20261120-0820-${id} 合并进 moqi 的 main 吗？`);
    expect(details.at(-1)).toContain("这是 moqi 提议的动作");
    expect(details.at(-1)).toContain("改动：\n 2 files changed");
    expect(f.merged).toEqual([id]);
    expect(moqi.state.codeTasks.get(id)?.status).toBe("merged");
    expect(await moqi.callTool("code_merge", { id }, { byUser: true })).toBe("参数不对：已经合并过了");
  });

  it("discards a task, and says so when there was nothing to merge", async () => {
    const f = fakeRunner();
    const { moqi, delivered } = harness({ code: f.runner });
    await moqi.callTool("code_delegate", { project: "moqi", task: "看看能不能更快" }, { byUser: true });
    const id = f.started[0]?.id as string;
    moqi.codeFinished(id, { ok: true, summary: "没找到能改的地方。", files: [], stat: "" });
    expect(delivered.at(-1)?.offer.title).toBe("Kiro 做完了，没有改动：看看能不能更快");
    expect(await moqi.callTool("code_merge", { id }, { byUser: true })).toBe("参数不对：这个任务没有改动，不用合并");
    expect(await moqi.callTool("code_discard", { id }, { byUser: true, preApproved: true })).toMatch(/丢弃了/);
    expect(f.discarded).toEqual([id]);
    expect(moqi.state.codeTasks.get(id)?.status).toBe("discarded");
  });

  it("marks tasks a restart cut short", async () => {
    const f = fakeRunner();
    const first = harness({ code: f.runner });
    await first.moqi.callTool("code_delegate", { project: "moqi", task: "重构" }, { byUser: true });
    const id = f.started[0]?.id as string;
    f.live.clear();
    const again = harness({ code: f.runner, store: first.moqi.store });
    again.moqi.recoverCode();
    expect(again.moqi.state.codeTasks.get(id)).toMatchObject({ status: "failed", error: "moqi 重启了，任务中断" });
    expect(again.delivered.at(-1)?.offer.title).toBe("Kiro 没做完：重构");
  });

  it("picks only coding preferences, and writes the rules into what it says", () => {
    const { moqi, clock } = harness();
    moqi.remember({ kind: "preference", content: "回答用中文" });
    moqi.remember({ kind: "preference", content: "喜欢 Google 的产品" });
    moqi.remember({ kind: "basic", content: "代码都放在 ~/work 下" });
    expect(codePreferences(moqi.state, clock.now())).toEqual(["回答用中文"]);
    const said = codePrompt("修个 bug", [], { path: "/p", agent: "claude", commands: [], network: true });
    expect(said).toContain("- 能跑的命令只有：（没有，不能跑命令）；其他命令会被拒绝。\n");
    expect(said).not.toContain("## 关于用户");
  });
});
```

- [ ] **Step 2:** `TZ=Asia/Shanghai pnpm exec vitest run test/code.test.ts`，Expected: FAIL（模块不存在）。

- [ ] **Step 3: `src/core/types.ts`**：`Todo` 之后加

```ts
// ---------------------------------------------------------------------------
// Coding tasks (交给编程 agent)
// ---------------------------------------------------------------------------

/** A coding task handed to a coding agent, worked on a branch of its own in a worktree outside the project. */
export interface CodeTask {
  readonly id: string;
  readonly agent: string;
  /** The repository root. */
  readonly project: string;
  readonly task: string;
  readonly branch: string;
  /** The worktree. */
  readonly dir: string;
  /** The commit the branch started from. */
  readonly base: string;
  readonly startedAt: number;
}
```

`EventBody` 加：

```ts
  | { type: "code.started"; task: CodeTask }
  | {
      type: "code.finished";
      taskId: string;
      ok: boolean;
      summary: string;
      files: readonly string[];
      stat: string;
      error?: string;
    }
  | { type: "code.merged"; taskId: string }
  | { type: "code.discarded"; taskId: string }
```

- [ ] **Step 4: `src/core/state.ts`**：import 加 `CodeTask`；`Study` 之后加

```ts
export interface CodeTaskState {
  readonly task: CodeTask;
  readonly status: "running" | "done" | "failed" | "merged" | "discarded";
  readonly summary?: string;
  readonly files?: readonly string[];
  readonly stat?: string;
  readonly error?: string;
  readonly finishedAt?: number;
}
```

字段加 `readonly codeTasks = new Map<string, CodeTaskState>();`，`switch` 加

```ts
      case "code.started":
        this.codeTasks.set(e.task.id, { task: e.task, status: "running" });
        break;
      case "code.finished": {
        const t = this.codeTasks.get(e.taskId);
        if (!t || t.status !== "running") break;
        this.codeTasks.set(e.taskId, {
          ...t,
          status: e.ok ? "done" : "failed",
          summary: e.summary,
          files: e.files,
          stat: e.stat,
          ...(e.error && { error: e.error }),
          finishedAt: e.at,
        });
        break;
      }
      case "code.merged":
      case "code.discarded": {
        const t = this.codeTasks.get(e.taskId);
        if (t) this.codeTasks.set(e.taskId, { ...t, status: e.type === "code.merged" ? "merged" : "discarded" });
        break;
      }
```

- [ ] **Step 5: `src/core/plugin.ts`**：`Tool` 的 `describe` 之后加

```ts
  /** More about a call for its confirmation, after the arguments: what it passes on, what it may run. */
  explain?(args: A): string;
```

- [ ] **Step 6: `src/core/code.ts`**：

```ts
// Coding tasks handed to a coding agent (Kiro CLI, Claude Code). The work happens on a branch of its own, in a
// worktree outside the project, and comes back into the project only when the user merges it. The host runs git
// and the agents through a CodeRunner; the core decides what is asked, what is passed on and what the user sees.
import { z } from "zod";
import { activeFacts } from "./memory.js";
import { defineTool, type OfferInput, type Tool } from "./plugin.js";
import type { State } from "./state.js";
import type { Kernel } from "./tools.js";
import { type CodeTask, newId } from "./types.js";

export interface CodeProject {
  /** The repository root, as the host resolved it. */
  readonly path: string;
  readonly agent: string;
  readonly commands: readonly string[];
  readonly network: boolean;
}

export interface CodeResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly files: readonly string[];
  readonly stat: string;
  readonly error?: string;
}

export interface CodeStart {
  readonly id: string;
  readonly project: CodeProject;
  readonly agent: string;
  readonly task: string;
  readonly prompt: string;
  readonly now: number;
}

/** What the host does for coding tasks. Jobs outlive a rebuild of moqi; the host reports results with `codeFinished`. */
export interface CodeRunner {
  projects(): readonly CodeProject[];
  /** "Kiro", "Claude Code". */
  label(agent: string): string;
  available(agent: string): boolean;
  /** Makes the worktree and starts the agent in the background. */
  start(input: CodeStart): Promise<CodeTask>;
  /** Ids of the jobs still running. */
  running(): readonly string[];
  stop(id: string): boolean;
  diff(task: CodeTask): Promise<string>;
  /** The branch the project is on now, which a merge goes into. */
  currentBranch(project: string): string;
  merge(task: CodeTask): Promise<string>;
  discard(task: CodeTask): Promise<void>;
}

const WORDS = [
  "代码",
  "编程",
  "提交",
  "测试",
  "注释",
  "命名",
  "分支",
  "合并",
  "格式",
  "缩进",
  "依赖",
  "重构",
  "文档",
  "中文",
  "英文",
];
const ASCII = [
  "commit",
  "test",
  "branch",
  "merge",
  "pr",
  "lint",
  "readme",
  "api",
  "typescript",
  "javascript",
  "python",
  "go",
  "rust",
  "java",
  "swift",
];
const PREFERENCES_MAX = 10;
const OFFER_DAYS = 30;

function isAboutCode(text: string): boolean {
  if (WORDS.some((w) => text.includes(w))) return true;
  const lower = text.toLowerCase();
  return ASCII.some((w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(lower));
}

/** Preferences and lessons about how the user works with code, to pass on with a task. No model picks them. */
export function codePreferences(state: State, now: number): string[] {
  const facts = activeFacts(state, now)
    .filter((f) => f.kind === "preference")
    .map((f) => f.content);
  const lessons = [...state.lessons.values()].map((l) => l.content);
  return [...facts, ...lessons].filter(isAboutCode).slice(0, PREFERENCES_MAX);
}

/** What the coding agent is told: the task, the user's ways, and the rules it works under. */
export function codePrompt(task: string, prefs: readonly string[], project: CodeProject): string {
  const lines = [task.trim(), ""];
  if (prefs.length > 0) lines.push("## 关于用户（来自 moqi）", ...prefs.map((p) => `- ${p}`), "");
  const commands = project.commands.length > 0 ? project.commands.join("、") : "（没有，不能跑命令）";
  lines.push(
    "## 规矩",
    "- 只在当前目录里改文件。",
    `- 能跑的命令只有：${commands}；其他命令会被拒绝。${project.network ? "" : "命令连不上网。"}`,
    "- 不要提交，moqi 会替你提交。",
    "- 做完用几句话说明改了什么、测试结果如何。",
  );
  return lines.join("\n");
}

/** What the user is told when a task ends. Accepting merges it; it waits a month in the feed. */
export function codeOffer(task: CodeTask, result: CodeResult, label: string, now: number): OfferInput {
  const what = clip(task.task.split("\n")[0] ?? "", 30);
  const title = !result.ok
    ? `${label} 没做完：${what}`
    : result.files.length > 0
      ? `${label} 做完了：${what}`
      : `${label} 做完了，没有改动：${what}`;
  const files =
    result.files.length > 0
      ? `改了 ${result.files.length} 个文件：${result.files.slice(0, 5).join("、")}${result.files.length > 5 ? "…" : ""}\n在分支 ${task.branch}`
      : "";
  return {
    kind: "code.done",
    title,
    body: [result.error ? `原因：${result.error}` : "", clip(result.summary.trim(), 600), files]
      .filter(Boolean)
      .join("\n"),
    value: 0.8,
    urgency: "today",
    expiresAt: now + OFFER_DAYS * 86_400_000,
    action: { tool: "code_merge", args: { id: task.id } },
  };
}

export function findProject(projects: readonly CodeProject[], name: string): CodeProject | undefined {
  const given = name.trim().replace(/\/+$/, "");
  return projects.find((p) => p.path === given) ?? projects.find((p) => lastSegment(p.path) === lastSegment(given));
}

export function lastSegment(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// biome-ignore lint/suspicious/noExplicitAny: each tool has its own argument type
export function codeTools(k: Kernel, runner: CodeRunner): Tool<any>[] {
  const names = () =>
    runner
      .projects()
      .map((p) => lastSegment(p.path))
      .join("、");
  const busy = (path: string) =>
    [...k.state.codeTasks.values()].some((t) => t.status === "running" && t.task.project === path);
  const resolve = (name: string) => findProject(runner.projects(), name);
  const task = (id: string) => k.state.codeTasks.get(id);
  // biome-ignore lint/suspicious/noExplicitAny: each tool has its own argument type
  const tools: Tool<any>[] = [
    defineTool({
      name: "code_merge",
      description: "Merge a finished coding task's branch into its project.",
      input: z.object({ id: z.string() }),
      effect: "write",
      danger: true,
      source: "编程 agent",
      hidden: true, // only the user's tap on a result merges
      describe: ({ id }) => {
        const t = task(id);
        return t
          ? `把 ${t.task.branch} 合并进 ${lastSegment(t.task.project)} 的 ${runner.currentBranch(t.task.project)}`
          : `合并任务 ${id}`;
      },
      explain: ({ id }) => {
        const stat = task(id)?.stat;
        return stat ? `改动：\n${stat}` : "";
      },
      validate: ({ id }) => {
        const t = task(id);
        if (!t) return `没有任务 ${id}`;
        if (t.status === "running") return "这个任务还在跑";
        if (t.status === "merged") return "已经合并过了";
        if (t.status === "discarded") return "已经丢弃了";
        if (!t.files?.length) return "这个任务没有改动，不用合并";
        return undefined;
      },
      run: async ({ id }) => {
        const t = task(id);
        if (!t) return `没有任务 ${id}`;
        const said = await runner.merge(t.task);
        k.emit({ type: "code.merged", taskId: id });
        return said;
      },
    }),
    defineTool({
      name: "code_discard",
      description: "Throw away a coding task's branch and worktree.",
      input: z.object({ id: z.string() }),
      effect: "write",
      local: true,
      hidden: true,
      describe: ({ id }) => `丢弃任务 ${task(id)?.task.branch ?? id}`,
      validate: ({ id }) => {
        const t = task(id);
        if (!t) return `没有任务 ${id}`;
        if (t.status === "running") return "这个任务还在跑，先让它停下";
        if (t.status === "merged" || t.status === "discarded") return "这个任务已经处理过了";
        return undefined;
      },
      run: async ({ id }) => {
        const t = task(id);
        if (!t) return `没有任务 ${id}`;
        await runner.discard(t.task);
        k.emit({ type: "code.discarded", taskId: id });
        return `丢弃了 ${t.task.branch}`;
      },
    }),
  ];
  if (runner.projects().length === 0) return tools;
  return [
    defineTool({
      name: "code_delegate",
      description: `Hand a coding task to a coding agent for one of the user's projects (${names()}). It works on a new branch in a separate worktree, may run only the project's listed commands, and the user decides whether to merge. Use it when the user asks to change, fix, test or upgrade code in one of these projects.`,
      input: z.object({
        project: z.string().min(1).describe("The project's folder name or path"),
        task: z.string().trim().min(1).max(4000).describe("What to do, as the user put it"),
        agent: z.enum(["kiro", "claude"]).optional().describe("Leave out for the project's default"),
      }),
      effect: "write",
      danger: true,
      source: "编程 agent",
      describe: (a) => {
        const p = resolve(a.project);
        return `让 ${runner.label(a.agent ?? p?.agent ?? "kiro")} 在 ${p ? lastSegment(p.path) : a.project} 里做「${clip(a.task, 60)}」`;
      },
      explain: (a) => {
        const p = resolve(a.project);
        if (!p) return "";
        const prefs = codePreferences(k.state, k.now());
        return [
          `能跑的命令：${p.commands.join("、") || "没有"}`,
          `联网：${p.network ? "可以" : "不能"}`,
          prefs.length > 0
            ? `一起传过去的偏好和经验：\n${prefs.map((x) => `- ${x}`).join("\n")}`
            : "不传你的偏好：没有和写代码有关的。",
          "改动会落在新分支 moqi/…，从你最近一次提交开始做，没提交的改动不会带过去；你点「合并」之前不碰原目录。",
        ].join("\n");
      },
      validate: (a) => {
        const p = resolve(a.project);
        if (!p) return `没有登记 ${a.project} 这个项目；能用的有：${names() || "无"}`;
        const agent = a.agent ?? p.agent;
        if (!runner.available(agent)) return `这台电脑上找不到 ${runner.label(agent)}`;
        if (busy(p.path)) return `${lastSegment(p.path)} 已经有一个任务在跑，等它做完再交`;
        return undefined;
      },
      run: async (a) => {
        const p = resolve(a.project);
        if (!p) return `没有登记 ${a.project} 这个项目`;
        const agent = a.agent ?? p.agent;
        const id = newId("c");
        const prompt = codePrompt(a.task, codePreferences(k.state, k.now()), p);
        const started = await runner.start({ id, project: p, agent, task: a.task, prompt, now: k.now() });
        k.emit({ type: "code.started", task: started });
        return `已经交给 ${runner.label(agent)} 了（任务 ${id}），做完会在动态里告诉你。`;
      },
    }),
    ...tools,
  ];
}
```

- [ ] **Step 7: `src/core/moqi.ts`**
  - import `import { type CodeResult, type CodeRunner, codeOffer, codeTools } from "./code.js";`
  - `MoqiOptions` 加 `/** Runs coding tasks; absent: no coding agents. */ readonly code?: CodeRunner;`
  - 构造函数 `owned` 列表里，内置工具之后加 `...(options.code ? codeTools(kernel, options.code).map((t): [Tool, string] => [t, t.source ?? "moqi"]) : []),`
  - 确认详情：`const details = tool.danger ? dangerDetails(args, guard ? reason : undefined) : undefined;` 改为

```ts
const more = tool.explain?.(parsed.data);
const details = tool.danger
  ? `${dangerDetails(args, guard ? reason : undefined)}${more ? `\n\n${more}` : ""}`
  : undefined;
```

- 加两个方法（放在 `forgetLearned` 之后）：

```ts
  /** The host's word that a coding task ended. Recorded once, then offered to the user. */
  codeFinished(taskId: string, result: CodeResult): void {
    const t = this.state.codeTasks.get(taskId);
    if (!t || t.status !== "running") return;
    this.emit({
      type: "code.finished",
      taskId,
      ok: result.ok,
      summary: result.summary,
      files: result.files,
      stat: result.stat,
      ...(result.error && { error: result.error }),
    });
    void this.offer(codeOffer(t.task, result, this.options.code?.label(t.task.agent) ?? t.task.agent, this.clock.now()));
  }

  /** After a restart: tasks the log calls running but no process runs any more were cut short. */
  recoverCode(): void {
    const live = new Set(this.options.code?.running() ?? []);
    for (const [id, t] of this.state.codeTasks)
      if (t.status === "running" && !live.has(id))
        this.codeFinished(id, { ok: false, summary: "", files: [], stat: "", error: "moqi 重启了，任务中断" });
  }
```

- [ ] **Step 8:** `src/core/index.ts` 加 `export * from "./code.js";`（放在 `./briefing.js` 之后）。
- [ ] **Step 9:** `TZ=Asia/Shanghai pnpm exec vitest run test/code.test.ts test/safety.test.ts test/architecture.test.ts && pnpm typecheck && pnpm format && pnpm lint`，Expected: PASS。
- [ ] **Step 10:** `git commit -m "feat(code): coding tasks in the core: delegate, merge, discard, and what comes back"`

---

### Task 2: Node 端：工作区、适配器和后台进程

**Files:** Create `src/node/code.ts`；Test `test/code-runner.test.ts`（新）

**Interfaces — Produces:** `type AgentName = "kiro" | "claude"`；`interface AgentRun { file; args; cwd; env }`；`type Launch = (run, signal) => Promise<{ code; stdout; stderr }>`；`interface CodeSettings { timeoutMinutes; projects }`；`codeRunner(options: { home; settings: () => CodeSettings | undefined; onFinished; find?; launch?; claudeEnv? }): CodeRunner`；`findBin(bin, dirs?)`；`claudeSettings(project)`、`claudeRun(...)`、`claudeResult(stdout)`、`kiroAgent(project)`、`kiroRun(...)`；`launchAgent: Launch`。

说明：Kiro 的输出用 `--output-format text`（实测时 stdout 只有回答文字，日志在 stderr），比解析 stream-json 简单可靠。spec 第 5.4 节相应改动。

- [ ] **Step 1: 失败的测试** `test/code-runner.test.ts`：

```ts
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeResult } from "../src/core/code.js";
import { type AgentRun, type CodeSettings, codeRunner, findBin, type Launch } from "../src/node/code.js";

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
      expect.arrayContaining(["--output-format", "json", "--setting-sources", "project", "--strict-mcp-config"]),
    );
    const settings = JSON.parse(run.args[run.args.indexOf("--settings") + 1] as string);
    expect(settings).toEqual({
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
```

- [ ] **Step 2:** `TZ=Asia/Shanghai pnpm exec vitest run test/code-runner.test.ts`，Expected: FAIL（模块不存在）。

- [ ] **Step 3: `src/node/code.ts`**：

```ts
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
```

- [ ] **Step 4:** `TZ=Asia/Shanghai pnpm exec vitest run test/code-runner.test.ts && pnpm typecheck && pnpm format && pnpm lint`，Expected: PASS。
- [ ] **Step 5:** `git commit -m "feat(code): worktrees, Kiro and Claude Code adapters, background runs on this computer"`

---

### Task 3: 配置、home 和控制台接口

**Files:** Modify `src/node/config.ts`、`src/node/home.ts`、`src/node/console/server.ts`；Test `test/console.test.ts`

**Interfaces — Produces:** 配置 `code?: { timeoutMinutes: number; projects: { path; agent; commands; network }[] }`；`HomeOptions.codeLaunch?`、`HomeOptions.codeFind?`；`Home.code: CodeRunner`；`/api/state` 的 `code` 列表和 `code.done` 提议的 `taskId`；`GET /api/code/agents`、`GET /api/code/diff?id=`、`POST /api/code/stop`、`POST /api/code/discard`；保存配置时检查项目路径是 git 仓库根目录。

- [ ] **Step 1: 失败的测试**：`start()` 加第 5 个参数 `homeExtra: Partial<HomeOptions> = {}`，展开进 `openHome({ …, ...homeExtra })`（import `type HomeOptions`）。加：

```ts
describe("console: coding agents", () => {
  it("checks projects are git roots, shows a task, its changes, and discards it from the page", async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), "moqi-proj-")));
    const g = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
    g("init", "-q", "-b", "main");
    writeFileSync(join(project, "README.md"), "# p\n");
    g("add", ".");
    g("commit", "-qm", "init");
    const launch: Launch = async (run) => {
      writeFileSync(join(run.cwd, "NEW.md"), "hello\n");
      return { code: 0, stdout: "加了 NEW.md\n", stderr: "" };
    };
    const config = {
      briefingAt: null,
      code: { projects: [{ path: project, agent: "kiro", commands: ["pnpm test"] }] },
    };
    const { home, api } = await start(
      config,
      undefined,
      [],
      {},
      { codeFind: (bin) => `/bin/${bin}`, codeLaunch: launch },
    );
    expect((await api("GET", "/api/code/agents")).data).toEqual({ kiro: true, claude: true });

    const asking = home.moqi.callTool(
      "code_delegate",
      { project: basename(project), task: "加一个 NEW.md" },
      { byUser: true },
    );
    let question: { id: string; details?: string } | null = null;
    for (let i = 0; i < 50 && !question; i++) {
      await new Promise((r) => setTimeout(r, 20));
      question = (await api("GET", "/api/state")).data.question;
    }
    expect(question?.details).toContain("能跑的命令：pnpm test");
    await api("POST", "/api/confirm", { id: question?.id, yes: true });
    expect(await asking).toMatch(/^已经交给 Kiro 了/);
    let task: { id: string; status: string; files: number } | undefined;
    for (let i = 0; i < 100 && task?.status !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      task = (await api("GET", "/api/state")).data.code[0];
    }
    expect(task).toMatchObject({ status: "done", files: 1, agent: "Kiro", project: basename(project) });
    const offer = (await api("GET", "/api/state")).data.offers.find((o: { kind: string }) => o.kind === "code.done");
    expect(offer?.taskId).toBe(task?.id);
    expect((await api("GET", `/api/code/diff?id=${task?.id}`)).data.diff).toContain("+hello");
    expect((await api("POST", "/api/code/stop", { id: task?.id })).status).toBe(409);
    expect((await api("POST", "/api/code/discard", { id: task?.id })).data.message).toMatch(/^丢弃了 moqi\//);
    const after = (await api("GET", "/api/state")).data;
    expect(after.code[0].status).toBe("discarded");
    expect(after.offers.filter((o: { kind: string }) => o.kind === "code.done")).toEqual([]);

    const notRepo = mkdtempSync(join(tmpdir(), "moqi-plain-"));
    const page = {
      model: null,
      briefingAt: null,
      quiet: { from: "22:30", to: "08:00" },
      dailyBudget: 3,
      news: { feeds: [] },
    };
    const bad = await api("POST", "/api/config", {
      config: { ...page, code: { projects: [{ path: notRepo, agent: "kiro", commands: [] }] } },
    });
    expect(bad).toMatchObject({ status: 400, data: { error: `「${notRepo}」不是 git 仓库的根目录` } });
  });
});
```

（import：`execFileSync`、`realpathSync`、`basename`、`type Launch`（`../src/node/code.js`）。）

- [ ] **Step 2:** `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/console.test.ts`，Expected: FAIL。

- [ ] **Step 3: `src/node/config.ts`** `ConfigSchema` 里 `mac` 之后加：

```ts
  /** Coding agents and the projects they may work on. Absent: off. */
  code: z
    .object({
      timeoutMinutes: z.number().int().min(1).max(240).default(30),
      projects: z
        .array(
          z.object({
            path: z.string().min(1),
            agent: z.enum(["kiro", "claude"]),
            commands: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
            network: z.boolean().default(false),
          }),
        )
        .max(20)
        .default([]),
    })
    .optional(),
```

- [ ] **Step 4: `src/node/home.ts`**
  - import `type CodeRunner`（`../core/code.js`）、`codeRunner, type Launch`（`./code.js`）。
  - `HomeOptions` 加 `/** Tests: stand-ins for running and finding coding agents. */ readonly codeLaunch?: Launch; readonly codeFind?: (bin: string) => string | undefined;`
  - `Home` 加 `/** Runs coding tasks; lives as long as the home, so a rebuild of moqi does not lose them. */ readonly code: CodeRunner;`
  - `openHome` 里 `const hub = new McpHub(VERSION);` 之后加：

```ts
// A finished task is reported to whichever moqi is current by then, after the jobs before it.
const code = codeRunner({
  home: options.home,
  settings: () => config.code,
  onFinished: (id, result) => void serial(async () => moqi.codeFinished(id, result)),
  ...(options.codeFind && { find: options.codeFind }),
  ...(options.codeLaunch && { launch: options.codeLaunch }),
});
```

- `build(...)` 多一个参数 `code: CodeRunner`，`new Moqi({ … })` 里加 `code,`；三处调用都传 `code`。
- `let moqi = build(…);` 之后加 `moqi.recoverCode(); // tasks a previous run left running were cut short`。
- 返回对象加 `code,`。

* [ ] **Step 5: `src/node/console/server.ts`**
  - import `execFileSync`（`node:child_process`）、`realpathSync`（`node:fs`）、`lastSegment`（`../../core/code.js`）。
  - `/api/state`：`offers` 每项加 `...(o.kind === "code.done" && { taskId: String(o.action?.args.id ?? "") }),`；返回值加：

```ts
        code: [...moqi.state.codeTasks.values()]
          .filter((t) => t.status === "running" || now - (t.finishedAt ?? t.task.startedAt) < 30 * 86_400_000)
          .reverse()
          .map((t) => ({
            id: t.task.id,
            agent: home.code.label(t.task.agent),
            project: lastSegment(t.task.project),
            task: t.task.task,
            status: t.status,
            startedAt: t.task.startedAt,
            branch: t.task.branch,
            files: t.files?.length ?? 0,
          })),
```

- routes 加：

```ts
    "GET /api/code/agents": () => ({ kiro: home.code.available("kiro"), claude: home.code.available("claude") }),

    "GET /api/code/diff": async (_body, url) => {
      const t = home.moqi.state.codeTasks.get(url.searchParams.get("id") ?? "");
      if (!t) throw new HttpError(404, "没有这个任务");
      return { diff: await home.code.diff(t.task) };
    },

    "POST /api/code/stop": (body) => {
      if (!home.code.stop(str(body.id, "id"))) throw new HttpError(409, "这个任务已经不在跑了");
      return { ok: true };
    },

    "POST /api/code/discard": async (body) => {
      const id = str(body.id, "id");
      const problem = home.moqi.checkTool("code_discard", { id });
      if (problem) throw new HttpError(400, problem);
      // Pressing "discard" twice on the page is the user's own decision, so it does not ask again.
      const message = await home.serial(async () => {
        const said = await home.moqi.callTool("code_discard", { id }, { byUser: true, preApproved: true });
        for (const o of home.moqi.state.openOffers(home.moqi.clock.now()))
          if (o.kind === "code.done" && o.action?.args.id === id) await home.moqi.feedback(o.id, "dismissed");
        return said;
      });
      return { message };
    },
```

- `POST /api/config` 的文件夹检查之后加：

```ts
for (const p of parsed.data.code?.projects ?? []) {
  let same = false;
  try {
    const real = realpathSync(expandHome(p.path));
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: real, encoding: "utf8" }).trim();
    same = realpathSync(top) === real;
  } catch {
    same = false;
  }
  if (!same) throw new HttpError(400, `「${p.path}」不是 git 仓库的根目录`);
}
```

- [ ] **Step 6:** `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/console.test.ts test/node.test.ts test/cli.test.ts && pnpm typecheck && pnpm format && pnpm lint`，Expected: PASS。
- [ ] **Step 7:** `git commit -m "feat(code): projects in the config, tasks on the home, and the console's code API"`

---

### Task 4: 控制台页面

**Files:** `src/node/console/assets/index.html`、`app.js`、`app.css`；Test `test/console.test.ts`

- [ ] **Step 1:** 页面测试加 `expect(html).toContain('id="code-running"');`、`expect(html).toContain('id="code-projects"');`。
- [ ] **Step 2: `index.html`**：动态里 `<div class="list" id="offers"></div>` 之前加 `<div class="list" id="code-running"></div>`；"能力包"里 macOS 那个 `.field` 之后加：

```html
            <div class="field">
              <span class="label">编程 agent</span>
              <p class="hint first" id="code-agents">正在找这台电脑上的编程 agent…</p>
              <div class="list" id="code-projects"></div>
              <div class="inline">
                <button type="button" class="btn" id="code-add">添加项目</button>
                <span class="unit">每个任务最长</span>
                <label for="code-timeout" class="sr-only">每个任务最长几分钟</label>
                <input id="code-timeout" type="number" min="1" max="240" step="1" inputmode="numeric" class="short" />
                <span class="unit">分钟</span>
              </div>
              <p class="hint">任务在单独的分支和工作区里做，你点「合并」之前不碰项目目录。agent 只能改工作区里的文件、只能跑你列出的命令，命令在它自己的沙箱里跑。</p>
            </div>
```

- [ ] **Step 3: `app.js`**
  - 状态变量加 `let codeKey = "";`。
  - `renderFeed()` 开头加 `renderCode();`，并加函数：

```js
function renderCode() {
  const list = $("code-running");
  const running = (state.code || []).filter((t) => t.status === "running");
  const key = JSON.stringify(running);
  if (key === codeKey) return refreshTimes(list);
  codeKey = key;
  list.replaceChildren();
  for (const t of running) {
    const stop = async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        await api("POST", "/api/code/stop", { id: t.id });
        toast("让它停下了，已经做的改动会留在分支上");
      } catch (error) {
        toast(error.message);
      }
      refresh();
    };
    list.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h(
            "p",
            { class: "item-text" },
            h("span", { class: "tag", text: "进行中" }),
            `${t.agent} · ${t.project}：${t.task}`,
          ),
          h("p", { class: "item-meta" }, "开始于", timeOf(t.startedAt)),
        ),
        h("button", { type: "button", class: "btn", text: "停下", onclick: stop }),
      ),
    );
  }
}
```

- `offerCard` 里 `if (o.answer) {` 之前加：

```js
  if (o.kind === "code.done") {
    const task = (state.code || []).find((t) => t.id === o.taskId);
    const changes = h("pre", { class: "ask-details", hidden: true });
    const look = async (e) => {
      const button = e.currentTarget;
      if (!changes.hidden) {
        changes.hidden = true;
        button.textContent = "看改动";
        return;
      }
      button.disabled = true;
      try {
        const { diff } = await api("GET", `/api/code/diff?id=${encodeURIComponent(o.taskId)}`);
        changes.textContent = diff || "（没有改动）";
        changes.hidden = false;
        button.textContent = "收起改动";
      } catch (error) {
        toast(error.message);
      }
      button.disabled = false;
    };
    const changed = !!task && task.files > 0;
    const open = !!task && (task.status === "done" || task.status === "failed");
    return h(
      "article",
      { class: "card" },
      head,
      body,
      changes,
      h(
        "div",
        { class: "actions" },
        changed && open ? h("button", { type: "button", class: "btn primary", text: "合并", onclick: respond("accepted") }) : null,
        changed ? h("button", { type: "button", class: "btn", text: "看改动", onclick: look }) : null,
        h("span", { class: "spacer" }),
        open ? removeButton("丢弃这个任务的分支", "确定丢弃", () => api("POST", "/api/code/discard", { id: o.taskId })) : null,
      ),
    );
  }
```

- 设置：在 `loadShortcuts` 之后加：

```js
async function loadCodeAgents() {
  let found = { kiro: false, claude: false };
  try {
    found = await api("GET", "/api/code/agents");
  } catch {
    // shown as none found
  }
  const names = [found.kiro ? "Kiro" : "", found.claude ? "Claude Code" : ""].filter(Boolean);
  $("code-agents").textContent = names.length
    ? `找到了：${names.join("、")}。Cursor 暂不支持：要先登录，并实测它的权限限制能生效。`
    : "这台电脑上没找到 Kiro 或 Claude Code。";
}

function projectRow(p) {
  const path = h("input", {
    type: "text",
    class: "code-path",
    spellcheck: "false",
    placeholder: "~/code/项目",
    "aria-label": "项目路径",
  });
  path.value = p.path || "";
  const agent = h(
    "select",
    { class: "policy code-agent", "aria-label": "交给谁" },
    h("option", { value: "kiro", text: "Kiro" }),
    h("option", { value: "claude", text: "Claude Code" }),
  );
  agent.value = p.agent || "kiro";
  const commands = h("textarea", {
    class: "code-commands",
    rows: "2",
    spellcheck: "false",
    placeholder: "pnpm test",
    "aria-label": "允许跑的命令",
  });
  commands.value = (p.commands || []).join("\n");
  const network = h("input", { type: "checkbox", class: "code-network" });
  network.checked = !!p.network;
  const row = h(
    "div",
    { class: "item code-project" },
    h(
      "div",
      { class: "item-main" },
      path,
      h("p", { class: "hint", text: "允许跑的命令，一行一条；其他命令一律拒绝：" }),
      commands,
      h("label", { class: "check" }, network, "允许命令联网（比如要装依赖）"),
    ),
    h(
      "div",
      { class: "code-side" },
      agent,
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          "aria-label": "删除这个项目",
          title: "删除这个项目",
          onclick: () => row.remove(),
        },
        icon("trash"),
      ),
    ),
  );
  return row;
}

$("code-add").addEventListener("click", () => $("code-projects").append(projectRow({ commands: ["pnpm test"] })));

function projectsInput() {
  return [...document.querySelectorAll(".code-project")]
    .map((row) => ({
      path: row.querySelector(".code-path").value.trim(),
      agent: row.querySelector(".code-agent").value,
      commands: row
        .querySelector(".code-commands")
        .value.split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
      network: row.querySelector(".code-network").checked,
    }))
    .filter((p) => p.path);
}
```

- `loadSettings` 里 macOS 那几行之后加：

```js
$("code-projects").replaceChildren(...(config.code ? config.code.projects : []).map(projectRow));
$("code-timeout").value = String(config.code ? config.code.timeoutMinutes : 30);
await loadCodeAgents();
```

- 保存的 `config` 里加：

```js
    code: projectsInput().length
      ? { timeoutMinutes: Number($("code-timeout").value) || 30, projects: projectsInput() }
      : undefined,
```

- [ ] **Step 4: `app.css`** 加：

```css
.code-project {
  align-items: flex-start;
}

.code-project .item-main {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.code-side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
```

- [ ] **Step 5:** `node --check src/node/console/assets/app.js && pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/console.test.ts && pnpm format && pnpm lint`；再用无头 Chrome 截设置页"编程 agent"和一张 `code.done` 卡片，确认显示正常。
- [ ] **Step 6:** `git commit -m "feat(console): running coding tasks, their results, and projects in settings"`

---

### Task 5: 真机检查、文档和全量检查

- [ ] **Step 1: 真机检查（Kiro）**：临时 git 仓库，里面一个 `check.js`（打印"测试通过"）；项目配置 `commands: ["node check.js"]`。用 `openHome`（`confirm` 自动同意）调用 `code_delegate`，任务是：`在 README.md 末尾加一行「hello from kiro」，然后运行 node check.js；再试着运行 ls ~，以及写一个文件到 /tmp/moqi-escape-test。最后告诉我哪些成功、哪些被拒绝。` 等任务结束，确认：README 的改动在任务分支里；`node check.js` 跑了；`ls ~` 被拒；`/tmp/moqi-escape-test` 不存在；项目目录没变。结果记进 CHANGELOG 和 README 的说明。Claude Code 当前登录失效（401），不做真机检查，文档写明"未实测"。
- [ ] **Step 2: 文档**：
  - `CHANGELOG.md` Unreleased 加一条（英文），写明：交给 Kiro / Claude Code，单独分支和工作区，只改工作区、只跑列出的命令、各家沙箱，合并或丢弃，偏好随任务传过去且确认框列出，Kiro 实测结果，Claude Code 未实测。
  - README（中英文）"能力包"表加"编程 agent"一行；"设计取舍"加一行：任务在单独的分支和工作区里做，点"合并"才回到你的目录。
  - `docs/design.md` "操作电脑"一节加"编程 agent"一段。
  - spec 第 5.4 节改为 `--output-format text`。
- [ ] **Step 3:** `pnpm exec biome check --write README.md README.zh-CN.md docs/design.md CHANGELOG.md docs/superpowers && pnpm check`，Expected: 全部通过。
- [ ] **Step 4:** `git commit -m "docs: coding agents"`
