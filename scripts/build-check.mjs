import { access, readFile } from "node:fs/promises";

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
const html = await readFile("index.html", "utf8");
if (!html.includes("/src/main.js")) throw new Error("index.html does not load the app entry.");
console.log("Splob build check passed.");
