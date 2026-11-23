import { describe, expect, it } from "vitest";
import type { OfferInput } from "../src/core/plugin.js";
import { decide, defaultPolicy, inQuietHours } from "../src/core/proactive.js";
import { RULES } from "../src/core/state.js";
import { DAY, harness } from "./helpers.js";

const news = (over: Partial<OfferInput> = {}): OfferInput => ({
  kind: "test",
  title: "t",
  body: "b",
  value: 0.8,
  urgency: "today",
  ...over,
});

describe("when to speak up", () => {
  it("knows quiet hours across midnight", () => {
    expect(inQuietHours(defaultPolicy, Date.parse("2026-11-20T23:00:00+08:00"))).toBe(true);
    expect(inQuietHours(defaultPolicy, Date.parse("2026-11-20T07:59:00+08:00"))).toBe(true);
    expect(inQuietHours(defaultPolicy, Date.parse("2026-11-20T08:00:00+08:00"))).toBe(false);
  });

  it("interrupts for valuable, timely offers and keeps the rest in the feed", async () => {
    const { moqi, delivered } = harness();
    await moqi.offer(news());
    await moqi.offer(news({ value: 0.3 }));
    await moqi.offer(news({ urgency: "whenever" }));
    expect(delivered.map((d) => d.surface)).toEqual(["notify", "feed", "feed"]);
  });

  it("stays quiet at night unless it is urgent and important", async () => {
    const { moqi, delivered } = harness({ start: "2026-11-20T23:30:00+08:00" });
    await moqi.offer(news({ urgency: "today" }));
    await moqi.offer(news({ urgency: "now", value: 0.95 }));
    expect(delivered.map((d) => d.surface)).toEqual(["feed", "notify"]);
  });

  it("interrupts at most three times a day, then resets the next day", async () => {
    const { moqi, clock, delivered } = harness();
    for (let i = 0; i < 5; i++) await moqi.offer(news());
    expect(delivered.map((d) => d.surface)).toEqual(["notify", "notify", "notify", "feed", "feed"]);
    clock.advance(DAY);
    await moqi.offer(news());
    expect(delivered.at(-1)?.surface).toBe("notify");
  });

  it("learns from dismissals to bother less with that kind", async () => {
    const { moqi } = harness();
    const offer = await moqi.offer(news({ value: 0.55 }));
    expect(decide(moqi.state, moqi.policy, { ...offer, id: "x" }, moqi.clock.now()).surface).toBe("notify");
    await moqi.feedback(offer.id, "dismissed");
    expect(moqi.state.kind("test").threshold).toBeCloseTo(RULES.thresholdStart + RULES.onDismissed);
    expect(decide(moqi.state, moqi.policy, { ...offer, id: "y" }, moqi.clock.now()).surface).toBe("feed");
  });

  it("drops a kind the user muted until they unmute it", async () => {
    const { moqi, delivered } = harness();
    await moqi.feedback((await moqi.offer(news())).id, "muted");
    await moqi.offer(news());
    expect(delivered).toHaveLength(1);
    moqi.unmute("test");
    await moqi.offer(news());
    expect(delivered).toHaveLength(2);
  });

  it("counts an offer nobody answered as ignored when it expires", async () => {
    const { moqi, clock } = harness();
    const offer = await moqi.offer(news());
    clock.advance(DAY + 1);
    await moqi.tick();
    expect(moqi.state.offers.get(offer.id)?.verdict).toBe("ignored");
    expect(moqi.state.kind("test").threshold).toBeCloseTo(RULES.thresholdStart + RULES.onIgnored);
  });
  it("always lets through a reminder at the time the user set, and does not count it", async () => {
    const { moqi } = harness({ start: "2026-11-20T23:30:00+08:00" });
    await moqi.feedback((await moqi.offer(news())).id, "muted");
    const timed = { ...news({ value: 0.1, urgency: "whenever", userTimed: true }), id: "x", createdAt: 0 };
    const policy = { ...moqi.policy, dailyBudget: 0 };
    expect(decide(moqi.state, policy, timed, moqi.clock.now())).toEqual({
      surface: "notify",
      reason: "你定的时间到了",
    });
  });
});
