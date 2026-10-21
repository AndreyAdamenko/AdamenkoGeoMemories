import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { DB } from "./db.ts";
import type { Config } from "./config.ts";
import { inside } from "./config.ts";
import type { ExifTool } from "exiftool-vendored";

export async function originalPath(db: DB, id: string) {
  const photo = db.prepare("SELECT * FROM photos WHERE id=?").get(id);
  if (!photo) throw Error("Фотография не найдена.");
  const root = String(photo.source_root),
    file = path.resolve(root, ...String(photo.relative_path).split("/"));
  if (!inside(root, file)) throw Error("Недопустимый путь к оригиналу.");
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(root),
    fs.realpath(file),
  ]);
  if (!inside(realRoot, realFile))
    throw Error("Файл находится за пределами папки оригиналов.");
  return { photo, file: realFile };
}
export function createMedia(db: DB, config: Config, tool: ExifTool) {
  const pending = new Map<string, Promise<string>>();
  let running = 0;
  const waiting: (() => void)[] = [];
  async function slot() {
    if (running >= 3)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
  }
  function release() {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
  async function preview(id: string, large = false) {
    const { photo, file } = await originalPath(db, id);
    const key = `${id}-${photo.size}-${Math.trunc(Number(photo.mtime_ms))}-${large ? "large" : "thumb"}`;
    const dest = path.join(config.dataDir, "thumbnails", `${key}.webp`);
    try {
      await fs.access(dest);
      return dest;
    } catch {
      /* Create missing cached preview. */
    }
    if (pending.has(key)) return pending.get(key)!;
    const task = (async () => {
      await slot();
      try {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const pipeline = (input: string | Buffer) =>
          sharp(input, { failOn: "error", limitInputPixels: 180_000_000 })
            .rotate()
            .resize({
              width: large ? 1800 : 480,
              height: large ? 1800 : 480,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: large ? 85 : 76 })
            .toBuffer();
        let output: Buffer;
        try {
          output = await pipeline(file);
        } catch (first) {
          let recovered: Buffer | null = null;
          if (
            [
              "SRW",
              "DNG",
              "CR2",
              "CR3",
              "NEF",
              "ARW",
              "ORF",
              "RW2",
              "RAF",
              "TIFF",
            ].includes(String(photo.format))
          ) {
            for (const tag of [
              "PreviewImage",
              "JpgFromRaw",
              "ThumbnailImage",
            ] as const) {
              try {
                const embedded = await tool.extractBinaryTagToBuffer(tag, file);
                if (embedded.length) {
                  recovered = await pipeline(embedded);
                  break;
                }
              } catch {
                /* Extraction or decoding may fail: try the next embedded image. */
              }
            }
          }
          if (!recovered) throw first;
          output = recovered;
        }
        const temp = `${dest}.${process.pid}.tmp`;
        await fs.writeFile(temp, output);
        await fs.rename(temp, dest);
        return dest;
      } finally {
        release();
      }
    })();
    pending.set(key, task);
    try {
      return await task;
    } finally {
      pending.delete(key);
    }
  }
  return { preview };
}
