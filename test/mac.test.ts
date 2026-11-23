import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Exec, listShortcuts, macPlugin, runCommand, shortcutName } from "../src/node/mac.js";
import { harness } from "./helpers.js";

function fake() {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args: [...args], ...(options?.input !== undefined && { input: options.input }) });
    if (file === "pbpaste") return "剪贴板内容";
    if (file === "shortcuts" && args[0] === "list") return "早上模式\n给老板发消息\n";
    if (file === "shortcuts" && args[0] === "run") {
      if (args[1] === "卡住") throw new Error("超过 60 秒没完成");
      const i = args.indexOf("--input-path");
      const got = i >= 0 ? readFileSync(args[i + 1] as string, "utf8") : "";
      writeFileSync(args[args.indexOf("--output-path") + 1] as string, `收到：${got}`);
    }
    return "";
  };
  return { calls, exec };
}

describe("macOS", () => {
  it("runs fixed actions with their arguments as data, at once", async () => {
    const f = fake();
    const plugin = macPlugin({
      shortcuts: [],
      exec: f.exec,
      desktop: "/Users/me/Desktop",
      now: () => Date.parse("2026-11-23T09:05:07+08:00"),
    });
    const { moqi, asked } = harness({ plugins: [plugin] });
    const run = (tool: string, args: Record<string, unknown>) => moqi.callTool(tool, args, { byUser: true });
    expect(await run("mac_open_app", { name: "日历" })).toBe("打开了 日历");
    expect(await run("mac_open_app", { name: "/System/Applications/Calendar.app" })).toMatch(/^参数不对/);
    expect(await run("mac_screenshot", {})).toBe("截好了：/Users/me/Desktop/moqi-截图-20261123-090507.png");
    expect(await run("mac_volume", { level: 30 })).toBe("音量调到 30");
    expect(await run("mac_volume", { muted: true })).toBe("已静音");
    expect(await run("mac_volume", {})).toMatch(/^参数不对/);
    expect(await run("mac_volume", { level: 300 })).toMatch(/^参数不对/);
    expect(f.calls.map((c) => [c.file, ...c.args])).toEqual([
      ["open", "-a", "日历"],
      ["screencapture", "-x", "/Users/me/Desktop/moqi-截图-20261123-090507.png"],
      [
        "osascript",
        "-e",
        "on run argv",
        "-e",
        "set volume output volume (item 1 of argv as integer)",
        "-e",
        "end run",
        "--",
        "30",
      ],
      ["osascript", "-e", "set volume output muted true"],
    ]);
    expect(asked).toEqual([]);
  });

  it("asks before reading the clipboard, never reads it on a schedule, and writes it through stdin", async () => {
    const f = fake();
    const { moqi, asked } = harness({ plugins: [macPlugin({ shortcuts: [], exec: f.exec })] });
    expect(await moqi.callTool("mac_clipboard_read", {}, { byUser: true })).toBe("剪贴板内容");
    expect(asked).toEqual(["要我读剪贴板里的文字吗？"]);
    expect(await moqi.callTool("mac_clipboard_write", { text: "收款地址" }, { byUser: true })).toBe(
      "复制到剪贴板了（4 字）",
    );
    expect(asked).toHaveLength(2);
    expect(f.calls.at(-1)).toEqual({ file: "pbcopy", args: [], input: "收款地址" });
    expect(moqi.watchableTools().map((t) => t.name)).not.toContain("mac_clipboard_read");
  });

  it("turns only the picked shortcuts into dangerous tools with stable names", async () => {
    const f = fake();
    const { moqi, asked } = harness({ plugins: [macPlugin({ shortcuts: ["早上模式", "卡住"], exec: f.exec })] });
    const name = shortcutName("早上模式");
    expect(name).toMatch(/^shortcut_[0-9a-f]{8}$/);
    expect(shortcutName("早上模式")).toBe(name);
    expect(moqi.tool(name)).toMatchObject({ danger: true, source: "快捷指令" });
    expect(moqi.tool(name)?.description).toContain("「早上模式」");
    expect(moqi.tool(shortcutName("给老板发消息"))).toBeUndefined();
    expect(await moqi.callTool(name, { input: "今天要早起" }, { byUser: true })).toBe("收到：今天要早起");
    expect(asked).toEqual(["要我运行快捷指令「早上模式」吗？"]);
    expect(f.calls.find((c) => c.file === "shortcuts")?.args.slice(0, 3)).toEqual(["run", "早上模式", "--input-path"]);
    expect(await moqi.callTool(shortcutName("卡住"), {}, { byUser: true })).toBe(
      "出错了：快捷指令「卡住」没跑完：超过 60 秒没完成",
    );
    expect(await listShortcuts(f.exec, "darwin")).toEqual(["早上模式", "给老板发消息"]);
    expect(await listShortcuts(f.exec, "linux")).toBeUndefined();
  });

  it("survives a command that exits without reading its input", async () => {
    expect(await runCommand(process.execPath, ["-e", "process.exit(0)"], { input: "x".repeat(4_000_000) })).toBe("");
  });
});
