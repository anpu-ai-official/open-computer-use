import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { stat } from "node:fs/promises";

const endpoint = process.env.CLAUDE_CUA_HTTP_URL ?? "http://127.0.0.1:17840/mcp";
const driver = process.env.CLAUDE_CUA_TEST_DRIVER ?? `${process.env.HOME}/.local/bin/cua-driver-local`;
let nextId = 0;

async function request(method, params = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
    signal: AbortSignal.timeout(180_000),
  });
  const message = await response.json();
  if (message.error) throw new Error(message.error.message);
  return message.result;
}

function call(session, code) {
  return request("tools/call", { name: "js", arguments: { session, surface: "browser", code } });
}

function payload(result) {
  const item = result.content?.filter((entry) => entry.type === "text").findLast((entry) => entry.text.trim().startsWith("{"));
  if (!item) throw new Error("No JSON payload returned");
  return JSON.parse(item.text);
}

function frontmost() {
  return execFileSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'], { encoding: "utf8" }).trim();
}

function chromePid() {
  return Number.parseInt(execFileSync("/usr/bin/pgrep", ["-x", "Google Chrome"], { encoding: "utf8" }).trim(), 10);
}

function chromeWindow(pid) {
  const result = JSON.parse(execFileSync(driver, ["list_windows", JSON.stringify({ pid })], { encoding: "utf8" }));
  const candidates = result.windows.filter((window) => window.title?.trim() && window.bounds?.width >= 500 && window.bounds?.height >= 400);
  candidates.sort((a, b) => Number(b.on_current_space === true) - Number(a.on_current_space === true) || a.z_index - b.z_index);
  if (!candidates.length) throw new Error("No normal Chrome window available");
  return candidates[0];
}

function selectedChromeTab(pid, windowInfo) {
  const result = JSON.parse(execFileSync(driver, ["list_windows", JSON.stringify({ pid })], { encoding: "utf8" }));
  const current = result.windows.find((window) => window.window_id === windowInfo.window_id);
  return `window-title:${current?.title ?? ""}`;
}

