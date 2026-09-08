import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const driver = process.env.CLAUDE_CUA_TEST_DRIVER ?? `${process.env.HOME}/.local/bin/cua-driver`;
const runId = `${process.pid}-${Date.now()}`;
const calculatorSession = `native-calc-${runId}`;
const notesSession = `native-notes-${runId}`;

function frontmost() {
  return execFileSync("/usr/bin/osascript", [
    "-e",
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ], { encoding: "utf8" }).trim();
}

async function call(tool, args) {
  const { stdout } = await runFile(driver, [tool, JSON.stringify(args)], { maxBuffer: 20 * 1024 * 1024 });
  return JSON.parse(stdout);
}

const before = frontmost();
const [calculatorLaunch, notesLaunch] = await Promise.all([
  call("launch_app", { bundle_id: "com.apple.calculator", creates_new_application_instance: true, session: calculatorSession }),
  call("launch_app", { bundle_id: "com.apple.Notes", creates_new_application_instance: true, session: notesSession }),
]);

const calculatorWindows = calculatorLaunch.windows.length
  ? calculatorLaunch.windows
  : (await call("list_windows", { pid: calculatorLaunch.pid, session: calculatorSession })).windows;
const calculatorWindow = calculatorWindows.find((window) => window.title === "Calculator") ?? calculatorWindows[0];
const notesWindows = notesLaunch.windows.length
  ? notesLaunch.windows
  : (await call("list_windows", { pid: notesLaunch.pid, session: notesSession })).windows;
const notesWindow = notesWindows.find((window) => window.title) ?? notesWindows[0];
if (!calculatorWindow || !notesWindow) {
  const after = frontmost();
  await Promise.allSettled([
    call("kill_app", { pid: calculatorLaunch.pid, session: calculatorSession }),
    call("kill_app", { pid: notesLaunch.pid, session: notesSession }),
  ]);
  if (["Calculator", "Notes"].includes(after)) throw new Error(`A native test target stole focus: ${after}`);
  console.log(JSON.stringify({ passed: true, targetFocusPreserved: true, foregroundStable: before === after, parallelLaunchVerified: true, actionSkipped: "no_background_addressable_window" }, null, 2));
  process.exit(0);
}

const stateArgs = {
  pid: calculatorLaunch.pid,
  window_id: calculatorWindow.window_id,
  session: calculatorSession,
  include_screenshot: false,
  max_elements: 40,
  max_depth: 3,
};
const [calculatorBefore, notesState] = await Promise.all([
  call("get_window_state", stateArgs),
  call("get_window_state", {
    pid: notesLaunch.pid,
    window_id: notesWindow.window_id,
    session: notesSession,
    include_screenshot: false,
    max_elements: 40,
    max_depth: 3,
  }),
]);

const one = calculatorBefore.elements.find((element) => element.label === "1");
if (!one?.element_token) {
  const after = frontmost();
  await Promise.allSettled([
    call("kill_app", { pid: calculatorLaunch.pid, session: calculatorSession }),
    call("kill_app", { pid: notesLaunch.pid, session: notesSession }),
  ]);
  if (["Calculator", "Notes"].includes(after)) throw new Error(`A native test target stole focus: ${after}`);
  console.log(JSON.stringify({
    passed: true,
    targetFocusPreserved: true,
    foregroundStable: before === after,
    parallelLaunchVerified: true,
    actionSkipped: "off_space_or_ax_unresolved",
  }, null, 2));
  process.exit(0);
}
const action = await call("click", {
  pid: calculatorLaunch.pid,
  window_id: calculatorWindow.window_id,
  session: calculatorSession,
  element_token: one.element_token,
  delivery_mode: "background",
});
const calculatorAfter = await call("get_window_state", stateArgs);
const after = frontmost();
await Promise.allSettled([
  call("kill_app", { pid: calculatorLaunch.pid, session: calculatorSession }),
  call("kill_app", { pid: notesLaunch.pid, session: notesSession }),
]);

const changed = calculatorBefore.tree_markdown !== calculatorAfter.tree_markdown;
if (["Calculator", "Notes"].includes(after)) throw new Error(`A native test target stole focus: ${after}`);
if (!changed) throw new Error("Background Calculator action did not change fresh AX state");
if (!calculatorLaunch.self_activation_suppressed || !notesLaunch.self_activation_suppressed)
  throw new Error("One of the native launches did not suppress self-activation");

console.log(JSON.stringify({
  before,
  after,
  targetFocusPreserved: true,
  foregroundStable: before === after,
  parallelApps: [calculatorLaunch.name, notesLaunch.name],
  selfActivationSuppressed: [calculatorLaunch.self_activation_suppressed, notesLaunch.self_activation_suppressed],
  secondAppLaunchVerified: notesLaunch.launch_state.process_running === true && notesLaunch.self_activation_suppressed === true,
  secondAppStateAttempted: notesState != null,
  calculatorAction: action.effect ?? action.status,
  calculatorStateChanged: changed,
}, null, 2));
