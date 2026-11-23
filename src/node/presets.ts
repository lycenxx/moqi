// Ready-made abilities the user turns on with one tap. The browser is Playwright's MCP server, pinned to a
// version so its tools do not change under the user, with a profile of its own: what moqi browses never
// sees the user's everyday Chrome, its logins or its history.
import { dirname, join } from "node:path";
import type { SiteRole } from "../core/sites.js";
import type { McpServerConfig } from "./mcp-client.js";

export const PLAYWRIGHT_MCP = "@playwright/mcp@0.0.86";

export function browserPreset(
  home: string,
  execPath: string = process.execPath,
): { command: string; args: string[]; cwd: string } {
  const dir = join(home, "browser");
  return {
    command: join(dirname(execPath), "npx"),
    args: ["-y", PLAYWRIGHT_MCP, "--user-data-dir", join(dir, "profile"), "--output-dir", join(dir, "output")],
    cwd: dir,
  };
}

/**
 * How Playwright's write tools are granted. "goto" opens an address; "within" moves around a site already
 * granted. Tools that send what the model wrote (typing, forms, uploads, scripts) are left out on purpose,
 * so they stay dangerous and are asked every time, as is any tool this list does not know.
 */
export const PLAYWRIGHT_SITES: Readonly<Record<string, SiteRole>> = {
  browser_navigate: "goto",
  browser_tabs: "goto", // "within" when it has no url
  browser_click: "within",
  browser_hover: "within",
  browser_navigate_back: "within",
  browser_wait_for: "within",
  browser_resize: "within",
  browser_close: "within",
  browser_drag: "within",
  browser_emulate_media: "within",
};

/** The grant roles for a server's tools, when it is Playwright's MCP server. */
export function sitesFor(config: McpServerConfig): Readonly<Record<string, SiteRole>> | undefined {
  return [config.command, ...(config.args ?? [])].some((a) => a.includes("@playwright/mcp"))
    ? PLAYWRIGHT_SITES
    : undefined;
}
