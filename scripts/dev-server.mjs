import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const api = require(path.join(root, "netlify/functions/api.js"));
const port = Number(process.env.PORT || 8888);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      const body = await readBody(req);
      const event = {
        path: url.pathname,
        rawUrl: url.toString(),
        httpMethod: req.method,
        headers: req.headers,
        queryStringParameters: Object.fromEntries(url.searchParams.entries()),
        body,
        isBase64Encoded: false
      };
      const result = await api.handler(event, {});
      send(res, result.statusCode || 200, result.headers || {}, result.body || "");
      return;
    }

    let filePath = path.normalize(path.join(publicDir, url.pathname));
    if (!filePath.startsWith(publicDir)) {
      send(res, 403, { "content-type": "text/plain" }, "Forbidden");
      return;
    }
    if (url.pathname === "/" || !existsSync(filePath)) {
      filePath = path.join(publicDir, "index.html");
    }
    const content = await readFile(filePath);
    send(res, 200, { "content-type": mime[path.extname(filePath)] || "application/octet-stream" }, content);
  } catch (error) {
    console.error(error);
    send(res, 500, { "content-type": "text/plain; charset=utf-8" }, error.stack || String(error));
  }
}).listen(port, () => {
  console.log(`Texas Hold'em dev server running at http://localhost:${port}`);
});
