import { execFileSync, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const profile = process.env.CLAUDE_CUA_BROWSER_PROFILE ?? `${process.env.HOME}/.claude/browser-use-profile`;
const title = `Teardown Probe ${Date.now()}`;
const url = `data:text/html,${encodeURIComponent(`<title>${title}</title><h1>${title}</h1>`)}`;
const before = frontmost();

const first = startServer();
await first.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teardown", version: "1" } });
await first.request("tools/call", { name: "js", arguments: { session: "teardown_owner", code: `let tab = await cua.createBrowserTab("chrome", ${JSON.stringify(url)}); await tab.title()` } });
if (!(await targets()).some(target => target.title === title)) throw new Error("probe page was not created");

first.child.kill("SIGKILL");
await first.exited;
if (!(await targets()).some(target => target.title === title)) throw new Error("SIGKILL unexpectedly closed the probe; orphan reaping was not exercised");

const second = startServer();
await second.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "teardown-reaper", version: "1" } });
await second.request("tools/call", { name: "js", arguments: { session: "teardown_reaper", code: "1" } });
const reaped = !(await targets()).some(target => target.title === title);
second.child.stdin.end();
await second.exited;
const after = frontmost();
if (!reaped) throw new Error("dead-owner page was not reaped by the next bridge");
console.log(JSON.stringify({ title, orphanObserved: true, reaped, before, after, focusPreserved: before === after }, null, 2));

function startServer() {
  const child = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map();
  let nextId = 0;
  createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    replies.get(String(message.id))?.(message);
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 180_000);
    replies.set(String(id), message => {
      clearTimeout(timer);
      replies.delete(String(id));
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return { child, request, exited: new Promise(resolve => child.once("close", resolve)) };
}

async function targets() {
  const [port] = (await readFile(`${profile}/DevToolsActivePort`, "utf8")).trim().split(/\r?\n/);
  return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

function frontmost() {
  return execFileSync("/usr/bin/osascript", ["-e", "tell application \"System Events\" to get name of first application process whose frontmost is true"], { encoding: "utf8" }).trim();
}
