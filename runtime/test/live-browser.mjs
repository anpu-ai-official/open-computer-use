import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createInterface } from "node:readline";

const existingProfile = (process.env.CLAUDE_CUA_BROWSER_MODE ?? "existing") === "existing";
const driver = process.env.CLAUDE_CUA_TEST_DRIVER ?? `${process.env.HOME}/.local/bin/cua-driver-local`;

const web = createServer((request, response) => {
  const name = request.url === "/b" ? "B" : "A";
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><title>Parallel ${name}</title><label>Value <input aria-label="Value"></label><select aria-label="Mode"><option>alpha</option><option>beta</option></select><label><input type="checkbox" aria-label="Confirmed">Confirmed</label><button onclick="document.querySelector('#out').textContent=document.querySelector('input').value">Apply</button><output id="out"></output>`);
});
await new Promise((resolve) => web.listen(0, "127.0.0.1", resolve));
const port = web.address().port;

const server = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
});
const replies = new Map();
let nextId = 0;
createInterface({ input: server.stdout }).on("line", (line) => {
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
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function text(result) {
  return result.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
}

function jsonPayloads(result) {
  return result.content
    ?.filter((item) => item.type === "text")
    .flatMap((item) => item.text.split("\n"))
    .filter((line) => line.trim().startsWith("{") && line.trim().endsWith("}")) ?? [];
}

function frontmost() {
  return execFileSync("/usr/bin/osascript", [
    "-e",
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ], { encoding: "utf8" }).trim();
}

function existingChromePid() {
  return Number.parseInt(execFileSync("/usr/bin/pgrep", ["-x", "Google Chrome"], { encoding: "utf8" }).trim(), 10);
}

function existingEndpointOwnerPid() {
  const root = process.env.CLAUDE_CUA_EXISTING_CHROME_ROOT ?? `${process.env.HOME}/Library/Application Support/Google/Chrome`;
  const [port] = readFileSync(`${root}/DevToolsActivePort`, "utf8").trim().split(/\r?\n/);
  const pids = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { encoding: "utf8" })
    .split(/\r?\n/)
    .filter(line => /^p\d+$/.test(line))
    .map(line => Number.parseInt(line.slice(1), 10));
  if (pids.length !== 1) throw new Error(`expected one owner for Chrome DevTools port ${port}, got ${pids.length}`);
  return pids[0];
}

function mainChromeWindowId(pid) {
  const result = JSON.parse(execFileSync(driver, ["list_windows", JSON.stringify({ pid })], { encoding: "utf8" }));
  const candidates = result.windows.filter(window => window.title?.trim() && window.bounds?.width >= 500 && window.bounds?.height >= 400);
  candidates.sort((a, b) => Number(b.on_current_space === true) - Number(a.on_current_space === true) || a.z_index - b.z_index);
  if (!candidates.length) throw new Error("no normal Chrome window available for tab-state verification");
  return candidates[0].window_id;
}

function chromeState(pid, windowId) {
  const result = JSON.parse(execFileSync(driver, ["get_window_state", JSON.stringify({
    pid,
    window_id: windowId,
    session: "live-profile-verifier",
    include_screenshot: false,
    max_elements: 5000,
    max_depth: 80,
  })], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  const tabs = result.elements.filter(element =>
    element.role === "AXRadioButton"
    && element.frame
    && element.frame.y < 60
    && element.frame.h >= 20
    && element.frame.h <= 60
  );
  const unique = new Map();
  for (const tab of tabs) {
    const frame = tab.frame;
    const key = [frame.x, frame.y, frame.w, frame.h, tab.label ?? ""].join(":");
    if (!unique.has(key)) unique.set(key, tab);
  }
  const logical = [...unique.values()];
  return {
    active: [...new Set(logical.filter(tab => tab.selected === true).map(tab => tab.label ?? ""))].sort().join("|"),
    totalTabs: logical.length,
  };
}

try {
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "live-browser-test", version: "1" },
  });
  const before = frontmost();

  const discovery = await request("tools/call", {
    name: "js",
    arguments: {
      session: "live_discovery",
      code: `const discovered = await cua.getState({emit:false}); nodeRepl.write(JSON.stringify({browsers: discovered.browsers.map(({id,name,type,family,profileName}) => ({id,name,type,family,profileName})), appCount: discovered.apps.length}))`,
    },
  });
  const discoverySummary = await request("tools/call", {
    name: "js",
    arguments: {
      session: "live_discovery",
      code: `const discoveredAgain = await cua.getState({emit:false}); nodeRepl.write(JSON.stringify({browsers: discoveredAgain.browsers.map(({id,name,type,family,profileName}) => ({id,name,type,family,profileName})), appCount: discoveredAgain.apps.length}))`,
    },
  });
  if (process.env.CLAUDE_CUA_DEBUG === "1") console.error("[live-browser] shared connection ready");
  // Establishing the one shared CDP connection may require the broker to
  // resolve Chrome's modal consent sheet. Read AppleScript tab state only
  // after that sheet is gone, before any session-owned tabs are created.
  const chromePid = existingProfile ? existingChromePid() : null;
  const chromeWindowId = existingProfile ? mainChromeWindowId(chromePid) : null;
  const chromeBefore = existingProfile ? chromeState(chromePid, chromeWindowId) : null;
  if (process.env.CLAUDE_CUA_DEBUG === "1") console.error("[live-browser] baseline captured");
  const endpointOwnerPid = existingProfile ? existingEndpointOwnerPid() : null;
  if (existingProfile && endpointOwnerPid !== chromePid)
    throw new Error(`DevTools endpoint owner ${endpointOwnerPid} did not match Chrome pid ${chromePid}`);

  const runs = await Promise.all([
    request("tools/call", {
      name: "js",
      arguments: {
        session: "live_parallel_a",
        code: `let testTabA = await cua.createBrowserTab("chrome", "http://127.0.0.1:${port}/a", {sessionName:"🔎 Parallel A"}); nodeRepl.write(JSON.stringify({id:testTabA.id,url:await testTabA.url(),title:await testTabA.title()}))`,
      },
    }),
    request("tools/call", {
      name: "js",
      arguments: {
        session: "live_parallel_b",
        code: `let testTabB = await cua.createBrowserTab("chrome", "http://127.0.0.1:${port}/b", {sessionName:"🔎 Parallel B"}); nodeRepl.write(JSON.stringify({id:testTabB.id,url:await testTabB.url(),title:await testTabB.title()}))`,
      },
    }),
  ]);
  if (process.env.CLAUDE_CUA_DEBUG === "1") console.error("[live-browser] inactive tabs created");

  const afterCreate = frontmost();
  const chromeAfterCreate = existingProfile ? chromeState(chromePid, chromeWindowId) : null;
  if (existingProfile && chromeAfterCreate.active !== chromeBefore.active)
    throw new Error("creating background targets changed Chrome's selected tab");
  if (existingProfile && chromeAfterCreate.totalTabs !== chromeBefore.totalTabs + 2)
    throw new Error(`expected two new Chrome tabs, got ${chromeAfterCreate.totalTabs - chromeBefore.totalTabs}`);
  const summaries = await Promise.all([
    request("tools/call", {
      name: "js",
      arguments: { session: "live_parallel_a", code: "await testTabA.ax.setValue(0,'alpha'); await testTabA.ax.setValue(1,'beta'); await testTabA.ax.setChecked(2,true); await testTabA.playwright.getByRole('button',{name:'Apply'}).click(); nodeRepl.write(JSON.stringify({id:testTabA.id,title:await testTabA.title(),result:await testTabA.playwright.locator('#out').innerText(),mode:await testTabA.playwright.getByLabel('Mode').inputValue(),confirmed:await testTabA.playwright.getByLabel('Confirmed').isChecked()}))" },
    }),
    request("tools/call", {
      name: "js",
      arguments: { session: "live_parallel_b", code: "await testTabB.playwright.getByLabel('Value').fill('beta'); await testTabB.playwright.getByRole('button',{name:'Apply'}).click(); nodeRepl.write(JSON.stringify({id:testTabB.id,title:await testTabB.title(),result:await testTabB.playwright.locator('#out').innerText()}))" },
    }),
  ]);
  await Promise.all([
    request("tools/call", {
      name: "js",
      arguments: { session: "live_parallel_a", code: "await testTabA.close(); nodeRepl.write('closed-a')" },
    }),
    request("tools/call", {
      name: "js",
      arguments: { session: "live_parallel_b", code: "await testTabB.playwright.close(); nodeRepl.write('closed-b-through-playwright')" },
    }),
  ]);
  const directCloseCleanup = await request("tools/call", {
    name: "js",
    arguments: { session: "live_parallel_b", code: "(await cua.listTabs({emit:false})).length" },
  });
  if (text(directCloseCleanup) !== "0") throw new Error("direct Playwright close left a stale owned-tab entry");
  const afterClose = frontmost();
  const chromeAfterClose = existingProfile ? chromeState(chromePid, chromeWindowId) : null;
  if (existingProfile && chromeAfterClose.active !== chromeBefore.active)
    throw new Error("closing session-owned targets changed Chrome's selected tab");
  if (existingProfile && chromeAfterClose.totalTabs !== chromeBefore.totalTabs)
    throw new Error("session-owned Chrome tabs were not fully closed");

  console.log(JSON.stringify({
    before,
    afterCreate,
    afterClose,
    focusPreserved: before === afterCreate && before === afterClose,
    existingProfile,
    sameChromeProcess: existingProfile ? endpointOwnerPid === chromePid : null,
    selectedTabPreserved: existingProfile ? chromeAfterCreate.active === chromeBefore.active && chromeAfterClose.active === chromeBefore.active : null,
    tabCountDeltaDuringRun: existingProfile ? chromeAfterCreate.totalTabs - chromeBefore.totalTabs : null,
    tabCountRestored: existingProfile ? chromeAfterClose.totalTabs === chromeBefore.totalTabs : null,
    directPlaywrightCloseCleanedOwnership: text(directCloseCleanup) === "0",
    discovery: jsonPayloads(discoverySummary),
    parallel: summaries.map(jsonPayloads),
  }, null, 2));
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("close", resolve));
  web.closeAllConnections();
  await new Promise((resolve) => web.close(resolve));
}
