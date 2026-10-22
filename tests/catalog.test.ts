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
import { AltitudeBackfill } from "../server/altitude-backfill.ts";
import { readAltitude, signedAltitude } from "../server/altitude.ts";
import { execFileSync } from "node:child_process";
import { isPublicHostname } from "../src/access.ts";
import {
  photoLink,
  linkedPhotoId,
  photoMapTarget,
} from "../src/photo-links.ts";

test("Ссылки открывают конкретное фото и приближают карту без передачи пароля", () => {
  const id = "b634628b-a4de-442e-893d-651a015cd244";
  const link = photoLink(
    id,
    "https://viewer:secret@gallery.example/path?q=private#old",
  );
  assert.equal(link, `https://gallery.example/#photo=${id}`);
  assert.equal(linkedPhotoId(new URL(link).hash), id);
  assert.equal(
    photoLink(id, "http://127.0.0.1:3210"),
    `http://127.0.0.1:3210/#photo=${id}`,
  );
  for (const invalid of [
    "",
    "#other=id",
    "#photo=../file",
    "#photo=%3Cscript%3E",
    "#photo=" + "a".repeat(129),
  ])
    assert.equal(linkedPhotoId(invalid), null);
  assert.throws(() => photoLink("../file", "https://gallery.example"));
  assert.throws(() => photoLink(id, "file:///photos"));
  assert.deepEqual(photoMapTarget({ id, lat: 0, lon: 0 }), {
    id,
    lat: 0,
    lon: 0,
    zoom: 17,
  });
  assert.deepEqual(photoMapTarget({ id, lat: -43.3, lon: -76.8 }), {
    id,
    lat: -43.3,
    lon: -76.8,
    zoom: 17,
  });
  for (const coords of [
    { lat: null, lon: 45 },
    { lat: 45, lon: null },
    { lat: 91, lon: 0 },
    { lat: 0, lon: 181 },
    { lat: NaN, lon: 0 },
  ])
    assert.equal(photoMapTarget({ id, ...coords }), null);
});

test("Публичный интерфейс скрывает управление библиотекой, локальный сохраняет его", async () => {
  for (const hostname of ["localhost", "LOCALHOST", "127.0.0.1"])
    assert.equal(isPublicHostname(hostname), false);
  for (const hostname of [
    "example.com",
    "endowment.ngrok-free.dev",
    "localhost.example.com",
    "127.0.0.1.example.com",
    "",
  ])
    assert.equal(isPublicHostname(hostname), true);
  const { createServer } = await import("vite");
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const vite = await createServer({
    configFile: false,
    logLevel: "error",
    server: { middlewareMode: true, hmr: false },
    plugins: [
      {
        name: "map-without-dom-for-render-test",
        enforce: "pre",
        resolveId(source) {
          if (/(?:^|\/)MapView(?:\.tsx)?$/.test(source.replaceAll("\\", "/")))
            return "\0map-render-stub";
        },
        load(id) {
          if (id === "\0map-render-stub")
            return "export const MapView=()=>null;export const PointPicker=()=>null;";
        },
      },
    ],
  });
  try {
    const { default: App } = await vite.ssrLoadModule("/src/App.tsx");
    const { ClusterDialog } = await vite.ssrLoadModule("/src/Dialogs.tsx");
    const controls = [
      "Настройки и копии",
      "Импортировать",
      "Создать альбом",
      "Новый альбом",
      "Выбрать фото",
      "Результаты импорта",
    ];
    for (const hostname of [
      "127.0.0.1",
      "localhost",
      "photos.ngrok-free.dev",
    ]) {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { location: { hostname } },
      });
      const html = renderToStaticMarkup(React.createElement(App));
      for (const label of controls)
        assert.equal(
          html.includes(label),
          !isPublicHostname(hostname),
          hostname + ": " + label,
        );
      assert.ok(html.includes("Все фотографии"));
      assert.ok(html.includes("Альбомы"));
      if (isPublicHostname(hostname))
        assert.ok(html.includes("Только просмотр"));
    }
    const props = {
      cluster: { clusterId: 1, snapshot: "test", count: 10 },
      onClose: () => {},
      onPhoto: () => {},
    };
    assert.ok(
      !renderToStaticMarkup(React.createElement(ClusterDialog, props)).includes(
        "Редактировать загруженные",
      ),
    );
    assert.ok(
      renderToStaticMarkup(
        React.createElement(ClusterDialog, { ...props, onEdit: () => {} }),
      ).includes("Редактировать загруженные"),
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
    await vite.close();
  }
});

