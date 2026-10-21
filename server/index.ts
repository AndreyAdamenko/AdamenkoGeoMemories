import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const service = createApp(config);
const server = service.app.listen(config.port, "127.0.0.1", () => {
  console.log(
    `\nAdamenkoGeoMemories → http://127.0.0.1:${config.port}\nОригиналы (только чтение): ${config.sourceRoot}\nДанные: ${config.dataDir}\n`,
  );
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  console.log("Сохраняю состояние импорта…");
  server.close();
  await service.close();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
server.on("error", async (error) => {
  console.error(error.message);
  await service.close();
  process.exit(1);
});
