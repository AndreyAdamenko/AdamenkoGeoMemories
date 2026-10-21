import express from "express";
import path from "node:path";
import fs from "node:fs";
import Supercluster from "supercluster";
import type { Config } from "./config.ts";
import { projectRoot } from "./config.ts";
import { openDatabase } from "./db.ts";
import { preparePortableCatalog } from "./portable.ts";
import { AltitudeBackfill } from "./altitude-backfill.ts";
import { FLIGHT_ALTITUDE } from "./altitude.ts";
import {
  editPhotos,
  facets,
  filterSQL,
  getPhoto,
  LAT,
  listPhotos,
  LON,
  ALT,
  saveAlbum,
  stats,
} from "./catalog.ts";
import type { Filters } from "./catalog.ts";
import { Importer } from "./importer.ts";
import { createMedia, originalPath } from "./media.ts";

export function createApp(config: Config) {
  const db = openDatabase(config.dataDir);
  try {
    preparePortableCatalog(db, config);
  } catch (error) {
    db.close();
    throw error;
  }
  let version = 0;
  const changed = () => {
    version++;
  };
  const importer = new Importer(db, config, changed);
  const altitudeBackfill = new AltitudeBackfill(db, config, changed);
  const media = createMedia(db, config, importer.tool);
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    // Local-only service: reject DNS rebinding and cross-origin mutation attempts.
    let host = "";
    try {
      host = new URL(`http://${req.headers.host}`).hostname;
    } catch {
      /* Invalid Host. */
    }
    if (!["127.0.0.1", "localhost"].includes(host)) {
      res.status(403).json({ error: "Разрешён только локальный доступ." });
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      try {
        const u = new URL(origin);
        if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw Error();
      } catch {
        res.status(403).json({ error: "Недопустимый источник запроса." });
        return;
      }
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  const filters = (query: express.Request["query"]): Filters =>
    Object.fromEntries(
      ["q", "folder", "tag", "album", "gps", "from", "to", "issues"]
        .filter((k) => typeof query[k] === "string")
        .map((k) => [k, query[k]]),
    );
  app.get("/api/status", (_req, res) =>
    res.json({
      sourceRoot: config.sourceRoot,
      dataDir: config.dataDir,
      stats: stats(db),
      job: importer.job,
      version,
      altitudeJob: altitudeBackfill.status(),
    }),
  );
  app.get("/api/facets", (_req, res) => res.json(facets(db)));
  app.get("/api/photos", (req, res) => {
    const offset = Math.max(0, Math.trunc(Number(req.query.offset) || 0)),
      limit = Math.min(
        200,
        Math.max(1, Math.trunc(Number(req.query.limit) || 80)),
      );
    const photoFilters = filters(req.query);
    if (typeof req.query.bbox === "string") photoFilters.bbox = req.query.bbox;
    res.json(listPhotos(db, photoFilters, offset, limit));
  });
  app.get("/api/photos/:id", (req, res) => {
    const photo = getPhoto(db, req.params.id);
    if (!photo) {
      res.status(404).json({ error: "Фотография не найдена." });
      return;
    }
    res.json(photo);
  });
  app.post("/api/photos/edit", (req, res) => {
    res.json(editPhotos(db, req.body));
    changed();
  });
  app.post("/api/albums", (req, res) => {
    res.json(saveAlbum(db, req.body));
    changed();
  });
  app.patch("/api/albums/:id", (req, res) => {
    res.json(saveAlbum(db, { ...req.body, id: req.params.id }));
    changed();
  });
  app.delete("/api/albums/:id", (req, res) => {
    db.prepare("DELETE FROM albums WHERE id=?").run(req.params.id);
    changed();
    res.json({ ok: true });
  });
  app.post("/api/import/start", (_req, res) => {
    if (altitudeBackfill.active)
      throw Error("Дождитесь завершения чтения высоты или приостановите его.");
    res.status(202).json(importer.start());
  });
  app.post("/api/import/stop", (_req, res) => res.json(importer.stop()));
  app.post("/api/altitude/start", (req, res) => {
    if (importer.active) throw Error("Дождитесь завершения импорта.");
    res
      .status(202)
      .json(altitudeBackfill.start(req.body?.retryErrors === true));
  });
  app.post("/api/altitude/stop", (_req, res) =>
    res.json(altitudeBackfill.stop()),
  );
  const clusterCache = new Map<
    string,
    Supercluster<
      { id: string; altitude: number | null; flightCount: number },
      { flightCount: number }
    >
  >();
  app.get("/api/map", (req, res) => {
    const f = filters(req.query),
      key = Buffer.from(JSON.stringify([version, f])).toString("base64url");
    let index = clusterCache.get(key);
    if (!index) {
      const { where, values } = filterSQL(f);
      const points = db
        .prepare(
          `SELECT p.id,${LAT} AS lat,${LON} AS lon,${ALT} AS altitude FROM photos p WHERE ${where} AND ${LAT} IS NOT NULL AND ${LON} IS NOT NULL`,
        )
        .all(...values);
      index = new Supercluster<
        { id: string; altitude: number | null; flightCount: number },
        { flightCount: number }
      >({
        radius: 55,
        maxZoom: 19,
        map: (p) => ({ flightCount: p.flightCount }),
        reduce: (a, p) => {
          a.flightCount += p.flightCount;
        },
      }).load(
        points.map((p) => ({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: [Number(p.lon), Number(p.lat)],
          },
          properties: {
            id: String(p.id),
            altitude: p.altitude === null ? null : Number(p.altitude),
            flightCount:
              typeof p.altitude === "number" && p.altitude >= FLIGHT_ALTITUDE
                ? 1
                : 0,
          },
        })),
      );
      if (clusterCache.size >= 4) clusterCache.clear();
      clusterCache.set(key, index);
    }
    const bbox = String(req.query.bbox || "-180,-85,180,85")
      .split(",")
      .map(Number);
    if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
      res.status(400).json({ error: "Некорректная область карты." });
      return;
    }
    const zoom = Math.max(
      0,
      Math.min(20, Math.floor(Number(req.query.zoom) || 0)),
    );
    const features = index
      .getClusters(bbox as [number, number, number, number], zoom)
      .map((feature) =>
        "cluster" in feature.properties
          ? {
              ...feature,
              properties: {
                ...feature.properties,
                expansionZoom: index!.getClusterExpansionZoom(
                  feature.properties.cluster_id,
                ),
              },
            }
          : feature,
      );
    const area = filterSQL({ ...f, bbox: bbox.join(",") });
    const visibleCount = Number(
      db
        .prepare(`SELECT count(*) AS n FROM photos p WHERE ${area.where}`)
        .get(...area.values)!.n,
    );
    res.json({
      type: "FeatureCollection",
      features,
      snapshot: key,
      visibleCount,
    });
  });
  app.get("/api/map/leaves", (req, res) => {
    const index = clusterCache.get(String(req.query.snapshot || ""));
    if (!index) {
      res
        .status(409)
        .json({ error: "Карта обновилась. Откройте группу ещё раз." });
      return;
    }
    const id = Number(req.query.clusterId),
      offset = Math.max(0, Math.trunc(Number(req.query.offset) || 0));
    if (!Number.isSafeInteger(id) || id < 0) {
      res.status(400).json({ error: "Некорректная группа." });
      return;
    }
    const photos = index
      .getLeaves(id, 80, offset)
      .map((f) => getPhoto(db, f.properties.id))
      .filter(Boolean);
    res.json({ photos });
  });
  app.get("/api/photos/:id/preview", async (req, res) => {
    try {
      const file = await media.preview(
        req.params.id,
        req.query.size === "large",
      );
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.type("webp").sendFile(file);
    } catch (error) {
      res.status(422).json({
        error: `Не удалось создать превью: ${(error as Error).message}`,
      });
    }
  });
  app.get("/api/photos/:id/original", async (req, res) => {
    const { file, photo } = await originalPath(db, req.params.id);
    // Always download: a mislabeled HTML/SVG must never execute at this origin.
    res.download(file, String(photo.filename));
  });
  app.get("/api/export", (_req, res) => {
    res.attachment("adamenko-geo-memories-metadata.json");
    const photos = db
      .prepare(
        "SELECT id,source_root,relative_path,description,manual_lat,manual_lon,manual_altitude FROM photos ORDER BY relative_path",
      )
      .all()
      .map((p) => ({
        id: p.id,
        sourceRoot: p.source_root,
        path: p.relative_path,
        description: p.description,
        manualAltitude: p.manual_altitude,
        manualCoordinates:
          p.manual_lat === null
            ? null
            : { lat: p.manual_lat, lon: p.manual_lon },
      }));
    res.json({
      version: 1,
      exportedAt: new Date().toISOString(),
      photos,
      tags: db.prepare("SELECT * FROM tags").all(),
      photoTags: db.prepare("SELECT * FROM photo_tags").all(),
      albums: db.prepare("SELECT * FROM albums").all(),
      albumPhotos: db.prepare("SELECT * FROM album_photos").all(),
    });
  });
  app.get("/api/backup", (_req, res) => {
    // VACUUM INTO produces a consistent SQLite copy, including WAL contents.
    const dir = path.join(config.dataDir, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `catalog-${Date.now()}.sqlite`);
    db.prepare("VACUUM INTO ?").run(file);
    res.download(file, "adamenko-geo-memories.sqlite");
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API-маршрут не найден." }),
  );
  const dist = path.join(projectRoot, "dist");
  app.use(express.static(dist));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(dist, "index.html")),
  );
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (!res.headersSent)
        res
          .status(400)
          .json({ error: error.message || "Не удалось выполнить действие." });
    },
  );
  return {
    app,
    db,
    importer,
    altitudeBackfill,
    async close() {
      await altitudeBackfill.close();
      await importer.close();
      db.close();
    },
  };
}
