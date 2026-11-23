import { describe, expect, it } from "vitest";
import { systemPrompt } from "../src/core/agent.js";
import type { ChatRequest } from "../src/core/model.js";
import { call, harness, scriptedModel } from "./helpers.js";

const isExtraction = (r: ChatRequest) => r.messages[0]?.content.includes("从对话里摘出用户亲口说的") ?? false;
const lastTool = (r: ChatRequest) => [...r.messages].reverse().find((m) => m.role === "tool");

describe("conversation", () => {
  it("answers, calling tools in a loop and feeding results back", async () => {
    const model = scriptedModel((r) => {
      if (isExtraction(r)) return '{"facts":[]}';
      return lastTool(r)
        ? `好的，${lastTool(r)?.content}`
        : call("remember", { kind: "basic", content: "住在深圳南山" });
    });
    const { moqi } = harness({ model });
    expect(await moqi.chat("我住在深圳南山")).toBe("好的，记住了：住在深圳南山");
    expect([...moqi.state.facts.values()].map((f) => f.content)).toEqual(["住在深圳南山"]);
    expect(model.requests[0]?.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["remember", "watch_create"]));
    expect(model.requests[0]?.tools?.map((t) => t.name)).not.toContain("set_level");
  });

  it("asks the user before a write the model wants, and tells the model the answer", async () => {
    const model = scriptedModel((r) =>
      lastTool(r)
        ? `结果：${lastTool(r)?.content}`
        : call("watch_create", { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "该睡了" }),
    );
    const { moqi, asked } = harness({ model, answer: false });
    expect(await moqi.chat("每晚十点提醒我睡觉")).toBe("结果：用户没有同意，这一步没做");
    expect(asked).toHaveLength(1);
  });

  it("puts what it knows about the user into the system prompt", () => {
    const { moqi } = harness();
    moqi.remember({ kind: "relation", content: "女儿叫朵朵" });
    expect(systemPrompt(moqi)).toMatch(/女儿叫朵朵[\s\S]*做事的方式/);
    expect(systemPrompt(moqi)).toContain("2026年11月20日 周五 08:20");
  });

  it("learns facts on the side every third user turn, never inside the chat", async () => {
    const model = scriptedModel((r) =>
      isExtraction(r)
        ? '```json\n{"facts":[{"kind":"preference","content":"喜欢喝燕麦拿铁"},{"kind":"relation","content":"女儿叫朵朵"}]}\n```'
        : "嗯",
    );
    const { moqi } = harness({ model });
    await moqi.chat("早");
    await moqi.chat("今天想喝燕麦拿铁");
    expect(model.requests.filter(isExtraction)).toHaveLength(0);
    await moqi.chat("下午要去接朵朵，她是我女儿");
    await moqi.idle();
    const extraction = model.requests.find(isExtraction);
    expect(extraction).toMatchObject({ temperature: 0, json: true, reasoning: "off" });
    expect(extraction?.tools).toBeUndefined();
    expect([...moqi.state.facts.values()].map((f) => f.content)).toEqual(["喜欢喝燕麦拿铁", "女儿叫朵朵"]);
  });

  it("marks facts learned from a conversation another agent took part in", async () => {
    const model = scriptedModel((r) =>
      isExtraction(r) ? JSON.stringify({ facts: [{ kind: "preference", content: "想要每天清空下载文件夹" }] }) : "嗯",
    );
    const { moqi } = harness({ model });
    await moqi.chat("早");
    await moqi.chat("【kiro-cli】用户想要每天清空下载文件夹", undefined, { fromAgent: true });
    await moqi.chat("好的");
    await moqi.idle();
    expect([...moqi.state.facts.values()]).toMatchObject([{ content: "想要每天清空下载文件夹", by: "外部内容" }]);
  });

  it("forgets who wrote a memory once the user settles a contradiction in favour of it", async () => {
    const { moqi } = harness();
    moqi.remember({ kind: "basic", content: "住在深圳" });
    const id = [...moqi.state.facts.keys()][0] as string;
    moqi.remember({ kind: "basic", content: "住在北京", contradicts: id, by: "kiro-cli" });
    await moqi.callTool("resolve_conflict", { id, keep: "new" }, { byUser: true, preApproved: true });
    expect(moqi.state.facts.get(id)).toMatchObject({ content: "住在北京" });
    expect(moqi.state.facts.get(id)?.by).toBeUndefined();
  });

  it("turns a contradiction found while learning into a question for the user", async () => {
    const { moqi, delivered } = harness();
    moqi.remember({ kind: "basic", content: "住在深圳" });
    const id = [...moqi.state.facts.keys()][0];
    const model = scriptedModel((r) =>
      isExtraction(r) ? JSON.stringify({ facts: [{ kind: "basic", content: "住在北京", contradicts: id }] }) : "好",
    );
    const withModel = harness({ model, store: moqi.store });
    for (let i = 0; i < 3; i++) await withModel.moqi.chat(`第 ${i} 句`);
    await withModel.moqi.idle();
    expect(withModel.moqi.state.conflicts.get(id ?? "")).toMatchObject({ old: "住在深圳", new: "住在北京" });
    expect(withModel.delivered.some((d) => d.offer.kind === "memory.conflict")).toBe(true);
    void delivered;
  });

  it("survives malformed tool arguments and unknown tools", async () => {
    let round = 0;
    const model = scriptedModel((r) => {
      if (isExtraction(r)) return '{"facts":[]}';
      round++;
      if (round === 1) return { content: "", toolCalls: [{ id: "a", name: "remember", arguments: "{oops" }] };
      if (round === 2) return call("teleport", {});
      return `${lastTool(r)?.content}`;
    });
    const { moqi } = harness({ model });
    expect(await moqi.chat("hi")).toBe("没有工具 teleport");
  });

  it("answers without waiting for learning to finish", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const model = scriptedModel((r) => (isExtraction(r) ? '{"facts":[{"kind":"other","content":"慢慢学"}]}' : "嗯"));
    const slow = {
      id: "slow",
      requests: model.requests,
      chat: async (r: ChatRequest) => {
        if (isExtraction(r)) await gate;
        return model.chat(r);
      },
    };
    const { moqi } = harness({ model: slow });
    for (let i = 0; i < 3; i++) expect(await moqi.chat(`第 ${i} 句`)).toBe("嗯");
    expect(moqi.state.facts.size).toBe(0); // the third answer came back before learning finished
    release();
    await moqi.idle();
    expect([...moqi.state.facts.values()].map((f) => f.content)).toEqual(["慢慢学"]);
  });

  it("explains that chat needs a model", async () => {
    const { moqi } = harness();
    await expect(moqi.chat("hi")).rejects.toThrow(/no model/);
  });
});

