const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const localNode = path.join(
  root,
  "node_modules",
  "node",
  "bin",
  process.platform === "win32" ? "node.exe" : "node",
);
const node = fs.existsSync(localNode) ? localNode : process.execPath;
if (
  node === process.execPath &&
  Number(process.versions.node.split(".")[0]) < 24
) {
  console.error(
    "Нужен Node.js 24+. Выполните npm install — он установит Node.js локально для проекта.",
  );
  process.exit(1);
}
const mode = process.argv[2] || "start";
const env = {
  ...process.env,
  PATH: `${path.dirname(node)}${path.delimiter}${process.env.PATH || process.env.Path || ""}`,
};
const run = (args) => {
  const result = spawnSync(node, args, { cwd: root, stdio: "inherit", env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
};
if (mode === "setup")
  run([
    process.env.npm_execpath,
    "install",
    "--include=optional",
    "--no-audit",
    "--no-fund",
  ]);
else if (mode === "build") run(["node_modules/vite/bin/vite.js", "build"]);
else if (mode === "check") run(["node_modules/typescript/bin/tsc", "--noEmit"]);
else if (mode === "test")
  run(["--test", "--test-concurrency=1", "tests/catalog.test.ts"]);
else if (mode === "import")
  run(["server/import-cli.ts", ...process.argv.slice(3)]);
else if (mode === "start") {
  run(["node_modules/vite/bin/vite.js", "build"]);
  run(["server/index.ts"]);
} else if (mode === "dev") {
  const children = [
    spawn(node, ["--watch", "server/index.ts"], {
      cwd: root,
      stdio: "inherit",
      env,
    }),
    spawn(node, ["node_modules/vite/bin/vite.js"], {
      cwd: root,
      stdio: "inherit",
      env,
    }),
  ];
  const stop = () => children.forEach((c) => c.kill());
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  children.forEach((c) => c.on("exit", stop));
} else throw Error(`Неизвестная команда: ${mode}`);
