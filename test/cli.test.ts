import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readConsoleInfo } from "../src/node/console/info.js";
import { lockHolder } from "../src/node/file-store.js";

const cli = join(import.meta.dirname, "..", "dist", "node", "cli.js");
const run = (home: string, args: string[], input = "") =>
  spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, MOQI_HOME: home, MOQI_BASE_URL: "", MOQI_MODEL: "", MOQI_NO_OPEN: "1" },
    timeout: 20_000,
  });

describe("moqi command", () => {
  it("prints its version and help", () => {
    const home = mkdtempSync(join(tmpdir(), "moqi-cli-"));
    expect(run(home, ["--version"]).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(run(home, ["--help"]).stdout).toContain("moqi daemon");
  });

  it("writes a config template once", () => {
    const home = mkdtempSync(join(tmpdir(), "moqi-cli-"));
    expect(run(home, ["init"]).stdout).toContain("config.json");
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toHaveProperty("model.baseURL");
    expect(run(home, ["init"]).status).toBe(1);
  });

  it("prints a briefing without any model", () => {
    const home = mkdtempSync(join(tmpdir(), "moqi-cli-"));
    const out = run(home, ["brief"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/今天的简报 · \d+月\d+日/);
  });

  it("runs commands interactively and explains that chat needs a model", () => {
    const home = mkdtempSync(join(tmpdir(), "moqi-cli-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ briefingAt: null }));
    const out = run(home, ["chat"], "/memory\n/watches\n你好\n/quit\n");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("还不了解你");
    expect(out.stdout).toContain("没有托管的事");
    expect(out.stdout).toContain("还没配置模型");
    expect(existsSync(join(home, "moqi.lock"))).toBe(false); // released on exit
  });

  it("starts on a fresh machine where ~/.moqi does not exist yet", () => {
    const home = join(mkdtempSync(join(tmpdir(), "moqi-cli-")), "fresh", ".moqi");
    try {
      const started = run(home, []);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toContain("控制台：http://127.0.0.1:");
    } finally {
      run(home, ["stop"]);
    }
  });

  it("runs in the background with a console, answers briefings through it, and stops", async () => {
    const home = mkdtempSync(join(tmpdir(), "moqi-cli-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ briefingAt: null }));
    try {
      const started = run(home, []);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toMatch(/控制台：http:\/\/127\.0\.0\.1:\d+\/#t=[\w-]{32}/);
      const pid = lockHolder(home);
      expect(pid).toBeGreaterThan(0);
      const info = readConsoleInfo(home);
      expect(info.pid).toBe(pid);

      // A second "moqi" reuses the running one.
      const again = run(home, []);
      expect(again.stdout).not.toContain("后台运行了");
      expect(again.stdout).toContain(`#t=${info.token}`);

      const res = await fetch(`http://127.0.0.1:${info.port}/api/state`, {
        headers: { "x-moqi-token": info.token ?? "" },
      });
      expect(res.status).toBe(200);

      expect(run(home, ["brief"]).stdout).toMatch(/今天的简报 · \d+月\d+日/);
      const chat = run(home, ["chat"], "/quit\n");
      expect(chat.status).toBe(1);
      expect(chat.stderr).toContain("请在控制台里对话");

      expect(run(home, ["stop"]).stdout).toContain("已停止");
      expect(lockHolder(home)).toBeUndefined();
      expect(run(home, ["stop"]).stdout).toContain("没在运行");
    } finally {
      const pid = lockHolder(home);
      if (pid) process.kill(pid, "SIGTERM");
    }
  });
});
