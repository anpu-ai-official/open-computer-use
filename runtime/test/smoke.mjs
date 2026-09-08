import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const server = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
});
const replies = new Map();
createInterface({ input: server.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  replies.get(String(message.id))?.(message);
});

function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 150_000);
    replies.set(String(id), (message) => {
      clearTimeout(timer);
      replies.delete(String(id));
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

try {
  const initialized = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  if (initialized.serverInfo?.name !== "open-computer-use") throw new Error("bad initialize result");

  const listed = await request(2, "tools/list");
  if (listed.tools?.map((tool) => tool.name).join(",") !== "js,js_reset")
    throw new Error("unexpected tools/list result");

  const first = await request(3, "tools/call", {
    name: "js",
    arguments: { session: "smoke_a", code: "const parityValue = 41; nodeRepl.write('stored')" },
  });
  const second = await request(4, "tools/call", {
    name: "js",
    arguments: { session: "smoke_a", code: "nodeRepl.write(String(parityValue + 1))" },
  });
  const parallel = await Promise.all([
    request(5, "tools/call", {
      name: "js",
      arguments: { session: "parallel_a", code: "nodeRepl.write(await Promise.resolve('A'))" },
    }),
    request(6, "tools/call", {
      name: "js",
      arguments: { session: "parallel_b", code: "nodeRepl.write(await Promise.resolve('B'))" },
    }),
  ]);
  const expression = await request(7, "tools/call", {
    name: "js",
    arguments: { session: "smoke_expression", code: "1 + 1" },
  });
  const logged = await request(8, "tools/call", {
    name: "js",
    arguments: { session: "smoke_console", code: "console.log('captured')" },
  });
  await request(9, "tools/call", {
    name: "js",
    arguments: { session: "smoke_destructure", code: "const [left, right] = await Promise.resolve([20, 22]); const { nested } = { nested: 'kept' };" },
  });
  const destructured = await request(10, "tools/call", {
    name: "js",
    arguments: { session: "smoke_destructure", code: "({ total: left + right, nested })" },
  });
  if (!second.content?.some((item) => item.type === "text" && item.text.includes("42")))
    throw new Error("persistent JavaScript binding was not preserved");
  if (parallel.map((result) => result.content?.[0]?.text).join("") !== "AB")
    throw new Error("parallel sessions returned unexpected results");
  if (expression.content?.[0]?.text !== "2") throw new Error("bare final expression was not returned");
  if (logged.content?.[0]?.text !== "captured") throw new Error("console.log was not captured");
  if (!destructured.content?.[0]?.text.includes('"total": 42') || !destructured.content?.[0]?.text.includes('"nested": "kept"'))
    throw new Error("top-level destructured bindings were not preserved");
  console.log(JSON.stringify({ initialized, listed: listed.tools.map((t) => t.name), first, second, parallel, expression, logged, destructured }));
} finally {
  server.kill("SIGTERM");
}
