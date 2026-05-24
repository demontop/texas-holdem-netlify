import { access, readFile } from "node:fs/promises";

const required = [
  "public/index.html",
  "public/styles.css",
  "public/app.js",
  "src/worker.js",
  "wrangler.jsonc",
  "netlify/functions/api.js",
  "netlify.toml"
];

for (const file of required) {
  await access(file);
}

const index = await readFile("public/index.html", "utf8");
if (!index.includes("app.js") || !index.includes("styles.css")) {
  throw new Error("index.html must include app.js and styles.css");
}

console.log("Build check passed. Static site and Cloudflare Worker are ready.");
