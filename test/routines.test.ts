import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, type Plugin } from "../src/core/plugin.js";
import { findRoutines } from "../src/core/routines.js";
import { DAY, harness } from "./helpers.js";

function weatherStub(): Plugin & { calls: number } {
  const plugin = {
    name: "weather-stub",
    calls: 0,
    tools: [
      defineTool({
        name: "weather",
        description: "weather",
        input: z.object({ day: z.enum(["today", "tomorrow"]).default("today") }),
        effect: "read" as const,
        run: () => {
          plugin.calls++;
          return { value: "sunny", headline: "北京今天晴" };
        },
      }),
    ],
  };
  return plugin;
}

describe("you asked three times; the fourth time you don't have to", () => {
  it("finds a request made at about the same time on three days", async () => {
    const { moqi, clock } = harness({ plugins: [weatherStub()], start: "2026-11-17T08:20:00+08:00" });
    for (const t of ["08:20", "08:35", "08:10"]) {
      clock.set(`${new Date(clock.now()).toISOString().slice(0, 10)}T${t}:00+08:00`);
      await moqi.callTool("weather", { day: "today" }, { byUser: true });
      clock.advance(DAY);
    }
    const [routine] = findRoutines(moqi.state, clock.now(), (t) => t === "weather");
    expect(routine).toMatchObject({
      tool: "weather",
      args: { day: "today" },
      days: 3,
      schedule: { every: "day", at: "08:00" },
    });
  });

  it("needs three days, not two", async () => {
    const { moqi, clock } = harness({ plugins: [weatherStub()], start: "2026-11-17T08:20:00+08:00" });
    for (let d = 0; d < 2; d++) {
      await moqi.callTool("weather", { day: "today" }, { byUser: true });
      await moqi.callTool("weather", { day: "today" }, { byUser: true }); // twice the same day counts once
      clock.advance(DAY);
    }
    expect(findRoutines(moqi.state, clock.now(), () => true)).toEqual([]);
  });

  it("ignores requests at scattered times or on fewer days", async () => {
    const { moqi, clock } = harness({ plugins: [weatherStub()], start: "2026-11-17T08:00:00+08:00" });
    for (const t of ["08:00", "13:00", "21:00"]) {
      clock.set(`${new Date(clock.now()).toISOString().slice(0, 10)}T${t}:00+08:00`);
      await moqi.callTool("weather", { day: "today" }, { byUser: true });
      clock.advance(DAY);
    }
    expect(findRoutines(moqi.state, clock.now(), () => true)).toEqual([]);
  });

  it("offers to automate it once, and the next morning tells the user unasked", async () => {
    const stub = weatherStub();
    const { moqi, clock, delivered } = harness({ plugins: [stub], start: "2026-11-17T08:20:00+08:00" });
    for (let d = 0; d < 3; d++) {
      await moqi.callTool("weather", { day: "today" }, { byUser: true });
      clock.advance(DAY);
    }
    await moqi.tick();
    await moqi.tick();
    const offers = delivered.filter((d) => d.offer.kind === "routine.automate");
    expect(offers).toHaveLength(1);
    expect(offers[0]?.offer.body).toContain("每天 08:00");

    expect(await moqi.feedback(offers[0]?.offer.id ?? "", "accepted")).toMatch(/每天 08:00/);
    const [watch] = [...moqi.state.watches.values()];
    expect(watch).toMatchObject({ check: { tool: "weather", args: { day: "today" } }, notify: "always" });

    const before = stub.calls;
    clock.set("2026-11-21T08:00:30+08:00");
    const report = await moqi.tick();
    expect(report.watchesRun).toBe(1);
    expect(stub.calls).toBe(before + 1);
    expect(delivered.at(-1)).toMatchObject({ surface: "notify", offer: { kind: "watch.alert", body: "北京今天晴" } });
    await moqi.tick();
    expect(findRoutines(moqi.state, clock.now(), () => true)).toHaveLength(1); // still a routine...
    expect(delivered.filter((d) => d.offer.kind === "routine.automate")).toHaveLength(1); // ...but not offered again
  });
});
