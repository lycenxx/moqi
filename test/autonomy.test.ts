import { describe, expect, it } from "vitest";
import { levelOf, needsConfirmation, promotionDue } from "../src/core/autonomy.js";
import { actionPolicy } from "../src/core/plugin.js";
import { State } from "../src/core/state.js";
import type { EventBody, MoqiEvent, ToolPolicy } from "../src/core/types.js";
import { harness } from "./helpers.js";

const reminder = (n: number) => ({
  title: `提醒 ${n}`,
  schedule: { every: "day", at: "21:00" },
  remind: `第 ${n} 件事`,
});

describe("trust, earned one kind of action at a time", () => {
  it("asks before an action that changes things, and does nothing when refused", async () => {
    const { moqi, asked } = harness({ answer: false });
    expect(await moqi.callTool("watch_create", reminder(1), { byUser: true })).toMatch(/没有同意/);
    expect(asked).toEqual(["要我每天 21:00提醒你「第 1 件事」吗？"]);
    expect(moqi.state.watches.size).toBe(0);
  });

  it("offers to stop asking after three approvals in a row, and stops asking once accepted", async () => {
    const { moqi, asked, delivered } = harness();
    const promotions = () => delivered.filter((d) => d.offer.kind === "trust.promote");
    for (let i = 1; i <= 2; i++) await moqi.callTool("watch_create", reminder(i), { byUser: true });
    expect(promotions()).toHaveLength(0); // two approvals are not enough
    await moqi.callTool("watch_create", reminder(3), { byUser: true });
    expect(asked).toHaveLength(3);
    expect(promotions()).toHaveLength(1);
    const promote = delivered.find((d) => d.offer.kind === "trust.promote")?.offer;
    expect(promote?.action).toEqual({ tool: "set_level", args: { kind: "watch_create", level: "auto-undo" } });

    expect(await moqi.feedback(promote?.id ?? "", "accepted")).toMatch(/直接办/);
    await moqi.callTool("watch_create", reminder(4), { byUser: true });
    expect(asked).toHaveLength(3); // no fourth question
    expect(moqi.state.watches.size).toBe(4);
  });

  it("lists the write tools the user may let run without asking, and sets them both ways", async () => {
    const { moqi, asked } = harness();
    const names = moqi.ordinaryTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["watch_create", "watch_cancel", "todo_remove"]));
    expect(names).not.toContain("forget"); // capped at asking
    expect(names).not.toContain("todo_add"); // never asks
    expect(names).not.toContain("set_level"); // hidden
    expect(moqi.ordinaryTools().find((t) => t.name === "watch_create")).toEqual({
      name: "watch_create",
      source: "moqi",
      level: "ask",
    });

    expect(moqi.setToolLevel("watch_create", "auto")).toBe("以后 watch_create 直接办，办完告诉你");
    expect(moqi.ordinaryTools().find((t) => t.name === "watch_create")?.level).toBe("auto");
    await moqi.callTool("watch_create", reminder(1), { byUser: true });
    expect(asked).toEqual([]);

    expect(moqi.setToolLevel("watch_create", "ask")).toBe("watch_create 以后先问你");
    await moqi.callTool("watch_create", reminder(2), { byUser: true });
    expect(asked).toHaveLength(1);
    expect(() => moqi.setToolLevel("forget", "auto")).toThrow("forget 不是能在这里设置的工具");
  });

  it("goes back to asking after a single refusal", async () => {
    let yes = true;
    const { moqi, asked } = harness({ answer: () => yes });
    for (let i = 1; i <= 2; i++) await moqi.callTool("watch_create", reminder(i), { byUser: true });
    yes = false;
    await moqi.callTool("watch_create", reminder(3), { byUser: true });
    yes = true;
    await moqi.callTool("watch_create", reminder(4), { byUser: true });
    expect(moqi.state.trust.get("watch_create")).toEqual({ level: "suggest", streak: 1 });
    expect(asked).toHaveLength(4);
  });

  it("sends a broken call back to the model without asking the user", async () => {
    const { moqi, asked } = harness();
    expect(
      await moqi.callTool("watch_create", { title: "x", schedule: { every: "day", at: "22:00" } }, { byUser: true }),
    ).toMatch(/参数不对：要么填 tool/);
    expect(
      await moqi.callTool(
        "watch_create",
        { title: "x", schedule: { every: "day", at: "25:00" }, remind: "r" },
        { byUser: true },
      ),
    ).toMatch(/参数不对：Time must be HH:MM/);
    expect(
      await moqi.callTool(
        "watch_create",
        { title: "x", schedule: { every: "day", at: "08:00" }, tool: "forget" },
        { byUser: true },
      ),
    ).toMatch(/没有叫 forget 的只读工具/);
    expect(asked).toEqual([]);
    expect(moqi.state.trust.size).toBe(0); // nothing to approve, nothing learned
  });

  it("never lets a capped action pass its cap", () => {
    const { moqi } = harness();
    const forget = moqi.tool("forget");
    if (!forget) throw new Error("forget tool missing");
    moqi.emit({ type: "level.changed", kind: "forget", level: "auto" });
    expect(levelOf(moqi.state, "forget", actionPolicy(forget))).toBe("suggest");
  });

  it("refuses actions that need consent when there is nobody to ask", async () => {
    const { moqi } = harness({ confirm: undefined });
    expect(await moqi.callTool("watch_cancel", { id: "w_x" }, { byUser: false })).toMatch(/没有同意/);
  });

  it("runs read tools without asking", async () => {
    const { moqi, asked } = harness();
    expect(await moqi.callTool("watch_list", {}, { byUser: true })).toMatch(/没有托管/);
    expect(asked).toHaveLength(0);
  });
});

describe("dangerous tools", () => {
  const policy = { start: "suggest", cap: "auto-undo", danger: true } as const;
  let n = 0;
  const ev = (body: EventBody) => ({ ...body, id: `e_${++n}`, at: n }) as MoqiEvent;
  const withPolicy = (p?: ToolPolicy, approvals = 0) =>
    State.from([
      ...(p ? [ev({ type: "tool.policy", tool: "shell", policy: p })] : []),
      ...Array.from({ length: approvals }, () => ev({ type: "approval", kind: "shell", approved: true })),
    ]);

  it("asks unless the user unlocked it, and asks again after outside content", () => {
    const cases = [
      [undefined, false, true],
      [undefined, true, true],
      ["ask", false, true],
      ["auto", false, false],
      ["auto", true, true],
      ["normal", false, true], // back on the ladder, which starts by asking
    ] as const;
    for (const [p, tainted, ask] of cases)
      expect(needsConfirmation(withPolicy(p), "shell", policy, tainted), `${p} ${tainted}`).toBe(ask);
    expect(needsConfirmation(withPolicy(), "shell", { ...policy, danger: false }, true)).toBe(true);
  });

  it("is never offered to stop asking, until the user calls it normal", () => {
    expect(promotionDue(withPolicy(undefined, 3), "shell", policy)).toBeUndefined();
    expect(promotionDue(withPolicy("auto", 3), "shell", policy)).toBeUndefined();
    expect(promotionDue(withPolicy("normal", 3), "shell", policy)).toBe("auto-undo");
  });
});
