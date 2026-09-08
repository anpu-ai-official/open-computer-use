import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const PREVIEW_ROOT = process.env.CLAUDE_CUA_PREVIEW_ROOT ?? join(tmpdir(), "claude-cua-preview");

export function createBrowserPreviewAdapter({ getCdp, page, session, tabId }) {
  return new BrowserPreviewAdapter({ getCdp, page, session, tabId });
}

class BrowserPreviewAdapter {
  constructor({ getCdp, page, session, tabId }) {
    this.getCdp = getCdp;
    this.page = page;
    this.session = session;
    this.tabId = tabId;
    this.state = null;
    this.lastResult = null;
  }

  async start(options = {}) {
    if (this.state) return { ...this.status(), alreadyStarted: true };
    const stream = safeSegment(options.stream ?? sessionGroup(this.session));
    const channel = safeSegment(options.channel ?? this.session);
    const format = options.format === "png" ? "png" : "jpeg";
    const fps = clampNumber(options.fps, 1, 12, 4);
    const mode = options.mode === "screencast" ? "screencast" : "poll";
    const directory = join(PREVIEW_ROOT, "streams", stream, channel);
    await mkdir(directory, { recursive: true });
    const cdp = await this.getCdp();
    const state = {
      stream,
      channel,
      directory,
      format,
      extension: format === "png" ? "png" : "jpg",
      fps,
      mode,
      quality: clampInteger(options.quality, 20, 95, 60),
      startedAt: new Date().toISOString(),
      frameCount: 0,
      droppedFrames: 0,
      unchangedFrames: 0,
      captureErrors: 0,
      lastAcceptedAt: 0,
      visible: null,
      pending: null,
      writing: false,
      drainPromise: Promise.resolve(),
      stopRequested: false,
    };
    state.onFrame = (event) => {
      const sessionId = event.sessionId;
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      this.#accept(state, event.data, event.metadata);
    };
    state.onVisibility = ({ visible }) => { state.visible = visible; };
    cdp.on("Page.screencastFrame", state.onFrame);
    cdp.on("Page.screencastVisibilityChanged", state.onVisibility);
    this.state = state;
    await this.#writeMeta(state, "starting");
    try {
      if (mode === "screencast") {
        await cdp.send("Page.startScreencast", {
          format,
          quality: state.quality,
          maxWidth: clampInteger(options.maxWidth, 240, 1920, 720),
          maxHeight: clampInteger(options.maxHeight, 180, 1440, 540),
          everyNthFrame: clampInteger(options.everyNthFrame, 1, 10, 1),
        });
      } else {
        cdp.off("Page.screencastFrame", state.onFrame);
        cdp.off("Page.screencastVisibilityChanged", state.onVisibility);
        state.pollPromise = this.#poll(state, cdp);
      }
      await this.#writeMeta(state, "active");
      return this.status();
    } catch (error) {
      cdp.off("Page.screencastFrame", state.onFrame);
      cdp.off("Page.screencastVisibilityChanged", state.onVisibility);
      this.state = null;
      await this.#writeMeta(state, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  status() {
    const state = this.state;
    if (!state) return this.lastResult ?? { active: false };
    return {
      active: true,
      stream: state.stream,
      channel: state.channel,
      directory: state.directory,
      fps: state.fps,
      format: state.format,
      mode: state.mode,
      frameCount: state.frameCount,
      droppedFrames: state.droppedFrames,
      unchangedFrames: state.unchangedFrames,
      captureErrors: state.captureErrors,
      visible: state.visible,
      startedAt: state.startedAt,
    };
  }

  async stop() {
    const state = this.state;
    if (!state) return this.lastResult ? { ...this.lastResult, alreadyStopped: true } : { active: false, alreadyStopped: true };
    this.state = null;
    state.stopRequested = true;
    const cdp = await this.getCdp();
    cdp.off("Page.screencastFrame", state.onFrame);
    cdp.off("Page.screencastVisibilityChanged", state.onVisibility);
    if (state.mode === "screencast") await cdp.send("Page.stopScreencast").catch(() => {});
    await state.pollPromise?.catch(() => {});
    await state.drainPromise.catch(() => {});
    const result = {
      active: false,
      stream: state.stream,
      channel: state.channel,
      directory: state.directory,
      frameCount: state.frameCount,
      droppedFrames: state.droppedFrames,
      unchangedFrames: state.unchangedFrames,
      captureErrors: state.captureErrors,
      stoppedAt: new Date().toISOString(),
    };
    this.lastResult = result;
    await this.#writeMeta(state, "stopped");
    return result;
  }

  #accept(state, data, metadata = null) {
    const now = Date.now();
    if (now - state.lastAcceptedAt < 1000 / state.fps) {
      state.droppedFrames += 1;
      return;
    }
    state.lastAcceptedAt = now;
    if (state.pending) state.droppedFrames += 1;
    state.pending = { data, metadata, receivedAt: now };
    this.#drain(state).catch(() => {});
  }

