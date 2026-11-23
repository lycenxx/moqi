// Files, inside the folders the user picked: list, read, make folders and new files, move, rename, and move
// to the Trash. Nothing overwrites an existing file or changes what is in it, and nothing is deleted for good,
// so every step can be undone. Every path is resolved to where it really is first, so a symlink cannot lead
// outside the folders.
import { execFile } from "node:child_process";
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { defineTool, type Plugin } from "../core/plugin.js";
import { expandHome } from "./config.js";

export interface FilesOptions {
  readonly folders: readonly string[];
  /** Moves a path to the Trash. Default: Finder on macOS, `gio trash` on Linux. */
  readonly trash?: (path: string) => Promise<void>;
}

const LIST_MAX = 200;
const READ_CHARS = 20_000;
const READ_BYTES = 256 * 1024;
const WRITE_MAX = 1_000_000;

/** A request that cannot work; its message goes back to the model, never to the user to approve. */
class Problem extends Error {}

export function filesPlugin(options: FilesOptions): Plugin {
  const trash = options.trash ?? systemTrash;
  const listed = options.folders.join("、");
  const roots = () =>
    options.folders.flatMap((f) => {
      try {
        return [realpathSync(expandHome(f))];
      } catch {
        return [];
      }
    });
  const within = (real: string, strict: boolean) =>
    roots().some((r) => (!strict && real === r) || real.startsWith(r + sep));
  const isRoot = (real: string) => roots().includes(real);
  const outside = (p: string) => new Problem(`${show(p)} 不在允许的文件夹里（${listed}）`);

  const absolute = (p: string) => {
    if (!p.startsWith("/") && !p.startsWith("~/")) throw new Problem("路径要以 / 或 ~/ 开头");
    if (p.includes("\0")) throw new Problem("路径里有非法字符");
    return resolve(expandHome(p));
  };
  /** An existing path inside the folders, where it really is. */
  const existing = (p: string) => {
    const abs = absolute(p);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new Problem(`找不到 ${show(abs)}`);
    }
    if (!within(real, false)) throw outside(abs);
    return real;
  };
  /** A path that does not exist yet, inside the folders. */
  const fresh = (p: string) => {
    const abs = absolute(p);
    checkName(basename(abs));
    let parent: string;
    try {
      parent = realpathSync(dirname(abs));
    } catch {
      throw new Problem(`找不到文件夹 ${show(dirname(abs))}`);
    }
    const full = join(parent, basename(abs));
    if (!within(full, true)) throw outside(abs);
    if (taken(full)) throw new Problem(`已经有同名的 ${show(full)}，不会覆盖`);
    return full;
  };
  const movable = (p: string, verb: string) => {
    const real = existing(p);
    if (isRoot(real)) throw new Problem(`${show(real)} 是允许的文件夹本身，不能${verb}`);
    return real;
  };
  /**
   * A path as the user should see it in a question, with where it really is when a symlink inside the folders
   * stands in between (a link to another folder would move all of that folder).
   */
  const named = (p: string) => {
    try {
      const abs = absolute(p);
      const real = realpathSync(abs);
      const linked = `${show(abs)}（链接，实际是 ${show(real)}）`;
      for (const folder of options.folders) {
        const given = resolve(expandHome(folder));
        if (abs === given || abs.startsWith(given + sep))
          return real === realpathSync(given) + abs.slice(given.length) ? show(abs) : linked;
      }
      return lstatSync(abs).isSymbolicLink() ? linked : show(abs);
    } catch {
      return p;
    }
  };
  const destination = (from: string, to: string) => {
    const src = movable(from, "移动");
    const abs = absolute(to);
    let dest: string;
    let into: string | undefined;
    try {
      into = realpathSync(abs);
    } catch {
      into = undefined;
    }
    if (into && statSync(into).isDirectory()) {
      if (!within(into, false)) throw outside(abs);
      dest = join(into, basename(src));
      if (taken(dest)) throw new Problem(`已经有同名的 ${show(dest)}，不会覆盖`);
    } else dest = fresh(to);
    if (dest.startsWith(src + sep)) throw new Problem("不能把文件夹移进它自己里面");
    return { src, dest };
  };

  return {
    name: "files",
    tools: [
      defineTool({
        name: "files_list",
        description: `List a folder the user allowed moqi to use (${listed}), or a folder inside one. Hidden files are skipped.`,
        input: z.object({ folder: z.string().describe("Absolute or ~/ path") }),
        effect: "read",
        validate: ({ folder }) =>
          check(() => {
            if (!statSync(existing(folder)).isDirectory()) throw new Problem(`${show(folder)} 不是文件夹`);
          }),
        run: ({ folder }) => {
          const dir = existing(folder);
          const rows = readdirSync(dir)
            .filter((name) => !name.startsWith("."))
            .flatMap((name) => {
              try {
                const st = lstatSync(join(dir, name));
                return [{ name, dir: st.isDirectory(), size: st.size, at: st.mtimeMs }];
              } catch {
                return [];
              }
            })
            .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, "zh") : a.dir ? -1 : 1));
          const lines = rows
            .slice(0, LIST_MAX)
            .map((r) => (r.dir ? `${r.name}/` : `${r.name}  ${size(r.size)}  ${when(r.at)}`));
          const more = rows.length > LIST_MAX ? `，只列出前 ${LIST_MAX} 项` : "";
          return [`${show(dir)}（${rows.length} 项${more}）`, ...lines].join("\n");
        },
      }),
      defineTool({
        name: "files_read",
        description: `Read a text file inside the allowed folders (${listed}). Long files are cut.`,
        input: z.object({ path: z.string().describe("Absolute or ~/ path") }),
        effect: "read",
        validate: ({ path }) =>
          check(() => {
            if (!statSync(existing(path)).isFile()) throw new Problem(`${show(path)} 不是文件`);
          }),
        run: ({ path }) => {
          const file = existing(path);
          const total = statSync(file).size;
          const buf = Buffer.alloc(Math.min(total, READ_BYTES));
          const fd = openSync(file, "r");
          try {
            readSync(fd, buf, 0, buf.length, 0);
          } finally {
            closeSync(fd);
          }
          if (buf.includes(0)) return `${show(file)} 不是文本文件（${size(total)}）`;
          const text = buf.toString("utf8");
          const cut = text.length > READ_CHARS || total > buf.length;
          return cut ? `${text.slice(0, READ_CHARS)}\n…（后面还有，没读完）` : text || "（空文件）";
        },
      }),
      defineTool({
        name: "files_mkdir",
        description: "Make a new folder inside the allowed folders. Its parent must exist.",
        input: z.object({ path: z.string().describe("Absolute or ~/ path of the new folder") }),
        effect: "write",
        local: true,
        describe: ({ path }) => `新建文件夹 ${path}`,
        validate: ({ path }) => check(() => fresh(path)),
        run: ({ path }) => {
          const full = fresh(path);
          try {
            mkdirSync(full);
          } catch (error) {
            throw friendly(error, ` ${show(full)}`);
          }
          return `新建了文件夹 ${show(full)}`;
        },
      }),
      defineTool({
        name: "files_write_new",
        description:
          "Save text as a new file inside the allowed folders. Never overwrites: an existing name is refused.",
        input: z.object({
          path: z.string().describe("Absolute or ~/ path of the new file"),
          content: z.string().max(WRITE_MAX),
        }),
        effect: "write",
        local: true,
        describe: ({ path }) => `新建文件 ${path}`,
        validate: ({ path }) => check(() => fresh(path)),
        run: ({ path, content }) => {
          const full = fresh(path);
          try {
            writeFileSync(full, content, { flag: "wx" });
          } catch (error) {
            throw friendly(error, ` ${show(full)}`);
          }
          return `新建了 ${show(full)}（${content.length} 字）；不要了可以移到废纸篓`;
        },
      }),
      defineTool({
        name: "files_move",
        description:
          "Move a file or folder inside the allowed folders. If `to` is an existing folder, it goes into it. Never overwrites.",
        input: z.object({ from: z.string(), to: z.string() }),
        effect: "write",
        local: true,
        describe: ({ from, to }) => `把 ${named(from)} 移到 ${to}`,
        validate: ({ from, to }) => check(() => destination(from, to)),
        run: ({ from, to }) => {
          const { src, dest } = destination(from, to);
          try {
            moveAside(src, dest);
          } catch (error) {
            throw friendly(error, ` ${show(dest)}`);
          }
          return `已把 ${show(src)} 移到 ${show(dest)}；要移回去就说一声`;
        },
      }),
      defineTool({
        name: "files_rename",
        description: "Rename a file or folder where it is, inside the allowed folders. Never overwrites.",
        input: z.object({ path: z.string(), name: z.string().describe("The new name, without a folder") }),
        effect: "write",
        local: true,
        describe: ({ path, name }) => `把 ${named(path)} 改名为 ${name}`,
        validate: ({ path, name }) =>
          check(() => {
            const src = movable(path, "改名");
            checkName(name);
            if (taken(join(dirname(src), name))) throw new Problem(`已经有同名的 ${name}，不会覆盖`);
          }),
        run: ({ path, name }) => {
          const src = movable(path, "改名");
          checkName(name);
          const dest = join(dirname(src), name);
          if (taken(dest)) throw new Error(`已经有同名的 ${name}，不会覆盖`);
          try {
            moveAside(src, dest);
          } catch (error) {
            throw friendly(error, ` ${show(dest)}`);
          }
          return `已把 ${basename(src)} 改名为 ${name}（在 ${show(dirname(src))}）；要改回去就说一声`;
        },
      }),
      defineTool({
        name: "files_trash",
        description: "Move a file or folder inside the allowed folders to the Trash, where the user can put it back.",
        input: z.object({ path: z.string() }),
        effect: "write",
        danger: true,
        source: "文件",
        describe: ({ path }) => `把 ${named(path)} 移到废纸篓`,
        validate: ({ path }) => check(() => movable(path, "移到废纸篓")),
        run: async ({ path }) => {
          const src = movable(path, "移到废纸篓");
          await trash(src);
          return `已把 ${show(src)} 移到废纸篓，可以在访达的废纸篓里「放回原处」`;
        },
      }),
    ],
  };
}

