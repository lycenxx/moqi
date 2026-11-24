# Console: Multimodal Chat, New Style, Feed History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The user can send moqi images and get formatted answers with the images tools brought back; the console takes the "留白 · 纸感" look; handled feed cards stay in a "看过的" list with their links.

**Architecture:** Images are files under `<moqi home>/media` (`src/node/media.ts`); events carry ids only. The core gets images through an injected loader (`MoqiOptions.media`) and sends them as OpenAI content parts; tools return image ids in `ToolResult.images`, collected per turn onto moqi's answer. The console uploads raw bytes to `/api/media`, shows images through `blob:` URLs, renders answers with a small Markdown parser (`assets/markdown.js`, data only, no `innerHTML`), and lists handled offers from a new `history` field of `/api/state`.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), zod, vitest, plain browser JS/CSS in `src/node/console/assets`.

Spec: `docs/superpowers/specs/2026-11-23-console-multimodal-design.md`.

## Global Constraints

- `src/core` uses no Node APIs (`test/architecture.test.ts`); runtime dependencies stay `taugraph` and `zod`.
- The console loads nothing from outside; CSP stays strict, only `img-src` gains `blob:`. No `innerHTML`; links only `http:`/`https:`.
- Code comments in English; user-facing text in Simplified Chinese.
- Limits: 4 images per message; browser shrinks to long edge 2048 px or 2 MB (JPEG 0.85, GIF kept, refused over 2 MB); server takes up to 3 MB per image; types PNG, JPEG, GIF, WebP by file header; ids `^m_[0-9a-f]{16}$`; history carries images of the last 3 user messages with images (the current one included); a reply keeps at most 8 tool images; an MCP result keeps at most 4.
- Colours (light / dark): bg `#F8F8F6`/`#121414`, surface `#FFFFFF`/`#1A1D1E`, text `#1F2328`/`#E7E9EA`, muted `#5F6670`/`#9AA1A6`, faint `#6B7075`/`#8A9196`, border `#E6E6E1`/`#2A2F31`, border-strong `#DCDCD6`/`#3A4043`, bubble `#ECECE8`/`#24292B`, accent `#2F6F67`/`#6FB8AD`, accent-hover `#275C55`/`#8ACBC1`, accent-soft `#E8F1EF`/`#1C2B29`, on-accent `#FFFFFF`/`#0E1A18` (all text pairs checked ≥ 4.5:1).
- `pnpm check` must pass. Single file: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run <file>`; `pnpm format`; Markdown: `pnpm exec biome check --write <md>`. Biome rejects assignments inside conditions, so write `const m = RE.exec(x); if (m) …`.

## File Structure

- Create `src/node/media.ts` (store), `src/node/console/assets/markdown.js` (parser), `test/media.test.ts`, `test/markdown.test.ts`, `test/fixtures/picture-mcp.mjs`.
- Core: `src/core/model.ts` (`ImagePart`, content parts, `canSeeImages`), `src/core/plugin.ts` (`ToolResult.images`), `src/core/types.ts` (message `images`, `code.finished.head`, `code.merged.into`), `src/core/agent.ts` (history with images, tool images, Markdown hint), `src/core/moqi.ts` (`media` option, `loadImage`, `chat` images, `callTool` image collector), `src/core/state.ts` (`decidedAt`, `head`, `into`), `src/core/code.ts` (`CodeResult.head`, `diff(task, head?)`, merge `into`).
- Node: `src/node/home.ts` (media store wiring), `src/node/mcp-client.ts` (image content), `src/node/mac.ts` (screenshot image), `src/node/code.ts` (commit head, diff range), `src/node/config.ts` (`model.vision`), `src/node/console/server.ts` (media routes, chat images, vision, history, CSP, `/markdown.js`).
- Page: `src/node/console/assets/{index.html,app.js,app.css}`.
- Docs: `README.md`, `README.zh-CN.md`, `docs/design.md`, `CHANGELOG.md`, `docs/console.png`.

---

### Task 1: Media store

**Files:**

- Create: `src/node/media.ts`
- Test: `test/media.test.ts`

**Interfaces:**

- Produces: `MEDIA_MAX = 3 * 1024 * 1024`; `MEDIA_ID = /^m_[0-9a-f]{16}$/`; `sniff(bytes: Uint8Array): string | undefined`; `interface MediaStore { save(bytes: Uint8Array): string; read(id: string): { type: string; bytes: Buffer } | undefined; load(id: string): Promise<{ type: string; data: string } | undefined> }`; `mediaStore(home: string): MediaStore`. (`load` returns the same shape as Task 2's `ImagePart`.)

- [ ] **Step 1: Write the failing test**

Add to `test/helpers.ts` (later tasks use it too):

```ts
/** A 32×32 solid red PNG. */
export const RED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC",
  "base64",
);
```

Create `test/media.test.ts`:

```ts
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEDIA_MAX, mediaStore, sniff } from "../src/node/media.js";
import { RED_PNG } from "./helpers.js";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

describe("media", () => {
  it("tells the four image types apart by their first bytes", () => {
    expect(sniff(RED_PNG)).toBe("image/png");
    expect(sniff(JPEG)).toBe("image/jpeg");
    expect(sniff(GIF)).toBe("image/gif");
    expect(sniff(WEBP)).toBe("image/webp");
    expect(sniff(Buffer.from("<svg></svg>"))).toBeUndefined();
  });

  it("keeps an image under an id, privately, and gives it back", async () => {
    const home = mkdtempSync(join(tmpdir(), "moqi-media-"));
    const media = mediaStore(home);
    const id = media.save(RED_PNG);
    expect(id).toMatch(/^m_[0-9a-f]{16}$/);
    expect(media.read(id)).toEqual({ type: "image/png", bytes: RED_PNG });
    expect(await media.load(id)).toEqual({ type: "image/png", data: RED_PNG.toString("base64") });
    expect(readdirSync(join(home, "media"))).toEqual([`${id}.png`]);
    expect(statSync(join(home, "media")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "media", `${id}.png`)).mode & 0o777).toBe(0o600);
  });

  it("refuses other types, empty files and big ones, and ids that are not ids", async () => {
    const media = mediaStore(mkdtempSync(join(tmpdir(), "moqi-media-")));
    expect(() => media.save(Buffer.from("hello"))).toThrow("只收 PNG、JPEG、GIF、WebP 图片");
    expect(() => media.save(Buffer.alloc(0))).toThrow("图片是空的");
    expect(() => media.save(Buffer.concat([RED_PNG, Buffer.alloc(MEDIA_MAX)]))).toThrow("图片太大了，最多 3 MB");
    expect(media.read("../config.json")).toBeUndefined();
    expect(media.read("m_0000000000000000")).toBeUndefined();
    expect(await media.load("m_zz")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/media.test.ts`
Expected: FAIL, cannot find `../src/node/media.js`.

- [ ] **Step 3: Implement** — `src/node/media.ts`:

```ts
// Images the user sends and tools bring back, kept as files under <moqi home>/media. Events only carry the ids.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MEDIA_MAX = 3 * 1024 * 1024;
export const MEDIA_ID = /^m_[0-9a-f]{16}$/;
const EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The image type from the file's first bytes; undefined for anything else, whatever it is called. */
export function sniff(bytes: Uint8Array): string | undefined {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

export interface MediaStore {
  /** Keeps an image and returns its id. Throws for other types, empty files and anything over 3 MB. */
  save(bytes: Uint8Array): string;
  read(id: string): { readonly type: string; readonly bytes: Buffer } | undefined;
  /** For the model: the type and the bytes in base64. */
  load(id: string): Promise<{ readonly type: string; readonly data: string } | undefined>;
}

export function mediaStore(home: string): MediaStore {
  const dir = join(home, "media");
  const read = (id: string) => {
    if (!MEDIA_ID.test(id)) return undefined; // never a path from outside
    for (const [type, ext] of Object.entries(EXT)) {
      const file = join(dir, `${id}.${ext}`);
      if (existsSync(file)) return { type, bytes: readFileSync(file) };
    }
    return undefined;
  };
  return {
    save(bytes) {
      if (bytes.length === 0) throw new Error("图片是空的");
      if (bytes.length > MEDIA_MAX) throw new Error("图片太大了，最多 3 MB");
      const type = sniff(bytes);
      if (!type) throw new Error("只收 PNG、JPEG、GIF、WebP 图片");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const id = `m_${randomBytes(8).toString("hex")}`;
      writeFileSync(join(dir, `${id}.${EXT[type]}`), bytes, { mode: 0o600 });
      return id;
    },
    read,
    load: async (id) => {
      const found = read(id);
      return found && { type: found.type, data: found.bytes.toString("base64") };
    },
  };
}
```

- [ ] **Step 4: Run the test** — same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm check
git add src/node/media.ts test/media.test.ts test/helpers.ts
git commit -m "feat(media): keep images as private files under the moqi home"
```

---

### Task 2: Images through the core (model contract, history, tool images, vision check)

**Files:**

- Modify: `src/core/model.ts` (`ChatMessage` union lines 11–13; `toWire`; new `ImagePart`, `canSeeImages`)
- Modify: `src/core/plugin.ts:49` (`ToolResult`)
- Modify: `src/core/types.ts` (`message` event, line 172)
- Modify: `src/core/moqi.ts` (`MoqiOptions.media`; `loadImage`; `chat`; `callTool` `how.images` and the run block)
- Modify: `src/core/agent.ts` (`AGENT`; `history`; `chatTurn`)
- Test: `test/agent.test.ts`

**Interfaces:**

- Produces: `interface ImagePart { readonly type: string; readonly data: string }`; user `ChatMessage` gains `images?: readonly ImagePart[]`; `canSeeImages(model: ChatModel, signal?: AbortSignal): Promise<boolean>` (exported from `src/core/model.ts`); `ToolResult` object form gains `images?: readonly string[]`; event `{ type: "message"; role; text; images?: readonly string[] }`; `MoqiOptions.media?: { load(id: string): Promise<ImagePart | undefined> }`; `Moqi.loadImage(id): Promise<ImagePart | undefined>`; `Moqi.chat(text, signal?, how?: { fromAgent?: boolean; images?: readonly string[] })`; `callTool` `how.images?: string[]` (ids pushed there); `AGENT.imageMessages = 3`, `AGENT.replyImages = 8`.

- [ ] **Step 1: Write the failing tests** — append to `test/agent.test.ts` (it already imports `harness`, `scriptedModel`, `call`; add `defineTool`, `z` imports if missing):

```ts
describe("images in chat", () => {
  const media = (ids: string[]) => ({
    load: async (id: string) => (ids.includes(id) ? { type: "image/png", data: `data-${id}` } : undefined),
  });
  const userMessages = (r: { messages: readonly import("../src/core/model.js").ChatMessage[] } | undefined) =>
    (r?.messages ?? []).flatMap((m) => (m.role === "user" ? [m] : []));

  it("gives the model the user's images, and only the last three messages with images keep them", async () => {
    const model = scriptedModel(() => "好");
    const { moqi } = harness({ model, media: media(["m_1", "m_2", "m_3", "m_4"]) });
    for (const id of ["m_1", "m_2", "m_3"]) await moqi.chat(`看 ${id}`, undefined, { images: [id] });
    await moqi.chat("看最后一张", undefined, { images: ["m_4"] });
    const sent = userMessages(model.requests.at(-1));
    expect(sent.map((m) => m.content)).toEqual(["看 m_1 [图片]", "看 m_2", "看 m_3", "看最后一张"]);
    expect(sent.map((m) => (m.images ?? []).map((i) => i.data))).toEqual([
      [],
      ["data-m_2"],
      ["data-m_3"],
      ["data-m_4"],
    ]);
    const logged = moqi.store.all().flatMap((e) => (e.type === "message" && e.role === "user" ? [e.images] : []));
    expect(logged).toEqual([["m_1"], ["m_2"], ["m_3"], ["m_4"]]);
  });

  it("says [图片] for an image it cannot read, and sends an image without words", async () => {
    const model = scriptedModel(() => "好");
    const { moqi } = harness({ model, media: media(["m_ok"]) });
    await moqi.chat("", undefined, { images: ["m_ok"] });
    expect(userMessages(model.requests.at(-1)).at(-1)).toEqual({
      role: "user",
      content: "",
      images: [{ type: "image/png", data: "data-m_ok" }],
    });
    await moqi.chat("这张呢", undefined, { images: ["m_gone"] });
    expect(userMessages(model.requests.at(-1)).at(-1)).toEqual({ role: "user", content: "这张呢 [图片]" });
  });

  it("puts the images tools brought back under the answer, not in front of the model", async () => {
    const shot = defineTool({
      name: "shot",
      description: "Take a picture",
      input: z.object({}),
      effect: "read",
      run: () => ({ value: "截好了", headline: "截好了", images: ["m_shot"] }),
    });
    const model = scriptedModel((r) => (r.messages.some((m) => m.role === "tool") ? "给你" : call("shot", {})));
    const { moqi } = harness({ model, plugins: [{ name: "cam", tools: [shot] }] });
    expect(await moqi.chat("截个图")).toBe("给你");
    const tool = model.requests.at(-1)?.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe("截好了");
    const answer = moqi.store
      .all()
      .filter((e) => e.type === "message")
      .at(-1);
    expect(answer).toMatchObject({ role: "assistant", text: "给你", images: ["m_shot"] });
  });
});

describe("openAICompatible with images", () => {
  it("sends images as content parts, with /no_think on the words", async () => {
    const { openAICompatible } = await import("../src/core/model.js");
    const bodies: { messages: { content: unknown }[] }[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: "红色" } }] }));
    }) as typeof globalThis.fetch;
    const model = openAICompatible({ baseURL: "http://x/v1", model: "qwen3-vl", noThink: true, fetch });
    await model.chat({
      messages: [{ role: "user", content: "这是什么", images: [{ type: "image/png", data: "QUJD" }] }],
      reasoning: "off",
    });
    expect(bodies[0]?.messages[0]?.content).toEqual([
      { type: "text", text: "这是什么 /no_think" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  });

  it("tells a model that sees from one that does not", async () => {
    const { canSeeImages } = await import("../src/core/model.js");
    const said = (content: string) => ({ id: "m", chat: async () => ({ content, toolCalls: [] }) });
    const fails = (message: string) => ({
      id: "m",
      chat: async () => {
        throw new Error(message);
      },
    });
    expect(await canSeeImages(said("红色"))).toBe(true);
    expect(await canSeeImages(said("Red."))).toBe(true);
    expect(await canSeeImages(said("我看不到图片"))).toBe(false);
    expect(await canSeeImages(fails("http://x/v1/chat/completions responded 400: image input not supported"))).toBe(
      false,
    );
    await expect(canSeeImages(fails("fetch failed"))).rejects.toThrow("fetch failed");
    await expect(canSeeImages(fails("http://x/v1/chat/completions responded 401: bad key"))).rejects.toThrow("401");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/agent.test.ts`
Expected: FAIL (images are not passed, `canSeeImages` is not exported).

- [ ] **Step 3: The model contract** — in `src/core/model.ts` replace the `ChatMessage` type with:

```ts
/** An image for the model: its type and its bytes in base64. */
export interface ImagePart {
  readonly type: string;
  readonly data: string;
}

export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string; readonly images?: readonly ImagePart[] }
  | { readonly role: "assistant"; readonly content: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly role: "tool"; readonly content: string; readonly toolCallId: string };
```

In `toWire`, before the final `return`:

```ts
  if (m.role === "user" && m.images?.length)
    return {
      role: "user",
      content: [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.type};base64,${i.data}` } })),
      ],
    };
