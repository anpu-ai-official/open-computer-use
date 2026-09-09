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
    const text = `${message.params.name}:${message.params.arguments.session}`;
    const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }], isError: false } });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) }).end(body);
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");

const address = server.address();
const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const helper = join(runtimeRoot, "..", "share", "agy", "skills", "computer-use", "scripts", "ocu-call.mjs");

async function run(args) {
  const child = spawn(process.execPath, [helper, ...args], {
    env: { ...process.env, OCU_MCP_URL: `http://127.0.0.1:${address.port}/mcp` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, stderr);
  return stdout.trim();
}

assert.equal(await run(["js", "agy_helper_test", "1+1"]), "js:agy_helper_test");
assert.equal(await run(["js_reset", "agy_helper_test"]), "js_reset:agy_helper_test");
server.close();

assert.equal(requests.length, 2);
assert.equal(requests[0].params.arguments.code, "1+1");
console.log(JSON.stringify({ passed: true, calls: requests.length }));
