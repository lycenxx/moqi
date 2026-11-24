// Images the user sends and tools bring back, kept as files under <moqi home>/media. Events only carry the ids.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MEDIA_MAX = 3 * 1024 * 1024;
export const MEDIA_ID = /^m_[0-9a-f]{16}$/;
const EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** The image type from the file's first bytes; undefined for anything else, whatever it is called. */
export function sniff(bytes: Uint8Array): string | undefined {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

export interface MediaStore {
  /** Keeps an image and returns its id. Throws for other types, empty files and anything over 3 MB. */
  save(bytes: Uint8Array): string;
  read(id: string): { readonly type: string; readonly bytes: Buffer } | undefined;
  /** For the model: the type and the bytes in base64. */
  load(id: string): Promise<{ readonly type: string; readonly data: string } | undefined>;
}

export function mediaStore(home: string): MediaStore {
  const dir = join(home, "media");
  const read = (id: string) => {
    if (!MEDIA_ID.test(id)) return undefined; // never a path from outside
    for (const [type, ext] of Object.entries(EXT)) {
      const file = join(dir, `${id}.${ext}`);
      if (existsSync(file)) return { type, bytes: readFileSync(file) };
    }
    return undefined;
  };
  return {
    save(bytes) {
      if (bytes.length === 0) throw new Error("图片是空的");
      if (bytes.length > MEDIA_MAX) throw new Error("图片太大了，最多 3 MB");
      const type = sniff(bytes);
      if (!type) throw new Error("只收 PNG、JPEG、GIF、WebP 图片");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      const id = `m_${randomBytes(8).toString("hex")}`;
      writeFileSync(join(dir, `${id}.${EXT[type]}`), bytes, { mode: 0o600 });
      return id;
    },
    read,
    load: async (id) => {
      const found = read(id);
      return found && { type: found.type, data: found.bytes.toString("base64") };
    },
  };
}