  async #poll(state, cdp) {
    while (!state.stopRequested) {
      try {
        const frame = await withTimeout(cdp.send("Page.captureScreenshot", {
          format: state.format,
          quality: state.format === "jpeg" ? state.quality : undefined,
          fromSurface: true,
          captureBeyondViewport: false,
          optimizeForSpeed: true,
        }), 1_000, "Page.captureScreenshot timed out");
        this.#accept(state, frame.data, { capture: "poll" });
      } catch (error) {
        if (!state.stopRequested) state.captureErrors += 1;
      }
      if (!state.stopRequested) await delay(1000 / state.fps);
    }
  }

  async #drain(state) {
    if (state.writing) return await state.drainPromise;
    state.writing = true;
    state.drainPromise = (async () => {
      try {
        while (state.pending) {
          const frame = state.pending;
          state.pending = null;
          const bytes = Buffer.from(frame.data, "base64");
          const hash = createHash("sha1").update(bytes).digest("hex");
          if (hash === state.lastHash) {
            state.unchangedFrames += 1;
            continue;
          }
          state.lastHash = hash;
          const framePath = join(state.directory, `latest.${state.extension}`);
          await atomicWrite(framePath, bytes);
          state.frameCount += 1;
          state.lastFrame = {
            path: framePath,
            bytes: bytes.length,
            receivedAt: frame.receivedAt,
            metadata: frame.metadata,
          };
          await this.#writeMeta(state, "active");
        }
      } finally {
        state.writing = false;
      }
    })();
    return await state.drainPromise;
  }

  async #writeMeta(state, status, error = null) {
    const title = await withTimeout(this.page.title(), 1_000, "page.title timed out").catch(() => state.lastTitle ?? "");
    if (title) state.lastTitle = title;
    const meta = {
      version: 1,
      status,
      source: state.mode === "screencast" ? "browser-cdp-screencast" : "browser-cdp-screenshot-poll",
      stream: state.stream,
      channel: state.channel,
      session: this.session,
      tabId: this.tabId,
      title,
      url: this.page.url(),
      fps: state.fps,
      mode: state.mode,
      format: state.format,
      frameCount: state.frameCount,
      droppedFrames: state.droppedFrames,
      unchangedFrames: state.unchangedFrames,
      captureErrors: state.captureErrors,
      visible: state.visible,
      startedAt: state.startedAt,
      updatedAt: new Date().toISOString(),
      lastFrame: state.lastFrame ?? null,
      error,
    };
    await atomicWrite(join(state.directory, "meta.json"), Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function atomicWrite(path, bytes) {
  const temporary = `${path}.partial-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function sessionGroup(session) {
  return String(session).replace(/[-_](network|console|application|app|cpu|memory|trace|heap|ui|native|browser)([-_].*)?$/i, "") || session;
}

function safeSegment(value) {
  const safe = String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 96);
  return safe || "preview";
}

function clampInteger(value, min, max, fallback) {
  if (value == null || !Number.isFinite(Number(value))) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(Number(value))));
}

function clampNumber(value, min, max, fallback) {
  if (value == null || !Number.isFinite(Number(value))) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}
