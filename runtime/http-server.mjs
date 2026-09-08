#!/usr/bin/env node

import { createServer } from "node:http";
import { handle, shutdown } from "./server.mjs";

const host = process.env.CLAUDE_CUA_HTTP_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.CLAUDE_CUA_HTTP_PORT ?? "17840", 10);

const server = createServer(async (request, response) => {
  if (request.url !== "/mcp") {
    response.writeHead(404).end("Not found");
    return;
  }
  if (request.method === "GET") {
    response.writeHead(405, { Allow: "POST, DELETE" }).end("Method not allowed");
    return;
  }
  if (request.method === "DELETE") {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(405, { Allow: "POST, DELETE" }).end("Method not allowed");
    return;
  }

  try {
    const body = await readJson(request);
    if (body.id == null) {
      response.writeHead(202).end();
      return;
    }
    const result = await handle(body);
    sendJson(response, 200, { jsonrpc: "2.0", id: body.id, result });
  } catch (error) {
    sendJson(response, 200, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    });
  }
});

server.listen(port, host, () => {
  console.error(`open-computer-use HTTP MCP listening on http://${host}:${port}/mcp`);
});

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  server.close();
  await shutdown();
  process.exit(signal === "SIGINT" ? 130 : 143);
}
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("MCP request exceeded 2 MiB"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    request.once("error", reject);
  });
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}