function check(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkName(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw new Problem(`「${name}」不能用作文件名`);
}

/**
 * Moves without ever replacing what is at `dest`: a file is hard-linked there first, which fails if the name
 * is taken even when something lands there a moment before, then unlinked from where it was. A folder is
 * renamed; rename can only replace an empty folder, which loses nothing.
 */
function moveAside(src: string, dest: string): void {
  if (lstatSync(src).isDirectory()) {
    renameSync(src, dest);
    return;
  }
  try {
    linkSync(src, dest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Some disks (FAT, exFAT) have no hard links: check once more and rename.
    if ((code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") && !taken(dest)) {
      renameSync(src, dest);
      return;
    }
    throw error;
  }
  unlinkSync(src);
}

function taken(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function show(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function when(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function friendly(error: unknown, what: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return new Error(`没有权限${what}`);
  if (code === "ENOENT") return new Error(`找不到${what}`);
  if (code === "EEXIST") return new Error(`已经有同名的${what}，不会覆盖`);
  if (code === "EXDEV") return new Error("不能跨磁盘移动");
  return error instanceof Error ? error : new Error(String(error));
}

function systemTrash(path: string): Promise<void> {
  if (process.platform === "darwin")
    return exec("osascript", [
      "-e",
      "on run argv",
      "-e",
      'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
      "-e",
      "end run",
      "--",
      path,
    ]);
  if (process.platform === "linux") return exec("gio", ["trash", "--", path]);
  return Promise.reject(new Error("这台电脑上还不支持移到废纸篓"));
}

function exec(file: string, args: readonly string[]): Promise<void> {
  return new Promise((done, fail) => {
    execFile(file, [...args], { timeout: 15_000 }, (error, _stdout, stderr) => {
      if (error) fail(new Error(String(stderr || error.message).trim()));
      else done();
    });
  });
}
