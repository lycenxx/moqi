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
  /** Whether this agent's sandbox keeps the listed commands off the network when a project says so. */
  offline(agent: string): boolean;
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
export function codePrompt(task: string, prefs: readonly string[], project: CodeProject, offline = true): string {
  const lines = [task.trim(), ""];
  if (prefs.length > 0) lines.push("## 关于用户（来自 moqi）", ...prefs.map((p) => `- ${p}`), "");
  const commands = project.commands.length > 0 ? project.commands.join("、") : "（没有，不能跑命令）";
  lines.push(
    "## 规矩",
    "- 只在当前目录里改文件。",
    `- 能跑的命令只有：${commands}；其他命令会被拒绝。${project.network || !offline ? "" : "命令连不上网。"}`,
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
    about: task.id,
    // Nothing to merge: the user can only discard it.
    ...(result.files.length > 0 && { action: { tool: "code_merge", args: { id: task.id } } }),
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
          `联网：${
            p.network
              ? "可以"
              : runner.offline(a.agent ?? p.agent)
                ? "不能"
                : `没有断网：${runner.label(a.agent ?? p.agent)} 跑你列出的命令时能联网，没列出的命令一律被拒`
          }`,
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
        const prompt = codePrompt(a.task, codePreferences(k.state, k.now()), p, runner.offline(agent));
        const started = await runner.start({ id, project: p, agent, task: a.task, prompt, now: k.now() });
        k.emit({ type: "code.started", task: started });
        return `已经交给 ${runner.label(agent)} 了（任务 ${id}），做完会在动态里告诉你。`;
      },
    }),
    ...tools,
  ];
}
