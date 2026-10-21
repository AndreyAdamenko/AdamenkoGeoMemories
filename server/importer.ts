import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ExifTool } from "exiftool-vendored";
import type { DB } from "./db.ts";
import { inside, projectRoot } from "./config.ts";
import type { Config } from "./config.ts";
import { validCoordinates } from "./catalog.ts";

const EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".jpe",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
  ".srw",
  ".dng",
  ".cr2",
  ".cr3",
  ".nef",
  ".arw",
  ".orf",
  ".rw2",
  ".raf",
  ".jp2",
  ".jxl",
  ".mpo",
]);
const IMAGE_TYPES = new Set([
  "JPEG",
  "PNG",
  "GIF",
  "WEBP",
  "BMP",
  "TIFF",
  "HEIC",
  "HEIF",
  "AVIF",
  "SRW",
  "DNG",
  "CR2",
  "CR3",
  "NEF",
  "ARW",
  "ORF",
  "RW2",
  "RAF",
  "JP2",
  "JXL",
  "MPO",
]);
export type ImportJob = {
  id: string;
  state: string;
  discovered: number;
  processed: number;
  imported: number;
  unchanged: number;
  empty: number;
  failed: number;
  unsupported: number;
  current: string;
  startedAt: string | null;
  finishedAt: string | null;
  discoveryErrors: string[];
  error?: string;
};
function initial(): ImportJob {
  return {
    id: "",
    state: "idle",
    discovered: 0,
    processed: 0,
    imported: 0,
    unchanged: 0,
    empty: 0,
    failed: 0,
    unsupported: 0,
    current: "",
    startedAt: null,
    finishedAt: null,
    discoveryErrors: [],
  };
}
export class Importer {
  db: DB;
  config: Config;
  tool: ExifTool;
  job: ImportJob;
  active: Promise<void> | null = null;
  stopping = false;
  lastSaved = 0;
  onChange: () => void;
  constructor(db: DB, config: Config, onChange = () => {}) {
    this.db = db;
    this.config = config;
    this.onChange = onChange;
    this.tool = new ExifTool({
      maxProcs: config.importConcurrency,
      taskTimeoutMillis: 30000,
    });
    const saved = db
      .prepare("SELECT value FROM settings WHERE key='import_job'")
      .get();
    this.job = saved ? JSON.parse(String(saved.value)) : initial();
    if (["discovering", "running", "stopping"].includes(this.job.state)) {
      this.job.state = "interrupted";
      this.persist(true);
    }
  }
  persist(force = false) {
    if (!force && Date.now() - this.lastSaved < 1000) return;
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES('import_job',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(this.job));
    this.lastSaved = Date.now();
  }
  start() {
    if (this.active) throw Error("Импорт уже выполняется.");
    this.stopping = false;
    this.job = {
      ...initial(),
      id: randomUUID(),
      state: "discovering",
      startedAt: new Date().toISOString(),
    };
    this.persist(true);
    this.active = this.run()
      .catch((error) => {
        this.job.state = "error";
        this.job.error = error.message;
      })
      .finally(() => {
        this.job.finishedAt = new Date().toISOString();
        this.job.current = "";
        this.active = null;
        this.persist(true);
        this.onChange();
      });
    return this.job;
  }
  stop() {
    if (this.active) {
      this.stopping = true;
      this.job.state = "stopping";
      this.persist(true);
    }
    return this.job;
  }
  async run() {
    const root = this.config.sourceRoot;
    await fs.access(root);
    const candidates: { relative: string; size: number; mtime: number }[] = [];
    const walk = async (dir: string) => {
      if (this.stopping) return;
      if (inside(this.config.dataDir, dir) || inside(projectRoot, dir)) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
        if (
          dir !== root &&
          entries.some((e) => e.isFile() && e.name === ".geo-memories-app")
        )
          return;
      } catch (error) {
        if (dir === root) throw error;
        this.job.discoveryErrors.push(
          `${path.relative(root, dir)}: ${(error as Error).message}`,
        );
        return;
      }
      for (const entry of entries) {
        if (this.stopping) return;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (
          entry.isFile() &&
          EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ) {
          try {
            const stat = await fs.stat(full);
            candidates.push({
              relative: path.relative(root, full).split(path.sep).join("/"),
              size: stat.size,
              mtime: stat.mtimeMs,
            });
            this.job.discovered++;
            this.persist();
          } catch (error) {
            this.job.discoveryErrors.push(
              `${path.relative(root, full)}: ${(error as Error).message}`,
            );
          }
        }
      }
    };
    await walk(root);
    this.job.state = this.stopping ? "stopping" : "running";
    this.persist(true);
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length && !this.stopping) {
        const f = candidates[cursor++];
        this.job.current = f.relative;
        const old = this.db
          .prepare(
            "SELECT id,size,mtime_ms,status FROM photos WHERE source_root=? AND relative_path=?",
          )
          .get(root, f.relative);
        if (
          old &&
          old.size === f.size &&
          Math.abs(Number(old.mtime_ms) - f.mtime) < 1 &&
          old.status !== "missing" &&
          old.status !== "error"
        ) {
          this.db
            .prepare("UPDATE photos SET seen_run=? WHERE id=?")
            .run(this.job.id, old.id as string);
          this.job.unchanged++;
        } else {
          const id = (old?.id as string) || randomUUID();
          let status = "ready",
            error: string | null = null,
            format: string | null = null,
            width: number | null = null,
            height: number | null = null,
            taken: string | null = null,
            dateSource: string | null = null,
            lat: number | null = null,
            lon: number | null = null,
            metadata: string | null = null;
          if (!f.size) {
            status = "empty";
            error = "Пустой файл (0 байт)";
            this.job.empty++;
          } else
            try {
              const tags = await this.tool.read(
                path.join(root, ...f.relative.split("/")),
                ["-fast", "-api", "LargeFileSupport=1"],
              );
              format = String(tags.FileType || "").toUpperCase();
              if (!IMAGE_TYPES.has(format)) {
                status = "unsupported";
                error = `Фактический формат ${format || "неизвестен"}; не поддерживается как изображение`;
                this.job.unsupported++;
              } else {
                width = Number(tags.ImageWidth || tags.ExifImageWidth) || null;
                height =
                  Number(tags.ImageHeight || tags.ExifImageHeight) || null;
                const raw = tags.DateTimeOriginal || tags.CreateDate;
                // Keep wall-clock capture time; do not invent a time zone for old cameras.
                if (raw) {
                  const value =
                    (typeof raw === "string" ? raw : raw.toString()) || "";
                  const match = value.match(
                    /(\d{4})[:-](\d{2})[:-](\d{2})[T ](\d{2}):(\d{2}):(\d{2})/,
                  );
                  if (
                    match &&
                    Number(match[1]) >= 1900 &&
                    Number(match[2]) >= 1 &&
                    Number(match[2]) <= 12 &&
                    Number(match[3]) >= 1 &&
                    Number(match[3]) <= 31
                  ) {
                    taken = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
                    dateSource = "exif";
                  }
                }
                if (!taken) {
                  const folders = f.relative.slice(
                    0,
                    Math.max(0, f.relative.lastIndexOf("/")),
                  );
                  const match = folders.match(
                    /(?:^|\/)((?:19|20)\d{2})(\d{2})(\d{2})(?=[_\/ .-]|$)/,
                  );
                  if (
                    match &&
                    Number(match[2]) >= 1 &&
                    Number(match[2]) <= 12 &&
                    Number(match[3]) >= 1 &&
                    Number(match[3]) <= 31
                  ) {
                    taken = `${match[1]}-${match[2]}-${match[3]}T00:00:00`;
                    dateSource = "folder";
                  }
                }
                if (
                  validCoordinates(tags.GPSLatitude, tags.GPSLongitude) &&
                  !(tags.GPSLatitude === 0 && tags.GPSLongitude === 0)
                ) {
                  lat = Number(tags.GPSLatitude);
                  lon = Number(tags.GPSLongitude);
                }
                metadata = JSON.stringify({
                  make: tags.Make,
                  model: tags.Model,
                  orientation: tags.Orientation,
                  lens: tags.LensModel,
                  iso: tags.ISO,
                  warnings: tags.warnings,
                  errors: tags.errors,
                });
                this.job.imported++;
              }
            } catch (e) {
              status = "error";
              error = (e as Error).message;
              this.job.failed++;
            }
          const folder = f.relative.includes("/")
            ? f.relative.slice(0, f.relative.lastIndexOf("/"))
            : "";
          this.db
            .prepare(
              `INSERT INTO photos(id,source_root,relative_path,filename,folder,size,mtime_ms,format,width,height,taken_at,date_source,original_lat,original_lon,status,error,metadata_json,seen_run)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source_root,relative_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,format=excluded.format,width=excluded.width,height=excluded.height,taken_at=excluded.taken_at,date_source=excluded.date_source,original_lat=excluded.original_lat,original_lon=excluded.original_lon,status=excluded.status,error=excluded.error,metadata_json=excluded.metadata_json,seen_run=excluded.seen_run,updated_at=datetime('now')`,
            )
            .run(
              id,
              root,
              f.relative,
              path.basename(f.relative),
              folder,
              f.size,
              f.mtime,
              format,
              width,
              height,
              taken,
              dateSource,
              lat,
              lon,
              status,
              error,
              metadata,
              this.job.id,
            );
          this.onChange();
        }
        this.job.processed++;
        this.persist();
        // Yield even when thousands of unchanged or empty files are visited.
        if (this.job.processed % 100 === 0)
          await new Promise((resolve) => setImmediate(resolve));
      }
    };
    await Promise.all(
      Array.from({ length: this.config.importConcurrency }, worker),
    );
    if (!this.stopping && !this.job.discoveryErrors.length) {
      this.db
        .prepare(
          "UPDATE photos SET status='missing',error='Файл отсутствует при последнем полном сканировании' WHERE source_root=? AND (seen_run IS NULL OR seen_run!=?)",
        )
        .run(root, this.job.id);
    }
    this.job.state = this.stopping ? "cancelled" : "completed";
  }
  async close() {
    this.stop();
    await this.active;
    await this.tool.end();
  }
}