test("Настройки передаются в PowerShell без потери кириллицы при любой кодировке консоли", () => {
  const source = path.join(os.tmpdir(), "Фото_Архив"),
    data = path.join(os.tmpdir(), "Фото_Каталог");
  const stdout = execFileSync(
    process.execPath,
    [path.resolve("server/print-config.ts")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PHOTO_SOURCE: source,
        PHOTO_DATA_DIR: data,
        PORT: "3210",
      },
    },
  );
  assert.doesNotMatch(stdout, /[^\x00-\x7f]/);
  // ASCII output is identical after a legacy console's single-byte decoding.
  const config = JSON.parse(Buffer.from(stdout, "utf8").toString("latin1"));
  assert.equal(config.sourceRoot, source);
  assert.equal(config.dataDir, data);
});

test("Экранное превью имеет отдельный кэш, ограничено 3840 пикселями и не меняет оригинал", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "geo-memories-screen-"));
  const source = path.join(temp, "source"),
    data = path.join(temp, "data");
  await fs.mkdir(source);
  const file = path.join(source, "wide.jpg");
  await sharp({
    create: { width: 5000, height: 60, channels: 3, background: "#416f9e" },
  })
    .jpeg()
    .toFile(file);
  const original = await fs.readFile(file),
    stat = await fs.stat(file);
  const service = createApp({
    sourceRoot: source,
    dataDir: data,
    port: 0,
    importConcurrency: 1,
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    service.db
      .prepare(
        "INSERT INTO photos(id,source_root,relative_path,filename,folder,size,mtime_ms,format) VALUES('screen-test',?,'wide.jpg','wide.jpg','',?,?,'JPEG')",
      )
      .run(source, stat.size, stat.mtimeMs);
    for (const [suffix, width] of [
      ["", 480],
      ["?size=large", 1800],
      ["?size=screen", 3840],
    ] as const) {
      const response = await fetch(
        base + "/api/photos/screen-test/preview" + suffix,
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /image\/webp/);
      const metadata = await sharp(
        Buffer.from(await response.arrayBuffer()),
      ).metadata();
      assert.equal(metadata.width, width);
    }
    const cached = await fs.readdir(path.join(data, "thumbnails"));
    assert.equal(cached.length, 3);
    const screenFile = path.join(
      data,
      "thumbnails",
      cached.find((f) => f.endsWith("-screen.webp"))!,
    );
    const before = (await fs.stat(screenFile)).mtimeMs;
    assert.equal(
      (await fetch(base + "/api/photos/screen-test/preview?size=screen"))
        .status,
      200,
    );
    assert.equal((await fs.stat(screenFile)).mtimeMs, before);
    assert.deepEqual(await fs.readFile(file), original);
    assert.equal((await fs.stat(file)).mtimeMs, stat.mtimeMs);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
    await service.close();
    assert.ok(
      inside(os.tmpdir(), temp) &&
        path.basename(temp).startsWith("geo-memories-screen-"),
    );
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("Дочитывание высоты мигрирует старую базу, продолжается после остановки и сохраняет оригиналы, кэш и ручные поправки", async () => {
  const temp = await fs.mkdtemp(
    path.join(os.tmpdir(), "geo-memories-altitude-"),
  );
  const source = path.join(temp, "photos"),
    data = path.join(temp, "data");
  await fs.mkdir(source);
  const jpeg = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#267366" },
  })
    .jpeg()
    .toBuffer();
  const high = path.join(source, "high.jpg"),
    low = path.join(source, "low.jpg"),
    none = path.join(source, "none.jpg"),
    bad = path.join(source, "bad.jpg");
  for (const file of [high, low, none, bad]) await fs.writeFile(file, jpeg);
  const tool = new ExifTool({ maxProcs: 1 });
  try {
    await tool.write(
      high,
      { GPSAltitude: 9360, GPSAltitudeRef: 0 },
      { writeArgs: ["-overwrite_original"] },
    );
    await tool.write(
      low,
      { GPSAltitude: -30 },
      { writeArgs: ["-overwrite_original"] },
    );
    await tool.write(
      bad,
      { GPSAltitude: 4294967295, GPSAltitudeRef: 0 },
      { writeArgs: ["-overwrite_original"] },
    );
    assert.equal(await readAltitude(high, "JPEG", tool), 9360);
    assert.equal(await readAltitude(low, "JPEG", tool), -30);
    assert.equal(await readAltitude(low, "TIFF", tool), -30);
    assert.equal(await readAltitude(high, "TIFF", tool), 9360);
    assert.equal(await readAltitude(none, "JPEG", tool), null);
    assert.equal(await readAltitude(bad, "JPEG", tool), 4294967295);
    assert.equal(signedAltitude(20, 3), -20);
  } finally {
    await tool.end();
  }
  const originals = await Promise.all(
    [high, low, none, bad].map((f) => fs.readFile(f)),
  );
  let db = openDatabase(data);
  for (const name of ["a-high", "b-low", "c-none", "d-bad", "e-missing"]) {
    const file = name.slice(2) + ".jpg";
    db.prepare(
      "INSERT INTO photos(id,source_root,relative_path,filename,folder,size,mtime_ms,format,original_lat,original_lon) VALUES(?,?,?,?,'',1,1,'JPEG',43,76)",
    ).run(name, source, file, file);
  }
  editPhotos(db, {
    ids: ["a-high"],
    description: "Сохранить",
    addTags: ["поездка"],
    location: { lat: 1, lon: 2 },
  });
  for (const column of [
    "original_altitude",
    "manual_altitude",
    "altitude_checked",
    "altitude_error",
  ])
    db.exec(`ALTER TABLE photos DROP COLUMN ${column}`);
  db.exec("PRAGMA user_version=1");
  db.close();
  db = openDatabase(data);
  const config = {
    sourceRoot: source,
    dataDir: data,
    port: 0,
    importConcurrency: 1,
  };
  let job = new AltitudeBackfill(db, config);
  await fs.mkdir(path.join(data, "thumbnails"));
  const preview = path.join(data, "thumbnails", "existing.webp");
  await fs.writeFile(preview, "existing preview");
  try {
    editPhotos(db, { ids: ["a-high"], altitude: 1234 });
    job.start();
    job.stop();
    await job.active;
    assert.equal(job.state, "paused");
    assert.ok(job.status().pending > 0);
    await job.close();
    db.close();
    db = openDatabase(data);
    job = new AltitudeBackfill(db, config);
    job.start();
    await job.active;
    assert.equal(job.state, "completed");
    assert.equal(job.status().pending, 0);
    assert.equal(job.status().failed, 1);
    assert.equal(job.status().invalid, 1);
    let photo = listPhotos(db, {}).photos.find((p) => p.id === "a-high")!;
    assert.equal(photo.original_altitude, 9360);
    assert.equal(photo.altitude, 1234);
    assert.equal(photo.description, "Сохранить");
    assert.equal(photo.lat, 1);
    assert.deepEqual(photo.tags, ["поездка"]);
    assert.equal(
      listPhotos(db, {}).photos.find((p) => p.id === "b-low")!.altitude,
      -30,
    );
    assert.equal(
      listPhotos(db, {}).photos.find((p) => p.id === "c-none")!.altitude,
      null,
    );
    assert.equal(
      listPhotos(db, {}).photos.find((p) => p.id === "d-bad")!.altitude,
      null,
    );
    editPhotos(db, { ids: ["a-high"], altitude: null });
    assert.equal(
      listPhotos(db, {}).photos.find((p) => p.id === "a-high")!.altitude,
      9360,
    );
    assert.throws(() =>
      editPhotos(db, { ids: ["a-high"], altitude: 4294967295 }),
    );
    assert.throws(() =>
      editPhotos(db, {
        ids: ["a-high"],
        altitude: "9000" as unknown as number,
      }),
    );
    await fs.rename(high, high + ".offline");
    job.start();
    await job.active;
    assert.equal(job.status().failed, 1); // checked originals are not read again
    await fs.writeFile(path.join(source, "missing.jpg"), jpeg);
    job.start(true);
    await job.active;
    assert.equal(job.status().failed, 0);
    await fs.rename(high + ".offline", high);
    assert.deepEqual(
      await Promise.all([high, low, none, bad].map((f) => fs.readFile(f))),
      originals,
    );
    assert.equal(await fs.readFile(preview, "utf8"), "existing preview");
  } finally {
    await job.close();
    db.close();
    assert.ok(
      inside(os.tmpdir(), temp) &&
        path.basename(temp).startsWith("geo-memories-altitude-"),
    );
    await fs.rm(temp, { recursive: true, force: true });
  }
});

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
        GPSAltitude: 9360,
        GPSAltitudeRef: 0,
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
    assert.equal(result.photos[0].altitude, 9360);
    assert.equal(result.photos[0].altitude_checked, 1);
    assert.equal(result.photos[0].taken_at, "2020-01-02T03:04:05");
    assert.equal((await req("/api/photos?bbox=76,43,77,44&limit=1")).total, 2);
    assert.equal((await req("/api/photos?bbox=0,0,1,1")).total, 0);
    const issues = await req("/api/photos?issues=1");
    assert.equal(issues.total, 2);
    const map = await req("/api/map?zoom=3");
    assert.equal(map.features[0].properties.point_count, 2);
    assert.equal(map.features[0].properties.flightCount, 2);
    const singles = await req("/api/map?zoom=20");
    assert.equal(singles.features[0].properties.altitude, 9360);
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
      altitude: 100,
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
    assert.equal(photo.altitude, 100);
    assert.equal(
      (await req("/api/map?zoom=3")).features[0].properties.flightCount,
      0,
    );
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
      altitude: null,
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
