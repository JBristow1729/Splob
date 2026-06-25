import { access, readFile, writeFile } from "node:fs/promises";

const required = [
  "index.html",
  "manifest.webmanifest",
  "service-worker.js",
  "src/main.js",
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
console.log("Splob build check passed.");
