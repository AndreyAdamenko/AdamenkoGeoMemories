import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { DB } from "./db.ts";
import { transaction } from "./db.ts";

export const LAT = "COALESCE(p.manual_lat,p.original_lat)";
export const LON = "COALESCE(p.manual_lon,p.original_lon)";
export type Filters = {
  q?: string;
  folder?: string;
  tag?: string;
  album?: string;
  gps?: string;
  from?: string;
  to?: string;
  issues?: string;
  bbox?: string;
};
export function filterSQL(f: Filters) {
  const clauses = [
    f.issues === "1" ? "p.status != 'ready'" : "p.status = 'ready'",
  ];
  const values: SQLInputValue[] = [];
  const add = (sql: string, ...v: SQLInputValue[]) => {
    clauses.push(sql);
    values.push(...v);
  };
  if (f.q) {
    const q = `%${f.q
      .slice(0, 200)
      .normalize("NFKC")
      .toLocaleLowerCase("ru-RU")
      .replace(/[\\%_]/g, "\\$&")}%`;
    add(
      "(fold(p.filename) LIKE ? ESCAPE '\\' OR fold(p.description) LIKE ? ESCAPE '\\' OR fold(p.folder) LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM photo_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.photo_id=p.id AND fold(t.name) LIKE ? ESCAPE '\\'))",
      q,
      q,
      q,
      q,
    );
  }
  if (f.folder)
    add(
      "(p.folder = ? OR substr(p.folder,1,length(?)+1) = ? || '/')",
      f.folder,
      f.folder,
      f.folder,
    );
  if (f.tag)
    add(
      "EXISTS(SELECT 1 FROM photo_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.photo_id=p.id AND t.name=?)",
      f.tag.normalize("NFKC").toLocaleLowerCase("ru-RU"),
    );
  if (f.album)
    add(
      "EXISTS(SELECT 1 FROM album_photos ap WHERE ap.photo_id=p.id AND ap.album_id=?)",
      f.album,
    );
  if (f.gps === "yes") add(`${LAT} IS NOT NULL AND ${LON} IS NOT NULL`);
  if (f.gps === "no") add(`(${LAT} IS NULL OR ${LON} IS NULL)`);
  if (f.bbox !== undefined) {
    const parts = f.bbox.split(",");
    const bounds = parts.map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => !p.trim()) ||
      bounds.some((n) => !Number.isFinite(n)) ||
      bounds[1] < -90 ||
      bounds[3] > 90 ||
      bounds[1] > bounds[3]
    )
      throw Error("Некорректная область карты.");
    const [west, south, east, north] = bounds;
    add(`${LAT} BETWEEN ? AND ?`, south, north);
    add(`${LON} IS NOT NULL`);
    if (east - west < 360) {
      const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
      const w = wrap(west),
        e = wrap(east);
      if (w <= e) add(`${LON} BETWEEN ? AND ?`, w, e);
      else add(`(${LON} >= ? OR ${LON} <= ?)`, w, e);
    }
  }
  if (f.from) add("p.taken_at >= ?", f.from);
  if (f.to) add("p.taken_at < ?", `${f.to}T99`);
  return { where: clauses.join(" AND "), values };
}
const SELECT_PHOTO = `p.id,p.filename,p.relative_path,p.folder,p.size,p.format,p.width,p.height,p.taken_at,p.date_source,p.original_lat,p.original_lon,p.manual_lat,p.manual_lon,p.description,p.status,p.error,${LAT} AS lat,${LON} AS lon`;
export function listPhotos(db: DB, filters: Filters, offset = 0, limit = 80) {
  const { where, values } = filterSQL(filters);
  const total = Number(
    db
      .prepare(`SELECT count(*) AS n FROM photos p WHERE ${where}`)
      .get(...values)!.n,
  );
  const photos = db
    .prepare(
      `SELECT ${SELECT_PHOTO} FROM photos p WHERE ${where} ORDER BY p.taken_at DESC,p.id LIMIT ? OFFSET ?`,
    )
    .all(...values, limit, offset);
  return { total, photos: photos.map((p) => attach(db, p)), offset, limit };
}
function attach(db: DB, p: Record<string, unknown>) {
  return {
    ...p,
    tags: db
      .prepare(
        "SELECT t.name FROM tags t JOIN photo_tags pt ON pt.tag_id=t.id WHERE pt.photo_id=? ORDER BY t.name",
      )
      .all(String(p.id))
      .map((t) => t.name),
    albums: db
      .prepare(
        "SELECT a.id,a.name FROM albums a JOIN album_photos ap ON ap.album_id=a.id WHERE ap.photo_id=? ORDER BY a.name",
      )
      .all(String(p.id)),
  };
}
export function getPhoto(db: DB, id: string) {
  const p = db
    .prepare(
      `SELECT ${SELECT_PHOTO},p.source_root,p.metadata_json FROM photos p WHERE p.id=?`,
    )
    .get(id);
  return p ? attach(db, p) : null;
}
export function stats(db: DB) {
  const row = db
    .prepare(
      `SELECT count(*) AS total,
    sum(status='ready') AS ready,
    sum(status='ready' AND COALESCE(manual_lat,original_lat) IS NOT NULL AND COALESCE(manual_lon,original_lon) IS NOT NULL) AS located,
    sum(status!='ready') AS issues,
    sum(status='empty') AS empty,
    sum(status='missing') AS missing,
    sum(status='ready' AND manual_lat IS NOT NULL) AS manual
    FROM photos`,
    )
    .get()!;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value || 0)]),
  );
}
export function facets(db: DB) {
  return {
    folders: db
      .prepare(
        "SELECT folder,count(*) AS count FROM photos WHERE status='ready' GROUP BY folder ORDER BY folder",
      )
      .all(),
    tags: db
      .prepare(
        "SELECT t.id,t.name,count(*) AS count FROM tags t JOIN photo_tags pt ON pt.tag_id=t.id JOIN photos p ON p.id=pt.photo_id WHERE p.status='ready' GROUP BY t.id ORDER BY t.name",
      )
      .all(),
    albums: db
      .prepare(
        `SELECT a.*,count(p.id) AS count,(SELECT ap2.photo_id FROM album_photos ap2 JOIN photos p2 ON p2.id=ap2.photo_id WHERE ap2.album_id=a.id AND p2.status='ready' ORDER BY p2.taken_at DESC LIMIT 1) AS cover_id FROM albums a LEFT JOIN album_photos ap ON ap.album_id=a.id LEFT JOIN photos p ON p.id=ap.photo_id AND p.status='ready' GROUP BY a.id ORDER BY a.created_at DESC,a.id`,
      )
      .all(),
  };
}
export function validCoordinates(lat: unknown, lon: unknown) {
  return (
    typeof lat === "number" &&
    typeof lon === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  );
}
export type Edit = {
  ids: string[];
  description?: string;
  addTags?: string[];
  removeTags?: string[];
  location?: { lat: number; lon: number } | null;
  albumId?: string;
  removeAlbumId?: string;
};
export function editPhotos(db: DB, edit: Edit) {
  if (
    !Array.isArray(edit.ids) ||
    !edit.ids.length ||
    edit.ids.length > 10000 ||
    edit.ids.some((id) => typeof id !== "string")
  )
    throw Error("Выберите от 1 до 10 000 фотографий.");
  const ids = [...new Set(edit.ids)];
  if (
    edit.description !== undefined &&
    (typeof edit.description !== "string" || edit.description.length > 20000)
  )
    throw Error("Описание должно быть текстом до 20 000 символов.");
  if (
    edit.location !== undefined &&
    edit.location !== null &&
    !validCoordinates(edit.location.lat, edit.location.lon)
  )
    throw Error("Широта: от −90 до 90. Долгота: от −180 до 180.");
  const tagList = (input: unknown): string[] => {
    if (input === undefined) return [];
    if (
      !Array.isArray(input) ||
      input.length > 100 ||
      input.some((t) => typeof t !== "string" || t.trim().length > 80)
    )
      throw Error("Теги: до 100 названий длиной не более 80 символов.");
    return [
      ...new Set(
        input
          .map((t) => t.trim().normalize("NFKC").toLocaleLowerCase("ru-RU"))
          .filter(Boolean),
      ),
    ];
  };
  const addTags = tagList(edit.addTags),
    removeTags = tagList(edit.removeTags);
  return transaction(db, () => {
    for (const albumId of [edit.albumId, edit.removeAlbumId])
      if (
        albumId &&
        !db.prepare("SELECT id FROM albums WHERE id=?").get(albumId)
      )
        throw Error("Альбом не найден.");
    for (const id of ids) {
      if (!db.prepare("SELECT id FROM photos WHERE id=?").get(id))
        throw Error("Фотография не найдена.");
      if (edit.description !== undefined)
        db.prepare(
          "UPDATE photos SET description=?,updated_at=datetime('now') WHERE id=?",
        ).run(edit.description, id);
      if (edit.location !== undefined)
        db.prepare(
          "UPDATE photos SET manual_lat=?,manual_lon=?,updated_at=datetime('now') WHERE id=?",
        ).run(edit.location?.lat ?? null, edit.location?.lon ?? null, id);
      for (const name of addTags) {
        db.prepare(
          "INSERT INTO tags(name) VALUES(?) ON CONFLICT(name) DO NOTHING",
        ).run(name);
        const tag = db.prepare("SELECT id FROM tags WHERE name=?").get(name)!;
        db.prepare(
          "INSERT OR IGNORE INTO photo_tags(photo_id,tag_id) VALUES(?,?)",
        ).run(id, tag.id as number);
      }
      for (const name of removeTags)
        db.prepare(
          "DELETE FROM photo_tags WHERE photo_id=? AND tag_id IN (SELECT id FROM tags WHERE name=?)",
        ).run(id, name);
      if (edit.albumId)
        db.prepare(
          "INSERT OR IGNORE INTO album_photos(album_id,photo_id) VALUES(?,?)",
        ).run(edit.albumId, id);
      if (edit.removeAlbumId)
        db.prepare(
          "DELETE FROM album_photos WHERE album_id=? AND photo_id=?",
        ).run(edit.removeAlbumId, id);
    }
    return { updated: ids.length };
  });
}
export function saveAlbum(
  db: DB,
  input: { id?: string; name: string; description?: string },
) {
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 200
  )
    throw Error("Введите название альбома, до 200 символов.");
  if (
    input.description !== undefined &&
    (typeof input.description !== "string" || input.description.length > 20000)
  )
    throw Error("Описание альбома слишком длинное.");
  const id = input.id || randomUUID();
  if (input.id && !db.prepare("SELECT id FROM albums WHERE id=?").get(id))
    throw Error("Альбом не найден.");
  db.prepare(
    "INSERT INTO albums(id,name,description) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description",
  ).run(id, input.name.trim(), input.description || "");
  return { id };
}
