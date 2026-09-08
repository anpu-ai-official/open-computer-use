#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { parse } from "acorn";
import { connectBrowser, setupBrowserSession } from "./browser-runtime.mjs";
import { acceptPendingExternalConsent, prepareExistingProfileBroker } from "./existing-profile-broker.mjs";

const VERSION = "0.1.0";
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const IDLE_MS = positiveInt(process.env.CLAUDE_CUA_IDLE_MS, 10 * 60 * 1000);
const BROWSER_MODE = process.env.CLAUDE_CUA_BROWSER_MODE ?? "existing";
const CHROME_PATH = process.env.CLAUDE_CUA_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BROWSER_PROFILE = process.env.CLAUDE_CUA_BROWSER_PROFILE ?? `${process.env.HOME}/.claude/browser-use-profile`;
const EXISTING_CHROME_ROOT = process.env.CLAUDE_CUA_EXISTING_CHROME_ROOT ?? `${process.env.HOME}/Library/Application Support/Google/Chrome`;

const sessions = new Map();
let browserReady = null;
let browserConnectionReady = null;

class BrowserSessionRuntime {
  constructor(session) {
    this.session = session;
    this.tail = Promise.resolve();
    this.ready = null;
    this.closed = false;
    this.idleTimer = null;
    this.currentContent = null;
    this.browserSession = null;
    this.output = {
      write: (value) => this.#write(value),
      emitImage: async (value) => this.#emitImage(value),
    };
  }

  start() {
    if (!this.ready) this.ready = this.#start();
    return this.ready;
  }

  async #start() {
    const cdpBrowser = await ensureBrowserConnection();
    this.browserSession = await setupBrowserSession({ cdpBrowser, output: this.output, session: this.session, existingProfile: BROWSER_MODE === "existing" });
    const nodeRepl = Object.freeze({ write: this.output.write, emitImage: this.output.emitImage });
    const console = makeConsole(this.output.write);
    this.context = vm.createContext({
      Buffer,
      URL,
      clearInterval,
      clearTimeout,
      console,
      fetch,
      setInterval,
      setTimeout,
      nodeRepl,
      cua: this.browserSession.cua,
      browser: this.browserSession.browser,
    });
    this.#touch();
  }

  enqueue(fn) {
    const operation = this.tail.then(fn, fn);
    this.tail = operation.catch(() => {});
    return operation;
  }

  async callTool(name, args) {
    await this.start();
    this.#touch();
    if (name === "js_reset") {
      await this.browserSession?.dispose();
      this.ready = null;
      this.browserSession = null;
      this.context = null;
      await this.start();
      return { content: [{ type: "text", text: "Background browser session reset" }], isError: false };
    }
    if (name !== "js") throw new Error(`Unknown browser runtime tool: ${name}`);

    this.currentContent = [];
    const tabsBefore = new Set((await this.browserSession.cua.listTabs({ emit: false })).map((tab) => tab.id));
    try {
      const code = returnFinalExpression(persistTopLevelBindings(args.code));
      const execution = vm.runInContext(`(async () => {\n${code}\n})()`, this.context, { timeout: 180_000 });
      const value = await withTimeout(execution, 180_000, "Browser JavaScript timed out after 180000ms");
      if (value !== undefined && this.currentContent.length === 0) this.#write(value);
      return { content: this.currentContent.length ? this.currentContent : [{ type: "text", text: "undefined" }], isError: false };
    } catch (error) {
      await this.#rollbackNewTabs(tabsBefore);
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    } finally {
      this.currentContent = null;
    }
  }

  async close() {
    clearTimeout(this.idleTimer);
    await this.browserSession?.dispose().catch(() => {});
    this.closed = true;
  }

  async #rollbackNewTabs(tabsBefore) {
    const tabs = await this.browserSession?.cua.listTabs({ emit: false }).catch(() => []) ?? [];
    await Promise.allSettled(tabs
      .filter((tab) => !tabsBefore.has(tab.id) && tab.mark == null)
      .map(async (tab) => await (await this.browserSession.cua.getTab(tab.id)).close()));
  }

  #write(value) {
    if (!this.currentContent) return;
    const text = typeof value === "string" ? value : safeOutputJson(value);
    this.currentContent.push({ type: "text", text });
  }

  async #emitImage(value) {
    if (!this.currentContent) return;
    const bytes = Buffer.isBuffer(value) ? value : value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value?.bytes ?? []);
    this.currentContent.push({ type: "image", data: bytes.toString("base64"), mimeType: value?.mimeType ?? "image/png" });
  }

  #touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref();
  }
}

