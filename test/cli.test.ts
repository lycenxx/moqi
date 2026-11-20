import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cli = join(import.meta.dirname, "..", "dist", "node", "cli.js");
const run = (home: string, args: string[], input = "") =>
  spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, MOQI_HOME: home, MOQI_BASE_URL: "", MOQI_MODEL: "" },
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
    const out = run(home, [], "/memory\n/watches\n你好\n/quit\n");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("还不了解你");
    expect(out.stdout).toContain("没有托管的事");
    expect(out.stdout).toContain("还没配置模型");
    expect(existsSync(join(home, "moqi.lock"))).toBe(false); // released on exit
  });
});
