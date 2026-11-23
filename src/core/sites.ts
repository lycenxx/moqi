// Site grants for web tools. Within one conversation turn, opening a site is asked once; after that,
// browsing and clicking there runs without asking, as long as the page is still on a granted site. What the
// model writes itself (text it types, addresses it makes up) is what could carry the user's words away, so
// typing is always asked and a new site is asked.

export type SiteRole = "goto" | "within";

/** What a turn knows about the web: the sites the user granted, and the site of the page the browser is on. */
export interface SiteGrant {
  readonly granted: Set<string>;
  current?: string | undefined;
}

/** The host of an http(s) address, lower case, without "www.", with its port when it is not the usual one. */
export function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.host.toLowerCase().replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** A granted site covers itself and its subdomains; a one-label host (localhost, com) covers only itself. */
function covers(granted: ReadonlySet<string>, host: string): boolean {
  for (const g of granted) if (host === g || (g.includes(".") && host.endsWith(`.${g}`))) return true;
  return false;
}

/** Run it, ask for its site, or `undefined` for the usual rules (not on a granted page, or not a web address). */
export function siteDecision(
  role: SiteRole,
  args: Record<string, unknown>,
  grant: SiteGrant,
): { readonly run: true } | { readonly host: string; readonly url: string } | undefined {
  const url = typeof args.url === "string" ? args.url : undefined;
  if (role === "within" || url === undefined)
    return grant.current !== undefined && covers(grant.granted, grant.current) ? { run: true } : undefined;
  const host = hostOf(url);
  if (!host) return undefined;
  return covers(grant.granted, host) ? { run: true } : { host, url };
}

/**
 * The site of the page a browser tool's result says it is on: Playwright's own "- Page URL:" line, read
 * only before the page's content starts, so text on a page cannot claim to be somewhere else.
 */
export function pageHost(result: string): string | undefined {
  const head = result.split("### Snapshot")[0] ?? "";
  const line = /^- Page URL: (\S+)\s*$/m.exec(head);
  return line?.[1] ? hostOf(line[1]) : undefined;
}
