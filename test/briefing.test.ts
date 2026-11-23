import { describe, expect, it } from "vitest";
import { DAY, harness } from "./helpers.js";

describe("daily briefing", () => {
  it("is offered once a day at the configured time, with plugin sections", async () => {
    const plugin = { name: "agenda", briefing: () => ({ title: "今天的日程", lines: ["09:30 周会"] }) };
    const { moqi, clock, delivered } = harness({
      briefingAt: "08:00",
      plugins: [plugin],
      start: "2026-11-20T07:59:00+08:00",
    });
    await moqi.tick();
    expect(delivered.filter((d) => d.offer.kind === "briefing")).toHaveLength(0);
    clock.set("2026-11-20T08:00:30+08:00");
    await moqi.tick();
    await moqi.tick();
    const briefings = delivered.filter((d) => d.offer.kind === "briefing");
    expect(briefings).toHaveLength(1);
    expect(briefings[0]).toMatchObject({ surface: "notify", offer: { title: "今天的简报 · 11月20日 周五" } });
    expect(briefings[0]?.offer.body).toContain("【今天的日程】\n· 09:30 周会");
    clock.advance(DAY);
    await moqi.tick();
    expect(delivered.filter((d) => d.offer.kind === "briefing")).toHaveLength(2);
  });

  it("collects what moqi kept in the feed, open questions, and today's watches", async () => {
    const { moqi, clock } = harness({ start: "2026-11-20T08:00:00+08:00" });
    await moqi.offer({ kind: "deal", title: "降价了", body: "990 元", value: 0.3, urgency: "today" });
    moqi.remember({ kind: "basic", content: "住在深圳" });
    moqi.remember({ kind: "basic", content: "住在北京", contradicts: [...moqi.state.facts.keys()][0] as string });
    await moqi.callTool(
      "watch_create",
      { title: "早点睡", schedule: { every: "day", at: "22:00" }, remind: "该睡了" },
      { byUser: true },
    );
    const b = await moqi.briefing();
    expect(b.body).toMatch(/【替你留意】\n· 降价了：990 元/);
    expect(b.body).toContain("【需要你定】\n· 你之前说「住在深圳」，后来说「住在北京」");
    expect(b.body).toContain("【今天替你盯着】\n· 早点睡（每天 22:00）");
    expect(b.sections).toBe(3);
    void clock;
  });

  it("does not interrupt when there is nothing to say", async () => {
    const { moqi, delivered } = harness({ briefingAt: "08:00", start: "2026-11-20T08:05:00+08:00" });
    await moqi.tick();
    expect(delivered).toEqual([
      expect.objectContaining({
        surface: "feed",
        offer: expect.objectContaining({ body: "今天没有需要你操心的事。" }),
      }),
    ]);
  });

  it("keeps the briefing when one source fails", async () => {
    const broken = { name: "broken", briefing: () => Promise.reject(new Error("boom")) };
    const ok = { name: "ok", briefing: () => ({ title: "天气", lines: ["晴"] }) };
    const { moqi } = harness({ plugins: [broken, ok] });
    expect((await moqi.briefing()).body).toContain("【天气】\n· 晴");
  });

  it("lists today's todos with how long each was put off, and does not repeat reminders kept in the feed", async () => {
    const { moqi, clock } = harness({ start: "2026-11-19T09:00:00+08:00" });
    const add = (args: Record<string, unknown>) => moqi.callTool("todo_add", args, { byUser: true });
    await add({ text: "交报告" });
    clock.set("2026-11-20T07:00:00+08:00");
    await add({ text: "开会", at: "15:00" });
    await add({ text: "续费", day: "tomorrow" });
    await moqi.offer({ kind: "todo.remind", title: "吃药", body: "本来 22:00 提醒你", value: 0.3, urgency: "today" });
    clock.set("2026-11-20T08:00:00+08:00");
    const b = await moqi.briefing();
    expect(b.body).toContain("【今天要做】\n· 15:00 开会\n· 交报告（已拖 1 天）");
    expect(b.body).not.toContain("续费");
    expect(b.body).not.toContain("吃药");
    expect(b.sections).toBe(1);
  });
});