```

At the end of the file:

```ts
/** A 32×32 solid red PNG: a model that can see says "red". */
const RED_SQUARE =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";

/**
 * Whether the model reads images: it is shown a red square and asked its colour. A refusal of the request
 * itself (400, 413, 415, 422) means it cannot; any other failure is not an answer and is thrown.
 */
export async function canSeeImages(model: ChatModel, signal?: AbortSignal): Promise<boolean> {
  try {
    const reply = await model.chat({
      messages: [
        { role: "user", content: "这张图是什么颜色？只回答颜色。", images: [{ type: "image/png", data: RED_SQUARE }] },
      ],
      maxTokens: 20,
      reasoning: "off",
      ...(signal && { signal }),
    });
    return /红|red/i.test(reply.content);
  } catch (error) {
    if (/ responded (400|413|415|422):/.test(error instanceof Error ? error.message : String(error))) return false;
    throw error;
  }
}
```

If `pnpm typecheck` complains where messages are built with `role: "system" | "user"` from one variable (e.g. in `src/core/learn.ts`, `reflect.ts`, `study.ts`), give those literals their own role (`role: "system" as const` / `"user" as const`); no behaviour changes.

- [ ] **Step 4: Tool results and the message event**

`src/core/plugin.ts`:

```ts
export type ToolResult =
  | string
  | {
      readonly value: string;
      readonly headline: string;
      readonly details?: string;
      /** Media ids of images to show the user under the answer; the model only sees the words. */
      readonly images?: readonly string[];
    };
```

`src/core/types.ts`, the `message` event:

```ts
  | { type: "message"; role: "user" | "assistant"; text: string; images?: readonly string[] }
```

- [ ] **Step 5: Moqi**

In `src/core/moqi.ts`: import `type ImagePart` from `./model.js` (with `ChatModel`). Add to `MoqiOptions`:

```ts
  /** Reads the images messages refer to, by media id. Without it, images are mentioned as "[图片]". */
  readonly media?: { load(id: string): Promise<ImagePart | undefined> };
```

Add after `idle()`:

```ts
  /** An image a message refers to, for the model; undefined when it is gone or there is no media. */
  async loadImage(id: string): Promise<ImagePart | undefined> {
    return (await this.options.media?.load(id)) ?? undefined;
  }
```

Change `chat`:

```ts
  /** One conversation turn. `fromAgent`: another agent wrote it, so it counts as outside content. `images`: media ids. */
  chat(
    text: string,
    signal?: AbortSignal,
    how?: { readonly fromAgent?: boolean; readonly images?: readonly string[] },
  ): Promise<string> {
    return chatTurn(this, text, signal, how);
  }
```

In `callTool`, add `images?: string[]` to the `how` type (after `sites?: SiteGrant`) with the comment `// where images a tool brings back are collected`, and replace `text = resultText(await tool.run(parsed.data, ctx));` with:

```ts
const out = await tool.run(parsed.data, ctx);
text = resultText(out);
if (how.images && typeof out === "object" && out.images) how.images.push(...out.images);
```

- [ ] **Step 6: The chat turn** — in `src/core/agent.ts`:

Change `AGENT` to `export const AGENT = { maxToolRounds: 6, historyMessages: 12, imageMessages: 3, replyImages: 8 } as const;` and import `ImagePart` (`import type { ChatMessage, ImagePart } from "./model.js";`).

Replace `history` with:

```ts
const withImageMark = (text: string) => (text ? `${text} [图片]` : "[图片]");

/** The images of one message that can still be read, and whether any could not. */
async function loadImages(moqi: Moqi, ids: readonly string[]): Promise<{ images: ImagePart[]; missing: boolean }> {
  const found = await Promise.all(ids.map((id) => moqi.loadImage(id)));
  const images = found.filter((i): i is ImagePart => i !== undefined);
  return { images, missing: images.length < ids.length };
}

/** A user message for the model: its images when it keeps them, "[图片]" for the ones it does not. */
async function userMessage(moqi: Moqi, text: string, ids: readonly string[], keep: boolean): Promise<ChatMessage> {
  if (ids.length === 0) return { role: "user", content: text };
  if (!keep) return { role: "user", content: withImageMark(text) };
  const { images, missing } = await loadImages(moqi, ids);
  return {
    role: "user",
    content: missing ? withImageMark(text) : text,
    ...(images.length > 0 && { images }),
  };
}

/** The last messages; only the latest `withImages` user messages that had images still carry them. */
async function history(moqi: Moqi, limit: number, withImages: number): Promise<ChatMessage[]> {
  const recent = moqi.store
    .all()
    .flatMap((e) => (e.type === "message" ? [e] : []))
    .slice(-limit);
  let left = withImages;
  const out: ChatMessage[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    if (!e) continue;
    if (e.role === "assistant") {
      out.unshift({ role: "assistant", content: e.text });
      continue;
    }
    const ids = e.images ?? [];
    const keep = ids.length > 0 && left > 0;
    if (keep) left--;
    out.unshift(await userMessage(moqi, e.text, ids, keep));
  }
  return out;
}
```

In `chatTurn`, change the `how` type to `{ readonly fromAgent?: boolean; readonly images?: readonly string[] } = {}` and replace the lines from `const past = …` through the `messages` array with:

```ts
const images = how.images ?? [];
const past = await history(moqi, AGENT.historyMessages, AGENT.imageMessages - (images.length > 0 ? 1 : 0));
moqi.emit({ type: "message", role: "user", text, ...(images.length > 0 && { images: [...images] }) });

const tools = moqi.visibleTools().map(toolSpec);
const messages: ChatMessage[] = [
  { role: "system", content: systemPrompt(moqi) },
  ...past,
  await userMessage(moqi, text, images, true),
];
```

After `const sites: SiteGrant = …` add `const shown: string[] = []; // images tools brought back, for the user`; pass it in the tool call (`moqi.callTool(call.name, args, { byUser: true, tainted, sites, images: shown })`); and replace the final assistant `emit` with:

```ts
moqi.emit({
  type: "message",
  role: "assistant",
  text: answer,
  ...(shown.length > 0 && { images: shown.slice(0, AGENT.replyImages) }),
});
```

