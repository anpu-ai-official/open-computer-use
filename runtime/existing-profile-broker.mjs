import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const DRIVER_APP = process.env.CLAUDE_CUA_DRIVER_APP ?? join(homedir(), "Applications", "OpenComputerUseDriver.app");
const DRIVER = process.env.CLAUDE_CUA_DRIVER ?? join(DRIVER_APP, "Contents", "MacOS", "cua-driver");

export async function prepareExistingProfileBroker({ chromeRoot }) {
  debug("ensuring local driver daemon");
  await ensureDriverDaemon();
  debug("resolving Chrome process and window");
  const pid = await chromePid();
  const windowId = await mainChromeWindow(pid);
  const session = `open-computer-use-${process.pid}`;

  await driver("start_session", { session });
  debug(`preparing existing profile pid=${pid} window=${windowId}`);
  const prepared = await driver("browser_prepare", {
    pid,
    window_id: windowId,
    session,
    strategy: { kind: "existing_profile" },
  });
  requireOk(prepared, "prepare the existing Chrome profile");
  debug("existing profile prepared");

  const endpoint = await readEndpoint(chromeRoot);
  const keepalive = setInterval(() => {
    driver("get_session", { session }).catch(() => {});
  }, 120_000);
  keepalive.unref();

  return Object.freeze({ endpoint, pid, windowId, session, keepalive });
}

export async function acceptPendingExternalConsent(broker) {
  debug("brokering pending Playwright consent");
  const result = await driver("browser_prepare", {
    pid: broker.pid,
    window_id: broker.windowId,
    session: broker.session,
    strategy: { kind: "existing_profile" },
    accept_pending_external_consent: true,
  });
  requireOk(result, "broker Chrome's pending external DevTools consent");
  debug("pending Playwright consent accepted");
  return result;
}

async function ensureDriverDaemon() {
  let status = await command(DRIVER, ["status"]).catch(() => null);
  const pid = Number.parseInt(status?.stdout.match(/\bpid:\s*(\d+)/)?.[1] ?? "", 10);
  const commandLine = Number.isInteger(pid)
    ? (await command("/bin/ps", ["-p", String(pid), "-o", "command="]).catch(() => null))?.stdout ?? ""
    : "";
  if (status && commandLine.includes("--grant existing-profile")) return;

  if (status) await command(DRIVER, ["stop"]).catch(() => {});
  await command("/usr/bin/open", ["-n", "-g", DRIVER_APP, "--args", "serve", "--grant", "existing-profile"]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    status = await command(DRIVER, ["status"]).catch(() => null);
    if (status) {
      const startedPid = Number.parseInt(status.stdout.match(/\bpid:\s*(\d+)/)?.[1] ?? "", 10);
      const startedCommand = Number.isInteger(startedPid)
        ? (await command("/bin/ps", ["-p", String(startedPid), "-o", "command="]).catch(() => null))?.stdout ?? ""
        : "";
      if (startedCommand.includes("--grant existing-profile")) return;
    }
    await delay(200);
  }
  throw new Error("The bundled computer-use driver did not start with --grant existing-profile");
}

async function chromePid() {
  const { stdout } = await command("/usr/bin/pgrep", ["-x", "Google Chrome"]);
  const pids = stdout.trim().split(/\s+/).filter(Boolean).map(Number);
  const candidates = [];
  for (const pid of pids) {
    const process = await command("/bin/ps", ["-p", String(pid), "-o", "command="]).catch(() => null);
    const commandLine = process?.stdout ?? "";
    if (!commandLine.includes("--headless") && !commandLine.includes("--user-data-dir="))
      candidates.push(pid);
  }
  if (candidates.length !== 1)
    throw new Error(`Expected one running default-profile Google Chrome browser process, found ${candidates.length}`);
  return candidates[0];
}

async function mainChromeWindow(pid) {
  const result = await driver("list_windows", { pid });
  const windows = result.windows ?? [];
  const candidates = windows.filter(window =>
    window.pid === pid
    && typeof window.title === "string"
    && window.title.trim()
    && window.bounds?.width >= 500
    && window.bounds?.height >= 400
  );
  if (!candidates.length) throw new Error("No exact normal Chrome window was available for existing-profile consent brokering");
  candidates.sort((a, b) => {
    const current = Number(b.on_current_space === true) - Number(a.on_current_space === true);
    if (current) return current;
    const visible = Number(b.is_on_screen === true) - Number(a.is_on_screen === true);
    if (visible) return visible;
    return a.z_index - b.z_index;
  });
  return candidates[0].window_id;
}

async function readEndpoint(chromeRoot) {
  const portFile = `${chromeRoot}/DevToolsActivePort`;
  const text = await readFile(portFile, "utf8");
  const [port, browserPath] = text.trim().split(/\r?\n/);
  if (!/^\d+$/.test(port ?? "") || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browserPath ?? ""))
    throw new Error(`Existing Chrome DevToolsActivePort is malformed: ${portFile}`);
  return `ws://127.0.0.1:${port}${browserPath}`;
}

async function driver(tool, args) {
  const { stdout } = await command(DRIVER, [tool, JSON.stringify(args)]);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`The bundled computer-use driver returned non-JSON output for ${tool}`);
  }
}

function requireOk(result, action) {
  if (result?.status === "refused" || result?.refusal)
    throw new Error(`Could not ${action}: ${result.refusal?.code ?? "refused"}: ${result.refusal?.message ?? "unknown refusal"}`);
  return result;
}

async function command(file, args) {
  return await execFile(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function debug(message) {
  if (process.env.CLAUDE_CUA_DEBUG === "1") console.error(`[open-computer-use broker] ${message}`);
}
