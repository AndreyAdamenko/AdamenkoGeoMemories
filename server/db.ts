import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const marker = path.join(dataDir, ".geo-memories-data");
  if (!fs.existsSync(marker))
    fs.writeFileSync(marker, "GeoMemories application data v1\n", {
      flag: "wx",
    });
  const db = new DatabaseSync(path.join(dataDir, "catalog.sqlite"));
  // SQLite's built-in lower()/NOCASE only cover ASCII; Russian search needs Unicode folding.
  db.function("fold", { deterministic: true }, (value) =>
    String(value ?? "")
      .normalize("NFKC")
      .toLocaleLowerCase("ru-RU"),
  );
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY, source_root TEXT NOT NULL, relative_path TEXT NOT NULL,
      filename TEXT NOT NULL, folder TEXT NOT NULL, size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL, format TEXT, width INTEGER, height INTEGER,
      taken_at TEXT, date_source TEXT, original_lat REAL, original_lon REAL,
      manual_lat REAL, manual_lon REAL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ready', error TEXT, metadata_json TEXT,
      seen_run TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_root, relative_path)
    );
    CREATE INDEX IF NOT EXISTS photos_date ON photos(taken_at DESC, id);
    CREATE INDEX IF NOT EXISTS photos_folder ON photos(folder);
    CREATE INDEX IF NOT EXISTS photos_status ON photos(status);
    CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS photo_tags (
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY(photo_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS photo_tags_tag ON photo_tags(tag_id, photo_id);
    CREATE TABLE IF NOT EXISTS albums (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS album_photos (
      album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      PRIMARY KEY(album_id, photo_id)
    );
    CREATE INDEX IF NOT EXISTS album_photos_photo ON album_photos(photo_id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version=1;
  `);
  return db;
}
export type DB = ReturnType<typeof openDatabase>;
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