- [ ] **Step 7: Run the tests** — `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/agent.test.ts`. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
pnpm format && pnpm check
git add src/core test
git commit -m "feat(chat): images in messages, for the model and from tools, and a check for models that can see"
```

---

### Task 3: Images on this computer: home, MCP, macOS, and the console API

**Files:**

- Modify: `src/node/home.ts` (`Home.media`; `pluginsFrom(config, fetch?, platform?, media?)`; `openHome`; `build`)
- Modify: `src/node/mcp-client.ts` (`McpHub` and `Connection` constructors; `wrap().run`)
- Modify: `src/node/mac.ts` (`MacOptions.media`; `mac_screenshot`)
- Modify: `src/node/config.ts` (model schema: `vision`)
- Modify: `src/node/console/server.ts` (CSP; media routes in `handle`; `/api/chat`; `/api/state` `messages` and `vision`; `/api/model/vision`; `/api/model/test`; `/api/config`)
- Create: `test/fixtures/picture-mcp.mjs`
- Test: `test/console.test.ts`, `test/interop.test.ts`, `test/mac.test.ts`

**Interfaces:**

- Consumes: `mediaStore`, `MediaStore`, `MEDIA_MAX`, `MEDIA_ID`, `sniff` (Task 1); `canSeeImages`, `ToolResult.images`, `Moqi.chat(…, { images })` (Task 2).
- Produces: `Home.media: MediaStore`; `new McpHub(version, media?)`; `MacOptions.media?: { save(bytes: Uint8Array): string }`; config `model.vision?: boolean`; HTTP `POST /api/media` (raw image → `{ id }`), `GET /api/media?id=`, `POST /api/chat { text, images? }`, `POST /api/model/vision { model? } → { vision }`, `POST /api/model/test → { …, vision }`, `GET /api/state → messages[].images, vision: boolean | null`.

- [ ] **Step 1: Fixture** — `test/fixtures/picture-mcp.mjs`:

```js
// An MCP server with one read-only tool that returns an image, for moqi's image tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const RED =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAJ0lEQVR42u3NsQkAAAjAsP7/tF7hIASyp6lTCQQCgUAgEAgEgi/BAjLD/C5w/SM9AAAAAElFTkSuQmCC";
const server = new McpServer({ name: "picture", version: "1.0.0" });
server.registerTool(
  "red",
  { description: "Shows a red square", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "image", data: RED, mimeType: "image/png" }] }),
);
await server.connect(new StdioServerTransport());
```

- [ ] **Step 2: Write the failing tests**

`test/interop.test.ts`, inside `describe("moqi uses MCP servers", …)`:

```ts
it("keeps the images a server returns and gives the model words instead", async () => {
  const picture = join(import.meta.dirname, "fixtures", "picture-mcp.mjs");
  const h = home({ mcp: { servers: { picture: { command: process.execPath, args: [picture] } } } });
  await waitFor(() => h.mcpStatus().every((s) => s.state !== "starting"));
  const shown: string[] = [];
  expect(await h.moqi.callTool("picture__red", {}, { byUser: true, images: shown })).toBe("[图片，已显示给用户]");
  expect(shown).toHaveLength(1);
  expect(h.media.read(shown[0] as string)?.type).toBe("image/png");
});
```

`test/mac.test.ts` (import `RED_PNG` from `./helpers.js`, `mkdtempSync`, `writeFileSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path` as needed):

```ts
it("shows the screenshot it took under the answer", async () => {
  const desktop = mkdtempSync(join(tmpdir(), "moqi-desk-"));
  const saved: Uint8Array[] = [];
  const exec: Exec = async (file, args) => {
    if (file === "screencapture") writeFileSync(args[1] as string, RED_PNG);
    return "";
  };
  const media = {
    save: (bytes: Uint8Array) => {
      saved.push(bytes);
      return "m_0123456789abcdef";
    },
  };
  const tool = macPlugin({ shortcuts: [], exec, desktop, media }).tools?.find((t) => t.name === "mac_screenshot");
  const out = await tool?.run({}, { now: () => 0, state: undefined as never });
  expect(out).toMatchObject({ images: ["m_0123456789abcdef"] });
  expect(Buffer.from(saved[0] as Uint8Array).equals(RED_PNG)).toBe(true);
});
```

`test/console.test.ts` (import `RED_PNG` from `./helpers.js`; `request` is already imported from `node:http`):

```ts
describe("console: images", () => {
  const T = "t".repeat(32);
  const upload = (port: number, bytes: Uint8Array, type = "image/png", token = T) =>
    fetch(`http://127.0.0.1:${port}/api/media`, {
      method: "POST",
      headers: { "x-moqi-token": token, "content-type": type },
      body: bytes,
    });

  it("takes images, gives them back, and sends them to the model with the message", async () => {
    let seen: unknown;
    const { ui, api } = await start({ model: MODEL, briefingAt: null }, (body) => {
      seen = body.messages.at(-1);
      return { content: "一个红色方块" };
    });
    expect((await upload(ui.port, RED_PNG, "image/png", "x".repeat(32))).status).toBe(401);
    expect((await upload(ui.port, Buffer.from("hello"), "text/plain")).status).toBe(415);
    expect((await upload(ui.port, Buffer.from("hello"), "image/png")).status).toBe(415);
    const tooBig = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: ui.port,
          path: "/api/media",
          method: "POST",
          headers: { "x-moqi-token": T, "content-type": "image/png", "content-length": String(3 * 1024 * 1024 + 1) },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
          req.destroy();
        },
      );
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(tooBig).toBe(413);

    const { id } = (await (await upload(ui.port, RED_PNG)).json()) as { id: string };
    expect(id).toMatch(/^m_[0-9a-f]{16}$/);
    const got = await fetch(`http://127.0.0.1:${ui.port}/api/media?id=${id}`, { headers: { "x-moqi-token": T } });
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await got.arrayBuffer()).equals(RED_PNG)).toBe(true);
    expect((await api("GET", "/api/media?id=../config.json")).status).toBe(400);
    expect((await api("GET", "/api/media?id=m_0000000000000000")).status).toBe(404);

    expect((await api("POST", "/api/chat", { text: "", images: [] })).status).toBe(400);
    expect((await api("POST", "/api/chat", { text: "这是什么", images: ["m_0000000000000000"] })).status).toBe(400);
    expect((await api("POST", "/api/chat", { text: "这是什么", images: [id], from: "kiro" })).status).toBe(400);
    expect((await api("POST", "/api/chat", { text: "这是什么", images: [id] })).data.reply).toBe("一个红色方块");
    expect(seen).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "这是什么" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${RED_PNG.toString("base64")}` } },
      ],
    });
    const state = (await api("GET", "/api/state")).data;
    expect(state.messages.at(-2)).toMatchObject({ role: "user", text: "这是什么", images: [id] });
    expect(state.vision).toBeNull();
  });

  it("finds out once whether the model can see, and forgets it when the model changes", async () => {
    let answer = "红色";
    const { dir, api } = await start({ model: MODEL, briefingAt: null }, () => ({ content: answer }));
    expect((await api("POST", "/api/model/vision", {})).data).toEqual({ vision: true });
    expect(readConfigFile(dir).model?.vision).toBe(true);
    expect((await api("GET", "/api/state")).data.vision).toBe(true);
    answer = "我看不到图片";
    expect((await api("POST", "/api/model/vision", { model: MODEL })).data).toEqual({ vision: false });
    expect(readConfigFile(dir).model?.vision).toBe(true); // testing a form's model does not save
    const config = (await api("GET", "/api/config")).data.config;
    await api("POST", "/api/config", { config: { ...config, model: { ...MODEL } } });
    expect(readConfigFile(dir).model?.vision).toBe(true); // same model: kept
    await api("POST", "/api/config", { config: { ...config, model: { ...MODEL, model: "m2" } } });
    expect(readConfigFile(dir).model?.vision).toBeUndefined(); // another model: forgotten
    await api("POST", "/api/config", { config: { ...config, model: { ...MODEL, model: "m2", vision: false } } });
    expect(readConfigFile(dir).model?.vision).toBe(false); // the page tested this very model
  });

  it("lets images come from the page only, under the policy", async () => {
    const { ui } = await start({});
    const csp = (await fetch(`http://127.0.0.1:${ui.port}/`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("img-src 'self' data: blob:");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/console.test.ts test/interop.test.ts test/mac.test.ts`
Expected: FAIL (`h.media` undefined, 404 on `/api/media`, no `images` on screenshots).

- [ ] **Step 4: Home, MCP and macOS**

`src/node/home.ts`: import `{ type MediaStore, mediaStore } from "./media.js"`; add `readonly media: MediaStore;` to `Home` (comment: `/** Images the user sent and tools brought back. */`). Give `pluginsFrom` a fourth parameter `media?: MediaStore` and change the mac line to `plugins.push(macPlugin({ shortcuts: config.mac.shortcuts, ...(media && { media }) }))`. In `openHome`: `const media = mediaStore(options.home);` before the hub, `const hub = new McpHub(VERSION, media);`, pass `media` as a new last argument to every `build(…)` call, and return `media` in the home object. In `build`, take `media: MediaStore` as the last parameter, call `pluginsFrom(config, options.fetch, process.platform, media)` and add `media,` to the `Moqi` options.

`src/node/mcp-client.ts`: import `type MediaStore` from `./media.js`. `Connection`'s constructor gains a last parameter `private readonly media?: MediaStore`; `McpHub`'s constructor becomes `constructor(private readonly version: string, private readonly media?: MediaStore) {}` and creates connections with `new Connection(name, config, this.version, () => this.onChange(), this.media)`. Replace the body of `run` in `wrap`:

```ts
      run: async (args) => {
        const result = (await this.request("tools/call", { name: t.name, arguments: args })) as {
          content?: { type: string; text?: string; data?: string }[];
          structuredContent?: unknown;
          isError?: boolean;
        };
        // Images are kept for the user to see; the model gets a word for each.
        const images: string[] = [];
        const keep = (data: string): string => {
          if (!this.media || images.length >= 4) return "[图片]";
          try {
            images.push(this.media.save(Buffer.from(data, "base64")));
            return "[图片，已显示给用户]";
          } catch {
            return "[图片]";
          }
        };
        const text =
          (result.content ?? [])
            .map((c) =>
              c.type === "text" ? (c.text ?? "") : c.type === "image" && c.data ? keep(c.data) : `[${c.type}]`,
            )
            .join("\n")
            .trim() || (result.structuredContent ? JSON.stringify(result.structuredContent) : "（没有返回内容）");
        if (result.isError) throw new Error(text.slice(0, 500));
        const value = text.slice(0, 8000);
        return images.length > 0 ? { value, headline: value, images } : value;
      },
```

`src/node/mac.ts`: add to `MacOptions`:

```ts
  /** Keeps a screenshot so the console can show it under the answer. */
  readonly media?: { save(bytes: Uint8Array): string };
```

and replace the `mac_screenshot` `run`:

```ts
      run: async () => {
        const file = join(desktop, `moqi-截图-${stamp(now())}.png`);
        await exec("screencapture", ["-x", file]);
        const headline = `截好了：${file}`;
        let id: string | undefined;
        try {
          id = options.media?.save(readFileSync(file));
        } catch {
          id = undefined; // no permission to record the screen leaves no file: the words are enough
        }
        return id ? { value: headline, headline, images: [id] } : headline;
      },
```

(`options` is the `macPlugin` parameter; if the function destructures it, read `media` alongside `shortcuts`.)

`src/node/config.ts`: in the model object add `vision: z.boolean().optional(),` after `effort`.

- [ ] **Step 5: The console API** — in `src/node/console/server.ts`:

1. Imports: `canSeeImages` with `openAICompatible` from `../../core/model.js`; `{ MEDIA_ID, MEDIA_MAX, sniff }` from `../media.js`; `saveConfig` already imported from `../config.js` (add it if not).
2. CSP: `img-src 'self' data:` → `img-src 'self' data: blob:`.
3. A helper after `readJson`:

```ts
/** An uploaded image: raw bytes with an image content type, at most MEDIA_MAX, recognised by its header. */
async function readImage(req: IncomingMessage): Promise<Buffer> {
  if (!(req.headers["content-type"] ?? "").startsWith("image/")) throw new HttpError(415, "只收图片");
  if (Number(req.headers["content-length"] ?? 0) > MEDIA_MAX) throw new HttpError(413, "图片太大了，最多 3 MB");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MEDIA_MAX) throw new HttpError(413, "图片太大了，最多 3 MB");
    chunks.push(chunk as Buffer);
  }
  const bytes = Buffer.concat(chunks);
  if (!sniff(bytes)) throw new HttpError(415, "只收 PNG、JPEG、GIF、WebP 图片");
  return bytes;
}
```

