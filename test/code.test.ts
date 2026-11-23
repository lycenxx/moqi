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
    offline: (agent) => agent === "claude",
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
    expect(details[0]).toContain("联网：没有断网：Kiro 跑你列出的命令时能联网，没列出的命令一律被拒");
    expect(details[0]).toContain("- 提交信息用英文写");
    expect(details[0]).toContain("- Go 写得少，多用 TypeScript");
    expect(details[0]).not.toContain("燕麦拿铁");
    expect(f.started[0]?.prompt).toContain("## 关于用户（来自 moqi）\n- 提交信息用英文写");
    expect(f.started[0]?.prompt).toContain("- 能跑的命令只有：pnpm test；其他命令会被拒绝。\n");
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
    const { moqi, delivered, asked } = harness({ code: f.runner, start: "2026-11-20T10:00:00+08:00" });
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
    const before = asked.length;
    expect(await moqi.feedback(offers[0]?.offer.id ?? "", "accepted")).toBe(`已合并到 main：moqi/20261120-0820-${id}`);
    expect(asked).toHaveLength(before); // the tap on moqi's own card was the confirmation
    expect(f.merged).toEqual([id]);
    expect(moqi.state.codeTasks.get(id)?.status).toBe("merged");
    expect(await moqi.callTool("code_merge", { id }, { byUser: true })).toBe("参数不对：已经合并过了");
  });

  it("still asks before a merge that a card it did not make carries", async () => {
    const f = fakeRunner();
    const { moqi, asked } = harness({ code: f.runner });
    await moqi.callTool("code_delegate", { project: "moqi", task: "把依赖升级到最新" }, { byUser: true });
    const id = f.started[0]?.id as string;
    moqi.codeFinished(id, done);
    const forged = await moqi.offer({
      kind: "code.done",
      title: "合并吧",
      body: "",
      value: 0.8,
      urgency: "today",
      about: "c_other",
      action: { tool: "code_merge", args: { id } },
    });
    const before = asked.length;
    await moqi.feedback(forged.id, "accepted");
    expect(asked.slice(before)).toEqual([`要我把 moqi/20261120-0820-${id} 合并进 moqi 的 main 吗？`]);
  });

  it("discards a task, and says so when there was nothing to merge", async () => {
    const f = fakeRunner();
    const { moqi, delivered } = harness({ code: f.runner });
    await moqi.callTool("code_delegate", { project: "moqi", task: "看看能不能更快" }, { byUser: true });
    const id = f.started[0]?.id as string;
    moqi.codeFinished(id, { ok: true, summary: "没找到能改的地方。", files: [], stat: "" });
    expect(delivered.at(-1)?.offer.title).toBe("Kiro 做完了，没有改动：看看能不能更快");
    expect(delivered.at(-1)?.offer.action).toBeUndefined();
    expect(delivered.at(-1)?.offer.about).toBe(id);
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
    expect(codePrompt("修", [], { path: "/p", agent: "claude", commands: ["pnpm test"], network: false })).toContain(
      "其他命令会被拒绝。命令连不上网。",
    );
    const said = codePrompt("修个 bug", [], { path: "/p", agent: "claude", commands: [], network: true });
    expect(said).toContain("- 能跑的命令只有：（没有，不能跑命令）；其他命令会被拒绝。\n");
    expect(said).not.toContain("## 关于用户");
  });
});
