// Where the running console can be found: ~/.moqi/console.json, readable only by the user.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lockHolder } from "../file-store.js";

export interface ConsoleInfo {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Browsers send *.localhost to this machine (RFC 6761), so the address is easy to remember and type. */
export const CONSOLE_HOST = "moqi.localhost";

/** The address to remember. Opening it once through `consoleUrl` lets that browser remember the key. */
export function consoleAddress(port: number): string {
  return `http://${CONSOLE_HOST}:${port}`;
}

export function consoleUrl(port: number, token: string): string {
  return `${consoleAddress(port)}/#t=${token}`;
}

export function readConsoleInfo(home: string): Partial<ConsoleInfo> {
  const path = join(home, "console.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<ConsoleInfo>;
  } catch {
    return {};
  }
}

export function writeConsoleInfo(home: string, info: ConsoleInfo): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "console.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The same token across restarts, so a bookmarked console keeps working. */
export function consoleToken(home: string): string {
  const { token } = readConsoleInfo(home);
  return typeof token === "string" && token.length >= 32 ? token : newToken();
}

/** The console of the moqi running on this home, if it serves one. */
export function runningConsole(home: string): (ConsoleInfo & { readonly url: string }) | undefined {
  const pid = lockHolder(home);
  if (!pid) return undefined;
  const info = readConsoleInfo(home);
  if (info.pid !== pid || !info.port || !info.token) return undefined;
  return { pid, port: info.port, token: info.token, url: consoleUrl(info.port, info.token) };
}
