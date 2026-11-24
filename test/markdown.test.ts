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
