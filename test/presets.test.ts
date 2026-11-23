import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserPreset, PLAYWRIGHT_MCP, PLAYWRIGHT_SITES, sitesFor } from "../src/node/presets.js";

describe("the browser preset", () => {
  it("runs a pinned Playwright MCP with its own profile under moqi's home", () => {
    const p = browserPreset("/Users/me/.moqi", "/opt/node/bin/node");
    expect(p).toEqual({
      command: "/opt/node/bin/npx",
      args: [
        "-y",
        PLAYWRIGHT_MCP,
        "--user-data-dir",
        join("/Users/me/.moqi", "browser", "profile"),
        "--output-dir",
        join("/Users/me/.moqi", "browser", "output"),
      ],
      cwd: join("/Users/me/.moqi", "browser"),
    });
    expect(PLAYWRIGHT_MCP).toBe("@playwright/mcp@0.0.86");
  });

  it("sorts Playwright's tools only for a Playwright server, and leaves sending tools unsorted", () => {
    expect(sitesFor({ command: "npx", args: ["-y", "@playwright/mcp@0.0.86"] })).toBe(PLAYWRIGHT_SITES);
    expect(sitesFor({ command: "npx", args: ["-y", "some-other-mcp"] })).toBeUndefined();
    expect(PLAYWRIGHT_SITES).toMatchObject({ browser_navigate: "goto", browser_tabs: "goto", browser_click: "within" });
    for (const sending of [
      "browser_type",
      "browser_fill_form",
      "browser_select_option",
      "browser_press_key",
      "browser_file_upload",
      "browser_evaluate",
    ])
      expect(PLAYWRIGHT_SITES[sending]).toBeUndefined();
  });
});
