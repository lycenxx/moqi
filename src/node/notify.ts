import { execFile } from "node:child_process";

export type Notifier = (title: string, body: string) => Promise<void>;

type Exec = (file: string, args: readonly string[]) => Promise<void>;

const run: Exec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: 10_000 }, () => resolve()); // a missing notifier must not break moqi
  });

/**
 * System notifications. Text is passed as arguments, never spliced into a script, so a title from
 * a web page or a calendar cannot run code.
 */
export function desktopNotifier(platform: NodeJS.Platform = process.platform, exec: Exec = run): Notifier {
  if (platform === "darwin") {
    return (title, body) =>
      exec("osascript", [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        "--",
        title,
        body,
      ]);
  }
  if (platform === "linux") return (title, body) => exec("notify-send", ["--app-name=moqi", "--", title, body]);
  return async () => {};
}
