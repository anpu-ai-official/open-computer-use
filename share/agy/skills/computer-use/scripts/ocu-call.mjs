#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const [tool, session, ...rest] = process.argv.slice(2);
const endpoint = process.env.OCU_MCP_URL ?? "http://127.0.0.1:17840/mcp";

if (!tool || !session) {
  console.error("Usage: ocu-call.mjs <js|js_reset|native|native_reset> <session> [arguments]");
  process.exit(2);
}

let args = { session };
if (tool === "js") {
  let code;
  if (rest[0] === "--file" && rest[1]) code = await readFile(rest[1], "utf8");
  else code = rest.join(" ");
  if (!code.trim()) throw new Error("js requires code or --file <path>");
  args = { session, surface: "browser", code };
} else if (tool === "native") {
  const [nativeTool, jsonOrFlag, path] = rest;
  if (!nativeTool) throw new Error("native requires a native tool name");
  const json = jsonOrFlag === "--file" && path ? await readFile(path, "utf8") : (jsonOrFlag ?? "{}");
  args = { session, tool: nativeTool, arguments: JSON.parse(json) };
} else if (tool !== "js_reset" && tool !== "native_reset") {
  throw new Error(`Unsupported tool: ${tool}`);
}

const response = await fetch(endpoint, {
  method: "POST",
  headers: { accept: "application/json", "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: args },
  }),
});
if (!response.ok) throw new Error(`Open Computer Use broker returned HTTP ${response.status}`);
const message = await response.json();
if (message.error) throw new Error(message.error.message ?? JSON.stringify(message.error));
const result = message.result;
for (const item of result?.content ?? []) {
  if (item.type === "text") process.stdout.write(`${item.text}\n`);
}
if (result?.isError) process.exitCode = 1;
