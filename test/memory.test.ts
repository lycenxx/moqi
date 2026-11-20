import { describe, expect, it } from "vitest";
import { activeFacts, normalize, promptSection } from "../src/core/memory.js";
import { State } from "../src/core/state.js";
import { DAY, harness } from "./helpers.js";

describe("user model", () => {
  it("treats differently punctuated statements as the same fact", () => {
    expect(normalize("住在 深圳。")).toBe(normalize("住在深圳"));
  });

  it("makes a fact long-term after three separate confirmations", () => {
    const { moqi } = harness();
    expect(moqi.remember({ kind: "basic", content: "住在深圳" })).toMatch(/记住了/);
    moqi.remember({ kind: "basic", content: "住在深圳。" });
    const [fact] = [...moqi.state.facts.values()];
    expect(fact).toMatchObject({ confirmations: 2, term: "short" });
    moqi.remember({ kind: "basic", content: "住在 深圳" });
    expect([...moqi.state.facts.values()][0]).toMatchObject({ confirmations: 3, term: "long" });
    expect(moqi.state.facts.size).toBe(1);
  });

  it("lets short-term facts fade after 30 quiet days, but keeps long-term ones", () => {
    const { moqi, clock } = harness();
    moqi.remember({ kind: "preference", content: "最近在喝燕麦拿铁" });
    for (let i = 0; i < 3; i++) moqi.remember({ kind: "basic", content: "在杭州上班" });
    clock.advance(31 * DAY);
    expect(activeFacts(moqi.state, clock.now()).map((f) => f.content)).toEqual(["在杭州上班"]);
    expect(moqi.state.facts.size).toBe(2); // faded, not deleted
  });

  it("asks the user to settle a contradiction, and keeps what they choose", async () => {
    const { moqi, delivered } = harness();
    moqi.remember({ kind: "basic", content: "住在深圳" });
    const id = [...moqi.state.facts.keys()][0] as string;
    expect(moqi.remember({ kind: "basic", content: "住在北京", contradicts: id })).toMatch(/请用户定/);
    expect(moqi.state.conflicts.get(id)).toMatchObject({ old: "住在深圳", new: "住在北京" });
    const offer = delivered.find((d) => d.offer.kind === "memory.conflict")?.offer;
    expect(offer?.body).toContain("住在深圳");
    expect(await moqi.feedback(offer?.id ?? "", "accepted")).toMatch(/住在北京/);
    expect(moqi.state.facts.get(id)?.content).toBe("住在北京");
    expect(moqi.state.conflicts.size).toBe(0);
  });

  it("keeps the old fact when the user dismisses the contradiction", async () => {
    const { moqi, delivered } = harness();
    moqi.remember({ kind: "basic", content: "住在深圳" });
    const id = [...moqi.state.facts.keys()][0] as string;
    moqi.remember({ kind: "basic", content: "住在北京", contradicts: id });
    await moqi.feedback(delivered[0]?.offer.id ?? "", "dismissed");
    expect(moqi.state.facts.get(id)?.content).toBe("住在深圳");
  });

  it("puts long-term facts first in the prompt and marks unconfirmed ones", () => {
    const { moqi, clock } = harness();
    moqi.remember({ kind: "preference", content: "喜欢靠窗的座位" });
    for (let i = 0; i < 3; i++) moqi.remember({ kind: "relation", content: "女儿叫朵朵" });
    const text = promptSection(moqi.state, clock.now());
    expect(text.indexOf("女儿叫朵朵")).toBeLessThan(text.indexOf("喜欢靠窗"));
    expect(text).toContain("喜欢靠窗的座位（待印证）");
  });

  it("rebuilds exactly the same model from the log", () => {
    const { moqi } = harness();
    moqi.remember({ kind: "basic", content: "住在深圳" });
    moqi.remember({ kind: "basic", content: "住在深圳" });
    const rebuilt = State.from(moqi.store.all());
    expect([...rebuilt.facts.values()]).toEqual([...moqi.state.facts.values()]);
  });

  it("always confirms before forgetting, however often the user said yes", async () => {
    const { moqi, asked } = harness();
    for (let i = 0; i < 5; i++) {
      moqi.remember({ kind: "other", content: `事实 ${i}` });
      const id = [...moqi.state.facts.keys()].at(-1) as string;
      expect(await moqi.callTool("forget", { id }, { byUser: true })).toMatch(/已忘掉/);
    }
    expect(asked).toHaveLength(5);
    expect(moqi.state.openOffers(Date.now() + 1).some((o) => o.kind === "trust.promote")).toBe(false);
  });
});
