import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { transaction } from "./db.ts";

// The relative paths and photo IDs stay the same when an archive changes drive letter.
export function preparePortableCatalog(db: DB, config: Config) {
  if (!config.portable) return;
  transaction(db, () => {
    const saved = db
      .prepare("SELECT value FROM settings WHERE key='portable_source_root'")
      .get();
    let previous = saved ? String(saved.value) : null;
    if (!previous) {
      const roots = db.prepare("SELECT DISTINCT source_root FROM photos").all();
      if (roots.length > 1)
        throw Error(
          "В каталоге несколько архивов. Автоматический перенос путей отменён, чтобы сохранить привязки фотографий.",
        );
      previous = roots.length
        ? String(roots[0].source_root)
        : config.sourceRoot;
    }
    if (previous !== config.sourceRoot) {
      db.prepare("UPDATE photos SET source_root=? WHERE source_root=?").run(
        config.sourceRoot,
        previous,
      );
    }
    db.prepare(
      "INSERT INTO settings(key,value) VALUES('portable_source_root',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(config.sourceRoot);
  });
}
