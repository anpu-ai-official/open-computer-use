import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, stat } from "node:fs/promises";

const web = createServer(async (request, response) => {
  if (request.url === "/slow") {
    await new Promise((resolve) => setTimeout(resolve, 120));
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ slow: true }));
    return;
  }
  if (request.url === "/redirect") {
    response.writeHead(302, { location: "/slow" }).end();
    return;
  }
  if (request.url === "/fail") {
    response.writeHead(503, { "content-type": "text/plain" }).end("expected failure");
    return;
  }
  if (request.url === "/abort") {
    request.socket.destroy();
    return;
  }
  if (request.url === "/asset.js") {
    response.writeHead(200, { "content-type": "application/javascript" }).end(`
      function hotFunction(ms = 160) { const end = performance.now() + ms; let value = 0; while (performance.now() < end) value += Math.sqrt(value + 3); return value; }
      function neverCalledDeadFunction() { return "dead-code-marker"; }
      window.hotFunction = hotFunction;
    `);
    return;
  }
  if (request.url === "/style.css") {
    response.writeHead(200, { "content-type": "text/css" }).end("#used{color:green}.never-used-devtools-rule{color:magenta}");
    return;
  }
  if (request.url === "/sw.js") {
    response.writeHead(200, { "content-type": "application/javascript", "service-worker-allowed": "/" }).end("self.addEventListener('fetch',()=>{});");
    return;
  }
  if (request.method === "POST" && request.url === "/echo") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ body: Buffer.concat(chunks).toString("utf8") }));
    return;
  }
  response.writeHead(200, {
    "content-type": "text/html",
    "set-cookie": "devtools_cookie=present; Path=/; SameSite=Lax",
  }).end(`<!doctype html>
    <title>DevTools fixture</title>
    <link rel="stylesheet" href="/style.css">
    <main id="used">fixture ready</main>
    <script src="/asset.js"></script>
    <script>
      window.fixtureReady = (async () => {
        console.warn("devtools-warning-marker");
        localStorage.setItem("local-key", "local-value");
        sessionStorage.setItem("session-key", "session-value");
        const db = await new Promise((resolve, reject) => {
          const open = indexedDB.open("devtools-db", 1);
          open.onupgradeneeded = () => open.result.createObjectStore("records", { keyPath: "id" });
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction("records", "readwrite");
          tx.objectStore("records").put({ id: 1, value: "indexed-value" });
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        db.close();
        const cache = await caches.open("devtools-cache");
        await cache.put("/cached-value", new Response("cached-body", { headers: { "content-type": "text/plain" } }));
        await navigator.serviceWorker.register("/sw.js");
        await navigator.serviceWorker.ready;
        return true;
      })();
    </script>`);
});
await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
const port = web.address().port;

const bridge = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
const replies = new Map();
let nextId = 0;
createInterface({ input: bridge.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  replies.get(String(message.id))?.(message);
});

