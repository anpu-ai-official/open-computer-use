import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile, stat } from "node:fs/promises";

const bridge = spawn(process.execPath, [new URL("../server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] });
const replies = new Map();
let nextId = 0;
createInterface({ input: bridge.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  replies.get(String(message.id))?.(message);
});

function request(session, code) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview request timed out")), 180_000);
    replies.set(String(id), (message) => {
      clearTimeout(timer);
      replies.delete(String(id));
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "js", arguments: { session, surface: "browser", code } } })}\n`);
  });
}

function payload(result) {
  const text = result.content?.filter((item) => item.type === "text").findLast((item) => item.text.trim().startsWith("{"))?.text;
  if (!text) throw new Error("preview test returned no JSON");
  return JSON.parse(text);
}

function frontmost() {
  return execFileSync("/usr/bin/osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true'], { encoding: "utf8" }).trim();
}

try {
  const before = frontmost();
  const html = `<!doctype html><title>Preview fixture</title><style>body{margin:0;background:#151824;color:white;font:48px system-ui;display:grid;place-items:center;height:100vh}</style><main id="value">frame-0</main>`;
  const url = `data:text/html,${encodeURIComponent(html)}`;
  const result = payload(await request("preview_regression", `
    let tab=await cua.createBrowserTab("chrome","about:blank",{inspectOnly:true});
    const started=await tab.preview.start({stream:"preview-regression",channel:"browser",fps:6,maxWidth:640,maxHeight:420,quality:55});
    await tab.goto(${JSON.stringify(url)});
    for (let frame=1;frame<=6;frame++) {
      await tab.evaluate(value=>{document.querySelector("#value").textContent="frame-"+value;document.body.style.background="hsl("+(value*31)+" 55% 22%)"},frame);
      await new Promise(resolve=>setTimeout(resolve,350));
    }
    const status=tab.preview.status(); const stopped=await tab.preview.stop(); await tab.close();
    nodeRepl.write(JSON.stringify({started,status,stopped,owned:(await cua.listTabs({emit:false})).length}));
  `));
  const after = frontmost();
  if (result.stopped.frameCount < 2) throw new Error(`Expected at least two streamed frames, got ${result.stopped.frameCount}`);
  if (result.owned !== 0) throw new Error("Preview test leaked a tab");
  if (before !== after) throw new Error(`Preview changed foreground from ${before} to ${after}`);
  const metaPath = `${result.stopped.directory}/meta.json`;
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  const imagePath = meta.lastFrame.path;
  const imageBytes = (await stat(imagePath)).size;
  if (meta.status !== "stopped" || imageBytes <= 0) throw new Error("Preview metadata or latest image is invalid");
  console.log(JSON.stringify({ passed: true, frameCount: result.stopped.frameCount, droppedFrames: result.stopped.droppedFrames, imagePath, imageBytes, metaPath, responseBytes: Buffer.byteLength(JSON.stringify(result)), focusPreserved: true, owned: 0 }, null, 2));
} finally {
  bridge.kill("SIGTERM");
  await new Promise((resolve) => bridge.once("close", resolve));
}
