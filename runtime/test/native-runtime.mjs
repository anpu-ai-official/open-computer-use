import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const driver = fileURLToPath(new URL("./fixtures/fake-native-driver.mjs", import.meta.url));
const server = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
  env: { ...process.env, CLAUDE_CUA_DRIVER: driver },
  stdio: ["pipe", "pipe", "inherit"],
});
const replies = new Map();
let nextId = 0;
createInterface({ input: server.stdout }).on("line", line => {
  const message = JSON.parse(line);
  replies.get(String(message.id))?.(message);
});

function request(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000);
    replies.set(String(id), message => {
      clearTimeout(timer);
      replies.delete(String(id));
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "native-test", version: "1" } });
  const state = await request("tools/call", {
    name: "native",
    arguments: { session: "native_bridge_test", tool: "get_window_state", arguments: { pid: 41, window_id: 99 } },
  });
  const token = state.structuredContent.elements[0].element_token;
  const action = await request("tools/call", {
    name: "native",
    arguments: { session: "native_bridge_test", tool: "click", arguments: { element_token: token, delivery_mode: "background" } },
  });
  if (action.isError || action.structuredContent.status !== "ok") throw new Error(`token bridge failed: ${JSON.stringify(action)}`);
  let mismatchRefused = false;
  try {
    await request("tools/call", {
      name: "native",
      arguments: { session: "native_bridge_test", tool: "click", arguments: { element_token: token, pid: 42 } },
    });
  } catch (error) {
    mismatchRefused = error.message.includes("does not agree with element_token");
  }
  if (!mismatchRefused) throw new Error("mismatched token target was not refused");
  await request("tools/call", { name: "native_reset", arguments: { session: "native_bridge_test" } });
  console.log(JSON.stringify({ passed: true, token_bridge: true, mismatch_refused: true, route: action.structuredContent.route }));
} finally {
  server.kill("SIGTERM");
}
