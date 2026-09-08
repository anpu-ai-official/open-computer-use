import { chromium } from "playwright";
import { randomUUID } from "node:crypto";
import { createDevToolsAdapter } from "./devtools-runtime.mjs";

const HEADLESS_BROWSER_ID = "claude-headless-chrome";
const EXISTING_BROWSER_ID = "user-chrome-existing-profile";
const OWNER_PREFIX = "__claude_cua_owner__:";

export async function connectBrowser(cdpEndpoint) {
  return await chromium.connectOverCDP(cdpEndpoint, { timeout: 30_000 });
}

export async function setupBrowserSession({ cdpBrowser, output, session, existingProfile = false }) {
  const context = cdpBrowser.contexts()[0];
  if (!context) throw new Error("Chrome did not expose a default browser context");
  const browserId = existingProfile ? EXISTING_BROWSER_ID : HEADLESS_BROWSER_ID;
  const browserName = existingProfile ? "User Chrome (existing profile)" : "Claude Background Chrome";
  const browserCdp = existingProfile ? await cdpBrowser.newBrowserCDPSession() : null;

  // Never execute discovery JavaScript in pre-existing user tabs. Headless
  // mode can recover marked pages across bridge restarts; existing-profile
  // sessions begin with an empty owned set and learn only their new targets.
  if (!existingProfile) await reapDeadOwnerPages(context);

  const owned = new Map();
  let sequence = 0;
  let sessionName = session;

  class TabAdapter {
    constructor(page, restored = {}) {
      this.page = page;
      this.id = restored.id ?? `${session}-${++sequence}`;
      const restoredSequence = Number.parseInt(String(this.id).match(/-(\d+)$/)?.[1] ?? "0", 10);
      sequence = Math.max(sequence, restoredSequence);
      this.providerTabId = this.id;
      this.target = Object.freeze({ targetId: this.id, owned: true });
      this.playwright = page;
      this.dom_cua = this;
      this.cua = this;
      this.ax = new AXAdapter(this);
      this.devtools = createDevToolsAdapter({ page, context, session, tabId: this.id });
      this.preview = this.devtools.preview;
      this.mark = restored.mark ?? null;
      page.once("close", () => {
        owned.delete(this.id);
        this.devtools.dispose().catch(() => {});
      });
      page.on("popup", (popup) => {
        const child = new TabAdapter(popup);
        owned.set(child.id, child);
        child.tagOwner().catch(() => {});
      });
    }

    async tagOwner() {
      const marker = `${OWNER_PREFIX}${encodeURIComponent(JSON.stringify({ ownerPid: process.pid, session, id: this.id, mark: this.mark }))}`;
      await this.page.evaluate(value => { window.name = value; }, marker);
    }

    async goto(url) { await this.page.goto(url, { waitUntil: "domcontentloaded" }); }
    async navigate(url) { await this.goto(url); }
    async back() { await this.page.goBack({ waitUntil: "domcontentloaded" }); }
    async forward() { await this.page.goForward({ waitUntil: "domcontentloaded" }); }
    async reload() { await this.page.reload({ waitUntil: "domcontentloaded" }); }
    async waitForLoad(state = "load", options = {}) {
      if (typeof state === "object") { options = state; state = options.state ?? "load"; }
      await this.page.waitForLoadState(state, options);
    }
    async waitForFunction(pageFunction, argOrOptions, maybeOptions) {
      if (maybeOptions !== undefined) return await this.page.waitForFunction(pageFunction, argOrOptions, maybeOptions);
      return await this.page.waitForFunction(pageFunction, undefined, argOrOptions ?? {});
    }
    async waitForSelector(selector, options = {}) { return await this.page.waitForSelector(selector, options); }
    async evaluate(pageFunction, arg) { return await this.page.evaluate(pageFunction, arg); }
    async close() {
      owned.delete(this.id);
      await this.devtools.dispose();
      if (!this.page.isClosed()) await this.page.close();
    }
    async markDeliverable() { this.mark = "deliverable"; await this.tagOwner(); }
    async markHandoff() { this.mark = "handoff"; await this.tagOwner(); }
    async title() { return await this.page.title(); }
    async url() { return this.page.url(); }
    async getAXState(options = {}) { return await this.ax.get(options); }
    async getScreenshot(options = {}) {
      const bytes = await this.page.screenshot({ fullPage: options.fullPage === true });
      if (options.emit !== false) await output.emitImage(bytes);
      return bytes;
    }
    async getAXStateAndScreenshot(options = {}) {
      const state = await this.ax.get(options);
      const screenshot = await this.page.screenshot();
      if (options.emit !== false) {
        output.write(state);
        await output.emitImage(screenshot);
      }
      return { state, screenshot };
    }
    async click(target, options = {}) {
      if (typeof target === "number") return await this.ax.click(target, options);
      const [x, y] = target;
      await this.page.mouse.click(x, y, { button: mouseButton(options.mouseButton), clickCount: options.clickCount ?? 1 });
    }
    async drag(from, to) {
      await this.page.mouse.move(from[0], from[1]);
      await this.page.mouse.down();
      await this.page.mouse.move(to[0], to[1]);
      await this.page.mouse.up();
    }
    async pressKey(key) { await this.page.keyboard.press(normalizeKey(key)); }
    async typeText(text) { await this.page.keyboard.type(text); }
    async paste(text) { await this.page.keyboard.insertText(text); }
    async setValue(index, value) { await this.ax.setValue(index, value); }
    async scroll(target, direction, pages = 1) {
      const distance = 650 * pages;
      const vertical = direction === "up" || direction === "u" ? -distance : direction === "down" || direction === "d" ? distance : 0;
      const horizontal = direction === "left" || direction === "l" ? -distance : direction === "right" || direction === "r" ? distance : 0;
      if (Array.isArray(target)) await this.page.mouse.move(target[0], target[1]);
      await this.page.mouse.wheel(horizontal, vertical);
    }
    async selectText(index, text) { await this.ax.selectText(index, text); }
    async performSecondaryAction(index, action) {
      if (action.toLowerCase().includes("expand")) await this.ax.locator(index).press("ArrowRight");
      else throw new Error(`Unsupported browser secondary action: ${action}`);
    }
  }

  class AXAdapter {
    constructor(tab) {
      this.tab = tab;
      this.elements = [];
      this.lastState = null;
    }

    locator(index) {
      const locator = this.elements[index];
      if (!locator) throw new Error(`Accessibility element index ${index} is stale or unavailable; refresh state`);
      return locator;
    }

    async get(options = {}) {
      const page = this.tab.page;
      const candidates = page.locator("a,button,input,textarea,select,summary,[role],[contenteditable=true],[tabindex]");
      const count = Math.min(await candidates.count(), 500);
      this.elements = [];
      const lines = [`title: ${await page.title()}`, `url: ${page.url()}`];
      for (let i = 0; i < count; i += 1) {
        const item = candidates.nth(i);
        if (!(await item.isVisible().catch(() => false))) continue;
        const data = await item.evaluate((element) => ({
          role: element.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: "textbox", TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button" }[element.tagName] ?? element.tagName.toLowerCase()),
          name: element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || element.getAttribute("placeholder") || element.getAttribute("value") || "",
          disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
          checked: "checked" in element ? Boolean(element.checked) : undefined,
        })).catch(() => null);
        if (!data) continue;
        const index = this.elements.push(item) - 1;
        const flags = [data.disabled ? "disabled" : "", data.checked === true ? "checked" : data.checked === false ? "unchecked" : ""].filter(Boolean).join(",");
        lines.push(`[${index}] ${data.role} ${JSON.stringify(String(data.name).replace(/\s+/g, " ").trim().slice(0, 240))}${flags ? ` (${flags})` : ""}`);
      }
      const full = lines.join("\n");
      const state = options.disableDiffing || this.lastState == null ? full : lineDiff(this.lastState, full);
      this.lastState = full;
      if (options.emit !== false) output.write(state);
      return state;
    }

    async write(mode = "state", options = {}) {
      if (typeof mode === "object") { options = mode; mode = "state"; }
      if (mode === "screenshot") return await this.tab.getScreenshot(options);
      if (mode === "both") return await this.tab.getAXStateAndScreenshot(options);
      return await this.get(options);
    }
    async click(index, options = {}) { await this.locator(index).click({ button: mouseButton(options.mouseButton), clickCount: options.clickCount ?? 1 }); }
    async setValue(index, value) {
      const locator = this.locator(index);
      const tagName = await locator.evaluate(element => element.tagName);
      if (tagName === "SELECT") await locator.selectOption(String(value));
      else if (tagName === "INPUT" && ["checkbox", "radio"].includes(await locator.getAttribute("type"))) await locator.setChecked(toBoolean(value));
      else await locator.fill(String(value));
    }
    async fill(index, value) { await this.setValue(index, value); }
    async selectOption(index, value) { await this.locator(index).selectOption(String(value)); }
    async setChecked(index, checked = true) { await this.locator(index).setChecked(toBoolean(checked)); }
    async press(index, key) { await this.locator(index).press(normalizeKey(key)); }
    async type(index, text) { await this.locator(index).pressSequentially(text); }
    async typeText(text) { await this.tab.typeText(text); }
    async pressKey(key) { await this.tab.pressKey(key); }
    async scroll(target, direction, pages) { await this.tab.scroll(target, direction, pages); }
    async selectText(index, text) {
      await this.locator(index).evaluate((element, selected) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const start = element.value.indexOf(selected);
          if (start < 0) throw new Error("Text not found in editable element");
          element.focus();
          element.setSelectionRange(start, start + selected.length);
          return;
        }
        throw new Error("selectText currently supports input and textarea elements");
      }, text);
    }
  }

  class BrowserAdapter {
    constructor() {
      this.browserId = browserId;
      this.tabs = {
        list: async () => await tabInfos(),
        get: async (id) => getOwned(id),
        create: async (url) => await createBrowserTab(browserId, url),
      };
    }
    async nameSession(name) { sessionName = name; }
    async documentation() { return BROWSER_DOCUMENTATION; }
  }

  const browserAdapter = new BrowserAdapter();

  if (!existingProfile) {
    for (const page of context.pages()) {
      const metadata = await readOwner(page);
      if (!metadata || metadata.session !== session || !metadata.mark) continue;
      const tab = new TabAdapter(page, metadata);
      owned.set(tab.id, tab);
      await tab.tagOwner().catch(() => {});
    }
  }

  async function createBrowserTab(_browserId, url = "about:blank", options = {}) {
    if (typeof options.sessionName === "string" && options.sessionName.trim()) sessionName = options.sessionName.trim();
    const page = existingProfile ? await createInactivePage(context, browserCdp) : await context.newPage();
    const tab = new TabAdapter(page);
    owned.set(tab.id, tab);
    await tab.tagOwner();
    if (url && url !== "about:blank") await tab.goto(url);
    if (options.emitState !== false && options.inspectOnly !== true) await tab.getAXState({ disableDiffing: true });
    return tab;
  }

  function getOwned(id) {
    const tab = owned.get(String(id));
    if (!tab) throw new Error(`Tab is not owned by session ${session}: ${id}`);
    return tab;
  }

  async function tabInfos() {
    return await Promise.all([...owned.values()].map(async (tab) => ({
      id: tab.id,
      providerTabId: tab.providerTabId,
      browserId,
      title: await tab.title(),
      url: await tab.url(),
      sessionName,
      mark: tab.mark,
    })));
  }

  const cua = {
    async getState(options = {}) {
      const state = { apps: [], browsers: [{ id: browserId, name: browserName, family: "chrome", type: "cdp", profileName: existingProfile ? "Existing user profile" : "Claude Browser", tabs: await tabInfos() }] };
      if (options.emit !== false) output.write(JSON.stringify(state));
      return state;
    },
    async listApps(options = {}) { if (options.emit !== false) output.write("[]"); return []; },
    async getApp() { throw new Error("Use surface=computer for native macOS apps"); },
    async listBrowsers(options = {}) {
      const value = [{ id: browserId, name: browserName, family: "chrome", type: "cdp", profileName: existingProfile ? "Existing user profile" : "Claude Browser" }];
      if (options.emit !== false) output.write(JSON.stringify(value));
      return value;
    },
    async getBrowser() { return browserAdapter; },
    createBrowserTab,
    async getTab(id) { const tab = getOwned(id); await tab.getAXState({ disableDiffing: true }); return tab; },
    async listTabs(options = {}) { const value = await tabInfos(); if (options.emit !== false) output.write(JSON.stringify(value)); return value; },
    async listBrowserTabs(options = {}) { const value = await tabInfos(); if (options.emit !== false) output.write(JSON.stringify(value)); return value; },
    async closeAllTabs(options = {}) {
      const tabs = [...owned.values()].filter((tab) => options.includeMarked === true || tab.mark == null);
      await Promise.allSettled(tabs.map((tab) => tab.close()));
      return { closed: tabs.length, remaining: owned.size };
    },
  };

  async function dispose() {
    await Promise.allSettled([...owned.values()].filter((tab) => tab.mark == null).map((tab) => tab.close()));
    await browserCdp?.detach().catch(() => {});
  }

  return Object.freeze({ cua, browser: browserAdapter, context, cdpBrowser, dispose });
}

