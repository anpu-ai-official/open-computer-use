import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const bridge = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
const replies = new Map();
let nextId = 0;

function request(session, code) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("resilience request timed out")), 180_000);
    replies.set(String(id), (message) => {
      clearTimeout(timer);
      replies.delete(String(id));
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "js", arguments: { session, surface: "browser", code } } })}\n`);
  });
}

createInterface({ input: bridge.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  replies.get(String(message.id))?.(message);
});

function text(result) {
  return result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
}

try {
  const circular = await request("resilience_circular", `let tab=await cua.createBrowserTab("chrome","about:blank",{inspectOnly:true}); tab`);
  if (circular.isError || !text(circular).includes("BrowserTab")) throw new Error(`Tab output was not safely summarized: ${text(circular)}`);
  const closed = await request("resilience_circular", `await cua.closeAllTabs()`);
  if (!text(closed).includes('"remaining": 0')) throw new Error("closeAllTabs did not clean summarized tab");

  const failed = await request("resilience_rollback", `let tab=await cua.createBrowserTab("chrome","about:blank",{inspectOnly:true}); await tab.devtools.network.start(); await tab.devtools.performance.traceStart(); throw new Error("rollback-marker")`);
  if (!failed.isError || !text(failed).includes("rollback-marker")) throw new Error("Expected failing call was not reported");
  const rollback = await request("resilience_rollback", `nodeRepl.write(JSON.stringify({owned:(await cua.listTabs({emit:false})).length}))`);
  if (!text(rollback).includes('"owned":0')) throw new Error("Failed call left an owned tab");

  const afterLease = await request("resilience_after", `
    let tab=await cua.createBrowserTab("chrome","data:text/html,<title>lease-recovered</title>",{inspectOnly:true});
    await tab.devtools.network.start(); await tab.devtools.performance.traceStart(); await tab.evaluate(()=>{for(let i=0;i<100000;i++)Math.sqrt(i)});
    const trace=await tab.devtools.performance.traceStop({name:"recovered-trace"}); const network=await tab.devtools.network.stop({name:"recovered-network"});
    const networkAgain=await tab.devtools.network.stop(); await tab.close();
    nodeRepl.write(JSON.stringify({traceBytes:trace.bytes,requests:network.requestCount,idempotent:networkAgain.alreadyStopped,owned:(await cua.listTabs({emit:false})).length}));
  `);
  const value = JSON.parse(text(afterLease));
  if (value.traceBytes <= 0 || !value.idempotent || value.owned !== 0) throw new Error("Trace lease recovery, idempotent stop, or cleanup failed");
  console.log(JSON.stringify({ passed: true, circularOutputSafe: true, failedCallRolledBack: true, traceLeaseRecovered: true, idempotentStop: true, owned: value.owned }, null, 2));
} finally {
  bridge.kill("SIGTERM");
  await new Promise((resolve) => bridge.once("close", resolve));
}