function request(method, params = {}, timeoutMs = 180_000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), timeoutMs);
    replies.set(String(id), (message) => {
      clearTimeout(timer);
      replies.delete(String(id));
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function payload(result) {
  const item = result.content?.filter((entry) => entry.type === "text").findLast((entry) => entry.text.trim().startsWith("{"));
  if (!item) throw new Error("DevTools regression returned no JSON payload");
  return JSON.parse(item.text);
}

try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "devtools-regression", version: "1" } });
  const result = await request("tools/call", {
    name: "js",
    arguments: {
      session: "devtools_regression",
      surface: "browser",
      code: `
        let tab = await cua.createBrowserTab("chrome", "about:blank", {inspectOnly:true});
        const info = await tab.devtools.info();
        await tab.devtools.start({network:{includeBodies:true},console:true,issues:true,cpu:true,coverage:true,cssCoverage:true});
        await tab.goto("http://127.0.0.1:${port}/");
        await tab.playwright.evaluate(() => window.fixtureReady);
        await tab.playwright.evaluate(async () => {
          await Promise.allSettled([
            fetch("/redirect"), fetch("/fail"), fetch("/abort"),
            fetch("/echo", {method:"POST",headers:{"content-type":"text/plain"},body:"post-marker"}),
          ]);
          hotFunction(180);
        });
        const captures = await tab.devtools.stop({network:{includeBodies:true,name:"network"},console:{name:"console"},issues:{name:"issues"},cpu:{name:"cpu"},coverage:{name:"js-coverage"},cssCoverage:{name:"css-coverage"},performance:{name:"performance"}});
        const application = await tab.devtools.application.snapshot({name:"application"});
        await tab.devtools.performance.traceStart({screenshots:false});
        await tab.playwright.evaluate(() => hotFunction(80));
        const trace = await tab.devtools.performance.traceStop({name:"trace"});
        await tab.playwright.evaluate(() => { window.__heapMarker = Array.from({length:12000}, (_, i) => ({kind:"heap-marker",i,payload:"x".repeat(80)})); });
        const heap = await tab.devtools.memory.heapSnapshot({name:"heap",collectGarbage:true});
        const samplingStart = await tab.devtools.memory.samplingStart({samplingInterval:32768});
        await tab.playwright.evaluate(() => { window.__sampleMarker = Array.from({length:5000}, (_, i) => ({i,value:"sample"+i})); });
        const sampling = await tab.devtools.memory.samplingStop({name:"heap-sampling"});
        const networkEmulation = await tab.devtools.emulation.network({latency:20,downloadKbps:10000,uploadKbps:5000,disableCache:true});
        const cpuEmulation = await tab.devtools.emulation.cpu(2);
        await tab.devtools.emulation.reset();
        let blockedRaw = false;
        try { await tab.devtools.send("Page.bringToFront"); } catch { blockedRaw = true; }
        await tab.close();
        nodeRepl.write(JSON.stringify({info,captures,application,trace,heap,samplingStart,sampling,networkEmulation,cpuEmulation,blockedRaw,owned:(await cua.listTabs({emit:false})).length}));
      `,
    },
  }, 180_000);
  const value = payload(result);
  if (value.info.product == null) throw new Error("Browser version info missing");
  if (value.captures.network.requestCount < 7) throw new Error(`Expected network requests, saw ${value.captures.network.requestCount}`);
  if (value.captures.network.failureCount < 2) throw new Error("Expected HTTP and aborted failures");
  if (!value.captures.console.entries.some((entry) => entry.text.includes("devtools-warning-marker"))) throw new Error("Console marker missing");
  if (!value.application.localStorageKeys.includes("local-key")) throw new Error("localStorage snapshot missing");
  if (!value.application.indexedDBDatabases.some((db) => db.name === "devtools-db")) throw new Error("IndexedDB snapshot missing");
  if (!value.application.cacheStorage.some((cache) => cache.name === "devtools-cache")) throw new Error("Cache Storage snapshot missing");
  if (!value.application.serviceWorkers.some((worker) => worker.scope?.includes(`:${port}/`))) throw new Error("Service worker snapshot missing");
  if (value.captures.cpu.sampleCount === 0) throw new Error("CPU profile was empty");
  if (!value.captures.cpu.hottest.some((entry) => entry.functionName.includes("hotFunction"))) throw new Error("CPU profile did not identify hotFunction");
  if (value.captures.coverage.scriptCount === 0 || value.captures.cssCoverage.styleSheetCount === 0) throw new Error("Coverage capture was empty");
  if (value.captures.coverage.unusedBytes <= 0 || value.captures.cssCoverage.unusedBytes <= 0) throw new Error("Coverage summaries did not identify intentionally unused code");
  if (value.trace.bytes === 0 || value.heap.bytes === 0 || value.sampling.sampleCount === 0) throw new Error("Trace or heap artifact was empty");
  if (!value.blockedRaw) throw new Error("Focus-changing raw CDP command was not blocked");
  if (value.owned !== 0) throw new Error("Owned tabs remained after DevTools test");
  const artifactPaths = [
    value.captures.network.artifactPath, value.captures.console.artifactPath, value.captures.cpu.artifactPath,
    value.captures.coverage.artifactPath, value.captures.cssCoverage.artifactPath, value.captures.performance.artifactPath,
    value.application.artifactPath, value.trace.artifactPath, value.heap.artifactPath, value.sampling.artifactPath,
  ];
  for (const path of artifactPaths) {
    if ((await stat(path)).size === 0) throw new Error(`Empty artifact: ${path}`);
  }
  const har = JSON.parse(await readFile(value.captures.network.artifactPath, "utf8"));
  if (har.log.version !== "1.2" || har.log.entries.length !== value.captures.network.requestCount) throw new Error("HAR structure mismatch");
  console.log(JSON.stringify({
    passed: true,
    browser: value.info.product,
    networkRequests: value.captures.network.requestCount,
    networkFailures: value.captures.network.failureCount,
    consoleEntries: value.captures.console.entryCount,
    cpuSamples: value.captures.cpu.sampleCount,
    jsScripts: value.captures.coverage.scriptCount,
    jsUnusedBytes: value.captures.coverage.unusedBytes,
    cssSheets: value.captures.cssCoverage.styleSheetCount,
    cssUnusedBytes: value.captures.cssCoverage.unusedBytes,
    traceBytes: value.trace.bytes,
    heapBytes: value.heap.bytes,
    samplingSamples: value.sampling.sampleCount,
    application: { cookies: value.application.cookieCount, indexedDB: value.application.indexedDBDatabases.length, caches: value.application.cacheStorage.length, serviceWorkers: value.application.serviceWorkers.length },
    artifacts: artifactPaths,
    responseBytes: Buffer.byteLength(JSON.stringify(value)),
    cleanup: { owned: value.owned, rawFocusCommandBlocked: value.blockedRaw },
  }, null, 2));
} finally {
  bridge.kill("SIGTERM");
  await new Promise((resolve) => bridge.once("close", resolve));
  web.closeAllConnections();
  await new Promise((resolve) => web.close(resolve));
}
