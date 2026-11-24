import { describe, expect, it } from "vitest";
import { FEED, seenOffers } from "../src/core/feed.js";
import { harness } from "./helpers.js";

describe("what the user has seen in the feed", () => {
  it("keeps cards the user answered or let expire, newest first, with what became of them", async () => {
    const { moqi, clock } = harness();
    const offer = (title: string, extra: Record<string, unknown> = {}) =>
      moqi.offer({ kind: "test.note", title, body: "", value: 0.9, urgency: "whenever", ...extra });
    const a = await offer("甲", { links: [{ title: "原文", url: "https://sspai.com/1" }] });
    const b = await offer("乙", { action: { tool: "todo_add", args: { text: "交周报" } } });
    await offer("丙", { expiresAt: clock.now() + 60_000 });
    const open = await offer("丁");
    await moqi.feedback(a.id, "dismissed");
    clock.advance(1000);
    await moqi.feedback(b.id, "accepted");
    clock.advance(120_000);
    const seen = seenOffers(moqi.state, clock.now());
    expect(seen.map((s) => [s.record.offer.title, s.outcome])).toEqual([
      ["丙", "没理会，过期了"],
      ["乙", "好"],
      ["甲", "你说不用"],
    ]);
    expect(seen.some((s) => s.record.offer.id === open.id)).toBe(false);
    expect(seen[2]?.record.offer.links).toEqual([{ title: "原文", url: "https://sspai.com/1" }]);
  });

  it("forgets what is older than 30 days and keeps at most 100", async () => {
    const { moqi, clock } = harness();
    const note = (title: string) => moqi.offer({ kind: "test.note", title, body: "", value: 0.9, urgency: "whenever" });
    const old = await note("旧的");
    await moqi.feedback(old.id, "accepted");
    clock.advance((FEED.historyDays + 1) * 86_400_000);
    for (let i = 0; i < FEED.historyMax + 5; i++) await moqi.feedback((await note(`新 ${i}`)).id, "accepted");
    const seen = seenOffers(moqi.state, clock.now());
    expect(seen).toHaveLength(FEED.historyMax);
    expect(seen.every((s) => s.outcome === "有用")).toBe(true);
    expect(seen.some((s) => s.record.offer.title === "旧的")).toBe(false);
  });
});
