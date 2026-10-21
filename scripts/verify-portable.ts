import fs from "node:fs";
import path from "node:path";
import { loadConfig, projectRoot } from "../server/config.ts";
import { createApp } from "../server/app.ts";
import type { AddressInfo } from "node:net";

const config = loadConfig();
if (!config.portable) throw Error("Verification requires portable mode.");
const service = createApp(config);
const server = service.app.listen(0, "127.0.0.1");
try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const statusResponse = await fetch(base + "/api/status");
  if (!statusResponse.ok) throw Error("Status API failed.");
  const status = await statusResponse.json();
  const pageResponse = await fetch(base + "/api/photos?limit=10");
  if (!pageResponse.ok) throw Error("Photos API failed.");
  const page = await pageResponse.json();
  let preview = false;
  for (const photo of page.photos.slice(0, 5)) {
    const response = await fetch(`${base}/api/photos/${photo.id}/preview`);
    if (response.ok && (await response.arrayBuffer()).byteLength > 0) {
      preview = true;
      break;
    }
  }
  if (page.total > 0 && !preview)
    throw Error(
      "Could not preview any of the first five photos. Source data has been retained.",
    );
  const map = await fetch(base + "/api/map?bbox=-180,-85,180,85&zoom=1");
  if (!map.ok) throw Error("Map API failed.");
  const index = await fetch(base + "/");
  if (!index.ok || !(await index.text()).includes("root"))
    throw Error("Built interface is not available.");
  const result = {
    verified: true,
    node: process.version,
    projectRoot,
    sourceRoot: config.sourceRoot,
    dataDir: config.dataDir,
    stats: status.stats,
    previewChecked: preview,
  };
  fs.writeFileSync(
    path.join(projectRoot, "deployment-verification.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  await service.close();
}
