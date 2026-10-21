import { ExifTool } from "exiftool-vendored";
import type { DB } from "./db.ts";
import type { Config } from "./config.ts";
import { originalPath } from "./media.ts";
import { readAltitude } from "./altitude.ts";
import { transaction } from "./db.ts";

export class AltitudeBackfill {
  db: DB;
  config: Config;
  onChange: () => void;
  active: Promise<void> | null = null;
  stopping = false;
  state = "idle";
  error = "";
  current = "";
  tool: ExifTool | null = null;
  constructor(db: DB, config: Config, onChange = () => {}) {
    this.db = db;
    this.config = config;
    this.onChange = onChange;
  }
  status() {
    const n = this.db
      .prepare(
        `SELECT count(*) AS total,
      sum(altitude_checked=0) AS pending, sum(altitude_checked=1) AS checked,
      sum(altitude_checked=2) AS failed,
      sum(altitude_checked=1 AND original_altitude BETWEEN -12000 AND 100000) AS found,
      sum(altitude_checked=1 AND original_altitude IS NOT NULL AND NOT(original_altitude BETWEEN -12000 AND 100000)) AS invalid
      FROM photos WHERE status='ready'`,
      )
      .get()!;
    const counts = Object.fromEntries(
      Object.entries(n).map(([k, v]) => [k, Number(v || 0)]),
    ) as Record<
      "total" | "pending" | "checked" | "failed" | "found" | "invalid",
      number
    >;
    return {
      ...counts,
      state: this.state,
      current: this.current,
      error: this.error,
    };
  }
  start(retryErrors = false) {
    if (this.active) throw Error("Чтение высоты уже выполняется.");
    if (retryErrors)
      this.db
        .prepare(
          "UPDATE photos SET altitude_checked=0,altitude_error=NULL WHERE status='ready' AND altitude_checked=2",
        )
        .run();
    this.stopping = false;
    this.error = "";
    this.state = "running";
    this.active = this.run()
      .catch((e) => {
        this.state = "error";
        this.error = e.message;
      })
      .finally(async () => {
        await this.tool?.end();
        this.tool = null;
        this.active = null;
        this.current = "";
        this.onChange();
      });
    return this.status();
  }
  stop() {
    if (this.active) {
      this.stopping = true;
      this.state = "stopping";
    }
    return this.status();
  }
  async run() {
    const rows = this.db
      .prepare(
        "SELECT id,size,mtime_ms,format FROM photos WHERE status='ready' AND altitude_checked=0 ORDER BY relative_path,id",
      )
      .all();
    if (!rows.length) {
      this.state = "completed";
      return;
    }
    this.tool = new ExifTool({
      maxProcs: Math.min(2, this.config.importConcurrency),
      taskTimeoutMillis: 30000,
    });
    let cursor = 0,
      lastNotification = Date.now();
    const pending: {
      id: string;
      size: number;
      mtime: number;
      altitude: number | null;
      error: string | null;
    }[] = [];
    const update = this.db.prepare(
      "UPDATE photos SET original_altitude=?,altitude_checked=?,altitude_error=? WHERE id=? AND size=? AND mtime_ms=? AND altitude_checked=0",
    );
    const flush = () =>
      transaction(this.db, () => {
        for (const r of pending)
          update.run(
            r.altitude,
            r.error ? 2 : 1,
            r.error,
            r.id,
            r.size,
            r.mtime,
          );
        pending.length = 0;
      });
    const worker = async () => {
      while (cursor < rows.length && !this.stopping) {
        const row = rows[cursor++];
        try {
          const { file, photo } = await originalPath(this.db, String(row.id));
          this.current = String(photo.relative_path);
          const altitude = await readAltitude(
            file,
            String(row.format),
            this.tool!,
          );
          pending.push({
            id: String(row.id),
            size: Number(row.size),
            mtime: Number(row.mtime_ms),
            altitude,
            error: null,
          });
        } catch (e) {
          pending.push({
            id: String(row.id),
            size: Number(row.size),
            mtime: Number(row.mtime_ms),
            altitude: null,
            error: (e as Error).message,
          });
        }
        if (pending.length >= 1000) flush();
        if (Date.now() - lastNotification > 8000) {
          lastNotification = Date.now();
          this.onChange();
        }
        if (cursor % 100 === 0)
          await new Promise((resolve) => setImmediate(resolve));
      }
    };
    await Promise.all(
      Array.from(
        // Header reads are small asynchronous I/O; expensive ExifTool work
        // remains limited to two processes by the pool above.
        { length: Math.min(8, this.config.importConcurrency * 4) },
        worker,
      ),
    );
    flush();
    this.state = this.stopping ? "paused" : "completed";
  }
  async close() {
    this.stop();
    await this.active;
  }
}
