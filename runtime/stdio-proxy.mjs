#!/usr/bin/env node

import { createInterface } from "node:readline";

const endpoint = process.env.OCU_MCP_URL ?? "http://127.0.0.1:17840/mcp";
const pending = new Set();

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function rpcError(id, error) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

async function forward(message) {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error(`Open Computer Use broker returned HTTP ${response.status}`);
    if (message.id == null) return;
    write(await response.json());
  } catch (error) {
    if (message.id != null) write(rpcError(message.id, error));
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    write(rpcError(null, error));
    return;
  }
  const request = forward(message);
  pending.add(request);
  request.finally(() => pending.delete(request));
});
input.once("close", async () => {
  await Promise.allSettled([...pending]);
});
