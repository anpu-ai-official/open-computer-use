import { createServer } from "node:http";

const port = Number.parseInt(process.env.DEVTOOLS_FIXTURE_PORT ?? "17841", 10);
const server = createServer(async (request, response) => {
  if (request.url === "/api/slow") {
    await new Promise((resolve) => setTimeout(resolve, 320));
    response.writeHead(200, { "content-type": "application/json" }).end('{"result":"slow-ok"}');
    return;
  }
  if (request.url === "/api/redirect") { response.writeHead(302, { location: "/api/slow" }).end(); return; }
  if (request.url === "/api/fail") { response.writeHead(503, { "content-type": "application/json" }).end('{"error":"intentional-fixture-failure"}'); return; }
  if (request.url === "/app.js") {
    response.writeHead(200, { "content-type": "application/javascript" }).end(`
      function devtoolsFixtureHotLoop(ms=300){const end=performance.now()+ms;let n=0;while(performance.now()<end)n+=Math.sqrt(n+11);return n}
      function intentionallyUnusedFunction(){return "coverage-dead-marker"}
      window.devtoolsFixtureHotLoop=devtoolsFixtureHotLoop;
      window.devtoolsFixtureRetainObjects=(count=20000)=>window.__devtoolsRetained=Array.from({length:count},(_,i)=>({kind:"devtools-fixture-retained",i,payload:"x".repeat(120)}));
    `);
    return;
  }
  if (request.url === "/app.css") { response.writeHead(200, { "content-type": "text/css" }).end("#fixture-live{color:green}.fixture-unused-rule{color:purple}"); return; }
  if (request.url === "/sw.js") { response.writeHead(200, { "content-type": "application/javascript", "service-worker-allowed": "/" }).end("self.addEventListener('fetch',()=>{});"); return; }
  response.writeHead(200, { "content-type": "text/html", "set-cookie": "claude_fixture_cookie=present; Path=/; SameSite=Lax" }).end(`<!doctype html><title>Claude DevTools Expert Fixture</title><link rel="stylesheet" href="/app.css"><main id="fixture-live">fixture-ready</main><script src="/app.js"></script><script>
    window.fixtureReady=(async()=>{console.warn("claude-fixture-warning");localStorage.setItem("claude-fixture-local","local-value");sessionStorage.setItem("claude-fixture-session","session-value");
    const db=await new Promise((ok,bad)=>{const q=indexedDB.open("claude-fixture-db",1);q.onupgradeneeded=()=>q.result.createObjectStore("records",{keyPath:"id"});q.onsuccess=()=>ok(q.result);q.onerror=()=>bad(q.error)});
    await new Promise((ok,bad)=>{const tx=db.transaction("records","readwrite");tx.objectStore("records").put({id:7,value:"indexed-fixture-value"});tx.oncomplete=ok;tx.onerror=()=>bad(tx.error)});db.close();
    const cache=await caches.open("claude-fixture-cache");await cache.put("/cached-fixture",new Response("cache-fixture-value"));await navigator.serviceWorker.register("/sw.js");await navigator.serviceWorker.ready;return true})();
  </script>`);
});

server.listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
