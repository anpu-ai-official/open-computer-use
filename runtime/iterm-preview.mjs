#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const PREVIEW_ROOT = process.env.CLAUDE_CUA_PREVIEW_ROOT ?? join(tmpdir(), "claude-cua-preview");
const CLI_PATH = process.env.CLAUDE_CUA_PREVIEW_CLI ?? process.argv[1];
const DEFAULT_DRIVER = process.env.CLAUDE_CUA_DRIVER ?? join(process.env.HOME, "Applications", "OpenComputerUseDriver.app", "Contents", "MacOS", "cua-driver");

function safe(value) {
  return String(value ?? "preview").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 96) || "preview";
}

function normalizeSession(value) {
  return String(value ?? "").trim().split(":").at(-1);
}

function parseArgs(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) { result._.push(value); continue; }
    const key = value.slice(2).replaceAll("-", "_");
    if (index + 1 >= values.length || values[index + 1].startsWith("--")) result[key] = true;
    else result[key] = values[++index];
  }
  return result;
}

function requireOption(args, key) {
  if (args[key] == null || args[key] === "") throw new Error(`--${key.replaceAll("_", "-")} is required`);
  return args[key];
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.partial-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function loadJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function viewerStatePath(stream) { return join(PREVIEW_ROOT, "viewers", `${safe(stream)}.json`); }
function watcherStatePath(stream, channel) { return join(PREVIEW_ROOT, "watchers", safe(stream), `${safe(channel)}.json`); }
function channelDirectory(stream, channel) { return join(PREVIEW_ROOT, "streams", safe(stream), safe(channel)); }

function saveViewerState(value) {
  value.updatedAt = new Date().toISOString();
  atomicJson(viewerStatePath(value.stream), value);
}

function runAppleScript(source, args = []) {
  const result = spawnSync("/usr/bin/osascript", ["-e", source, ...args.map(String)], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `osascript exited ${result.status}`);
  return result.stdout.trim();
}

const FIND_SESSION = `
on findSession(sessionId)
  tell application "iTerm2"
    repeat with aWindow in windows
      repeat with aTab in tabs of aWindow
        repeat with aSession in sessions of aTab
          if unique ID of aSession is sessionId then return aSession
        end repeat
      end repeat
    end repeat
  end tell
  error "iTerm session not found: " & sessionId
end findSession

on findWindowForSession(sessionId)
  tell application "iTerm2"
    repeat with aWindow in windows
      repeat with aTab in tabs of aWindow
        repeat with aSession in sessions of aTab
          if unique ID of aSession is sessionId then return aWindow
        end repeat
      end repeat
    end repeat
  end tell
  error "iTerm window not found for session: " & sessionId
end findWindowForSession
`;

function sessionInfo(sessionId) {
  const output = runAppleScript(`${FIND_SESSION}
on run argv
  set aSession to findSession(item 1 of argv)
  tell application "iTerm2" to return (unique ID of aSession) & linefeed & (columns of aSession as text) & linefeed & (rows of aSession as text) & linefeed & (name of aSession)
end run`, [normalizeSession(sessionId)]).split("\n");
  return { sessionId: output[0], columns: Number(output[1]), rows: Number(output[2]), name: output.slice(3).join("\n") };
}

function sessionExists(sessionId) {
  try { sessionInfo(sessionId); return true; } catch { return false; }
}

function splitSession({ sourceSession, orientation, command, width, height }) {
  const output = runAppleScript(`${FIND_SESSION}
on run argv
  set sourceSession to findSession(item 1 of argv)
  set sourceWindow to findWindowForSession(item 1 of argv)
  set orientation to item 2 of argv
  set viewerCommand to item 3 of argv
  set requestedWidth to (item 4 of argv) as integer
  set requestedHeight to (item 5 of argv) as integer
  tell application "iTerm2"
    set originalBounds to bounds of sourceWindow
    set originalWidth to columns of sourceSession
    set originalHeight to rows of sourceSession
    if orientation is "right" then
      set viewerSession to split vertically with same profile sourceSession
      set columns of viewerSession to requestedWidth
    else
      set viewerSession to split horizontally with same profile sourceSession
      set rows of viewerSession to requestedHeight
    end if
    delay 0.15
    write viewerSession text viewerCommand newline yes
    set bounds of sourceWindow to originalBounds
    select sourceSession
    return (unique ID of viewerSession) & linefeed & (columns of viewerSession as text) & linefeed & (rows of viewerSession as text) & linefeed & (originalWidth as text) & linefeed & (originalHeight as text) & linefeed & (item 1 of originalBounds as text) & linefeed & (item 2 of originalBounds as text) & linefeed & (item 3 of originalBounds as text) & linefeed & (item 4 of originalBounds as text)
  end tell
end run`, [sourceSession, orientation, command, width, height]).split("\n").map((value, index) => index === 0 ? value : Number(value));
  return { viewerSessionId: output[0], width: output[1], height: output[2], sourceWidth: output[3], sourceHeight: output[4], windowBounds: output.slice(5, 9) };
}

function resizeSession({ sourceSession, viewerSession, orientation, size }) {
  runAppleScript(`${FIND_SESSION}
on run argv
  set sourceSession to findSession(item 1 of argv)
  set sourceWindow to findWindowForSession(item 1 of argv)
  set viewerSession to findSession(item 2 of argv)
  set orientation to item 3 of argv
  set requestedSize to (item 4 of argv) as integer
  tell application "iTerm2"
    set originalBounds to bounds of sourceWindow
    if orientation is "right" then
      set columns of viewerSession to requestedSize
    else
      set rows of viewerSession to requestedSize
    end if
    set bounds of sourceWindow to originalBounds
    select sourceSession
  end tell
end run`, [sourceSession, viewerSession, orientation, size]);
}

function closeSession(viewerSession, sourceSession, windowBounds = []) {
  runAppleScript(`${FIND_SESSION}
on run argv
  set viewerSession to findSession(item 1 of argv)
  set sourceSession to findSession(item 2 of argv)
  set sourceWindow to findWindowForSession(item 2 of argv)
  tell application "iTerm2"
    close viewerSession
    if (count of argv) is 6 then set bounds of sourceWindow to {(item 3 of argv) as integer, (item 4 of argv) as integer, (item 5 of argv) as integer, (item 6 of argv) as integer}
    select sourceSession
  end tell
end run`, [viewerSession, sourceSession, ...windowBounds]);
}

function shellQuote(value) { return `'${String(value).replaceAll("'", `'\\''`)}'`; }

function startViewer(args) {
  const stream = safe(requireOption(args, "stream"));
  const sourceSessionId = normalizeSession(args.source_session ?? process.env.ITERM_SESSION_ID);
  if (!sourceSessionId) throw new Error("No iTerm source session was supplied and ITERM_SESSION_ID is unavailable");
  const source = sessionInfo(sourceSessionId);
  const existing = loadJson(viewerStatePath(stream));
  if (existing && (existing.minimized || sessionExists(existing.viewerSessionId))) return resizeViewer({ ...args, stream }, false);
  const requestedWidth = Math.max(18, Math.min(80, Number(args.width ?? 30)));
  const requestedHeight = Math.max(8, Math.min(24, Number(args.height ?? 12)));
  const orientation = args.position && args.position !== "auto" ? args.position : source.columns >= 80 ? "right" : "bottom";
  const viewerCommand = `exec ${shellQuote(CLI_PATH)} viewer --stream ${shellQuote(stream)} --source-session ${shellQuote(sourceSessionId)}`;
  const split = splitSession({ sourceSession: sourceSessionId, orientation, command: viewerCommand, width: requestedWidth, height: requestedHeight });
  const state = {
    version: 2, status: "active", stream, sourceSessionId, viewerSessionId: split.viewerSessionId,
    orientation, width: split.width, height: split.height, sourceWidth: split.sourceWidth, sourceHeight: split.sourceHeight, windowBounds: split.windowBounds,
    minimizedWidth: 3, minimizedHeight: 2, minimized: false, createdAt: new Date().toISOString(),
  };
  saveViewerState(state);
  return { ...state, status: "started" };
}

function resizeViewer(args, minimized) {
  const state = loadJson(viewerStatePath(requireOption(args, "stream")));
  if (!state) throw new Error(`No preview viewer exists for stream ${args.stream}`);
  if (!sessionExists(state.sourceSessionId)) throw new Error("The source iTerm session no longer exists");
  if (minimized) {
    if (state.viewerSessionId && sessionExists(state.viewerSessionId)) closeSession(state.viewerSessionId, state.sourceSessionId, state.windowBounds);
    state.viewerSessionId = null;
    state.minimized = true;
    saveViewerState(state);
    return { ...state, status: "minimized" };
  }
  const size = state.orientation === "right"
    ? Math.max(18, Math.min(80, Number(args.width ?? state.width ?? 30)))
    : Math.max(8, Math.min(24, Number(args.height ?? state.height ?? 12)));
  if (!state.viewerSessionId || !sessionExists(state.viewerSessionId)) {
    const viewerCommand = `exec ${shellQuote(CLI_PATH)} viewer --stream ${shellQuote(state.stream)} --source-session ${shellQuote(state.sourceSessionId)}`;
    const split = splitSession({ sourceSession: state.sourceSessionId, orientation: state.orientation, command: viewerCommand, width: state.orientation === "right" ? size : state.width, height: state.orientation === "bottom" ? size : state.height });
    state.viewerSessionId = split.viewerSessionId;
    state.windowBounds = split.windowBounds;
  } else resizeSession({ sourceSession: state.sourceSessionId, viewerSession: state.viewerSessionId, orientation: state.orientation, size });
  state[state.orientation === "right" ? "width" : "height"] = size;
  state.minimized = false;
  saveViewerState(state);
  return { ...state, status: "restored" };
}

function stopStreamWatchers(stream) {
  const directory = join(PREVIEW_ROOT, "watchers", safe(stream));
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const state = loadJson(join(directory, name));
    if (state?.status === "running" && processAlive(state.pid)) { try { process.kill(state.pid, "SIGTERM"); } catch {} }
  }
}

function closeViewer(args) {
  const stream = safe(requireOption(args, "stream"));
  const state = loadJson(viewerStatePath(stream));
  if (!state) { stopStreamWatchers(stream); return { status: "absent", stream }; }
  if (state.viewerSessionId && sessionExists(state.viewerSessionId) && sessionExists(state.sourceSessionId)) closeSession(state.viewerSessionId, state.sourceSessionId, state.windowBounds);
  state.status = "closed";
  state.closedAt = new Date().toISOString();
  saveViewerState(state);
  stopStreamWatchers(stream);
  return { ...state, status: "closed" };
}

function statusViewer(args) {
  const stream = safe(requireOption(args, "stream"));
  const state = loadJson(viewerStatePath(stream));
  if (!state) return { status: "absent", stream };
  const viewerAlive = state.viewerSessionId ? sessionExists(state.viewerSessionId) : false;
  return { ...state, status: state.minimized ? "minimized" : viewerAlive ? "active" : "stale", viewerAlive };
}

function channelStates(stream) {
  const directory = join(PREVIEW_ROOT, "streams", safe(stream));
  if (!existsSync(directory)) return [];
  const values = [];
  for (const channel of readdirSync(directory)) {
    const value = loadJson(join(directory, channel, "meta.json"));
    if (value) values.push(value);
  }
  return values.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || Number(b.frameCount ?? 0) - Number(a.frameCount ?? 0));
}

function renderFrame(stream, paused, clear = false) {
  const columns = process.stdout.columns ?? 42;
  const rows = process.stdout.rows ?? 24;
  const states = channelStates(stream);
  const active = states.find(value => value.lastFrame?.path);
  let output = "\x1b[H" + (clear ? "\x1b[2J" : "") + "\x1b[2K\x1b[1;38;5;45m Open Computer Use  ◱\x1b[0m\n";
  output += paused ? "\x1b[2K\x1b[38;5;220mPAUSED\x1b[0m  p resume • m hide • q close\n" : "\x1b[2Km hide • p pause • q close\n";
  if (!active) output += "\x1b[2K\n\x1b[2KWaiting for browser/native frames…\n\x1b[J";
  else {
    const label = active.actionLabel ?? active.title ?? active.channel ?? "computer use";
    output += `\x1b[2K\x1b[38;5;250m${String(label).slice(0, Math.max(8, columns - 18))}\x1b[0m  ${active.status ?? "active"} · frame ${active.frameCount ?? 0}\n`;
    const path = active.lastFrame.path;
    try {
      if (active.lastFrame.mimeType === "text/plain" || extname(path) === ".txt") {
        const lines = readFileSync(path, "utf8").split("\n").slice(-(rows - 4));
        for (let row = 0; row < rows - 4; row += 1) output += `\x1b[${row + 4};1H\x1b[2K${(lines[row] ?? "").slice(0, columns)}`;
      } else {
        const data = readFileSync(path).toString("base64");
        const height = Math.max(4, rows - 5);
        output += `\x1b[4;1H\x1b7\x1b]1337;File=inline=1;width=100%;height=${height};preserveAspectRatio=1:${data}\x07\x1b8`;
      }
    } catch (error) { output += `\x1b[2KFrame unavailable: ${error.message}\n`; }
  }
  if (states.length > 1) output += `\x1b[${Math.max(5, rows)};1H\x1b[2K${states.length} parallel channels; showing latest`;
  process.stdout.write(output);
}

async function viewer(args) {
  const stream = safe(requireOption(args, "stream"));
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H\x1b]0;Open Computer Use Preview\x07");
  if (process.stdin.isTTY) { process.stdin.setRawMode(true); process.stdin.resume(); }
  let paused = false;
  let lastSignature = "";
  let done = false;
  const keyHandler = key => {
    const value = key.toString();
    if (/^[qQ]$/.test(value)) { spawn(CLI_PATH, ["close", "--stream", stream], { detached: true, stdio: "ignore" }).unref(); done = true; }
    else if (/^[mM]$/.test(value)) spawn(CLI_PATH, ["minimize", "--stream", stream], { detached: true, stdio: "ignore" }).unref();
    else if (/^[rR]$/.test(value)) spawn(CLI_PATH, ["restore", "--stream", stream], { detached: true, stdio: "ignore" }).unref();
    else if (/^[pP ]$/.test(value)) { paused = !paused; renderFrame(stream, paused, false); }
  };
  process.stdin.on("data", keyHandler);
  try {
    do {
      const signature = JSON.stringify(channelStates(stream).map(value => [value.channel, value.updatedAt, value.frameCount, value.status]));
      if (!paused && signature !== lastSignature) { renderFrame(stream, false, false); lastSignature = signature; }
      if (args.once) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (!done);
  } finally {
    process.stdin.off("data", keyHandler);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }
}

function publishFile(args) {
  const source = requireOption(args, "file");
  if (!existsSync(source)) throw new Error(`Frame file does not exist: ${source}`);
  const stream = safe(requireOption(args, "stream"));
  const channel = safe(requireOption(args, "channel"));
  const directory = channelDirectory(stream, channel);
  mkdirSync(directory, { recursive: true });
  const extension = [".png", ".jpg", ".jpeg", ".txt"].includes(extname(source).toLowerCase()) ? extname(source).toLowerCase() : ".png";
  const destination = join(directory, `latest${extension}`);
  const temporary = `${destination}.partial-${randomUUID()}`;
  copyFileSync(source, temporary);
  renameSync(temporary, destination);
  const previous = loadJson(join(directory, "meta.json")) ?? {};
  const mimeType = extension === ".txt" ? "text/plain" : extension === ".png" ? "image/png" : "image/jpeg";
  const meta = {
    version: 2, status: args.status ?? "active", source: args.source ?? "local-frame", stream, channel,
    actionLabel: args.label ?? "native action", frameCount: Number(previous.frameCount ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    lastFrame: { path: destination, bytes: statSync(destination).size, mimeType, receivedAt: Date.now() },
  };
  atomicJson(join(directory, "meta.json"), meta);
  return meta;
}

function parseDriverJson(value) {
  const start = value.indexOf("{");
  if (start < 0) throw new Error(value.trim() || "Driver returned no JSON");
  return JSON.parse(value.slice(start));
}

function captureDriver(args, toolArgs) {
  const driver = args.driver ?? DEFAULT_DRIVER;
  const result = spawnSync(driver, ["get_window_state", JSON.stringify(toolArgs)], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: Math.max(1000, Number(args.capture_timeout ?? 2) * 1000) });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Driver exited ${result.status}`);
  return parseDriverJson(result.stdout);
}

function nativeSnapshot(args) {
  const toolArgs = JSON.parse(requireOption(args, "json"));
  const directory = channelDirectory(args.stream, args.channel);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `native-${randomUUID()}.png`);
  toolArgs.include_screenshot = true;
  toolArgs.screenshot_out_file = temporary;
  const result = captureDriver(args, toolArgs);
  if (existsSync(temporary)) {
    const published = publishFile({ ...args, file: temporary, source: "cua-driver-window-snapshot", status: "active" });
    unlinkSync(temporary);
    result.screenshot_file_path = published.lastFrame.path;
  }
  return result;
}

function processAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function readItermText(sessionId) {
  return runAppleScript(`${FIND_SESSION}
on run argv
  set aSession to findSession(item 1 of argv)
  tell application "iTerm2" to return contents of aSession
end run`, [normalizeSession(sessionId)]);
}

function captureWindow(args) {
  const directory = channelDirectory(args.stream, args.channel);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `watch-${randomUUID()}.png`);
  const values = {
    session: `preview-${safe(args.stream)}-${safe(args.channel)}`, pid: Number(args.pid), window_id: Number(args.window_id),
    include_accessibility_tree: false, include_screenshot: true, screenshot_out_file: temporary,
    max_dimension: Number(args.max_dimension ?? 900),
  };
  let result;
  try { result = captureDriver(args, values); } catch { result = null; }
  if (!result || !existsSync(temporary)) {
    values.include_accessibility_tree = true; values.max_elements = 1; values.max_depth = 1;
    result = captureDriver(args, values);
  }
  if (!existsSync(temporary)) throw new Error(result.degraded_reason ?? "Driver returned no screenshot");
  return temporary;
}

async function nativeWatchWorker(args) {
  let stopped = false;
  process.on("SIGTERM", () => { stopped = true; });
  process.on("SIGINT", () => { stopped = true; });
  const state = {
    version: 2, status: "running", stream: safe(args.stream), channel: safe(args.channel), pid: process.pid,
    targetPid: Number(args.pid), windowId: Number(args.window_id), itermSessionId: args.iterm_session ? normalizeSession(args.iterm_session) : null,
    fps: Number(args.fps ?? 1), changedFrames: 0, unchangedFrames: 0, captureErrors: 0, startedAt: new Date().toISOString(),
  };
  const statePath = watcherStatePath(state.stream, state.channel);
  let previousHash = null;
  while (!stopped) {
    const started = Date.now();
    let temporary = null;
    try {
      let source = "cua-driver-window-watch";
      if (args.iterm_session) {
        const directory = channelDirectory(args.stream, args.channel);
        mkdirSync(directory, { recursive: true });
        temporary = join(directory, `iterm-${randomUUID()}.txt`);
        writeFileSync(temporary, readItermText(args.iterm_session));
        source = "iterm-applescript-buffer";
        state.captureMode = source;
      } else temporary = captureWindow(args);
      const digest = createHash("sha256").update(readFileSync(temporary)).digest("hex");
      if (digest !== previousHash) {
        const published = publishFile({ ...args, file: temporary, source, status: "active" });
        previousHash = digest; state.changedFrames += 1; state.lastFrame = published.lastFrame;
      } else state.unchangedFrames += 1;
      state.lastCaptureAt = Date.now();
      delete state.lastError;
    } catch (error) { state.captureErrors += 1; state.lastError = error.message; }
    finally { if (temporary && existsSync(temporary)) unlinkSync(temporary); state.updatedAt = new Date().toISOString(); atomicJson(statePath, state); }
    const period = 1000 / Math.max(0.25, Math.min(5, Number(args.fps ?? 1)));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, period - (Date.now() - started))));
  }
  state.status = "stopped"; state.stoppedAt = new Date().toISOString(); state.updatedAt = state.stoppedAt; atomicJson(statePath, state);
}

function nativeWatchStart(args) {
  for (const key of ["stream", "channel", "pid", "window_id"]) requireOption(args, key);
  const path = watcherStatePath(args.stream, args.channel);
  const existing = loadJson(path);
  if (existing?.status === "running" && processAlive(existing.pid)) return { status: "already-running", ...existing };
  mkdirSync(dirname(path), { recursive: true });
  const logPath = path.replace(/\.json$/, ".log");
  const values = ["native-watch-worker"];
  for (const [key, value] of Object.entries(args)) {
    if (key === "_" || value == null || value === false) continue;
    values.push(`--${key.replaceAll("_", "-")}`);
    if (value !== true) values.push(String(value));
  }
  const log = openSync(logPath, "a");
  const child = spawn(process.execPath, [SCRIPT, ...values], { detached: true, stdio: ["ignore", log, log] });
  child.unref();
  closeSync(log);
  const started = { version: 2, status: "running", stream: safe(args.stream), channel: safe(args.channel), pid: child.pid, targetPid: Number(args.pid), windowId: Number(args.window_id), fps: Number(args.fps ?? 1), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: logPath };
  atomicJson(path, started);
  return { ...started, status: "started" };
}

function nativeWatchStop(args) {
  const path = watcherStatePath(requireOption(args, "stream"), requireOption(args, "channel"));
  const state = loadJson(path);
  if (!state) return { status: "absent", stream: safe(args.stream), channel: safe(args.channel) };
  if (processAlive(state.pid)) { try { process.kill(state.pid, "SIGTERM"); } catch {} }
  return { ...state, status: "stopping", alive: processAlive(state.pid) };
}

function nativeWatchStatus(args) {
  const state = loadJson(watcherStatePath(requireOption(args, "stream"), requireOption(args, "channel")));
  if (!state) return { status: "absent", stream: safe(args.stream), channel: safe(args.channel) };
  const alive = processAlive(state.pid);
  return { ...state, status: state.status === "running" && !alive ? "stale" : state.status, alive };
}

function help() {
  process.stdout.write(`Usage: open-computer-use preview <command> [options]\n\nCommands:\n  start | minimize | restore | status | close | probe\n  viewer | publish | native-snapshot\n  native-watch-start | native-watch-stop | native-watch-status\n`);
}

async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  let result;
  switch (command) {
    case "start": result = startViewer(args); break;
    case "minimize": result = resizeViewer(args, true); break;
    case "restore": result = resizeViewer(args, false); break;
    case "status": result = statusViewer(args); break;
    case "close": result = closeViewer(args); break;
    case "viewer": await viewer(args); return;
    case "publish": result = publishFile(args); break;
    case "native-snapshot": result = nativeSnapshot(args); break;
    case "native-watch-start": result = nativeWatchStart(args); break;
    case "native-watch-worker": await nativeWatchWorker(args); return;
    case "native-watch-stop": result = nativeWatchStop(args); break;
    case "native-watch-status": result = nativeWatchStatus(args); break;
    case "probe": result = { status: "ready", app: "iTerm2", version: runAppleScript('tell application "iTerm2" to return version') }; break;
    case "help": case "--help": case "-h": case undefined: help(); return;
    default: throw new Error(`Unknown command: ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => { process.stderr.write(`${JSON.stringify({ status: "error", error: error.message })}\n`); process.exitCode = 1; });
