import { loadConfig } from "./config.ts";
import { openDatabase } from "./db.ts";
import { Importer } from "./importer.ts";
import { preparePortableCatalog } from "./portable.ts";

const config = loadConfig(),
  db = openDatabase(config.dataDir);
preparePortableCatalog(db, config);
const importer = new Importer(db, config);
process.on("SIGINT", () => importer.stop());
importer.start();
const timer = setInterval(
  () => console.log(JSON.stringify(importer.job)),
  5000,
);
try {
  await importer.active;
  console.log(JSON.stringify(importer.job, null, 2));
  if (importer.job.state === "error") process.exitCode = 1;
} finally {
  clearInterval(timer);
  await importer.close();
  db.close();
}
