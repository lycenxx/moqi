# Fewer Confirmations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask the user less: remember sites for good, merge a finished coding task with one tap, let ordinary write tools be unlocked in Settings, and let unlocked browser tools honour site grants after reading a page.

**Architecture:** Everything that decides whether to ask lives in `Moqi.callTool` (`src/core/moqi.ts`); remembered sites are a new pair of events folded into `State.sites`. The confirm callback gains an optional third answer, `"always"`, which the console and the terminal offer only when moqi passes `choices`. The console exposes the new lists and switches.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), zod, vitest, plain browser JS in `src/node/console/assets`.

Spec: `docs/superpowers/specs/2026-11-23-fewer-confirmations-design.md`.

## Global Constraints

- `src/core` uses no Node APIs (`test/architecture.test.ts` enforces it).
- Runtime dependencies stay `taugraph` and `zod` only.
- Commands run as argument lists, never through a shell.
- Code comments in English; user-facing text in Simplified Chinese.
- `pnpm check` must pass (typecheck + biome + build + vitest with `TZ=Asia/Shanghai`).
- Single test file: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run <file>`. Fix formatting with `pnpm format`; format Markdown with `pnpm exec biome check --write <md>`.
- Unchanged rules: after outside content, dangerous actions still ask (in-site browsing of D is the only exception); shortcuts, trash, code delegation and MCP writes keep their rules; `forget` always asks.

## File Structure

- `src/core/types.ts`: `Answer`, `Choices`; events `site.remembered`, `site.forgotten`.
- `src/core/state.ts`: `State.sites`.
- `src/core/moqi.ts`: confirm signature; site logic (A, D); `confirmed` merges (B); `ordinaryTools`/`setToolLevel` (C); `rememberedSites`/`forgetSite`.
- `src/node/home.ts`: `terminalAnswer`.
- `src/node/cli.ts`: terminal `[y/N/a]`; daemon passes `choices`.
- `src/node/console/server.ts`: confirm queue with `always`; `/api/tools` (`ordinary`, `sites`); `/api/tool-level`; `/api/site/forget`; `code[].into`.
- `src/node/console/assets/{index.html,app.js}`: third confirm button, remembered sites, ordinary tools, "合并到 <分支>".
- Tests: `test/helpers.ts`, `test/sites.test.ts`, `test/code.test.ts`, `test/autonomy.test.ts`, `test/console.test.ts`, `test/node.test.ts`.
- Docs: `README.md`, `README.zh-CN.md`, `docs/design.md`, `CHANGELOG.md`.

---

### Task 1: Remembered sites, and site grants for unlocked browser tools (A, D in the core)

**Files:**

- Modify: `src/core/types.ts` (EventBody union near line 186; new exported types)
- Modify: `src/core/state.ts` (fields near line 97; `apply` switch near line 251)
- Modify: `src/core/moqi.ts` (imports; `MoqiOptions.confirm` line 52; `callTool` lines 316–360; `ask` lines 380–383; new methods after `setToolPolicy`)
- Modify: `test/helpers.ts:50-72`
- Test: `test/sites.test.ts`

**Interfaces:**

- Produces: `type Answer = boolean | "always"`, `interface Choices { readonly always: string }` (exported from `src/core/types.ts`, so from `src/core/index.ts` too); `MoqiOptions.confirm?: (question: string, details?: string, choices?: Choices) => Promise<Answer>`; `Moqi.rememberedSites(): string[]`; `Moqi.forgetSite(host: string): boolean`; `State.sites: Set<string>`; events `{ type: "site.remembered"; host: string }`, `{ type: "site.forgotten"; host: string }`.

- [ ] **Step 1: Let the harness answer "always"**

In `test/helpers.ts`, change the `harness` options type and the confirm callback:

```ts
export function harness(
  options: Partial<MoqiOptions> & { answer?: Answer | ((q: string) => Answer); start?: string } = {},
): Harness {
```

and add `Answer` to the existing type import: `import type { Answer, Clock, Offer, Surface } from "../src/core/types.js";`. The confirm callback body stays the same; its return type now is `Answer`.

- [ ] **Step 2: Write the failing tests**

In `test/sites.test.ts`, add `import { State } from "../src/core/state.js";` and these tests inside `describe("site grants", …)`:

```ts
it("remembers a site the user allowed for good, until they remove it", async () => {
  const b = browser();
  const { moqi, asked } = harness({
    plugins: [b.plugin],
    answer: (q) => (q.startsWith("要我打开") ? "always" : true),
    model: scriptedModel((r: ChatRequest) => {
      const turn = r.messages.filter((m) => m.role === "user").length;
      const done = r.messages.filter((m) => m.role === "tool").length;
      const script = [
        [call("navigate", { url: "https://www.jd.com/" }, "a1")],
        [
          call("navigate", { url: "https://item.jd.com/1.html" }, "b1"),
          call("click", { target: "e1" }, "b2"),
          call("type", { text: "耳机" }, "b3"),
        ],
        [call("navigate", { url: "https://jd.com/" }, "c1")],
      ];
      return script[turn - 1]?.[done] ?? "好";
    }),
  });
  await moqi.chat("打开京东");
  expect(asked).toEqual(["要我打开 jd.com 吗？"]);
  expect(moqi.rememberedSites()).toEqual(["jd.com"]);
  expect([...State.from(moqi.store.all()).sites]).toEqual(["jd.com"]);

  await moqi.chat("看看这款耳机，搜一下");
  expect(asked).toEqual(["要我打开 jd.com 吗？", "要我用「browser」的 type 吗？"]); // typing still asks

  expect(moqi.forgetSite("jd.com")).toBe(true);
  expect(moqi.forgetSite("jd.com")).toBe(false);
  await moqi.chat("再打开京东");
  expect(asked.at(-1)).toBe("要我打开 jd.com 吗？");
});

it("lets an unlocked browser keep going on sites it was given after reading a page, and asks at a new one", async () => {
  const b = browser();
  const { moqi, asked } = harness({
    plugins: [b.plugin],
    model: steps(
      call("navigate", { url: "https://jd.com/" }, "c1"),
      call("snapshot", {}, "c2"),
      call("click", { target: "e1" }, "c3"),
      call("navigate", { url: "https://evil.test/" }, "c4"),
      call("click", { target: "e2" }, "c5"),
    ),
  });
  moqi.setToolPolicy("navigate", "auto");
  moqi.setToolPolicy("click", "auto");
  await moqi.chat("打开京东看看");
  expect(asked).toEqual(["要我打开 evil.test 吗？"]);
  expect(b.done.map((d) => d.split(" ")[0])).toEqual(["navigate", "snapshot", "click", "navigate", "click"]);
});
```

In the existing test "keeps the usual rules for addresses it cannot read, offers, and tools the user unlocked", replace the last expectation:

```ts
expect(turn.asked).toEqual(["要我打开 jd.com 吗？"]); // read outside content: an unlocked tool asks for the site
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/sites.test.ts`
Expected: FAIL: `moqi.rememberedSites is not a function`; the unlocked-browser test asks `要我用「browser」的 click 吗？`.

- [ ] **Step 4: Add the types and events**

In `src/core/types.ts`, next to `ToolPolicy` (line 104):

```ts
/** What the user answered: yes, no, or yes and do not ask about this again ("以后都允许"). */
export type Answer = boolean | "always";

/** Extra answers a question offers. `always`: the label of the "do not ask again" button. */
export interface Choices {
  readonly always: string;
}
```

In the `EventBody` union, after the `tool.policy` line:

```ts
  | { type: "site.remembered"; host: string }
  | { type: "site.forgotten"; host: string }
```

- [ ] **Step 5: Fold them into the state**

In `src/core/state.ts`, after `readonly toolPolicies = new Map<string, ToolPolicy>();`:

```ts
  /** Sites the user allowed for good ("以后都允许"); opening and browsing there is not asked. */
  readonly sites = new Set<string>();
```

In the `apply` switch, after the `tool.policy` case:

```ts
      case "site.remembered":
        this.sites.add(e.host);
        break;
      case "site.forgotten":
        this.sites.delete(e.host);
        break;
```

- [ ] **Step 6: Change the confirm option and `ask`**

In `src/core/moqi.ts`, import `type Answer` and `type Choices` from `./types.js` (add to the existing type import list), and `hostOf` from `./sites.js` (the import becomes `import { hostOf, pageHost, type SiteGrant, siteDecision } from "./sites.js";`).

Replace the `confirm` option (line 52):

```ts
  /**
   * Asks the user before an action that has not earned trust yet. `details`: exactly what a dangerous one does.
   * `choices`: extra answers this question offers, e.g. "以后都允许" for a site. Without it, such actions are refused.
   */
  readonly confirm?: (question: string, details?: string, choices?: Choices) => Promise<Answer>;
```

Replace `ask` (lines 380–383):

```ts
  private async ask(question: string, details?: string, choices?: Choices): Promise<Answer> {
    if (!this.options.confirm) return false;
    if (choices) return this.options.confirm(question, details, choices);
    return details === undefined ? this.options.confirm(question) : this.options.confirm(question, details);
  }
```

- [ ] **Step 7: Use remembered sites, offer "以后都允许", and honour sites for unlocked tools**

In `callTool`, replace everything from `const guard = guarded(this.state, name, policy);` up to and including the line `how.sites?.granted.add(site.host);` with:

```ts
    const guard = guarded(this.state, name, policy);
    const chosen = this.state.toolPolicies.get(name) ?? "ask";
    // Within a turn, a site the user agreed to (in this turn or for good) may be browsed without asking again:
    // while the tool is asked about, and, once the user unlocked it, after the turn read outside content.
    const bySite = guard && (chosen === "ask" || (chosen === "auto" && how.tainted === true));
    const site =
      bySite && tool.site && how.sites
        ? siteDecision(tool.site, args, {
            granted: new Set([...how.sites.granted, ...this.state.sites]),
            current: how.sites.current,
          })
        : undefined;
    if (site && "host" in site) {
      const answer = await this.ask(
        `要我打开 ${site.host} 吗？`,
        `这一轮里在 ${site.host} 上打开页面、点击、翻页不再问；输入文字、上传、执行脚本仍会问。\n\n${site.url}`,
        { always: "以后都允许" },
      );
      this.emit({ type: "approval", kind: name, approved: answer !== false });
      if (answer === false) return "用户没有同意，这一步没做";
      how.sites?.granted.add(site.host);
      if (answer === "always" && !this.state.sites.has(site.host))
        this.emit({ type: "site.remembered", host: site.host });
```

In the `else if (!site) { … }` branch that follows, change the asking line so a yes is a boolean:

```ts
const approved = preApproved || (await this.ask(question, details)) !== false;
```

and at the end of that branch (just before its closing `}`), add:

```ts
// An unlocked tool opening a site the user's own words led to, before any outside content: that site
// counts as granted for the rest of the turn, so reading its page does not make every click ask.
if (guard && tool.site === "goto" && how.sites && chosen === "auto" && how.tainted !== true) {
  const host = typeof args.url === "string" ? hostOf(args.url) : undefined;
  if (host) how.sites.granted.add(host);
}
```

- [ ] **Step 8: Add the two methods**

After `setToolPolicy` in `src/core/moqi.ts`:

```ts
  /** Sites the user allowed for good, in order. */
  rememberedSites(): string[] {
    return [...this.state.sites].sort();
  }

  /** The user's own decision to stop allowing a site for good. False when it was not remembered. */
  forgetSite(host: string): boolean {
    if (!this.state.sites.has(host)) return false;
    this.emit({ type: "site.forgotten", host });
    return true;
  }
```

- [ ] **Step 9: Run the tests**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/sites.test.ts test/safety.test.ts`
Expected: PASS.

- [ ] **Step 10: Typecheck, lint, full tests, commit**

Run: `pnpm format && pnpm check`
Expected: all pass.

```bash
git add src/core test
git commit -m "feat(sites): remember a site for good, and let unlocked browser tools keep to granted sites"
```

---

### Task 2: One tap merges a finished coding task (B in the core)

**Files:**

- Modify: `src/core/moqi.ts` (`callTool` signature and the `offered`/`preApproved` lines; `feedback` lines 434–435; new private method)
- Test: `test/code.test.ts`

**Interfaces:**

- Consumes: `Offer.about?: string` (exists), `State.codeTasks` (exists).
- Produces: `callTool(name, args, how: { byUser: boolean; preApproved?: boolean; confirmed?: boolean; tainted?: boolean; sites?: SiteGrant })`.

- [ ] **Step 1: Write the failing tests**

In `test/code.test.ts`, in the test "tells the user once when it is done, and merges on their word with what it changed", replace these lines:

```ts
expect(await moqi.feedback(offers[0]?.offer.id ?? "", "accepted")).toBe(`已合并到 main：moqi/20261120-0820-${id}`);
expect(asked.at(-1)).toBe(`要我把 moqi/20261120-0820-${id} 合并进 moqi 的 main 吗？`);
expect(details.at(-1)).toContain("这是 moqi 提议的动作");
expect(details.at(-1)).toContain("改动：\n 2 files changed");
```

with:

```ts
const before = asked.length;
expect(await moqi.feedback(offers[0]?.offer.id ?? "", "accepted")).toBe(`已合并到 main：moqi/20261120-0820-${id}`);
expect(asked).toHaveLength(before); // the tap on moqi's own card was the confirmation
```

Remove `details` from that test's destructuring if it is no longer used. Then add a test after it:

```ts
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/code.test.ts`
Expected: FAIL, the first test asks the merge question again.

- [ ] **Step 3: Implement `confirmed`**

In `src/core/moqi.ts`, change the `how` type of `callTool`:

```ts
    how: { byUser: boolean; preApproved?: boolean; confirmed?: boolean; tainted?: boolean; sites?: SiteGrant },
```

Replace the two lines that compute `offered` and `preApproved` (and extend the comment above them):

```ts
// A dangerous action is confirmed with exactly what it does, even when an offer was accepted:
// the offer's words are the model's and may not match its action. `confirmed`: the user tapped this
// very action on a card moqi itself made, so there is nothing left to show them.
const confirmed = how.preApproved === true && how.confirmed === true;
const offered = how.preApproved === true && guard && !confirmed;
const preApproved = how.preApproved === true && (!guard || confirmed);
```

In `feedback`, replace

```ts
    if (verdict === "accepted" && offer.action)
      return this.callTool(offer.action.tool, offer.action.args, { byUser: true, preApproved: true });
```

with

```ts
    if (verdict === "accepted" && offer.action)
      return this.callTool(offer.action.tool, offer.action.args, {
        byUser: true,
        preApproved: true,
        ...(this.ownMerge(offer) && { confirmed: true }),
      });
```

and add, after `feedback`:

```ts
  /** moqi's own "done" card for a coding task, whose merge the user tapped: nothing about it came from a model. */
  private ownMerge(offer: Offer): boolean {
    const id = offer.action?.args.id;
    const status = typeof id === "string" ? this.state.codeTasks.get(id)?.status : undefined;
    return (
      offer.kind === "code.done" &&
      offer.action?.tool === "code_merge" &&
      offer.about === id &&
      (status === "done" || status === "failed")
    );
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/code.test.ts test/safety.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm check`

```bash
git add src/core test
git commit -m "feat(code): one tap on moqi's own card merges, with no second question"
```

---

### Task 3: Ordinary write tools can be unlocked directly (C in the core)

**Files:**

- Modify: `src/core/moqi.ts` (import `levelOf`, `rank` from `./autonomy.js`; new methods after `forgetSite`)
- Test: `test/autonomy.test.ts`

**Interfaces:**

- Produces: `Moqi.ordinaryTools(): { name: string; source: string; level: "ask" | "auto" }[]`; `Moqi.setToolLevel(name: string, level: "ask" | "auto"): string` (throws `Error("<name> 不是能在这里设置的工具")` for other tools).

- [ ] **Step 1: Write the failing test**

In `test/autonomy.test.ts`, inside `describe("trust, earned one kind of action at a time", …)`:

```ts
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/autonomy.test.ts`
Expected: FAIL with `moqi.ordinaryTools is not a function`.

- [ ] **Step 3: Implement**

In `src/core/moqi.ts`, change the autonomy import to `import { guarded, levelOf, needsConfirmation, promotionDue, rank } from "./autonomy.js";`, then add after `forgetSite`:

```ts
  /** Write tools the user may let run without asking: visible, not dangerous, asked first, allowed higher. */
  ordinaryTools(): { name: string; source: string; level: "ask" | "auto" }[] {
    return [...this.tools.values()]
      .filter((t) => this.isOrdinary(t))
      .map((t) => ({
        name: t.name,
        source: this.sourceOf(t.name),
        level: rank(levelOf(this.state, t.name, actionPolicy(t))) <= rank("suggest") ? "ask" : "auto",
      }));
  }

  /** The user's own switch for one ordinary tool, the same level the trust ladder raises. */
  setToolLevel(name: string, level: "ask" | "auto"): string {
    const tool = this.tools.get(name);
    if (!tool || !this.isOrdinary(tool)) throw new Error(`${name} 不是能在这里设置的工具`);
    this.emit({ type: "level.changed", kind: name, level: level === "ask" ? "suggest" : actionPolicy(tool).cap });
    return level === "ask" ? `${name} 以后先问你` : `以后 ${name} 直接办，办完告诉你`;
  }

  private isOrdinary(tool: Tool): boolean {
    const p = actionPolicy(tool);
    return (
      tool.effect === "write" &&
      tool.hidden !== true &&
      tool.danger !== true &&
      rank(p.start) <= rank("suggest") &&
      rank(p.cap) > rank("suggest")
    );
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/autonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `pnpm format && pnpm check`

```bash
git add src/core test
git commit -m "feat(trust): ordinary write tools the user can let run without asking"
```

---

### Task 4: Console and terminal: "以后都允许", remembered sites, ordinary tools, "合并到 main"

**Files:**

- Modify: `src/node/home.ts` (new export `terminalAnswer`)
- Modify: `src/node/cli.ts:143-146` (interactive confirm) and `:219` (daemon confirm)
- Modify: `src/node/console/server.ts` (`Asker` and `confirmQueue` lines 39–82; `/api/confirm` line 488; `/api/tools` line 535; new routes after `/api/tool-policy`; `code` map in `/api/state` lines 274–285)
- Modify: `src/node/console/assets/index.html` (ask box lines 36–42; browser hint line 244; tools block lines 293–295; hint line 236)
- Modify: `src/node/console/assets/app.js` (`renderAsk`, `answer` lines 238–264; `loadDangerTools` lines 1131–1177; code card button line 402)
- Test: `test/console.test.ts`, `test/node.test.ts`

**Interfaces:**

- Consumes: `Answer`, `Choices` (Task 1); `Moqi.rememberedSites`, `Moqi.forgetSite` (Task 1); `Moqi.ordinaryTools`, `Moqi.setToolLevel` (Task 3).
- Produces: `terminalAnswer(line: string, always: boolean): Answer` in `src/node/home.ts`; `Asker.ask(question, details?, choices?): Promise<Answer>`, `Asker.pending(): { id; text; details?; always? } | undefined`, `Asker.answer(id, yes, always?): boolean`; HTTP: `POST /api/confirm { id, yes, always? }`, `GET /api/tools → { tools, ordinary: { name, source, label, level }[], sites: string[] }`, `POST /api/tool-level { tool, level }`, `POST /api/site/forget { host }`, `GET /api/state → code[].into`.

- [ ] **Step 1: Write the failing tests**

In `test/node.test.ts`, import `terminalAnswer` with `openHome` (`import { openHome, terminalAnswer } from "../src/node/home.js";`) and add:

```ts
describe("terminal answers", () => {
  it("reads yes, no, and 'always' only where the question offers it", () => {
    expect(terminalAnswer("y", false)).toBe(true);
    expect(terminalAnswer(" 好 ", false)).toBe(true);
    expect(terminalAnswer("", false)).toBe(false);
    expect(terminalAnswer("a", false)).toBe(false);
    expect(terminalAnswer("a", true)).toBe("always");
    expect(terminalAnswer("以后都允许", true)).toBe("always");
    expect(terminalAnswer("n", true)).toBe(false);
  });
});
```

In `test/console.test.ts`, change the helper's confirm to pass choices through: `confirm: (q, d, c) => asker.ask(q, d, c),`. Add `into: "main"` to the `expect(task).toMatchObject({ status: "done", files: 1, agent: "Kiro", project: basename(project) })` in the coding-agents test. Then add inside `describe("console", …)`:

```ts
it("offers to allow a site for good, lists remembered sites, and removes them", async () => {
  const site: Plugin = {
    name: "web",
    tools: [
      defineTool({
        name: "navigate",
        description: "Open a page",
        input: z.object({ url: z.string() }),
        effect: "write",
        danger: true,
        site: "goto",
        source: "web",
        run: ({ url }) => `opened ${url}`,
      }),
    ],
  };
  const { api } = await start(
    { model: MODEL, briefingAt: null },
    (body) =>
      body.messages.at(-1)?.role === "tool"
        ? { content: "开好了" }
        : {
            content: "",
            tool_calls: [{ id: "c1", function: { name: "navigate", arguments: '{"url":"https://jd.com/"}' } }],
          },
    [site],
  );
  const turn = api("POST", "/api/chat", { text: "打开京东" });
  let question: { id: string; text: string; always?: string } | null = null;
  for (let i = 0; i < 50 && !question; i++) {
    await new Promise((r) => setTimeout(r, 20));
    question = (await api("GET", "/api/state")).data.question;
  }
  expect(question).toMatchObject({ text: "要我打开 jd.com 吗？", always: "以后都允许" });
  await api("POST", "/api/confirm", { id: question?.id, yes: true, always: true });
  expect((await turn).data.reply).toBe("开好了");
  expect((await api("GET", "/api/tools")).data.sites).toEqual(["jd.com"]);
  expect((await api("POST", "/api/site/forget", { host: "jd.com" })).status).toBe(200);
  expect((await api("POST", "/api/site/forget", { host: "jd.com" })).status).toBe(404);
  expect((await api("GET", "/api/tools")).data.sites).toEqual([]);
});

it("lists ordinary write tools and lets the user unlock them", async () => {
  const { home, api } = await start({ briefingAt: null });
  const { ordinary } = (await api("GET", "/api/tools")).data;
  expect(ordinary).toEqual(
    expect.arrayContaining([{ name: "watch_create", source: "moqi", label: "新建盯梢", level: "ask" }]),
  );
  expect((await api("POST", "/api/tool-level", { tool: "watch_create", level: "auto" })).status).toBe(200);
  expect(home.moqi.ordinaryTools().find((t) => t.name === "watch_create")?.level).toBe("auto");
  expect((await api("POST", "/api/tool-level", { tool: "forget", level: "auto" })).status).toBe(400);
  expect((await api("POST", "/api/tool-level", { tool: "watch_create", level: "always" })).status).toBe(400);
});
```

(`defineTool`, `Plugin` and `z` are already imported at the top of `test/console.test.ts`.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/console.test.ts test/node.test.ts`
Expected: FAIL (`terminalAnswer` is not exported; `question.always` undefined; `/api/tool-level` 404).

- [ ] **Step 3: `terminalAnswer` and the terminal**

In `src/node/home.ts` (extend the existing import to `import type { Answer, EventStore, Offer, Surface } from "../core/types.js";`):

```ts
/** A typed answer to a question in the terminal. "a" means "以后都允许", only where the question offers it. */
export function terminalAnswer(line: string, always: boolean): Answer {
  const text = line.trim();
  if (always && /^(a|always|以后都允许)$/i.test(text)) return "always";
  return /^(y|yes|好|是|可以)/i.test(text);
}
```

In `src/node/cli.ts`, import `terminalAnswer` from `./home.js` and replace the interactive confirm:

```ts
    confirm: async (question, details, choices) => {
      if (details) console.log(details);
      const line = (await input.next(`${question} ${choices ? "[y/N/a]" : "[y/N]"} `)) ?? "";
      return terminalAnswer(line, choices !== undefined);
    },
```

and the daemon's `confirm: (q, d) => asker.ask(q, d),` with `confirm: (q, d, c) => asker.ask(q, d, c),`.

- [ ] **Step 4: The confirm queue**

In `src/node/console/server.ts`, import `type Answer, type Choices` with the other core imports, and replace the `Asker` interface and `confirmQueue`:

```ts
export interface Asker {
  ask(question: string, details?: string, choices?: Choices): Promise<Answer>;
  pending():
    | { readonly id: string; readonly text: string; readonly details?: string; readonly always?: string }
    | undefined;
  /** `always`: the user pressed the question's "do not ask again" button; ignored when it offers none. */
  answer(id: string, yes: boolean, always?: boolean): boolean;
}

export function confirmQueue(timeoutMs = ANSWER_TIMEOUT_MS): Asker {
  let current:
    | {
        id: string;
        text: string;
        details?: string;
        always?: string;
        resolve: (answer: Answer) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  let n = 0;
  const settle = (answer: Answer) => {
    if (!current) return;
    clearTimeout(current.timer);
    const { resolve } = current;
    current = undefined;
    resolve(answer);
  };
  return {
    ask(text, details, choices) {
      settle(false); // only one question at a time; an unanswered one counts as "no"
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(false), timeoutMs);
        current = {
          id: `q${++n}`,
          text,
          ...(details !== undefined && { details }),
          ...(choices && { always: choices.always }),
          resolve,
          timer,
        };
      });
    },
    pending: () =>
      current
        ? {
            id: current.id,
            text: current.text,
            ...(current.details !== undefined && { details: current.details }),
            ...(current.always !== undefined && { always: current.always }),
          }
        : undefined,
    answer(id, yes, always = false) {
      if (current?.id !== id) return false;
      settle(yes && always && current.always !== undefined ? "always" : yes);
      return true;
    },
  };
}
```

Change `/api/confirm`:

```ts
    "POST /api/confirm": (body) => {
      if (!asker.answer(str(body.id, "id"), body.yes === true, body.always === true))
        throw new HttpError(409, "这个问题已经过期了");
      return { ok: true };
    },
```

- [ ] **Step 5: Tools, sites and the merge branch**

Near `VERDICT_WORDS`, add:

```ts
/** How the settings page names moqi's own ordinary write tools; others show their tool name. */
const ORDINARY_LABELS: Record<string, string> = {
  files_mkdir: "新建文件夹",
  files_write_new: "新建文件",
  files_move: "移动文件",
  files_rename: "改名",
  mac_clipboard_write: "写剪贴板",
  watch_create: "新建盯梢",
  watch_cancel: "取消盯梢",
  todo_remove: "删除待办",
};
```

Replace `"GET /api/tools"` and add two routes after `"POST /api/tool-policy"`:

```ts
    "GET /api/tools": () => ({
      tools: home.moqi.dangerousTools(),
      ordinary: home.moqi.ordinaryTools().map((t) => ({ ...t, label: ORDINARY_LABELS[t.name] ?? t.name })),
      sites: home.moqi.rememberedSites(),
    }),
```

```ts
    "POST /api/tool-level": async (body) => {
      const name = str(body.tool, "tool");
      const level = str(body.level, "level");
      if (level !== "ask" && level !== "auto") throw new HttpError(400, "level 只能是 ask 或 auto");
      if (!home.moqi.ordinaryTools().some((t) => t.name === name))
        throw new HttpError(400, `${name} 不是能在这里设置的工具`);
      return { message: await home.serial(async () => home.moqi.setToolLevel(name, level)) };
    },

    "POST /api/site/forget": async (body) => {
      const host = str(body.host, "host");
      if (!(await home.serial(async () => home.moqi.forgetSite(host)))) throw new HttpError(404, `没有记住 ${host}`);
      return { message: `以后打开 ${host} 会先问你` };
    },
```

In the `code:` map of `GET /api/state`, add after `files: t.files?.length ?? 0,`:

```ts
            ...((t.status === "done" || t.status === "failed") && { into: home.code.currentBranch(t.task.project) }),
```

- [ ] **Step 6: The page**

In `src/node/console/assets/index.html`, between `ask-yes` and `ask-no`:

```html
            <button type="button" class="btn" id="ask-always" hidden></button>
```

Replace the browser hint (line 244) with:

```html
            <p class="hint">用一个单独的 Chrome 配置，看不到你平时浏览器里的登录和记录。每个网站在一轮对话里问你一次，也可以选「以后都允许」；输入文字、上传、执行脚本每次都问。</p>
            <div class="list" id="sites" aria-label="记住的网站"></div>
```

Change the 能力包 hint (line 236) to `让 moqi 能在电脑和网页上动手。会改动东西的动作照样先问你，可以在下面「会改动东西的工具」和「普通动作」里逐个放开。`

After `<div class="list" id="danger-tools"></div>`:

```html
            <h3 class="minor">普通动作</h3>
            <p class="hint">新建、移动、改名这类不覆盖、不删除东西的动作。连着同意 3 次后 moqi 也会问你要不要直接办。</p>
            <div class="list" id="ordinary-tools"></div>
```

In `src/node/console/assets/app.js`, in `renderAsk` after `$("ask").dataset.id = q.id;`:

```js
$("ask-always").hidden = !q.always;
$("ask-always").textContent = q.always || "";
```

Replace `answer` and the listeners:

```js
async function answer(yes, always = false) {
  const id = $("ask").dataset.id;
  $("ask").hidden = true;
  try {
    await api("POST", "/api/confirm", { id, yes, always });
  } catch (error) {
    toast(error.message);
  }
  refresh();
}
$("ask-yes").addEventListener("click", () => answer(true));
$("ask-always").addEventListener("click", () => answer(true, true));
$("ask-no").addEventListener("click", () => answer(false));
```

In `loadDangerTools`, change `const { tools } = await api("GET", "/api/tools");` to `const { tools, ordinary, sites } = await api("GET", "/api/tools");`, and before the `catch`, after the `for (const t of tools)` loop, add:

```js
renderOrdinary(ordinary);
renderSites(sites);
```

and add these functions after `loadDangerTools`:

```js
const LEVEL_LABEL = { ask: "先问我", auto: "直接办，办完告诉你" };

function renderOrdinary(tools) {
  const list = $("ordinary-tools");
  list.replaceChildren();
  for (const t of tools) {
    const select = h(
      "select",
      { class: "policy", "aria-label": `${t.label} 怎么处理` },
      Object.entries(LEVEL_LABEL).map(([value, text]) => h("option", { value, text })),
    );
    select.value = t.level;
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        toast((await api("POST", "/api/tool-level", { tool: t.name, level: select.value })).message);
      } catch (error) {
        toast(error.message);
        select.value = t.level;
      }
      select.disabled = false;
    });
    list.append(
      h(
        "div",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("p", { class: "item-text", text: t.label }),
          h("p", { class: "item-meta", text: `${t.name} · 来自 ${t.source}` }),
        ),
        select,
      ),
    );
  }
}

function renderSites(sites) {
  const list = $("sites");
  list.replaceChildren();
  if (sites.length === 0) return;
  list.append(h("p", { class: "item-meta", text: "记住的网站：打开、点击、翻页不再问" }));
  for (const host of sites) {
    const remove = h("button", { type: "button", class: "btn", text: "移除", "aria-label": `移除 ${host}` });
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        toast((await api("POST", "/api/site/forget", { host })).message);
      } catch (error) {
        toast(error.message);
      }
      loadDangerTools();
    });
    list.append(
      h("div", { class: "item" }, h("div", { class: "item-main" }, h("p", { class: "item-text", text: host })), remove),
    );
  }
}
```

In the `code.done` card, change the merge button text:

```js
          ? h("button", {
              type: "button",
              class: "btn primary",
              text: task.into ? `合并到 ${task.into}` : "合并",
              onclick: respond("accepted"),
            })
```

- [ ] **Step 7: Run the tests**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/console.test.ts test/node.test.ts`
Expected: PASS.

- [ ] **Step 8: Look at the page**

Start a scratch moqi on a temporary home and take headless screenshots of the settings page (tools block and browser block) and of a confirm box with three buttons, at 1280 and 375 widths, light and dark. Check that the three buttons wrap cleanly at 375 px and the lists use the existing `.item` layout. Fix CSS in `src/node/console/assets/app.css` only if something breaks.

- [ ] **Step 9: Commit**

Run: `pnpm format && pnpm check`

```bash
git add src/node test
git commit -m "feat(console): allow a site for good, unlock ordinary tools, merge into the named branch"
```

---

### Task 5: Docs

**Files:**

- Modify: `README.md`, `README.zh-CN.md` (abilities table row for the browser; design trade-offs where confirmations are described)
- Modify: `docs/design.md` (safety section)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

- [ ] **Step 1: Write the docs**

- README (both languages), browser row "怎么保证安全": add "可以选「以后都允许」记住一个网站，在设置里移除". Where the README says actions are asked first, add one sentence: ordinary actions (new folder, new file, move, rename, clipboard, watches, removing todos) can be set to run without asking in Settings; a finished coding task merges with one tap on its card.
- `docs/design.md`, safety section: remembered sites (`site.remembered`/`site.forgotten`, only from the user's answer), unlocked browser tools keep to granted sites after outside content, `confirmed` for moqi's own `code.done` card, ordinary tools share the trust level.
- `CHANGELOG.md` under `## [Unreleased]`:

```markdown
- Fewer questions: a site can be allowed for good ("以后都允许"), after which opening, clicking and paging there are not asked (typing, forms, uploads and scripts still are); remembered sites are listed in Settings and can be removed. Ordinary actions (new folder, new file, move, rename, clipboard, watches, removing todos) can be set to run without asking in Settings. Merging a finished coding task takes one tap on its card, which names the branch. Browser tools set to "放开" keep to the sites already granted after reading a page, instead of asking at every click.
```

- [ ] **Step 2: Format and check**

Run: `pnpm exec biome check --write README.md README.zh-CN.md docs/design.md CHANGELOG.md && pnpm check`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh-CN.md docs/design.md CHANGELOG.md
git commit -m "docs: fewer confirmations"
```
