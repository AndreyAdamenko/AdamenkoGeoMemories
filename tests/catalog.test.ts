import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { ExifTool } from "exiftool-vendored";
import { createApp } from "../server/app.ts";
import type { Config } from "../server/config.ts";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../server/db.ts";
import { listPhotos, editPhotos } from "../server/catalog.ts";
import { resolveConfig, inside } from "../server/config.ts";
import { preparePortableCatalog } from "../server/portable.ts";
import { originalPath } from "../server/media.ts";
import { Importer } from "../server/importer.ts";

test("Перенос архива сохраняет ID, кэш и подписи; программа и миниатюры не импортируются", async () => {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "geo-memories-portable-"),
  );
  const oldArchive = path.join(temp, "diskA", "photos"),
    newArchive = path.join(temp, "diskB", "renamed-photos");
  const oldApp = path.join(oldArchive, "_GeoMemories");
  await fs.mkdir(oldApp, { recursive: true });
  await fs.writeFile(path.join(oldApp, ".geo-memories-app"), "GeoMemories");
  const photoFile = path.join(oldArchive, "scene.jpg");
  const jpeg = await sharp({
    create: { width: 40, height: 30, channels: 3, background: "#267366" },
  })
    .jpeg()
    .toBuffer();
  await fs.writeFile(photoFile, jpeg);
  await fs.writeFile(path.join(oldApp, "dependency.jpg"), jpeg);
  const before = await fs.stat(photoFile);
  let config = resolveConfig(
    { sourceRoot: "..", dataDir: "./data", portable: true },
    oldApp,
  );
  assert.equal(config.sourceRoot, oldArchive);
  assert.throws(() =>
    resolveConfig({ sourceRoot: oldArchive, dataDir: oldArchive }, oldApp),
  );
  assert.throws(() =>
    resolveConfig(
      {
        sourceRoot: oldArchive,
        dataDir: path.join(oldArchive, "ordinary-photo-folder"),
      },
      path.join(temp, "checkout"),
    ),
  );
  let db = openDatabase(config.dataDir);
  let importer: Importer | undefined;
  try {
    db.prepare(
      "INSERT INTO photos(id,source_root,relative_path,filename,folder,size,mtime_ms,original_lat,original_lon) VALUES('portable-id',?,'scene.jpg','scene.jpg','',?,?,43.2,76.9)",
    ).run(oldArchive, before.size, before.mtimeMs);
    editPhotos(db, {
      ids: ["portable-id"],
      description: "Сохранённая история",
      addTags: ["семья"],
      location: { lat: 42, lon: 75 },
    });
    preparePortableCatalog(db, config);
    await fs.mkdir(path.join(config.dataDir, "thumbnails"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(config.dataDir, "thumbnails", "existing-preview.webp"),
      jpeg,
    );
    db.close();
    await fs.mkdir(path.dirname(newArchive), { recursive: true });
    assert.ok(inside(temp, oldArchive) && inside(temp, newArchive));
    await fs.rename(oldArchive, newArchive);
    config = resolveConfig(
      { sourceRoot: "..", dataDir: "./data", portable: true },
      path.join(newArchive, "_GeoMemories"),
    );
    db = openDatabase(config.dataDir);
    preparePortableCatalog(db, config);
    preparePortableCatalog(db, config);
    const record = db
      .prepare("SELECT * FROM photos WHERE id='portable-id'")
      .get()!;
    assert.equal(record.source_root, newArchive);
    assert.equal(record.description, "Сохранённая история");
    assert.equal(record.manual_lat, 42);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM photo_tags").get()!.n,
      1,
    );
    assert.equal(
      (await originalPath(db, "portable-id")).file,
      await fs.realpath(path.join(newArchive, "scene.jpg")),
    );
    assert.deepEqual(
      await fs.readFile(
        path.join(config.dataDir, "thumbnails", "existing-preview.webp"),
      ),
      jpeg,
    );
    // The working checkout may use the marked data directory on the portable disk too.
    assert.equal(
      resolveConfig(
        { sourceRoot: newArchive, dataDir: config.dataDir },
        path.join(temp, "checkout"),
      ).dataDir,
      config.dataDir,
    );
    importer = new Importer(db, config);
    importer.start();
    await importer.active;
    assert.equal(importer.job.state, "completed");
    assert.equal(importer.job.discovered, 1);
    assert.equal(importer.job.unchanged, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM photos").get()!.n, 1);
    assert.deepEqual(
      await fs.readFile(path.join(newArchive, "scene.jpg")),
      jpeg,
    );
  } finally {
    await importer?.close();
    db.close();
    assert.ok(
      inside(os.tmpdir(), temp) &&
        path.basename(temp).startsWith("geo-memories-portable-"),
    );
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Область карты ограничивает количество и страницы фотографий, учитывает ручные координаты и переход через 180°", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "geo-memories-bounds-"));
  const db = openDatabase(temp);
  try {
    const insert = db.prepare(
      "INSERT INTO photos(id,source_root,relative_path,filename,folder,size,mtime_ms,original_lat,original_lon,manual_lat,manual_lon) VALUES(?,?,?,?,?,1,0,?,?,?,?)",
    );
    for (const [id, lat, lon, manualLat, manualLon] of [
      ["inside", 43.2, 76.5, null, null],
      ["manual", 10, 10, 43.4, 76.7],
      ["outside", 44.5, 78, null, null],
      ["east", 5, 179, null, null],
      ["west", 5, -179, null, null],
      ["unlocated", null, null, null, null],
    ] as const)
      insert.run(id, "test", id, id, "", lat, lon, manualLat, manualLon);
    const bbox = "76,43,77,44";
    const page1 = listPhotos(db, { bbox }, 0, 1),
      page2 = listPhotos(db, { bbox }, 1, 1);
    assert.equal(page1.total, 2);
    assert.equal(page1.photos.length, 1);
    assert.notDeepEqual(page1.photos, page2.photos);
    assert.equal(listPhotos(db, { bbox: "0,50,1,51" }).total, 0);
    assert.equal(listPhotos(db, { bbox: "436,43,437,44" }).total, 2);
    assert.equal(listPhotos(db, { bbox: "170,0,-170,10" }).total, 2);
    assert.equal(listPhotos(db, { bbox: "-540,-90,540,90" }).total, 5);
    assert.equal(listPhotos(db, {}).total, 6);
    editPhotos(db, { ids: ["inside", "outside"], addTags: ["тест"] });
    assert.equal(listPhotos(db, { bbox, tag: "тест" }).total, 1);
    editPhotos(db, { ids: ["inside"], location: { lat: 50, lon: 50 } });
    assert.equal(listPhotos(db, { bbox }).total, 1);
    assert.throws(() => listPhotos(db, { bbox: "NaN,0,10,20" }), /область/);
    assert.throws(() => listPhotos(db, { bbox: "0,20,10,0" }), /область/);
  } finally {
    db.close();
    if (
      !path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(temp).startsWith("geo-memories-bounds-")
    )
      throw Error("Unsafe test cleanup path");
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Импорт, карта, групповое редактирование, повторный импорт и перезапуск сохраняют данные и оригиналы", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "geo-memories-"));
  const source = path.join(temp, "source"),
    data = path.join(temp, "data");
  await fs.mkdir(path.join(source, "20200102_Поездка"), { recursive: true });
  const first = path.join(source, "20200102_Поездка", "с координатами.jpg"),
    second = path.join(source, "20200102_Поездка", "неверное расширение.png");
  await sharp({
    create: { width: 100, height: 70, channels: 3, background: "#267366" },
  })
    .jpeg()
    .toFile(first);
  const writer = new ExifTool({ maxProcs: 1 });
  try {
    await writer.write(
      first,
      {
        GPSLatitude: 43.2,
        GPSLongitude: 76.9,
        DateTimeOriginal: "2020:01:02 03:04:05",
      },
      { writeArgs: ["-overwrite_original"] },
    );
  } finally {
    await writer.end();
  }
  await fs.copyFile(first, second);
  await fs.writeFile(path.join(source, "пустой.jpg"), "");
  await fs.writeFile(path.join(source, "документ.jpg"), "Это не фотография");
  const hash = async (file: string) =>
    createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
  const originalHashes = await Promise.all([hash(first), hash(second)]);
  const config: Config = {
    sourceRoot: source,
    dataDir: data,
    port: 0,
    importConcurrency: 2,
  };
  let service = createApp(config),
    server: Server | undefined;
  let base = "";
  const listen = async () => {
    server = service.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    base = `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  };
  const req = async (
    url: string,
    body?: unknown,
    method = body ? "POST" : "GET",
  ) => {
    const response = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(
      response.status >= 200 && response.status < 300,
      true,
      `${url}: ${await response.clone().text()}`,
    );
    return response.json();
  };
  const stopServer = async () => {
    await new Promise<void>((resolve, reject) =>
      server!.close((e) => (e ? reject(e) : resolve())),
    );
    await service.close();
  };
  try {
    await listen();
    await req("/api/import/start", {});
    await service.importer.active;
    assert.equal(service.importer.job.state, "completed");
    const result = await req("/api/photos");
    assert.equal(result.total, 2);
    const ids = result.photos.map((p: { id: string }) => p.id);
    assert.equal(result.photos[0].lat, 43.2);
    assert.equal(result.photos[0].lon, 76.9);
    assert.equal(result.photos[0].taken_at, "2020-01-02T03:04:05");
    assert.equal((await req("/api/photos?bbox=76,43,77,44&limit=1")).total, 2);
    assert.equal((await req("/api/photos?bbox=0,0,1,1")).total, 0);
    const issues = await req("/api/photos?issues=1");
    assert.equal(issues.total, 2);
    const map = await req("/api/map?zoom=3");
    assert.equal(map.features[0].properties.point_count, 2);
    const leaves = await req(
      `/api/map/leaves?snapshot=${map.snapshot}&clusterId=${map.features[0].properties.cluster_id}`,
    );
    assert.equal(leaves.photos.length, 2);
    const album = await req("/api/albums", {
      name: "Путешествие",
      description: "Проверка кириллицы",
    });
    await req("/api/photos/edit", {
      ids,
      description: "Наша поездка",
      addTags: ["СЕМЬЯ", "горы"],
      location: { lat: -12.5, lon: 130.8 },
      albumId: album.id,
    });
    assert.equal((await req("/api/photos?album=" + album.id)).total, 2);
    assert.equal((await req("/api/photos?bbox=76,43,77,44")).total, 0);
    assert.equal(
      (await req(`/api/photos?bbox=130,-13,131,-12&album=${album.id}`)).total,
      2,
    );
    assert.equal(
      (await req("/api/photos?tag=" + encodeURIComponent("горы"))).total,
      2,
    );
    assert.equal(
      (await req("/api/photos?q=" + encodeURIComponent("наша"))).total,
      2,
    );
    const invalid = await fetch(base + "/api/photos/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, location: { lat: 100, lon: 1 } }),
    });
    assert.equal(invalid.status, 400);
    // An invalid member must roll back the entire bulk operation.
    const atomic = await fetch(base + "/api/photos/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: [ids[0], "missing-id"],
        description: "should rollback",
      }),
    });
    assert.equal(atomic.status, 400);
    assert.equal(
      (await req("/api/photos/" + ids[0])).description,
      "Наша поездка",
    );
    const preview = await fetch(base + `/api/photos/${ids[0]}/preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/webp");
    assert.ok((await preview.arrayBuffer()).byteLength > 20);
    // Force metadata refresh; manual coordinates and annotations must survive it.
    await fs.utimes(first, new Date(), new Date());
    await req("/api/import/start", {});
    await service.importer.active;
    let photo = await req("/api/photos/" + ids[0]);
    assert.equal(photo.description, "Наша поездка");
    assert.equal(photo.lat, -12.5);
    assert.deepEqual(photo.tags, ["горы", "семья"]);
    assert.equal((await req("/api/photos?album=" + album.id)).total, 2);
    assert.deepEqual(
      await Promise.all([hash(first), hash(second)]),
      originalHashes,
    );
    const exported = await req("/api/export");
    assert.equal(
      exported.photos.filter(
        (p: { description: string }) => p.description === "Наша поездка",
      ).length,
      2,
    );
    const backup = await fetch(base + "/api/backup");
    assert.equal(backup.status, 200);
    const backupFile = path.join(temp, "backup.sqlite");
    await fs.writeFile(backupFile, Buffer.from(await backup.arrayBuffer()));
    const backupDb = new DatabaseSync(backupFile);
    assert.equal(
      backupDb.prepare("SELECT count(*) AS n FROM album_photos").get()!.n,
      2,
    );
    backupDb.close();
    const crossOrigin = await fetch(base + "/api/import/start", {
      method: "POST",
      headers: {
        Origin: "https://example.com",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(crossOrigin.status, 403);
    await stopServer();
    service = createApp(config);
    await listen();
    photo = await req("/api/photos/" + ids[0]);
    assert.equal(photo.lat, -12.5);
    assert.equal(photo.description, "Наша поездка");
    await req("/api/photos/edit", {
      ids,
      location: null,
      removeTags: ["горы"],
      removeAlbumId: album.id,
    });
    photo = await req("/api/photos/" + ids[0]);
    assert.equal(photo.lat, 43.2);
    assert.equal(photo.manual_lat, null);
    assert.deepEqual(photo.tags, ["семья"]);
    assert.equal((await req("/api/photos?album=" + album.id)).total, 0);
    // Missing source never empties the catalog; a completed accessible scan marks absent files.
    await fs.rename(source, source + "-offline");
    await req("/api/import/start", {});
    await service.importer.active;
    assert.equal(service.importer.job.state, "error");
    assert.equal((await req("/api/photos")).total, 2);
    await fs.rename(source + "-offline", source);
    await fs.rename(second, second + ".moved");
    await req("/api/import/start", {});
    await service.importer.active;
    assert.equal((await req("/api/photos")).total, 1);
    await fs.rename(second + ".moved", second);
    await req("/api/import/start", {});
    await service.importer.active;
    assert.equal((await req("/api/photos")).total, 2);
    assert.deepEqual(
      await Promise.all([hash(first), hash(second)]),
      originalHashes,
    );
  } finally {
    if (server?.listening) await stopServer();
    if (
      !path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(temp).startsWith("geo-memories-")
    )
      throw Error("Unsafe test cleanup path");
    await fs.rm(temp, { recursive: true, force: true });
  }
});
