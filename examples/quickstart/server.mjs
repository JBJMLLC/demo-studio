import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = join(here, "index.html");
const port = Number(process.env.PORT || 4399);
const allowedPaths = new Set(["/", "/shared/weekly-growth-demo"]);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const page = await readFile(pagePath);
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  if (request.method !== "GET" || !allowedPaths.has(requestUrl.pathname)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'"
  });
  response.end(page);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Quickstart fixture ready at http://127.0.0.1:${port}\n`);
});