const tools = [
  {
    name: "js",
    description: "Run JavaScript in a persistent, session-isolated Chrome runtime. It attaches to the already-running user Chrome profile, creates only inactive session-owned tabs, and exposes compact browser automation plus tab.devtools profiling with file-backed artifacts. Each session owns its JS bindings, tab set, and ordered action stream. Use cua-driver for native apps.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["session", "code"],
      properties: {
        session: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", description: "Unique stable session name for this delegated browser task." },
        surface: { type: "string", enum: ["browser"], default: "browser" },
        code: { type: "string", description: "JavaScript to execute." },
      },
    },
  },
  {
    name: "js_reset",
    description: "Reset one persistent browser JavaScript context and close its unmarked tabs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["session"],
      properties: { session: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" } },
    },
  },
];

export async function handle(message) {
  switch (message.method) {
    case "initialize":
      return { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "open-computer-use", version: VERSION } };
    case "ping":
      return {};
    case "tools/list":
      return { tools };
    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const session = validateSession(args.session);
      if (name === "js") {
        if (args.surface != null && args.surface !== "browser") throw new Error("surface must be browser; use cua-driver for native apps");
        if (typeof args.code !== "string" || !args.code.trim()) throw new Error("js requires non-empty code");
      } else if (name !== "js_reset") {
        throw new Error(`Unknown tool: ${name}`);
      }
      const runtime = getRuntime(session);
      return runtime.enqueue(() => runtime.callTool(name, args));
    }
    default:
      throw new Error(`Method not found: ${message.method}`);
  }
}

function getRuntime(session) {
  let runtime = sessions.get(session);
  if (!runtime || runtime.closed) {
    runtime = new BrowserSessionRuntime(session);
    sessions.set(session, runtime);
  }
  return runtime;
}

async function ensureBrowserEndpoint() {
  if (browserReady) return browserReady;
  browserReady = (async () => {
    if (BROWSER_MODE === "existing") {
      const broker = await prepareExistingProfileBroker({ chromeRoot: EXISTING_CHROME_ROOT });
      return { endpoint: broker.endpoint, broker };
    }
    if (BROWSER_MODE !== "headless") throw new Error("CLAUDE_CUA_BROWSER_MODE must be existing or headless");
    await Promise.all([mkdir(BROWSER_PROFILE, { recursive: true }), access(CHROME_PATH)]);
    const existing = await readDevToolsEndpoint();
    if (existing && await endpointAlive(existing)) return { endpoint: existing, broker: null };

    const chrome = spawn(CHROME_PATH, [
      "--headless=new",
      `--user-data-dir=${BROWSER_PROFILE}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ], { detached: true, stdio: "ignore" });
    chrome.unref();

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const endpoint = await readDevToolsEndpoint();
      if (endpoint && await endpointAlive(endpoint)) return { endpoint, broker: null };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Headless Chrome did not expose DevToolsActivePort in ${BROWSER_PROFILE}`);
  })().catch((error) => {
    browserReady = null;
    throw error;
  });
  return browserReady;
}

async function ensureBrowserConnection() {
  if (browserConnectionReady) return await browserConnectionReady;
  browserConnectionReady = (async () => {
    const { endpoint, broker } = await ensureBrowserEndpoint();
    if (process.env.CLAUDE_CUA_DEBUG === "1") console.error("[open-computer-use] opening shared Playwright CDP connection");
    const connecting = connectBrowser(endpoint);
    const consent = broker
      ? delay(750).then(() => acceptPendingExternalConsent(broker))
      : Promise.resolve();
    try {
      const browser = await connecting;
      if (process.env.CLAUDE_CUA_DEBUG === "1") console.error("[open-computer-use] shared Playwright CDP connection established");
      await consent.catch(() => {});
      browser.once("disconnected", () => {
        browserConnectionReady = null;
        browserReady = null;
      });
      return browser;
    } catch (error) {
      const brokerError = await consent.then(() => null, failure => failure);
      browserConnectionReady = null;
      browserReady = null;
      if (brokerError) throw new Error(`${error.message}; consent broker: ${brokerError.message}`);
      throw error;
    }
  })();
  return await browserConnectionReady;
}

async function readDevToolsEndpoint() {
  try {
    const [port] = (await readFile(`${BROWSER_PROFILE}/DevToolsActivePort`, "utf8")).trim().split(/\r?\n/);
    return /^\d+$/.test(port ?? "") ? `http://127.0.0.1:${port}` : null;
  } catch {
    return null;
  }
}

async function endpointAlive(endpoint) {
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

function validateSession(value) {
  if (typeof value !== "string" || !SESSION_RE.test(value)) throw new Error("session must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
  return value;
}

function safeOutputJson(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (item && typeof item === "object" && typeof item.id === "string" && typeof item.providerTabId === "string") {
        return { type: "BrowserTab", id: item.id, providerTabId: item.providerTabId };
      }
      if (typeof item === "function") return undefined;
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
        const constructorName = item.constructor?.name;
        if (["Page", "BrowserContext", "Browser", "CDPSession", "Locator"].includes(constructorName)) return `[${constructorName}]`;
      }
      return item;
    }, 2) ?? String(value);
  } catch (error) {
    return JSON.stringify({ type: typeof value, serializationError: error instanceof Error ? error.message : String(error) });
  }
}