4. In `handle`, just before `const route = routes[…]`:

```ts
    if (url.pathname === "/api/media") {
      if (!tokenOk(req.headers["x-moqi-token"])) return send(res, 401, { error: "需要从 moqi 打开的链接进入" });
      try {
        if (req.method === "POST") return send(res, 200, { id: home.media.save(await readImage(req)) });
        if (req.method !== "GET") throw new HttpError(405, "只能上传或读取");
        const id = url.searchParams.get("id") ?? "";
        if (!MEDIA_ID.test(id)) throw new HttpError(400, "图片编号不对");
        const found = home.media.read(id);
        if (!found) throw new HttpError(404, "没有这张图片");
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": found.type,
          "Cache-Control": "private, max-age=31536000, immutable",
        });
        return void res.end(found.bytes);
      } catch (error) {
        return send(res, error instanceof HttpError ? error.status : 500, { error: message(error) });
      }
    }
```

5. `/api/chat`: replace its first four lines (through the `!home.moqi.model` check) with:

```ts
const text = str(body.text, "text").trim();
const images = Array.isArray(body.images) ? body.images : [];
if (text === "" && images.length === 0) throw new HttpError(400, "说点什么吧");
if (text.length > 4000) throw new HttpError(400, "一次说得太长了");
if (images.length > 4) throw new HttpError(400, "一次最多 4 张图片");
if (images.length > 0 && body.from !== undefined) throw new HttpError(400, "别的 agent 只能发文字");
if (!images.every((id) => typeof id === "string" && home.media.read(id)))
  throw new HttpError(400, "有一张图片找不到了，重新加一下");
if (!home.moqi.model) throw new HttpError(409, "还没配置模型，先去设置里接一个");
```

and the call to `home.moqi.chat(fromAgent(text, body.from), undefined, { fromAgent: byAgent(body.from), ...(images.length > 0 && { images: images as string[] }) })`.

6. `/api/state`: messages become `.flatMap((e) => (e.type === "message" ? [{ role: e.role, text: e.text, at: e.at, ...(e.images && { images: e.images }) }] : []))`, and add `vision: home.config.model?.vision ?? null,` to the returned object.

7. A model from a form, shared by the two model routes; put it inside `startConsole` after `savedKeyFor`:

```ts
/** A model built from what the settings form says, with the saved key only for its own endpoint. */
const formModel = (m: Record<string, unknown>) => {
  const baseURL = str(m.baseURL, "baseURL");
  if (!/^https?:\/\//.test(baseURL)) throw new HttpError(400, "接口地址要以 http:// 或 https:// 开头");
  const apiKey = (typeof m.apiKey === "string" && m.apiKey) || env.MOQI_API_KEY || savedKeyFor(baseURL);
  return openAICompatible({
    baseURL,
    model: str(m.model, "model"),
    ...(apiKey && { apiKey }),
    ...(m.noThink === true && { noThink: true }),
    fetch: doFetch,
  });
};
```

Use it in `/api/model/test` (`const model = formModel((body.model ?? {}) as Record<string, unknown>);` replacing the inline construction), and after a successful greeting return `{ ok: true, ms, reply, vision: await canSeeImages(model, AbortSignal.timeout(60_000)).catch(() => false) }`.

Add the route:

```ts
    "POST /api/model/vision": async (body) => {
      if (body.model !== undefined) {
        const model = formModel(body.model as Record<string, unknown>);
        return { vision: await canSeeImages(model, AbortSignal.timeout(60_000)) };
      }
      const current = home.moqi.model;
      if (!current) throw new HttpError(409, "还没配置模型，先去设置里接一个");
      let vision: boolean;
      try {
        vision = await canSeeImages(current, AbortSignal.timeout(60_000));
      } catch (error) {
        throw new HttpError(502, `模型出错了：${message(error)}`);
      }
      // Kept with the model it is about; a model from the environment has nowhere to keep it.
      const file = readConfigFile(home.dir);
      const live = home.config.model;
      if (file.model && live && file.model.baseURL === live.baseURL && file.model.model === live.model) {
        saveConfig(home.dir, { ...file, model: { ...file.model, vision } });
        await home.reconfigure(loadConfig(home.dir, env));
      }
      return { vision };
    },
```

8. `/api/config`: move `const file = readConfigFile(home.dir);` up to just after `const raw = …`, and after the two `apiKey` lines add:

```ts
// What moqi found out about seeing images belongs to that model: kept while it stays, dropped when it changes.
if (model && typeof model.vision !== "boolean") {
  const old = file.model;
  if (old?.vision !== undefined && old.baseURL === model.baseURL && old.model === model.model)
    model.vision = old.vision;
  else delete model.vision;
}
```

- [ ] **Step 6: Run the tests** — same command as Step 3. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm format && pnpm check
git add src/node test
git commit -m "feat(console): upload and show images, send them with a message, and find out whether the model can see"
```

---

### Task 4: The page: attach, send and look at images

**Files:**

- Modify: `src/node/console/assets/index.html` (the composer, lines 44–50; a `<dialog>` after it)
- Modify: `src/node/console/assets/app.js` (globals; `renderChat`; composer submit lines 821–837; new image helpers)
- Modify: `src/node/console/assets/app.css` (`.msg`, `.composer`, new image rules)

**Interfaces:**

- Consumes: `POST /api/media`, `GET /api/media?id=`, `POST /api/chat { text, images }`, `POST /api/model/vision`, `state.vision`, `state.messages[].images` (Task 3).
- Produces: `messageEl(m)` and `renderAnswer(text)` in `app.js` (Task 5 replaces `renderAnswer` with Markdown).

There are no DOM unit tests in this project; this task is verified with headless Chrome in Step 5.

- [ ] **Step 1: Markup** — replace the `<form class="composer" …>…</form>` in `index.html` with:

```html
        <form class="composer" id="composer">
          <div class="attachments" id="attachments" hidden></div>
          <div class="composer-row">
            <label for="input" class="sr-only">对 moqi 说</label>
            <textarea id="input" rows="1" placeholder="跟 moqi 说点什么，可以直接粘贴图片" autocomplete="off"></textarea>
            <input type="file" id="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden aria-label="选择图片" />
            <button type="button" class="attach" id="attach" aria-label="添加图片" title="添加图片">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="M21 15l-5-5L5 21" /></svg>
            </button>
            <button type="submit" class="send" id="send" aria-label="发送">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
            </button>
          </div>
          <p class="attach-status" id="attach-status" aria-live="polite"></p>
        </form>
        <dialog class="viewer" id="viewer" aria-label="放大的图片"><img id="viewer-img" alt="" /></dialog>
```

- [ ] **Step 2: Showing messages with images** — in `app.js`:

Change the `sending` comment to `// { text, images } being sent, shown until moqi answers`. Add after `const drafts = new Map();`:

```js
const MAX_IMAGES = 4;
const MAX_EDGE = 2048;
const MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const NO_VISION = "当前模型看不了图，可以换成 deepseek-flash 这类能看图的模型";
let attachments = []; // { preview, id?, error?, uploading }
let visionAsked = null; // the one check in flight
const pictures = new Map(); // media id -> Promise of a blob: URL
```

Add before `renderChat`:

```js
/** An image from moqi, fetched with the key and shown through a blob: URL. */
function mediaUrl(id) {
  if (!pictures.has(id))
    pictures.set(
      id,
      fetch(`/api/media?id=${encodeURIComponent(id)}`, { headers: { "x-moqi-token": token } })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((b) => URL.createObjectURL(b)),
    );
  return pictures.get(id);
}

function picture(id, alt) {
  const img = h("img", { alt });
  const button = h("button", { type: "button", class: "pic", "aria-label": `放大看：${alt}` }, img);
  button.addEventListener("click", () => openViewer(img.src, alt, button));
  mediaUrl(id)
    .then((url) => {
      img.src = url;
    })
    .catch(() => {
      button.classList.add("gone");
      img.alt = `${alt}（找不到了）`;
    });
  return button;
}

function openViewer(src, alt, from) {
  if (!src) return;
  $("viewer-img").src = src;
  $("viewer-img").alt = alt;
  $("viewer").addEventListener("close", () => from.focus(), { once: true });
  $("viewer").showModal();
}
$("viewer").addEventListener("click", (e) => {
  if (e.target === $("viewer")) $("viewer").close();
});

/** moqi's answer. Plain text here; Markdown replaces it. */
function renderAnswer(text) {
  return h("div", { class: "msg-text", text });
}

function messageEl(m) {
  const user = m.role === "user";
  const ids = m.images || [];
  const pics = ids.length
    ? h(
        "div",
        { class: "pics" },
        ids.map((id, i) => picture(id, user ? `你发的图片 ${i + 1}` : `moqi 带回的图片 ${i + 1}`)),
      )
    : null;
  if (user) return h("div", { class: "msg user" }, pics, m.text ? h("div", { class: "msg-text", text: m.text }) : null);
  return h("div", { class: "msg moqi" }, renderAnswer(m.text), pics);
}
```

In `renderChat`, replace the message loop and the `sending` block:

```js
for (const m of state.messages) list.append(messageEl(m));
if (sending !== null) {
  const last = state.messages.at(-1);
  if (!(last && last.role === "user" && last.text === sending.text))
    list.append(messageEl({ role: "user", text: sending.text, images: sending.images }));
  list.append(h("div", { class: "msg moqi thinking", text: "moqi 在想" }));
}
```

and at its end replace the `$("send").disabled = …` line with `renderAttach();`.

- [ ] **Step 3: Attaching and sending** — add after `renderChat`:

```js
async function shrink(file) {
  if (file.type === "image/gif") {
    if (file.size > MAX_BYTES) throw new Error("GIF 太大了，最多 2 MB");
    return file;
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_BYTES) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) throw new Error("这张图处理不了");
  return blob;
}

async function upload(blob) {
  const res = await fetch("/api/media", {
    method: "POST",
    headers: { "x-moqi-token": token, "content-type": blob.type || "application/octet-stream" },
    body: blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `上传失败（HTTP ${res.status}）`);
  return data.id;
}

/** Whether the model can see images; asks it once when nobody knows yet. */
async function canSee() {
  if (typeof state?.vision === "boolean") return state.vision;
  $("attach-status").textContent = "正在确认模型能不能看图…";
  visionAsked ??= api("POST", "/api/model/vision", {})
    .then((r) => r.vision)
    .finally(() => {
      visionAsked = null;
    });
  try {
    state.vision = await visionAsked;
    return state.vision;
  } finally {
    $("attach-status").textContent = "";
  }
}

async function addImages(files) {
  const images = [...files].filter((f) => IMAGE_TYPES.includes(f.type));
  if (images.length === 0) return;
  if (!state?.configured) return toast("先给 moqi 接一个模型");
  let ok = false;
  try {
    ok = await canSee();
  } catch (error) {
    return toast(error.message);
  }
  renderAttach();
  if (!ok) return toast(NO_VISION);
  for (const file of images) {
    if (attachments.length >= MAX_IMAGES) {
      toast(`一条消息最多 ${MAX_IMAGES} 张图片`);
      break;
    }
    const a = { preview: URL.createObjectURL(file), uploading: true };
    attachments.push(a);
    renderAttach();
    try {
      a.id = await upload(await shrink(file));
    } catch (error) {
      a.error = error.message;
    }
    a.uploading = false;
    renderAttach();
  }
}

function renderAttach() {
  const strip = $("attachments");
  strip.replaceChildren();
  strip.hidden = attachments.length === 0;
  for (const a of attachments) {
    const remove = h("button", { type: "button", class: "thumb-remove", "aria-label": "移除这张图片" }, icon("x"));
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(a.preview);
      attachments = attachments.filter((x) => x !== a);
      renderAttach();
    });
    const cls = `thumb${a.error ? " bad" : ""}${a.uploading ? " busy" : ""}`;
    strip.append(
      h("div", { class: cls, title: a.error || "" }, h("img", { src: a.preview, alt: "要发的图片" }), remove),
    );
  }
  const blocked = state?.vision === false;
  $("attach").setAttribute("aria-disabled", String(blocked || !state?.configured));
  $("attach").title = blocked ? NO_VISION : "添加图片";
  $("send").disabled = !state?.configured || sending !== null || attachments.some((a) => a.uploading);
}

$("attach").addEventListener("click", () => {
  if (!state?.configured) return toast("先给 moqi 接一个模型");
  if (state.vision === false) return toast(NO_VISION);
  $("file").click();
});
$("file").addEventListener("change", () => {
  addImages($("file").files);
  $("file").value = "";
});
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.some((f) => f.type.startsWith("image/"))) return;
  e.preventDefault();
  addImages(files);
});
$("view-chat").addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) e.preventDefault();
});
$("view-chat").addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  addImages(e.dataTransfer.files);
});
```

