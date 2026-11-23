import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEDIA_MAX, mediaStore, sniff } from "../src/node/media.js";
import { RED_PNG } from "./helpers.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

describe("media", () => {
  it("tells the four image types apart by their first bytes", () => {
    expect(sniff(RED_PNG)).toBe("image/png");
    expect(sniff(JPEG)).toBe("image/jpeg");
    expect(sniff(GIF)).toBe("image/gif");
    expect(sniff(WEBP)).toBe("image/webp");
    expect(sniff(Buffer.from("<svg></svg>"))).toBeUndefined();
  });

  it("keeps an image under an id, privately, and gives it back", async () => {
    const home = mkdtempSync(join(tmpdir(), "moqi-media-"));
    const media = mediaStore(home);
    const id = media.save(RED_PNG);
    expect(id).toMatch(/^m_[0-9a-f]{16}$/);
    expect(media.read(id)).toEqual({ type: "image/png", bytes: RED_PNG });
    expect(await media.load(id)).toEqual({ type: "image/png", data: RED_PNG.toString("base64") });
    expect(readdirSync(join(home, "media"))).toEqual([`${id}.png`]);
    expect(statSync(join(home, "media")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "media", `${id}.png`)).mode & 0o777).toBe(0o600);
  });

  it("refuses other types, empty files and big ones, and ids that are not ids", async () => {
    const media = mediaStore(mkdtempSync(join(tmpdir(), "moqi-media-")));
    expect(() => media.save(Buffer.from("hello"))).toThrow("只收 PNG、JPEG、GIF、WebP 图片");
    expect(() => media.save(Buffer.alloc(0))).toThrow("图片是空的");
    expect(() => media.save(Buffer.concat([RED_PNG, Buffer.alloc(MEDIA_MAX)]))).toThrow("图片太大了，最多 3 MB");
    expect(media.read("../config.json")).toBeUndefined();
    expect(media.read("m_0000000000000000")).toBeUndefined();
    expect(await media.load("m_zz")).toBeUndefined();
  });
});
