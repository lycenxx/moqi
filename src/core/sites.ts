// Site grants for web tools. Within one conversation turn, opening a site is asked once; after that,
// browsing and clicking there runs without asking. What the model writes itself (text it types, addresses
// it makes up) is what could carry the user's words away, so typing is always asked and a new site is asked.

export type SiteRole = "goto" | "within";

/** The host of an http(s) address, lower case and without "www.", or undefined. */
export function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.hostname.toLowerCase().replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Run it, ask for its site, or `undefined` for the usual rules (no grant yet, or an address that is not a web page). */
export function siteDecision(
  role: SiteRole,
  args: Record<string, unknown>,
  sites: ReadonlySet<string>,
): { readonly run: true } | { readonly host: string; readonly url: string } | undefined {
  const url = typeof args.url === "string" ? args.url : undefined;
  if (role === "within" || url === undefined) return sites.size > 0 ? { run: true } : undefined;
  const host = hostOf(url);
  if (!host) return undefined;
  for (const granted of sites) if (host === granted || host.endsWith(`.${granted}`)) return { run: true };
  return { host, url };
}