(`input` is the existing `const input = $("input")`; if that constant is declared below this code, move these listeners after it.)

Replace the composer `submit` handler:

```js
$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  const ready = attachments.filter((a) => a.id);
  if (sending !== null || attachments.some((a) => a.uploading) || (!text && ready.length === 0)) return;
  sending = { text, images: ready.map((a) => a.id) };
  const sent = attachments;
  attachments = [];
  input.value = "";
  autosize();
  render();
  try {
    await api("POST", "/api/chat", { text, ...(sending.images.length > 0 && { images: sending.images }) });
    for (const a of sent) URL.revokeObjectURL(a.preview);
  } catch (error) {
    toast(error.message);
    if (!input.value) input.value = text;
    attachments = sent; // kept, to send again
  }
  sending = null;
  await refresh();
});
```

Settings: show and keep what the connection test found. Add a global `let tested = null; // { baseURL, model, vision } of the last connection test`. In the `m-test` click handler, replace the success line with:

```js
if (r.ok) {
  const m = modelInput();
  tested = { baseURL: m.baseURL, model: m.model, vision: r.vision === true };
  const sees = r.vision ? "，能看图" : "，看不了图";
  setResult(out, r.reply ? `连上了（${secs} 秒${sees}）：${r.reply}` : `连上了（${secs} 秒${sees}）`, "ok");
} else setResult(out, `连不上：${r.error}`, "bad");
```

and in the settings save, where the config is built (`model: m.baseURL ? m : null,`), send the test's answer only for the very model it tested:

```js
    model: m.baseURL
      ? { ...m, ...(tested && tested.baseURL === m.baseURL && tested.model === m.model && { vision: tested.vision }) }
      : null,
```

- [ ] **Step 4: Styles** — in `app.css` replace the `.msg`, `.msg.user`, `.msg.moqi` rules and the `.composer`, `.composer textarea` rules with:

```css
.msg {
  max-width: 85%;
  overflow-wrap: anywhere;
}

.msg-text {
  white-space: pre-wrap;
}

.msg.user {
  align-self: flex-end;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.msg.user .msg-text {
  padding: 10px 16px;
  border-radius: 18px 18px 4px 18px;
  background: var(--bubble);
}

.msg.moqi {
  align-self: flex-start;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.composer {
  position: sticky;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 8px 8px 16px;
  border: 1px solid var(--border-strong);
  border-radius: 26px;
  background: var(--surface);
  box-shadow: 0 4px 18px rgb(0 0 0 / 5%);
  transition: border-color 150ms ease;
}

.composer-row {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}

.composer textarea {
  flex: 1;
  min-height: 28px;
  max-height: 160px;
  margin: 6px 0;
  padding: 0;
  border: 0;
  background: none;
  resize: none;
  outline: none;
  line-height: 1.6;
}

.attach {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: none;
  border: 0;
  border-radius: 50%;
  background: none;
  color: var(--muted);
  transition:
    background-color 150ms ease,
    color 150ms ease;
}

.attach:hover {
  background: var(--bubble);
  color: var(--text);
}

.attach[aria-disabled="true"] {
  opacity: 0.4;
  cursor: not-allowed;
}

.attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 4px;
}

.thumb {
  position: relative;
  width: 56px;
  height: 56px;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bubble);
}

.thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb.busy img {
  opacity: 0.5;
}

.thumb.bad {
  border-color: var(--danger);
}

.thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: rgb(0 0 0 / 55%);
  color: #fff;
}

.thumb-remove svg {
  width: 14px;
  height: 14px;
}

.attach-status {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.attach-status:empty {
  display: none;
}

.pics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pic {
  max-width: 320px;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bubble);
  cursor: zoom-in;
}

.pic img {
  display: block;
  max-width: 100%;
  max-height: 320px;
  object-fit: contain;
}

.pic.gone {
  min-width: 120px;
  min-height: 60px;
  cursor: default;
}

.viewer {
  max-width: 92vw;
  max-height: 92vh;
  padding: 0;
  border: 0;
  background: transparent;
}

.viewer::backdrop {
  background: rgb(0 0 0 / 72%);
}

.viewer img {
  display: block;
  max-width: 92vw;
  max-height: 92vh;
  border-radius: 8px;
}
```

- [ ] **Step 5: Look at it in a real browser**

Write a scratch script (outside the repo, e.g. `/tmp/moqi-mm/serve.mjs`) that opens a home on a temp dir with `openHome({ home, notifier: async () => {}, agents: false, lock: false, confirm, fetch })`, where `fetch` answers `/chat/completions` with `红色` when the last user message carries an image and `这是一张红色的小方块。` otherwise; config `{ briefingAt: null, news: { feeds: [] }, model: { baseURL: "http://model.test/v1", model: "m" } }`; then `startConsole({ home, asker: confirmQueue(), token: "t".repeat(32), port: 0 })` and print the URL. Drive it with a CDP script (as in `/tmp/moqi-fc/shot.mjs` of the previous plan): set `#file` with `DOM.setFileInputFiles` to a PNG on disk, wait for the thumbnail, type "这是什么", submit, wait for the answer, screenshot at 1280 and 375, light and dark; click the image and screenshot the viewer. Check: the thumbnail shows, the sent message shows the image above the bubble, the answer appears, the viewer opens, nothing overflows at 375 px. Also stub the fetch to answer `我看不到图片` to the colour question and check the attach button turns grey and shows the hint.

- [ ] **Step 6: Commit**

```bash
pnpm format && pnpm check
git add src/node/console/assets
git commit -m "feat(console): paste, drop or pick images, see them in the conversation, and look at them large"
```

---

### Task 5: Formatted answers (Markdown)

**Files:**

- Create: `src/node/console/assets/markdown.js`
- Modify: `src/node/console/server.ts` (`ASSETS`: `/markdown.js`)
- Modify: `src/node/console/assets/index.html` (load `/markdown.js` before `/app.js`)
- Modify: `src/node/console/assets/app.js` (`renderAnswer`)
- Modify: `src/node/console/assets/app.css` (`.md` rules)
- Modify: `src/core/agent.ts` (`GUIDE`)
- Test: `test/markdown.test.ts`, `test/console.test.ts`

**Interfaces:**

- Produces: `globalThis.moqiMarkdown.parse(text: string): Block[]` where blocks are `{ t: "p", c }`, `{ t: "h", level: 1 | 2, c }`, `{ t: "ul" | "ol", start, items: { c, sub? }[] }`, `{ t: "quote", blocks }`, `{ t: "code", lang, text }`, `{ t: "table", head, align, rows }`, `{ t: "hr" }`, `{ t: "cards", links: { text, href, host }[] }`; inline nodes `{ t: "text", v }`, `{ t: "br" }`, `{ t: "code", v }`, `{ t: "b" | "i", c }`, `{ t: "a", href, c }`.

- [ ] **Step 1: Write the failing test** — `test/markdown.test.ts`:

````ts
import { beforeAll, describe, expect, it } from "vitest";

type Parse = (text: string) => unknown[];
let parse: Parse;

beforeAll(async () => {
  // A plain browser script: it puts its parser on globalThis.
  await import(/* @vite-ignore */ new URL("../src/node/console/assets/markdown.js", import.meta.url).href);
  parse = (globalThis as unknown as { moqiMarkdown: { parse: Parse } }).moqiMarkdown.parse;
});

const text = (v: string) => ({ t: "text", v });

describe("markdown for moqi's answers", () => {
  it("reads paragraphs, line breaks, bold, italic and code", () => {
    expect(parse("第一行\n**重要**和*轻声*，`pnpm test`\n\n第二段")).toEqual([
      {
        t: "p",
        c: [
          text("第一行"),
          { t: "br" },
          { t: "b", c: [text("重要")] },
          text("和"),
          { t: "i", c: [text("轻声")] },
          text("，"),
          { t: "code", v: "pnpm test" },
        ],
      },
      { t: "p", c: [text("第二段")] },
    ]);
  });

  it("reads headings, lists with one level inside, quotes, rules and code blocks", () => {
    expect(parse("## 步骤\n1. 装好\n2. 跑起来\n   - 先 build\n\n> 注意\n\n---\n```ts\nconst a = 1;\n```")).toEqual([
      { t: "h", level: 1, c: [text("步骤")] },
      {
        t: "ol",
        start: 1,
        items: [
          { c: [text("装好")] },
          { c: [text("跑起来")], sub: { t: "ul", start: 1, items: [{ c: [text("先 build")] }] } },
        ],
      },
      { t: "quote", blocks: [{ t: "p", c: [text("注意")] }] },
      { t: "hr" },
      { t: "code", lang: "ts", text: "const a = 1;" },
    ]);
  });

  it("reads tables with their alignment", () => {
    expect(parse("| 名字 | 价格 |\n| :--- | ---: |\n| 咖啡 | 25 |")).toEqual([
      {
        t: "table",
        head: [[text("名字")], [text("价格")]],
        align: ["left", "right"],
        rows: [[[text("咖啡")], [text("25")]]],
      },
    ]);
  });

  it("links only http and https, and leaves HTML and other schemes as words", () => {
    expect(parse("看 [文档](https://example.com/a) 和 https://x.org/b。")).toEqual([
      {
        t: "p",
        c: [
          text("看 "),
          { t: "a", href: "https://example.com/a", c: [text("文档")] },
          text(" 和 "),
          { t: "a", href: "https://x.org/b", c: [text("https://x.org/b")] },
          text("。"),
        ],
      },
    ]);
    expect(parse("[点我](javascript:alert(1)) <img src=x onerror=alert(1)> ![图](data:image/png;base64,AA)")).toEqual([
      { t: "p", c: [text("[点我](javascript:alert(1)) <img src=x onerror=alert(1)> ![图](data:image/png;base64,AA)")] },
    ]);
  });

  it("turns a link on its own line, or a list of only links, into cards", () => {
    expect(parse("[macOS 27 新功能](https://www.sspai.com/post/1)")).toEqual([
      { t: "cards", links: [{ text: "macOS 27 新功能", href: "https://www.sspai.com/post/1", host: "sspai.com" }] },
    ]);
    expect(parse("- [甲](https://a.com/1)\n- [乙](https://b.com/2)")).toEqual([
      {
        t: "cards",
        links: [
          { text: "甲", href: "https://a.com/1", host: "a.com" },
          { text: "乙", href: "https://b.com/2", host: "b.com" },
        ],
      },
    ]);
  });
});
````