function persistTopLevelBindings(code) {
  try {
    const program = parse(code, {
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      ecmaVersion: "latest",
      sourceType: "script",
    });
    const declarations = program.body.filter(node => node.type === "VariableDeclaration");
    if (!declarations.length) return code;
    let result = code;
    for (const node of declarations.toReversed()) {
      const assignments = node.declarations.map(declaration => {
        const pattern = code.slice(declaration.id.start, declaration.id.end);
        const value = declaration.init ? code.slice(declaration.init.start, declaration.init.end) : "undefined";
        return `${pattern} = ${value}`;
      });
      result = `${result.slice(0, node.start)}(${assignments.join(", ")});${result.slice(node.end)}`;
    }
    return result;
  } catch {
    return code;
  }
}

function returnFinalExpression(code) {
  try {
    const program = parse(code, {
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      ecmaVersion: "latest",
      sourceType: "script",
    });
    const last = program.body.at(-1);
    if (last?.type !== "ExpressionStatement") return code;
    const expression = code.slice(last.expression.start, last.expression.end);
    return `${code.slice(0, last.start)}return (${expression});${code.slice(last.end)}`;
  } catch {
    return code;
  }
}

function makeConsole(writeOutput) {
  const emit = (...values) => writeOutput(values.length === 1 ? values[0] : values.map(formatConsoleValue).join(" "));
  return Object.freeze({ log: emit, info: emit, debug: emit, warn: emit, error: emit });
}

function formatConsoleValue(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function write(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function rpcError(code, message) { return { code, message: String(message ?? "Unknown error") }; }
export async function shutdown() { await Promise.allSettled([...sessions.values()].map(runtime => runtime.close())); }
let terminating = false;
async function terminate(code) {
  if (terminating) return;
  terminating = true;
  await shutdown();
  process.exit(code);
}

function startStdio() {
  const rpc = createInterface({ input: process.stdin });
  rpc.on("line", async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      write({ jsonrpc: "2.0", id: null, error: rpcError(-32700, error.message) });
      return;
    }
    if (message.id == null) return;
    try {
      write({ jsonrpc: "2.0", id: message.id, result: await handle(message) });
    } catch (error) {
      write({ jsonrpc: "2.0", id: message.id, error: rpcError(-32000, error.message) });
    }
  });
  rpc.once("close", () => terminate(0));
  process.once("SIGINT", () => terminate(130));
  process.once("SIGTERM", () => terminate(143));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startStdio();