const fixture = createServer(async (request, response) => {
  if (request.url === "/slow") {
    await new Promise((resolve) => setTimeout(resolve, 180));
    response.writeHead(200, { "content-type": "application/json" }).end('{"slow":true}');
    return;
  }
  if (request.url === "/redirect") { response.writeHead(302, { location: "/slow" }).end(); return; }
  if (request.url === "/fail") { response.writeHead(500, { "content-type": "text/plain" }).end("failure-marker"); return; }
  if (request.url === "/asset.js") {
    response.writeHead(200, { "content-type": "application/javascript" }).end(`
      function stressHotFunction(ms=220){const end=performance.now()+ms;let x=1;while(performance.now()<end)x=Math.sqrt(x+17);return x}
      function stressDeadFunction(){return "unused"}
      window.stressHotFunction=stressHotFunction;
    `);
    return;
  }
  if (request.url === "/style.css") { response.writeHead(200, { "content-type": "text/css" }).end("#live{color:green}.unused-stress-rule{display:none}"); return; }
  if (request.url === "/sw.js") { response.writeHead(200, { "content-type": "application/javascript", "service-worker-allowed": "/" }).end("self.addEventListener('fetch',()=>{});"); return; }
  response.writeHead(200, { "content-type": "text/html", "set-cookie": "stress_cookie=yes; Path=/; SameSite=Lax" }).end(`<!doctype html><title>DevTools stress</title><link rel="stylesheet" href="/style.css"><main id="live">ready</main><script src="/asset.js"></script><script>
    window.ready=(async()=>{console.warn("stress-console-marker");localStorage.setItem("stress-local","yes");sessionStorage.setItem("stress-session","yes");
    const db=await new Promise((ok,bad)=>{const q=indexedDB.open("stress-db",1);q.onupgradeneeded=()=>q.result.createObjectStore("items",{keyPath:"id"});q.onsuccess=()=>ok(q.result);q.onerror=()=>bad(q.error)});
    await new Promise((ok,bad)=>{const tx=db.transaction("items","readwrite");tx.objectStore("items").put({id:1,value:"stress-record"});tx.oncomplete=ok;tx.onerror=()=>bad(tx.error)});db.close();
    const cache=await caches.open("stress-cache");await cache.put("/cached",new Response("cache-marker"));await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;return true})();
  </script>`);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const port = fixture.address().port;
const base = `http://127.0.0.1:${port}`;

await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "http-devtools-stress", version: "1" } });
const pid = chromePid();
const windowInfo = chromeWindow(pid);
const initialFocus = frontmost();
const initialSelected = selectedChromeTab(pid, windowInfo);
const focusTransitions = [];
const selectedTransitions = [];
let monitoring = true;
const monitor = (async () => {
  let lastFocus = initialFocus;
  let lastSelected = initialSelected;
  while (monitoring) {
    const focus = frontmost();
    if (focus !== lastFocus) { focusTransitions.push({ from: lastFocus, to: focus, at: Date.now() }); lastFocus = focus; }
    const selected = selectedChromeTab(pid, windowInfo);
    if (selected !== lastSelected) { selectedTransitions.push({ from: lastSelected, to: selected, at: Date.now() }); lastSelected = selected; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
})();

try {
  const sessions = ["stress_network", "stress_cpu", "stress_heap", "stress_trace"];
  const createResults = await Promise.all(sessions.map((session) => call(session, `let tab=await cua.createBrowserTab("chrome","about:blank",{inspectOnly:true,sessionName:"DevTools ${session}"}); nodeRepl.write(JSON.stringify({id:tab.id}))`)));
  if (createResults.some((result) => result.isError)) throw new Error("Failed to create one or more stress tabs");

  await call("stress_trace", `await tab.devtools.performance.start(); await tab.devtools.performance.traceStart(); nodeRepl.write(JSON.stringify({started:true}))`);
  const contention = payload(await call("stress_network", `let busy=false; let message=""; try{await tab.devtools.performance.traceStart()}catch(error){busy=true;message=error.message} nodeRepl.write(JSON.stringify({busy,message}))`));
  if (!contention.busy || !contention.message.includes("browser-global")) throw new Error("Trace contention did not return the expected busy error");

  const [networkResult, cpuResult, heapResult, traceResult] = await Promise.all([
    call("stress_network", `
      await tab.devtools.start({network:{includeBodies:true,maxRequests:1000},console:true,issues:true}); await tab.goto("${base}/"); await tab.playwright.evaluate(()=>window.ready);
      await tab.playwright.evaluate(async()=>{await Promise.allSettled([fetch("/redirect"),fetch("/fail")]);});
      const captures=await tab.devtools.stop({network:{includeBodies:true,name:"network"},console:{name:"console"},issues:{name:"issues"},performance:{name:"performance"}});
      const application=await tab.devtools.application.snapshot({name:"application",maxRecordsPerStore:20,includeCacheBodies:true}); const manifest=await tab.devtools.artifactManifest(); await tab.close();
      nodeRepl.write(JSON.stringify({captures,application,manifest,owned:(await cua.listTabs({emit:false})).length}));
    `),
    call("stress_cpu", `
      await tab.devtools.start({cpu:true,coverage:true,cssCoverage:true}); await tab.goto("${base}/"); await tab.playwright.evaluate(()=>window.ready); await tab.playwright.evaluate(()=>stressHotFunction(350));
      const captures=await tab.devtools.stop({cpu:{name:"cpu"},coverage:{name:"js-coverage"},cssCoverage:{name:"css-coverage"},performance:{name:"performance"}}); const manifest=await tab.devtools.artifactManifest(); await tab.close();
      nodeRepl.write(JSON.stringify({captures,manifest,owned:(await cua.listTabs({emit:false})).length}));
    `),
    call("stress_heap", `
      await tab.goto("${base}/"); await tab.playwright.evaluate(()=>window.ready); await tab.devtools.memory.samplingStart(); await tab.playwright.evaluate(()=>{window.heapStress=Array.from({length:30000},(_,i)=>({kind:"stress-retained-object",i,payload:"x".repeat(120)}))});
      const sampling=await tab.devtools.memory.samplingStop({name:"sampling"}); const heap=await tab.devtools.memory.heapSnapshot({name:"heap",collectGarbage:true}); const manifest=await tab.devtools.artifactManifest(); await tab.close();
      nodeRepl.write(JSON.stringify({sampling,heap,manifest,owned:(await cua.listTabs({emit:false})).length}));
    `),
    call("stress_trace", `
      await tab.goto("${base}/"); await tab.playwright.evaluate(()=>window.ready); await tab.playwright.evaluate(()=>stressHotFunction(400)); const trace=await tab.devtools.performance.traceStop({name:"trace"}); const audit=await tab.devtools.performance.audit({name:"audit"}); const manifest=await tab.devtools.artifactManifest(); await tab.close();
      nodeRepl.write(JSON.stringify({trace,audit,manifest,owned:(await cua.listTabs({emit:false})).length}));
    `),
  ]);
  const values = [networkResult, cpuResult, heapResult, traceResult].map(payload);
  if (values.some((value) => value.owned !== 0)) throw new Error("Stress run leaked owned tabs");
  if (values[0].captures.network.failureCount < 1 || values[0].application.indexedDBDatabases[0]?.objectStores?.[0]?.records?.[0]?.value !== "stress-record") throw new Error("Network/Application stress evidence missing");
  if (!values[1].captures.cpu.hottest.some((entry) => entry.functionName.includes("stressHotFunction"))) throw new Error("CPU hot function missing");
  if (values[1].captures.coverage.scriptCount === 0 || values[1].captures.cssCoverage.styleSheetCount === 0) throw new Error("Coverage evidence missing");
  if (values[2].heap.bytes < 1_000_000 || values[2].sampling.sampleCount === 0) throw new Error("Heap evidence missing");
  if (values[3].trace.bytes === 0 || values[3].trace.dataLossOccurred) throw new Error("Trace artifact invalid or lossy");
  const manifests = values.map((value) => value.manifest);
  for (const manifest of manifests) {
    const manifestPath = `${manifest.directory}/manifest.json`;
    if ((await stat(manifestPath)).size === 0) throw new Error(`Missing manifest ${manifestPath}`);
  }
  const responseBytes = [networkResult, cpuResult, heapResult, traceResult].map((value) => Buffer.byteLength(JSON.stringify(value)));
  if (responseBytes.some((bytes) => bytes > 30_000)) throw new Error(`Model-facing response exceeded 30KB: ${responseBytes.join(",")}`);
  console.log(JSON.stringify({
    passed: true, endpoint, chromePid: pid, initialFocus, initialSelected,
    traceContention: contention,
    network: { requests: values[0].captures.network.requestCount, failures: values[0].captures.network.failureCount, console: values[0].captures.console.entryCount },
    application: { stores: values[0].application.indexedDBDatabases[0].objectStores.length, cacheEntries: values[0].application.cacheStorage[0].entries.length, serviceWorkers: values[0].application.serviceWorkers.length },
    cpu: { samples: values[1].captures.cpu.sampleCount, hottest: values[1].captures.cpu.hottest[0], jsScripts: values[1].captures.coverage.scriptCount, cssSheets: values[1].captures.cssCoverage.styleSheetCount },
    heap: { bytes: values[2].heap.bytes, samples: values[2].sampling.sampleCount },
    trace: { bytes: values[3].trace.bytes, dataLossOccurred: values[3].trace.dataLossOccurred, grade: values[3].audit.grade },
    responseBytes, artifactDirectories: manifests.map((manifest) => manifest.directory),
  }, null, 2));
} finally {
  monitoring = false;
  await monitor;
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  const finalFocus = frontmost();
  const finalSelected = selectedChromeTab(pid, windowInfo);
  const agentSelections = [initialSelected, finalSelected, ...selectedTransitions.map((item) => item.to)].filter((title) => /DevTools stress/.test(title));
  if (agentSelections.length) throw new Error(`A session-owned DevTools tab became physically selected: ${JSON.stringify(agentSelections)}`);
  console.log(JSON.stringify({
    agentTabNeverSelected: true,
    initialFocus, finalFocus, ambientFocusTransitions: focusTransitions.length,
    initialSelected, finalSelected, selectedTabTransitions: selectedTransitions.length,
  }));
}
