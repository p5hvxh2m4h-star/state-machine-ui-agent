/**
 * Serves visual/learning-neural-net.html and streams new lines from logs/learning-graph.jsonl as SSE.
 * Run: npm run graph:viz — open http://localhost:8765/learning-neural-net.html?live=1
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const visualDir = path.join(root, "visual");
const logFile = path.join(root, "logs", "learning-graph.jsonl");

let logSize = 0;
try {
  logSize = fs.statSync(logFile).size;
} catch {
  logSize = 0;
}

const clients = new Set();

function tailAndBroadcast() {
  try {
    const st = fs.statSync(logFile);
    if (st.size <= logSize) return;
    const fd = fs.openSync(logFile, "r");
    const len = st.size - logSize;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, logSize);
    fs.closeSync(fd);
    logSize = st.size;
    const text = buf.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const payload = `data: ${line}\n\n`;
      for (const res of clients) {
        try {
          res.write(payload);
        } catch {
          clients.delete(res);
        }
      }
    }
  } catch {
    /* missing file until first event */
  }
}

setInterval(tailAndBroadcast, 120);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer((req, res) => {
  if (req.url === "/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    clients.add(res);
    res.write(":ok\n\n");
    req.on("close", () => clients.delete(res));
    return;
  }

  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/learning-neural-net.html";
  const filePath = path.join(visualDir, path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, ""));
  if (!filePath.startsWith(visualDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  });
});

const PORT = Number(process.env.GRAPH_VIZ_PORT) || 8765;
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Learning graph: http://127.0.0.1:${PORT}/learning-neural-net.html?live=1`);
});