Also add to the CSP test in `test/console.test.ts` ("serves the page under a strict CSP…"): `expect((await fetch(\`http://127.0.0.1:${ui.port}/markdown.js\`)).headers.get("content-type")).toContain("javascript");`and`expect(html).toContain('<script src="/markdown.js"');`.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/markdown.test.ts test/console.test.ts`
Expected: FAIL (the file does not exist; `/markdown.js` is 404).

- [ ] **Step 3: The parser** — `src/node/console/assets/markdown.js`:

````js
// A small Markdown reader for moqi's answers. It returns plain data, which app.js turns into elements with
// textContent and checked links only: nothing in an answer can become HTML or load anything from outside.
(() => {
  const SAFE = /^https?:\/\//i;
  const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;
  const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const QUOTE = /^\s*>\s?(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
  const BARE = /^https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/i;
  const CODE = /^`([^`\n]+)`/;
  const LINK = /^!?\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/;
  const BOLD = /^(\*\*|__)(?=\S)([^\n]*?\S)\1/;
  const ITALIC = /^(\*|_)(?=\S)([^*_\n]*?\S)\1(?![*_])/;

  function inline(src) {
    const out = [];
    let buf = "";
    const flush = () => {
      if (buf) out.push({ t: "text", v: buf });
      buf = "";
    };
    let i = 0;
    while (i < src.length) {
      const rest = src.slice(i);
      const before = src[i - 1] ?? "";
      const code = CODE.exec(rest);
      if (code) {
        flush();
        out.push({ t: "code", v: code[1] });
        i += code[0].length;
        continue;
      }
      const link = LINK.exec(rest);
      if (link) {
        if (SAFE.test(link[2])) {
          flush();
          out.push({ t: "a", href: link[2], c: inline(link[1] || link[2]) });
        } else buf += link[0]; // another scheme stays words
        i += link[0].length;
        continue;
      }
      const bold = BOLD.exec(rest);
      if (bold) {
        flush();
        out.push({ t: "b", c: inline(bold[2]) });
        i += bold[0].length;
        continue;
      }
      const italic = ITALIC.exec(rest);
      if (italic && (italic[1] === "*" || !/\w/.test(before))) {
        flush();
        out.push({ t: "i", c: inline(italic[2]) });
        i += italic[0].length;
        continue;
      }
      const bare = /[\w/]/.test(before) ? null : BARE.exec(rest);
      if (bare) {
        const url = bare[0].replace(/[.,;:!?'"]+$/, "");
        flush();
        out.push({ t: "a", href: url, c: [{ t: "text", v: url }] });
        i += url.length;
        continue;
      }
      if (src[i] === "\n") {
        flush();
        out.push({ t: "br" });
      } else buf += src[i];
      i++;
    }
    flush();
    return out;
  }

  const plain = (nodes) => nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.c ? plain(n.c) : "")).join("");
  const hostOf = (href) => new URL(href).host.toLowerCase().replace(/^www\./, "");
  const soleLink = (c) =>
    c.length === 1 && c[0].t === "a" ? { text: plain(c[0].c), href: c[0].href, host: hostOf(c[0].href) } : undefined;
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((s) => s.trim());
  const isTable = (lines, i) => lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);
  const startsBlock = (lines, i) =>
    FENCE.test(lines[i]) ||
    HEADING.test(lines[i]) ||
    HR.test(lines[i]) ||
    ITEM.test(lines[i]) ||
    QUOTE.test(lines[i]) ||
    isTable(lines, i);

  function readList(lines, start) {
    const first = ITEM.exec(lines[start]);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const list = { t: ordered ? "ol" : "ul", start: ordered ? Number.parseInt(first[2], 10) : 1, items: [] };
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        const next = i + 1 < lines.length ? ITEM.exec(lines[i + 1]) : null;
        if (next && next[1].length === indent) {
          i++;
          continue;
        }
        break;
      }
      const m = ITEM.exec(line);
      const last = list.items[list.items.length - 1];
      if (m && m[1].length === indent) {
        list.items.push({ c: inline(m[3]) });
        i++;
      } else if (m && m[1].length > indent && last) {
        const [sub, next] = readList(lines, i);
        last.sub = sub;
        i = next;
      } else if (!m && /^\s+\S/.test(line) && last) {
        last.c = last.c.concat({ t: "br" }, inline(line.trim()));
        i++;
      } else break;
    }
    const links = list.items.map((it) => (it.sub ? undefined : soleLink(it.c)));
    if (links.length > 0 && links.every(Boolean)) return [{ t: "cards", links }, i];
    return [list, i];
  }

  function parse(text) {
    const lines = String(text ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && lines[i].trim() !== fence[1]) body.push(lines[i++]);
        i++; // the closing fence, when there is one
        blocks.push({ t: "code", lang: fence[2], text: body.join("\n") });
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        blocks.push({ t: "h", level: heading[1].length <= 2 ? 1 : 2, c: inline(heading[2]) });
        i++;
        continue;
      }
      if (HR.test(line)) {
        blocks.push({ t: "hr" });
        i++;
        continue;
      }
      if (isTable(lines, i)) {
        const head = cells(line).map(inline);
        const align = cells(lines[i + 1]).map((s) =>
          s.startsWith(":") && s.endsWith(":") ? "center" : s.endsWith(":") ? "right" : "left",
        );
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]).map(inline));
        blocks.push({ t: "table", head, align, rows });
        continue;
      }
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
        blocks.push({ t: "quote", blocks: parse(body.join("\n")) });
        continue;
      }
      if (ITEM.test(line)) {
        const [list, next] = readList(lines, i);
        blocks.push(list);
        i = next;
        continue;
      }
      const para = [lines[i++].trim()];
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++].trim());
      const c = inline(para.join("\n"));
      const card = soleLink(c);
      blocks.push(card ? { t: "cards", links: [card] } : { t: "p", c });
    }
    return blocks;
  }

  globalThis.moqiMarkdown = { parse };
})();
````

- [ ] **Step 4: Serve it and load it**

`server.ts` `ASSETS`: add `"/markdown.js": { file: "markdown.js", type: "text/javascript; charset=utf-8" },`. `index.html`: before `<script src="/app.js" defer></script>` add `<script src="/markdown.js" defer></script>`.

- [ ] **Step 5: Render it** — in `app.js` replace `renderAnswer`:

```js
/** moqi's answer, from Markdown data to elements; text goes in as text and only http(s) links become links. */
function renderAnswer(text) {
  const parse = globalThis.moqiMarkdown?.parse;
  const blocks = parse ? parse(text) : [{ t: "p", c: [{ t: "text", v: text }] }];
  return h("div", { class: "md" }, blocks.map(blockEl));
}

function inlineEl(n) {
  if (n.t === "text") return n.v;
  if (n.t === "br") return h("br");
  if (n.t === "code") return h("code", { text: n.v });
  if (n.t === "b") return h("strong", {}, n.c.map(inlineEl));
  if (n.t === "i") return h("em", {}, n.c.map(inlineEl));
  if (n.t === "a" && /^https?:\/\//i.test(n.href))
    return h("a", { href: n.href, target: "_blank", rel: "noopener noreferrer" }, n.c.map(inlineEl));
  return n.c ? n.c.map(inlineEl) : "";
}

function blockEl(b) {
  if (b.t === "p") return h("p", {}, b.c.map(inlineEl));
  if (b.t === "h") return h(b.level === 1 ? "h3" : "h4", { class: "md-h" }, b.c.map(inlineEl));
  if (b.t === "hr") return h("hr");
  if (b.t === "quote") return h("blockquote", {}, b.blocks.map(blockEl));
  if (b.t === "code") {
    const copy = h("button", { type: "button", class: "copy", text: "复制" });
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(b.text);
        toast("复制了");
      } catch {
        toast("复制不了，手动选中吧");
      }
    });
    return h("div", { class: "codeblock" }, copy, h("pre", {}, h("code", { text: b.text })));
  }
  if (b.t === "ul" || b.t === "ol")
    return h(
      b.t,
      b.t === "ol" && b.start !== 1 ? { start: String(b.start) } : {},
      b.items.map((it) => h("li", {}, it.c.map(inlineEl), it.sub ? blockEl(it.sub) : null)),
    );
  if (b.t === "table")
    return h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            b.head.map((c, i) => h("th", { class: `al-${b.align[i] || "left"}` }, c.map(inlineEl))),
          ),
        ),
        h(
          "tbody",
          {},
          b.rows.map((row) =>
            h(
              "tr",
              {},
              row.map((c, i) => h("td", { class: `al-${b.align[i] || "left"}` }, c.map(inlineEl))),
            ),
          ),
        ),
      ),
    );
  if (b.t === "cards")
    return h(
      "div",
      { class: "link-cards" },
      b.links
        .filter((l) => /^https?:\/\//i.test(l.href))
        .map((l) =>
          h(
            "a",
            { class: "link-card", href: l.href, target: "_blank", rel: "noopener noreferrer" },
            h("span", { class: "link-title", text: l.text }),
            h("span", { class: "link-host", text: l.host }),
          ),
        ),
    );
  return null;
}
```

- [ ] **Step 6: Styles** — append to `app.css`:

```css
/* moqi's formatted answers */

.md {
  line-height: 1.75;
}

.md > :first-child {
  margin-top: 0;
}

.md > :last-child {
  margin-bottom: 0;
}

.md p,
.md ul,
.md ol,
.md blockquote,
.md .codeblock,
.md .table-wrap,
.md .link-cards {
  margin: 0 0 12px;
}

.md ul,
.md ol {
  padding-left: 1.4em;
}

.md li > ul,
.md li > ol {
  margin: 4px 0 0;
}

.md .md-h {
  margin: 18px 0 8px;
  font-size: 17px;
  font-weight: 650;
}

.md h4.md-h {
  font-size: 16px;
}

.md code {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--bubble);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.88em;
}

.md hr {
  margin: 16px 0;
  border: 0;
  border-top: 1px solid var(--border);
}

.md blockquote {
  padding-left: 12px;
  border-left: 3px solid var(--border-strong);
  color: var(--muted);
}

.md a {
  color: var(--accent);
  text-underline-offset: 3px;
}

.codeblock {
  position: relative;
}

.codeblock pre {
  margin: 0;
  padding: 14px 16px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  line-height: 1.55;
}

.codeblock pre code {
  padding: 0;
  background: none;
}

.codeblock .copy {
  position: absolute;
  top: 6px;
  right: 6px;
  min-height: 32px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--muted);
  font-size: 12px;
}

.table-wrap {
  overflow-x: auto;
}

.md table {
  border-collapse: collapse;
  font-size: 15px;
}

.md th,
.md td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.md th {
  font-weight: 600;
}

.al-left {
  text-align: left;
}

.al-center {
  text-align: center;
}

.al-right {
  text-align: right;
}

.link-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.link-card {
  display: flex;
  flex-direction: column;
  max-width: 420px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  text-decoration: none;
  transition: border-color 150ms ease;
}

.link-card:hover {
  border-color: var(--accent);
}

.link-title {
  font-weight: 600;
  font-size: 14px;
}

.link-host {
  color: var(--faint);
  font-size: 12px;
}
```

