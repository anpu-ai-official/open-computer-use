import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "claude-preview-render-"));
const script = new URL("../iterm-preview.mjs", import.meta.url).pathname;
const image = join(root, "frame.png");
writeFileSync(image, "opaque terminal image bytes");
const env = { ...process.env, CLAUDE_CUA_PREVIEW_ROOT: root };

let result = spawnSync(process.execPath, [script, "publish", "--stream", "test", "--channel", "browser", "--file", image, "--label", "updated page"], { env, encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr);
result = spawnSync(process.execPath, [script, "viewer", "--stream", "test", "--once"], { env, encoding: "buffer" });
if (result.status !== 0) throw new Error(result.stderr.toString());
const output = result.stdout;
if (output.toString("binary").split("\x1b[2J").length - 1 !== 1) throw new Error("viewer must clear exactly once at startup");
if (!output.includes(Buffer.from("]1337;File="))) throw new Error("viewer did not emit an inline image");
if (!output.includes(Buffer.from("\x1b7")) || !output.includes(Buffer.from("\x1b8"))) throw new Error("viewer did not preserve its cursor");
console.log({ passed: true, perFrameClears: 0, anchoredImages: true });
