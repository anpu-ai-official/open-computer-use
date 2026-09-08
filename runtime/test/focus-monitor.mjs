import { execFileSync } from "node:child_process";
const driver = process.env.CLAUDE_CUA_TEST_DRIVER ?? `${process.env.HOME}/.local/bin/cua-driver-local`;

function frontmost() {
  return execFileSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'], { encoding: "utf8" }).trim();
}

function chromePid() {
  return Number.parseInt(execFileSync("/usr/bin/pgrep", ["-x", "Google Chrome"], { encoding: "utf8" }).trim(), 10);
}

function chromeWindowId(pid) {
  const result = JSON.parse(execFileSync(driver, ["list_windows", JSON.stringify({ pid })], { encoding: "utf8" }));
  const candidates = result.windows.filter((window) => window.title?.trim() && window.bounds?.width >= 500 && window.bounds?.height >= 400);
  candidates.sort((a, b) => Number(b.on_current_space === true) - Number(a.on_current_space === true) || a.z_index - b.z_index);
  if (!candidates.length) throw new Error("No normal Chrome window available");
  return candidates[0].window_id;
}

function selectedTab(pid, windowId) {
  const result = JSON.parse(execFileSync(driver, ["list_windows", JSON.stringify({ pid })], { encoding: "utf8" }));
  const window = result.windows.find((candidate) => candidate.window_id === windowId);
  return `window-title:${window?.title ?? ""}`;
}

const monitorChrome = process.argv.includes("--chrome");
const monitorChromeWhenFrontmost = process.argv.includes("--chrome-when-frontmost");
const shouldPrepareChrome = monitorChrome || monitorChromeWhenFrontmost;
const observedChromePid = shouldPrepareChrome ? chromePid() : null;
const windowId = shouldPrepareChrome ? chromeWindowId(observedChromePid) : null;
const baselineFocus = frontmost();
const baseline = { at: Date.now(), chromePid: observedChromePid, frontmost: baselineFocus, selectedTab: monitorChrome || (monitorChromeWhenFrontmost && baselineFocus === "Google Chrome") ? selectedTab(observedChromePid, windowId) : null };
const transitions = [];
const agentTabSelections = [];
let current = baseline;
let samples = 1;
let stopping = false;

console.log(JSON.stringify({ type: "baseline", ...baseline }));
const timer = setInterval(() => {
  try {
    const focus = frontmost();
    const next = { at: Date.now(), frontmost: focus, selectedTab: monitorChrome || (monitorChromeWhenFrontmost && focus === "Google Chrome") ? selectedTab(observedChromePid, windowId) : null };
    if (next.selectedTab && /Claude DevTools Expert Fixture|DevTools stress|Parallel A|Parallel B|HTTP Focus/.test(next.selectedTab)) agentTabSelections.push({ at: next.at, selectedTab: next.selectedTab });
    samples += 1;
    if (next.frontmost !== current.frontmost || next.selectedTab !== current.selectedTab) {
      const transition = { from: current, to: next };
      transitions.push(transition);
      console.log(JSON.stringify({ type: "transition", ...transition }));
    }
    current = next;
  } catch (error) {
    console.log(JSON.stringify({ type: "monitor-error", message: error.message }));
  }
}, 200);

function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const finalFocus = frontmost();
  const final = { at: Date.now(), frontmost: finalFocus, selectedTab: monitorChrome || (monitorChromeWhenFrontmost && finalFocus === "Google Chrome") ? selectedTab(observedChromePid, windowId) : null };
  console.log(JSON.stringify({ type: "summary", baseline, final, samples, transitions, agentTabSelections, agentTabWasNeverSelected: agentTabSelections.length === 0, chromeSelectedTabPreserved: monitorChrome ? final.selectedTab === baseline.selectedTab && transitions.every((item) => item.from.selectedTab === item.to.selectedTab) : null, chromeNeverFrontmost: baseline.frontmost === "Google Chrome" || transitions.every((item) => item.to.frontmost !== "Google Chrome") }));
  process.exit(0);
}
process.stdin.resume();
process.stdin.once("data", stop);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
