import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const requests = [];
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(message);
    if (message.id == null) {
      response.writeHead(202).end();
      return;
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { method: message.method } });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

const address = server.address();
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, [join(root, "stdio-proxy.mjs")], {
  env: { ...process.env, OCU_MCP_URL: `http://127.0.0.1:${address.port}/mcp` },
  stdio: ["pipe", "pipe", "pipe"],
});

const responses = [];
let stdout = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  stdout += chunk;
  const lines = stdout.split("\n");
  stdout = lines.pop();
  for (const line of lines) if (line) responses.push(JSON.parse(line));
});

for (const message of [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
]) child.stdin.write(`${JSON.stringify(message)}\n`);
child.stdin.end();

const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
const [code] = await once(child, "exit");
clearTimeout(timeout);
server.close();

assert.equal(code, 0);
assert.deepEqual(responses, [
  { jsonrpc: "2.0", id: 1, result: { method: "initialize" } },
  { jsonrpc: "2.0", id: 2, result: { method: "tools/list" } },
]);
assert.deepEqual(requests.map(request => request.method).sort(), [
  "initialize",
  "notifications/initialized",
  "tools/list",
]);
console.log(JSON.stringify({ passed: true, forwarded: requests.length, responses: responses.length }));
