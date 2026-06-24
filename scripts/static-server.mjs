import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(".");
const port = Number(process.env.PORT || 5173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8"
};

createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
  let file = resolve(join(root, clean));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
  res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Splob running at http://localhost:${port}`));
