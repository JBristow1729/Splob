import { access, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const required = [
  "index.html",
  "manifest.webmanifest",
  "service-worker.js",
  "src/main.js",
  "src/shared/game-constants.js",
  "src/styles.css",
  "src/game/splob-game.js",
  "src/ui/app.js",
  "relay/server.mjs"
];

await Promise.all(required.map((file) => access(file)));
await writeFile("env.js", `window.SPLOB_RELAY_URL = ${JSON.stringify(process.env.SPLOB_RELAY_URL || "")};\n`);
const html = await readFile("index.html", "utf8");
if (!html.includes("/src/main.js")) throw new Error("index.html does not load the app entry.");
if (!html.includes("/env.js")) throw new Error("index.html does not load generated environment config.");

const syntaxChecked = [
  "src/main.js",
  "src/config.js",
  "src/audio/sound.js",
  "src/game/splob-game.js",
  "src/network/relay-client.js",
  "src/services/profile.js",
  "src/shared/game-constants.js",
  "src/state/settings.js",
  "src/ui/app.js",
  "src/ui/templates.js",
  "src/utils/html.js",
  "relay/server.mjs",
  "service-worker.js"
];

for (const file of syntaxChecked) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Syntax check failed for ${file}\n${result.stderr || result.stdout}`);
  }
}

console.log("Splob build check passed.");
