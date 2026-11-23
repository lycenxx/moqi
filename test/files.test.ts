import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesPlugin } from "../src/node/files.js";
import { harness } from "./helpers.js";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "moqi-files-"));
  const downloads = join(base, "Downloads");
  const desktop = join(base, "Desktop");
  const outside = join(base, "Secret");
  for (const d of [downloads, desktop, outside]) mkdirSync(d);
  writeFileSync(join(downloads, "a.pdf"), "%PDF\0binary");
  writeFileSync(join(downloads, "notes.txt"), "周会纪要");
  writeFileSync(join(downloads, ".hidden"), "x");
  writeFileSync(join(outside, "key.txt"), "secret");
  symlinkSync(outside, join(downloads, "link"));
  const trashed: string[] = [];
  const h = harness({
    plugins: [filesPlugin({ folders: [downloads, desktop], trash: async (p) => void trashed.push(p) })],
  });
  const run = (tool: string, args: Record<string, unknown>) => h.moqi.callTool(tool, args, { byUser: true });
  return { ...h, downloads, desktop, outside, trashed, run };
}

describe("files", () => {
  it("lists and reads inside the allowed folders, skipping hidden files and binaries", async () => {
    const f = setup();
    const list = await f.run("files_list", { folder: f.downloads });
    expect(list).toContain("a.pdf");
    expect(list).toContain("notes.txt");
    expect(list).not.toContain(".hidden");
    expect(await f.run("files_read", { path: join(f.downloads, "notes.txt") })).toBe("周会纪要");
    expect(await f.run("files_read", { path: join(f.downloads, "a.pdf") })).toMatch(/不是文本文件/);
    expect(f.asked).toEqual([]);
  });

  it("refuses paths outside the folders, also through a symlink, and relative paths", async () => {
    const f = setup();
    expect(await f.run("files_read", { path: join(f.outside, "key.txt") })).toMatch(/^参数不对：.*不在允许的文件夹里/);
    expect(await f.run("files_read", { path: join(f.downloads, "link", "key.txt") })).toMatch(/不在允许的文件夹里/);
    expect(await f.run("files_read", { path: "notes.txt" })).toBe("参数不对：路径要以 / 或 ~/ 开头");
    expect(await f.run("files_write_new", { path: join(f.downloads, "link", "x.txt"), content: "x" })).toMatch(
      /不在允许的文件夹里/,
    );
    expect(existsSync(join(f.outside, "x.txt"))).toBe(false);
  });

  it("creates without overwriting, moves, renames, and asks every time before the Trash", async () => {
    const f = setup();
    expect(await f.run("files_mkdir", { path: join(f.downloads, "发票") })).toMatch(/^新建了文件夹/);
    expect(await f.run("files_write_new", { path: join(f.downloads, "notes.txt"), content: "覆盖" })).toMatch(
      /已经有同名的.*不会覆盖/,
    );
    expect(readFileSync(join(f.downloads, "notes.txt"), "utf8")).toBe("周会纪要");
    expect(await f.run("files_write_new", { path: join(f.desktop, "价格.md"), content: "# 耳机" })).toMatch(/^新建了/);
    expect(await f.run("files_move", { from: join(f.downloads, "a.pdf"), to: join(f.downloads, "发票") })).toMatch(
      /移到 .*发票\/a\.pdf/,
    );
    expect(existsSync(join(f.downloads, "发票", "a.pdf"))).toBe(true);
    expect(await f.run("files_rename", { path: join(f.downloads, "发票", "a.pdf"), name: "11月发票.pdf" })).toMatch(
      /改名为 11月发票\.pdf/,
    );
    expect(await f.run("files_rename", { path: join(f.downloads, "notes.txt"), name: "../x" })).toMatch(
      /不能用作文件名/,
    );
    expect(await f.run("files_trash", { path: join(f.desktop, "价格.md") })).toMatch(/移到废纸篓/);
    expect(f.trashed).toEqual([realpathSync(join(f.desktop, "价格.md"))]);
    expect(f.asked.at(-1)).toMatch(/^要我把 .*价格\.md 移到废纸篓吗？$/);
    expect(f.details.at(-1)).toMatch(/^这是会改动东西的动作，每次都要你确认。/);
  });

  it("names the real place behind a symlink when it asks", async () => {
    const f = setup();
    mkdirSync(join(f.desktop, "重要资料"));
    symlinkSync(join(f.desktop, "重要资料"), join(f.downloads, "a-link"));
    await f.run("files_trash", { path: join(f.downloads, "a-link") });
    expect(f.asked.at(-1)).toMatch(/a-link（链接，实际是 .*重要资料）/);
  });

  it("keeps the allowed folders themselves in place, and only listing runs on a schedule", async () => {
    const f = setup();
    expect(await f.run("files_trash", { path: f.downloads })).toMatch(/允许的文件夹本身/);
    expect(await f.run("files_move", { from: f.desktop, to: join(f.downloads, "x") })).toMatch(/允许的文件夹本身/);
    expect(f.trashed).toEqual([]);
    expect(f.moqi.watchableTools().map((t) => t.name)).toEqual(expect.arrayContaining(["files_list", "files_read"]));
    expect(f.moqi.dangerousTools().map((t) => t.name)).toEqual(["files_trash"]);
  });
});
