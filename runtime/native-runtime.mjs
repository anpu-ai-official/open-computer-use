import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DRIVER = process.env.CLAUDE_CUA_DRIVER;
const DRIVER_SOCKET = process.env.CLAUDE_CUA_DRIVER_SOCKET;
const IDLE_MS = positiveInt(process.env.CLAUDE_CUA_NATIVE_IDLE_MS, 10 * 60 * 1000);

const NATIVE_TOOLS = new Set([
  "bring_to_front", "check_permissions", "click", "clipboard_read", "clipboard_write",
  "double_click", "drag", "get_accessibility_tree", "get_agent_cursor_state",
  "get_cursor_position", "get_desktop_state", "get_recording_state", "get_screen_size",
  "get_window_state", "health_report", "hotkey", "invoke_menu", "kill_app", "launch_app",
  "list_apps", "list_windows", "move_cursor", "press_key", "replay_trajectory", "right_click",
  "scroll", "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_theme",
  "set_value", "set_window_frame", "start_recording", "stop_recording", "type_text",
  "verify_state", "zoom",
]);

const sessions = new Map();

class DriverMcpClient {
  constructor() {
    this.process = null;
    this.replies = new Map();
    this.nextId = 0;
    this.closedError = null;
  }

  async start() {
    if (!DRIVER) throw new Error("CLAUDE_CUA_DRIVER is not configured");
    const args = ["mcp"];
    if (DRIVER_SOCKET) args.push("--socket", DRIVER_SOCKET);
    this.process = spawn(DRIVER, args, { stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.process.stdout }).on("line", line => this.#receive(line));
    this.process.stderr.on("data", chunk => {
      if (process.env.CLAUDE_CUA_DEBUG === "1") process.stderr.write(chunk);
    });
    this.process.once("error", error => this.#close(error));
    this.process.once("exit", (code, signal) => this.#close(new Error(`cua-driver MCP exited (${signal ?? code})`)));
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "open-computer-use-native", version: "0.1.0" },
    });
    this.#send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  }

  call(tool, args) {
    return this.request("tools/call", { name: tool, arguments: args });
  }

  request(method, params) {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.replies.set(String(id), { resolve, reject });
      try { this.#send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        this.replies.delete(String(id));
        reject(error);
      }
    });
  }

  close() {
    this.#close(new Error("native session closed"));
    this.process?.kill("SIGTERM");
  }

  #send(message) {
    if (!this.process?.stdin.writable) throw new Error("cua-driver MCP stdin is unavailable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id == null) return;
    const pending = this.replies.get(String(message.id));
    if (!pending) return;
    this.replies.delete(String(message.id));
    if (message.error) pending.reject(new Error(message.error.message ?? "cua-driver MCP error"));
    else pending.resolve(message.result);
  }

  #close(error) {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.replies.values()) pending.reject(error);
    this.replies.clear();
  }
}

class NativeSessionRuntime {
  constructor(session) {
    this.session = session;
    this.client = null;
    this.ready = null;
    this.tail = Promise.resolve();
    this.idleTimer = null;
    this.closed = false;
    this.elements = new Map();
    this.windowTokens = new Map();
  }

  start() {
    if (!this.ready) {
      this.ready = (async () => {
        this.client = new DriverMcpClient();
        await this.client.start();
      })().catch(error => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  enqueue(operation) {
    const ordered = this.tail.then(operation, operation);
    this.tail = ordered.catch(() => {});
    return ordered;
  }

  async call(tool, args) {
    await this.start();
    this.#touch();
    const driverArgs = this.#resolveElementToken(args);
    const result = await this.client.call(tool, driverArgs);
    if (tool === "get_window_state" && !result?.isError) this.#rememberSnapshot(result);
    return result;
  }

  close() {
    clearTimeout(this.idleTimer);
    this.client?.close();
    this.closed = true;
    this.elements.clear();
    this.windowTokens.clear();
  }

  #touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close();
      sessions.delete(this.session);
    }, IDLE_MS);
    this.idleTimer.unref();
  }

  #resolveElementToken(args) {
    const normalized = { ...args };
    if (typeof normalized.element_token !== "string") return normalized;
    const target = this.elements.get(normalized.element_token);
    if (!target) return normalized;
    for (const [field, expected] of [
      ["pid", target.pid],
      ["window_id", target.windowId],
      ["snapshot_id", target.snapshotId],
      ["element_index", target.elementIndex],
    ]) {
      if (normalized[field] != null && normalized[field] !== expected)
        throw new Error(`${field} does not agree with element_token`);
    }
    delete normalized.element_token;
    normalized.pid = target.pid;
    normalized.window_id = target.windowId;
    normalized.snapshot_id = target.snapshotId;
    normalized.element_index = target.elementIndex;
    return normalized;
  }

  #rememberSnapshot(result) {
    const state = structured(result);
    if (!state || typeof state.snapshot_id !== "string" || !Array.isArray(state.elements)) return;
    const pid = Number(state.pid);
    const windowId = Number(state.window_id);
    if (!Number.isInteger(pid) || !Number.isInteger(windowId)) return;
    const windowKey = `${pid}:${windowId}`;
    for (const token of this.windowTokens.get(windowKey) ?? []) this.elements.delete(token);
    const tokens = [];
    for (const element of state.elements) {
      if (typeof element.element_token !== "string" || !Number.isInteger(element.element_index)) continue;
      tokens.push(element.element_token);
      this.elements.set(element.element_token, {
        pid,
        windowId,
        snapshotId: state.snapshot_id,
        elementIndex: element.element_index,
      });
    }
    this.windowTokens.set(windowKey, tokens);
  }
}

export function callNative(session, tool, args) {
  if (!NATIVE_TOOLS.has(tool)) throw new Error(`Unsupported native tool: ${tool}`);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("native arguments must be an object");
  let runtime = sessions.get(session);
  if (!runtime || runtime.closed) {
    runtime = new NativeSessionRuntime(session);
    sessions.set(session, runtime);
  }
  const driverArgs = { ...args };
  delete driverArgs.session;
  return runtime.enqueue(() => runtime.call(tool, driverArgs));
}

export function resetNative(session) {
  sessions.get(session)?.close();
  sessions.delete(session);
}

export function shutdownNative() {
  for (const runtime of sessions.values()) runtime.close();
  sessions.clear();
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function structured(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  for (const item of result?.content ?? []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try { return JSON.parse(item.text); } catch {}
  }
  return null;
}
