import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export type Config = {
  sourceRoot: string;
  dataDir: string;
  port: number;
  importConcurrency: number;
  portable?: boolean;
};
export function inside(root: string, file: string) {
  const rel = path.relative(root, file);
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export function loadConfig(): Config {
  const file = path.join(projectRoot, "config.local.json");
  const local = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  return resolveConfig({
    ...local,
    sourceRoot: process.env.PHOTO_SOURCE || local.sourceRoot || "../Photos",
    dataDir: process.env.PHOTO_DATA_DIR || local.dataDir || "data",
    port: Number(process.env.PORT || local.port || 3210),
  });
}

export function resolveConfig(
  values: Partial<Config>,
  appRoot = projectRoot,
): Config {
  const config: Config = {
    sourceRoot: path.resolve(appRoot, values.sourceRoot || "../Photos"),
    dataDir: path.resolve(appRoot, values.dataDir || "data"),
    port: Number(values.port || 3210),
    importConcurrency: Math.max(
      1,
      Math.min(4, Number(values.importConcurrency || 2)),
    ),
    portable: values.portable === true,
  };
  const appWithinArchive =
    appRoot !== config.sourceRoot && inside(config.sourceRoot, appRoot);
  if (inside(appRoot, config.sourceRoot))
    throw Error(
      "Папка оригиналов должна находиться вне папки приложения или быть её родительской папкой.",
    );
  const managedData =
    (appWithinArchive && inside(appRoot, config.dataDir)) ||
    fs.existsSync(path.join(config.dataDir, ".geo-memories-data"));
  if (
    inside(config.dataDir, config.sourceRoot) ||
    (inside(config.sourceRoot, config.dataDir) && !managedData)
  )
    throw Error(
      "Внутри архива данные можно хранить только в выделенной папке приложения. Папка данных не должна совпадать с архивом или содержать его.",
    );
  if (config.portable && !appWithinArchive)
    throw Error(
      "В переносимом режиме приложение должно находиться в отдельной подпапке архива фотографий.",
    );
  return config;
}