describe("openAICompatible", () => {
  it("adds /no_think only to quick side requests, and only when enabled", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "<think>hmm</think>ok" } }] }));
    }) as typeof globalThis.fetch;
    const on = openAICompatible({ baseURL: "http://x/v1", model: "qwen3", noThink: true, fetch });
    const off = openAICompatible({ baseURL: "http://x/v1", model: "qwen3", fetch });
    const messages = [
      { role: "system" as const, content: "s" },
      { role: "user" as const, content: "hi" },
    ];
    expect((await on.chat({ messages, reasoning: "off" })).content).toBe("ok");
    await on.chat({ messages });
    await off.chat({ messages, reasoning: "off" });
    expect(bodies.map((b) => b.messages[1]?.content)).toEqual(["hi /no_think", "hi", "hi"]);
  });

  it("asks models with adjustable reasoning for the lightest effort on background requests only", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const bodies: Record<string, unknown>[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    }) as typeof globalThis.fetch;
    const glimmer = openAICompatible({ baseURL: "http://x/v1", model: "muse-glimmer", effort: "low", fetch });
    const messages = [{ role: "user" as const, content: "hi" }];
    await glimmer.chat({ messages, reasoning: "off" });
    await glimmer.chat({ messages });
    expect(bodies.map((b) => b.reasoning_effort)).toEqual(["low", undefined]);
  });
});
