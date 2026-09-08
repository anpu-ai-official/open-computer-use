import { execFileSync } from "node:child_process";

const endpoint = process.env.CLAUDE_CUA_HTTP_URL ?? "http://127.0.0.1:17840/mcp";
let nextId = 0;

async function request(method, params = {}) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  });
  const message = await response.json();
  if (message.error) throw new Error(message.error.message);
  return message.result;
}

function frontmost() {
  return execFileSync("/usr/bin/osascript", [
    "-e",
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ], { encoding: "utf8" }).trim();
}

function payload(result) {
  const item = result.content?.filter(entry => entry.type === "text").findLast(entry => entry.text.startsWith("{"));
  if (!item) throw new Error("HTTP browser regression returned no JSON payload");
  return JSON.parse(item.text);
}

await request("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "http-browser-regression", version: "1" },
});

const before = frontmost();
const html = '<!doctype html><title>HTTP Focus</title><label>Value <input aria-label="Value"></label><button onclick="out.textContent=document.querySelector(\'input\').value">Apply</button><output id="out"></output>';
const url = `data:text/html,${encodeURIComponent(html)}`;
const values = ["http-a", "http-b"];
const results = await Promise.all(values.map((value, index) => request("tools/call", {
  name: "js",
  arguments: {
    session: `http_regression_${index}`,
    surface: "browser",
    code: `let t=await cua.createBrowserTab("chrome",${JSON.stringify(url)}); await t.playwright.getByLabel("Value").fill(${JSON.stringify(value)}); await t.playwright.getByRole("button",{name:"Apply"}).click(); const out=await t.playwright.locator("#out").innerText(); await t.playwright.close(); nodeRepl.write(JSON.stringify({out,owned:(await cua.listTabs({emit:false})).length}))`,
  },
})));
const after = frontmost();
const parsed = results.map(payload);

if (parsed.map(item => item.out).join("|") !== values.join("|")) throw new Error("parallel HTTP browser outputs did not match");
if (parsed.some(item => item.owned !== 0)) throw new Error("parallel HTTP browser cleanup left owned tabs");
if (before !== after) throw new Error(`foreground changed from ${before} to ${after}`);

console.log(JSON.stringify({ endpoint, before, after, focusPreserved: before === after, results: parsed }, null, 2));