- [ ] **Step 7: Tell the model** — in `src/core/agent.ts` `GUIDE`, before the last line add `- 回答可以用 Markdown：列表、加粗、行内代码和代码块、表格、链接；不要用 HTML。`

- [ ] **Step 8: Run the tests** — `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/markdown.test.ts test/console.test.ts test/agent.test.ts`. Expected: PASS.

- [ ] **Step 9: Look at it** — with the scratch console of Task 4, have the stub model answer with a heading, a list, inline code, a code block, a table and a standalone link; screenshot at 1280 and 375, light and dark. Check the table scrolls inside its box at 375 px and the copy button does not cover code on the first line.

- [ ] **Step 10: Commit**

```bash
pnpm format && pnpm check
git add src test
git commit -m "feat(console): formatted answers: lists, code, tables and link cards, with nothing raw from the model"
```

---

### Task 6: The "留白 · 纸感" style across the console

**Files:**

- Modify: `src/node/console/assets/app.css` (`:root` and the dark `:root`, `.top-inner`, `.page`, `.title`, `.card`, `.msg.moqi`, new `.hello` rules, reduced motion)
- Modify: `src/node/console/assets/app.js` (`renderChat` empty state; `greeting`, `EXAMPLES`)

**Interfaces:**

- Consumes: the markup from Tasks 4–5. Produces: nothing new for other tasks.

- [ ] **Step 1: Colours** — replace both `:root` blocks' colour variables with (keep `--radius*` and `--font` as they are; set `--radius: 14px`):

```css
:root {
  --bg: #f8f8f6;
  --surface: #ffffff;
  --text: #1f2328;
  --muted: #5f6670;
  --faint: #6b7075;
  --border: #e6e6e1;
  --border-strong: #dcdcd6;
  --bubble: #ecece8;
  --accent: #2f6f67;
  --accent-hover: #275c55;
  --accent-soft: #e8f1ef;
  --on-accent: #ffffff;
  --danger: #b42318;
  --danger-soft: #fdf0ee;
```

```css
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121414;
    --surface: #1a1d1e;
    --text: #e7e9ea;
    --muted: #9aa1a6;
    --faint: #8a9196;
    --border: #2a2f31;
    --border-strong: #3a4043;
    --bubble: #24292b;
    --accent: #6fb8ad;
    --accent-hover: #8acbc1;
    --accent-soft: #1c2b29;
    --on-accent: #0e1a18;
    --danger: #f28b82;
    --danger-soft: #2b1715;
  }
}
```

The danger pairs were checked too: `#b42318` on `#fdf0ee` and on white, `#f28b82` on `#2b1715` and on `#1a1d1e`, all above 4.5:1.

- [ ] **Step 2: Layout and type**

- `.top-inner` and `.page`: `max-width: 720px;`.
- `.title`: `font-size: 28px; font-weight: 700; letter-spacing: -0.01em;`.
- `.lead`: `font-size: 15px; line-height: 1.7;`.
- `.card`: `border-radius: var(--radius); padding: 16px 18px;`.
- `.msg.moqi`: add `font-size: 16px; line-height: 1.75;`.
- `.messages`: `gap: 20px;`.
- Append:

```css
.hello {
  margin: 12vh 0 32px;
  text-align: left;
}

.hello-title {
  display: block;
  margin-bottom: 8px;
  color: var(--text);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.hello p {
  margin: 0 0 20px;
  color: var(--muted);
}

.examples {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.example {
  min-height: 44px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  font-size: 14px;
  text-align: left;
  transition:
    border-color 150ms ease,
    background-color 150ms ease;
}

.example:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    /* biome-ignore lint/complexity/noImportantStyles: the user's own setting wins over every transition */
    transition: none !important;
    /* biome-ignore lint/complexity/noImportantStyles: the user's own setting wins over every animation */
    animation: none !important;
  }
}
```

- [ ] **Step 3: The empty conversation** — in `app.js`, add near `IDEA_LABEL`:

```js
const EXAMPLES = [
  "把下载文件夹里的 PDF 收进一个新文件夹",
  "打开 news.ycombinator.com，挑 5 条翻成中文",
  "明天上午十点提醒我交周报",
];

function greeting(now = new Date()) {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) return "早上好";
  if (hour >= 11 && hour < 13) return "中午好";
  if (hour >= 13 && hour < 18) return "下午好";
  return "晚上好";
}
```

and in `renderChat` replace the "跟 moqi 说说你自己" empty block with:

```js
list.append(
  h(
    "div",
    { class: "hello" },
    h("strong", { class: "hello-title", text: greeting() }),
    h("p", { text: "跟 moqi 说说你自己，或者让它替你做点事。" }),
    h(
      "div",
      { class: "examples" },
      EXAMPLES.map((text) =>
        h("button", {
          type: "button",
          class: "example",
          text,
          onclick: () => {
            input.value = text;
            autosize();
            input.focus();
          },
        }),
      ),
    ),
  ),
);
```

- [ ] **Step 4: Look at every page** — with the scratch console, screenshot 对话 (empty and with messages), 待办, 动态, 记忆, 设置 at 375, 768 and 1440 wide, light and dark. Check: no horizontal scroll (`document.documentElement.scrollWidth <= innerWidth` through CDP `Runtime.evaluate` on each), focus rings visible when tabbing (screenshot after two `Tab` key events), buttons at least 44 px high where they are tapped.

- [ ] **Step 5: Commit**

```bash
pnpm format && pnpm check
git add src/node/console/assets
git commit -m "style(console): 留白 · 纸感: warm paper, the teal kept, more room, a greeting with examples"
```

---

### Task 7: "看过的" in the feed

**Files:**

- Create: `src/core/feed.ts`
- Modify: `src/core/state.ts` (`OfferRecord.decidedAt`; `CodeTaskState.head`, `.into`; the `offer.feedback`, `code.finished`, `code.merged` cases)
- Modify: `src/core/types.ts` (`code.finished.head`, `code.merged.into`)
- Modify: `src/core/code.ts` (`CodeResult.head`; `CodeRunner.diff(task, head?)`; `code_merge` records `into`)
- Modify: `src/core/moqi.ts` (`codeFinished` passes `head`)
- Modify: `src/core/index.ts` (export `./feed.js`)
- Modify: `src/node/code.ts` (`commit` returns `head`; `diff`)
- Modify: `src/node/console/server.ts` (`/api/state` `history`, thoughts `offerId`; `/api/code/diff`)
- Modify: `src/node/console/assets/{index.html,app.js,app.css}`
- Test: `test/feed.test.ts`, `test/code.test.ts`, `test/code-runner.test.ts`, `test/console.test.ts`

**Interfaces:**

- Produces: `FEED = { historyDays: 30, historyMax: 100 }`; `interface Seen { record: OfferRecord; decidedAt: number; outcome: string; task?: CodeTaskState }`; `seenOffers(state: State, now: number): Seen[]`; `CodeResult.head?: string`; `CodeRunner.diff(task: CodeTask, head?: string): Promise<string>`; `/api/state` `history: { id, kind, title, body, links, at, decidedAt, outcome, taskId?, stat?, canDiff? }[]` and `thoughts[].ideas[].offerId: string | null`.

- [ ] **Step 1: Write the failing tests**

`test/feed.test.ts`:

```ts
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
```

`test/code.test.ts`: in "tells the user once when it is done…", finish with `moqi.codeFinished(id, { ...done, head: "def456" })` (both calls), and after the merge add:

```ts
expect(moqi.state.codeTasks.get(id)).toMatchObject({ status: "merged", head: "def456", into: "main" });
expect(seenOffers(moqi.state, clock.now()).at(0)?.outcome).toBe("已合并到 main");
```