async function createInactivePage(context, browserCdp) {
  if (!browserCdp) throw new Error("Existing-profile browser CDP session is unavailable");
  const markerUrl = `about:blank#__claude_cua_target__=${randomUUID()}`;
  if (process.env.CLAUDE_CUA_DEBUG === "1") console.error("[open-computer-use] requesting inactive Chrome target");
  const { targetId } = await browserCdp.send("Target.createTarget", {
    url: markerUrl,
    background: true,
    newWindow: false,
  });
  if (process.env.CLAUDE_CUA_DEBUG === "1") console.error(`[open-computer-use] inactive target created ${targetId}`);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = context.pages().find(candidate => candidate.url() === markerUrl);
    if (page) {
      if (process.env.CLAUDE_CUA_DEBUG === "1") console.error("[open-computer-use] inactive target bound to Playwright page");
      return page;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await browserCdp.send("Target.closeTarget", { targetId }).catch(() => {});
  throw new Error("Chrome created an inactive target but Playwright could not bind its exact page");
}

function lineDiff(before, after) {
  if (before === after) return "No accessibility-tree change";
  const oldLines = new Set(before.split("\n"));
  const newLines = new Set(after.split("\n"));
  return [
    ...before.split("\n").filter((line) => !newLines.has(line)).map((line) => `- ${line}`),
    ...after.split("\n").filter((line) => !oldLines.has(line)).map((line) => `+ ${line}`),
  ].join("\n") || after;
}

function mouseButton(value) {
  if (value === "right" || value === "r") return "right";
  if (value === "middle" || value === "m") return "middle";
  return "left";
}

function normalizeKey(key) {
  return key
    .replace(/super/gi, "Meta")
    .replace(/return/gi, "Enter")
    .split("+")
    .map((part) => part.length === 1 ? part.toUpperCase() : part)
    .join("+");
}

async function reapDeadOwnerPages(context) {
  for (const page of context.pages()) {
    const metadata = await readOwner(page);
    if (!metadata || metadata.mark || isPidAlive(metadata.ownerPid)) continue;
    await page.close().catch(() => {});
  }
}

async function readOwner(page) {
  const name = await page.evaluate(() => window.name).catch(() => "");
  if (!name.startsWith(OWNER_PREFIX)) return null;
  try { return JSON.parse(decodeURIComponent(name.slice(OWNER_PREFIX.length))); } catch { return null; }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function toBoolean(value) {
  if (typeof value === "string") return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

const BROWSER_DOCUMENTATION = `Claude browser runtime. Existing-profile mode creates inactive session-owned tabs in the user's already-running Chrome profile; it never adopts an existing user tab. Use tab.ax for compact indexed state, tab.playwright for Playwright locators, and tab.devtools for target-scoped Network, Console, Application, Performance, CPU, coverage, trace, heap, and emulation workflows. DevTools artifacts are written outside the model transcript. Mark tabs deliverable or handoff only when they should be retained.`;