(add `clock` to that test's `harness(…)` destructuring, and `import { seenOffers } from "../src/core/feed.js";` at the top.)

In "discards a task, and says so when there was nothing to merge", add `clock` to the destructuring and, after the discard, record the verdict the console's discard button records, then check:

```ts
await moqi.feedback(delivered.at(-1)?.offer.id ?? "", "dismissed");
expect(seenOffers(moqi.state, clock.now()).at(0)?.outcome).toBe("已丢弃");
```

`test/code-runner.test.ts`, in "runs Kiro in a worktree…", after the merge:

```ts
const head = s.finished[0]?.result.head;
expect(head).toMatch(/^[0-9a-f]{40}$/);
expect(await s.runner.diff(task, head)).toContain("+hello"); // the branch is gone, the commit is not
```

`test/console.test.ts`, in the coding-agents test after the discard: `expect((await api("GET", \`/api/code/diff?id=${task?.id}\`)).status).toBe(409);` and

```ts
expect(after.history.find((o: { kind: string }) => o.kind === "code.done")).toMatchObject({
  outcome: "已丢弃",
  taskId: task?.id,
  canDiff: false,
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm build && TZ=Asia/Shanghai pnpm exec vitest run test/feed.test.ts test/code.test.ts test/code-runner.test.ts test/console.test.ts`
Expected: FAIL (no `feed.js`, no `head`/`into`, no `history`).

- [ ] **Step 3: Record when and how**

`src/core/types.ts`: `code.finished` gains `head?: string;` and `| { type: "code.merged"; taskId: string; into?: string }`.

`src/core/state.ts`: `OfferRecord` gains `/** When the user reacted. */ decidedAt?: number;`; in `offer.feedback` after `r.verdict = e.verdict;` add `r.decidedAt = e.at;`. `CodeTaskState` gains `readonly head?: string;` (`/** The commit moqi made, when there were changes. */`) and `readonly into?: string;` (`/** The branch it was merged into. */`). In `code.finished` add `...(e.head && { head: e.head }),`; split `code.merged` from `code.discarded`:

```ts
      case "code.merged": {
        const t = this.codeTasks.get(e.taskId);
        if (t) this.codeTasks.set(e.taskId, { ...t, status: "merged", ...(e.into && { into: e.into }) });
        break;
      }
      case "code.discarded": {
        const t = this.codeTasks.get(e.taskId);
        if (t) this.codeTasks.set(e.taskId, { ...t, status: "discarded" });
        break;
      }
```

`src/core/code.ts`: `CodeResult` gains `readonly head?: string;`; `CodeRunner.diff` becomes `diff(task: CodeTask, head?: string): Promise<string>;` with the doc `/** The changes from where the task started to its branch, or to \`head\` once the branch is gone. */`; in `code_merge`'s `run`:

```ts
        const into = runner.currentBranch(t.task.project);
        const said = await runner.merge(t.task);
        k.emit({ type: "code.merged", taskId: id, into });
        return said;
```

`src/core/moqi.ts` `codeFinished`: add `...(result.head && { head: result.head }),` to the emitted event.

`src/node/code.ts`: `commit` returns `Promise<{ files: string[]; stat: string; head?: string }>` and ends with:

```ts
  const head = files.length > 0 ? (await git(["rev-parse", "HEAD"], task.dir)).trim() : "";
  return { files, stat, ...(head && { head }) };
```

and `diff` takes the head: `diff: async (task, head) => { const diff = await git(["diff", \`${task.base}..${head ?? task.branch}\`], task.project); … }`. Update the fake runner in `test/code.test.ts` (`diff: async () => …` already ignores arguments).

- [ ] **Step 4: The history** — `src/core/feed.ts`:

```ts
// What the user has already seen in the feed: cards they reacted to or let expire, kept with their links.
import type { CodeTaskState, OfferRecord, State } from "./state.js";

export const FEED = { historyDays: 30, historyMax: 100 } as const;

export interface Seen {
  readonly record: OfferRecord;
  readonly decidedAt: number;
  /** What became of it, in the user's words. */
  readonly outcome: string;
  readonly task?: CodeTaskState;
}

/** Cards shown and done with (a reaction, or expired) in the last 30 days, the latest first, at most 100. */
export function seenOffers(state: State, now: number): Seen[] {
  const since = now - FEED.historyDays * 86_400_000;
  return [...state.offers.values()]
    .filter((r) => r.surface !== undefined && r.offer.createdAt >= since)
    .flatMap((r) => {
      const expired = r.offer.expiresAt !== undefined && r.offer.expiresAt <= now;
      if (!r.verdict && !expired) return [];
      const about = r.offer.kind === "code.done" && r.offer.about ? state.codeTasks.get(r.offer.about) : undefined;
      return [
        {
          record: r,
          decidedAt: r.decidedAt ?? r.offer.expiresAt ?? r.offer.createdAt,
          outcome: outcomeOf(r, about),
          ...(about && { task: about }),
        },
      ];
    })
    .sort((a, b) => b.decidedAt - a.decidedAt)
    .slice(0, FEED.historyMax);
}

function outcomeOf(r: OfferRecord, task: CodeTaskState | undefined): string {
  if (task?.status === "merged") return `已合并到 ${task.into ?? "当前分支"}`;
  if (task?.status === "discarded") return "已丢弃";
  const o = r.offer;
  if (r.verdict === "accepted")
    return o.kind === "todo.remind" ? "完成了" : o.answer === "text" ? "回答了" : o.action ? "好" : "有用";
  if (r.verdict === "dismissed")
    return o.kind === "todo.remind" ? "还没做" : o.answer === "text" ? "不想说" : "你说不用";
  if (r.verdict === "ignored") return "你没理";
  if (r.verdict === "muted") return "你关掉了这类";
  return "没理会，过期了";
}
```

Add `export * from "./feed.js";` to `src/core/index.ts`. If `CodeTaskState` is not exported from `state.ts`, export it.

- [ ] **Step 5: The console data** — `src/node/console/server.ts`: import `seenOffers` from `../../core/feed.js`. In `/api/state` add:

```ts
const history = seenOffers(moqi.state, now).map((s) => ({
  id: s.record.offer.id,
  kind: s.record.offer.kind,
  title: s.record.offer.title,
  body: s.record.offer.body,
  links: s.record.offer.links ?? [],
  at: s.record.offer.createdAt,
  decidedAt: s.decidedAt,
  outcome: s.outcome,
  ...(s.task && {
    taskId: s.task.task.id,
    stat: s.task.stat ?? "",
    canDiff: s.task.status === "merged" && s.task.head !== undefined,
  }),
}));
```

return it (`history,` next to `offers`), and give each thought idea `offerId: idea.offerId ?? null,`. `/api/code/diff` becomes:

```ts
    "GET /api/code/diff": async (_body, url) => {
      const t = home.moqi.state.codeTasks.get(url.searchParams.get("id") ?? "");
      if (!t) throw new HttpError(404, "没有这个任务");
      if (t.status === "discarded") throw new HttpError(409, "这个任务丢弃了，改动没有留下");
      if (t.status === "merged" && !t.head) throw new HttpError(409, "这个任务合并前没记下提交，看不了改动");
      return { diff: await home.code.diff(t.task, t.status === "merged" ? t.head : undefined) };
    },
```

- [ ] **Step 6: The page**

`index.html`, after `<div class="list" id="offers"></div>`:

```html
        <div class="section-head" id="history-head" hidden>
          <h2 class="subtitle">看过的</h2>
          <span class="hint" id="history-count"></span>
        </div>
        <div class="list" id="history"></div>
        <button type="button" class="btn ghost more" id="history-more" hidden>再看 20 条</button>
```

`app.js`: add `check: "M5 12l5 5L19 7",` to `ICONS`; globals `let historyKey = ""; let historyShown = 10;`; a helper `const hostOf = (url) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; } };`. Pull the code card's `look` function out into a shared helper and use it there:

```js
/** Shows or hides a coding task's changes under its card. */
function diffToggle(taskId, changes) {
  return async (e) => {
    const button = e.currentTarget;
    if (!changes.hidden) {
      changes.hidden = true;
      button.textContent = "看改动";
      return;
    }
    button.disabled = true;
    try {
      const { diff } = await api("GET", `/api/code/diff?id=${encodeURIComponent(taskId)}`);
      changes.textContent = diff || "（没有改动）";
      changes.hidden = false;
      button.textContent = "收起改动";
    } catch (error) {
      toast(error.message);
    }
    button.disabled = false;
  };
}

function seenCard(o) {
  const links = o.links.filter((l) => /^https?:\/\//i.test(l.url));
  const changes = h("pre", { class: "ask-details", hidden: true });
  const good = /^(已合并|好|有用|完成了|回答了)/.test(o.outcome);
  return h(
    "article",
    { class: "card seen", id: `offer-${o.id}` },
    h(
      "div",
      { class: "card-head" },
      h("h3", { class: "card-title", text: o.title }),
      h("span", { class: "card-time", "data-at": String(o.at), text: when(o.at) }),
    ),
    o.body ? h("p", { class: "card-body", text: o.body }) : null,
    links.length
      ? h(
          "div",
          { class: "link-cards" },
          links.map((l) =>
            h(
              "a",
              { class: "link-card", href: l.url, target: "_blank", rel: "noopener noreferrer" },
              h("span", { class: "link-title", text: l.title }),
              h("span", { class: "link-host", text: hostOf(l.url) }),
            ),
          ),
        )
      : null,
    changes,
    h(
      "div",
      { class: "actions" },
      h(
        "span",
        { class: `outcome${good ? " good" : ""}` },
        good ? icon("check") : null,
        `${o.outcome} · `,
        timeOf(o.decidedAt),
      ),
      h("span", { class: "spacer" }),
      o.canDiff
        ? h("button", { type: "button", class: "btn", text: "看改动", onclick: diffToggle(o.taskId, changes) })
        : null,
    ),
  );
}

function renderHistory() {
  const items = state.history || [];
  $("history-head").hidden = items.length === 0;
  $("history-count").textContent = `最近 30 天 · ${items.length} 条`;
  const key = JSON.stringify([items, historyShown]);
  if (key !== historyKey) {
    historyKey = key;
    $("history").replaceChildren(...items.slice(0, historyShown).map(seenCard));
  }
  $("history-more").hidden = items.length <= historyShown;
  refreshTimes($("history"));
}
$("history-more").addEventListener("click", () => {
  historyShown += 20;
  renderHistory();
});

/** Scrolls to the card an idea became, opening more of "看过的" when it is further down. */
function jumpTo(offerId) {
  const index = (state.history || []).findIndex((o) => o.id === offerId);
  if (index >= historyShown) {
    historyShown = index + 1;
    renderHistory();
  }
  const card = document.getElementById(`offer-${offerId}`);
  if (!card) return;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  card.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "center" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 2000);
}
```

In `renderFeed`: give open cards the same id (`const card = offerCard(o); card.id = \`offer-${o.id}\`; list.append(card);`) and call `renderHistory();`before`renderThoughts();`. In the code card, replace the local `look`with`diffToggle(o.taskId, changes)`. In `renderThoughts`, make the key `JSON.stringify([state.thoughts, state.offers.map((o) => o.id), (state.history || []).map((o) => o.id)])`, and render an idea's title as

```js
const known =
  idea.offerId &&
  (state.offers.some((o) => o.id === idea.offerId) || (state.history || []).some((o) => o.id === idea.offerId));
const title = known
  ? h("button", { type: "button", class: "linkish", text: idea.title, onclick: () => jumpTo(idea.offerId) })
  : idea.title;
```

`app.css`:

```css
.card.seen {
  border-style: dashed;
  background: transparent;
}

.outcome {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 13px;
}

.outcome.good {
  color: var(--accent);
}

.outcome svg {
  width: 14px;
  height: 14px;
  stroke-width: 2.4;
}

.card.flash {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.linkish {
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
  text-decoration: underline;
  text-decoration-color: var(--border-strong);
  text-underline-offset: 3px;
}

.linkish:hover {
  text-decoration-color: var(--accent);
}

.more {
  align-self: center;
  margin-top: 8px;
}
```

- [ ] **Step 7: Run the tests** — same command as Step 2. Expected: PASS.

- [ ] **Step 8: Look at it** — in the scratch console, create a few offers (one with links, one coding task merged through a fake runner is not needed: a dismissed news card and an accepted plain card are enough), react to them, and screenshot 动态 at 375 and 1280, light and dark; click an idea title in "moqi 在想" through CDP and screenshot the highlighted card.

- [ ] **Step 9: Commit**

```bash
pnpm format && pnpm check
git add src test
git commit -m "feat(feed): cards you handled stay in 看过的 with their links, and ideas lead to their cards"
```

---

### Task 8: Real test, docs and the console screenshot

**Files:**

- Modify: `README.md`, `README.zh-CN.md`, `docs/design.md`, `CHANGELOG.md`
- Replace: `docs/console.png`

- [ ] **Step 1: Real test with a model that can see**

Ask the user to switch the model to one that reads images (DeepSeek `deepseek-flash`, or another vision model) in Settings, or, if they prefer not to, run the check from a scratch home with their key passed through `MOQI_BASE_URL`/`MOQI_MODEL`/`MOQI_API_KEY` in the environment (never written to a file or a log). In the console, paste a screenshot with visible text and ask "图里写了什么？"; confirm the answer quotes the text. Then point the scratch home at a text-only model and confirm the image button turns grey with the hint. Write down what was tried and what happened for the report; do not store any key.

- [ ] **Step 2: Docs**

- README (both languages): in the console section, say the conversation takes images (paste, drop or pick; up to 4; the model must be able to see, checked once), answers are formatted (lists, code, tables, link cards), images tools bring back (browser screenshots, macOS screenshots, MCP images) show under the answer, and handled feed cards stay in "看过的" for 30 days with their links.
- `docs/design.md`: a short section on media: files under `<home>/media`, ids in events, 3 MB, the four types by header, the last 3 user messages with images go to the model, tool images are for the user only, the vision check and where it is kept.
- `CHANGELOG.md` under `## [Unreleased]`:

```markdown
- Images in the conversation: paste, drop or pick up to 4 images; moqi checks once whether the model can see them (it shows the model a red square) and greys out the button when it cannot. Images stay under `~/.moqi/media` and go only to your model; the last three messages with images keep them. Answers are formatted: lists, bold, code with a copy button, tables and link cards, with no HTML and nothing loaded from outside. Images that tools bring back (browser and macOS screenshots, MCP servers) show under the answer and can be opened large.
- Console style: warm paper colours, the teal kept, more room, a greeting with three examples to start from.
- Feed: cards you handled stay in "看过的" for 30 days (at most 100) with their links and what became of them; a merged coding task can still show its changes; ideas in "moqi 在想" lead to their cards.
```

- [ ] **Step 3: New screenshot** — with the scratch console (a short conversation with one image and a formatted answer), take `docs/console.png` at 1440×960, light, the same framing as the current one.

- [ ] **Step 4: Format, check, commit**

```bash
pnpm exec biome check --write README.md README.zh-CN.md docs/design.md CHANGELOG.md
pnpm check
git add README.md README.zh-CN.md docs/design.md CHANGELOG.md docs/console.png
git commit -m "docs: images in the conversation, formatted answers, the new look, 看过的"
```
