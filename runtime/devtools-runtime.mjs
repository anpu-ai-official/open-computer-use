import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { createBrowserPreviewAdapter } from "./preview-runtime.mjs";

const ARTIFACT_ROOT = process.env.CLAUDE_CUA_ARTIFACT_DIR ?? join(tmpdir(), "open-computer-use-artifacts");
const BLOCKED_RAW_METHODS = new Set([
  "Page.bringToFront",
  "Target.activateTarget",
  "Target.attachToBrowserTarget",
  "Target.attachToTarget",
  "Target.getTargetInfo",
  "Target.getTargets",
  "Target.setAutoAttach",
]);

let traceLease = null;

export function createDevToolsAdapter({ page, context, session, tabId }) {
  return new DevToolsAdapter({ page, context, session, tabId });
}

class DevToolsAdapter {
  constructor({ page, context, session, tabId }) {
    this.page = page;
    this.context = context;
    this.session = session;
    this.tabId = tabId;
    this.cdpReady = null;
    this.networkState = null;
    this.lastNetworkResult = null;
    this.consoleState = null;
    this.lastConsoleResult = null;
    this.cpuState = null;
    this.coverageState = null;
    this.lastCoverageResult = null;
    this.cssCoverageState = null;
    this.lastCssCoverageResult = null;
    this.issuesState = null;
    this.lastIssuesResult = null;
    this.traceState = null;
    this.performanceInstalled = false;
    this.emulationActive = false;
    this.artifactRunId = randomUUID();
    this.artifactDirectory = null;
    this.artifacts = [];
    this.manifestTail = Promise.resolve();
    this.preview = createBrowserPreviewAdapter({ getCdp: async () => await this.cdp(), page, session, tabId });

    this.network = Object.freeze({
      start: async (options = {}) => await this.networkStart(options),
      stop: async (options = {}) => await this.networkStop(options),
    });
    this.console = Object.freeze({
      start: async () => await this.consoleStart(),
      stop: async (options = {}) => await this.consoleStop(options),
    });
    this.issues = Object.freeze({
      start: async () => await this.issuesStart(),
      stop: async (options = {}) => await this.issuesStop(options),
    });
    this.application = Object.freeze({
      snapshot: async (options = {}) => await this.applicationSnapshot(options),
    });
    this.performance = Object.freeze({
      start: async () => await this.performanceStart(),
      snapshot: async (options = {}) => await this.performanceSnapshot(options),
      stop: async (options = {}) => await this.performanceSnapshot(options),
      traceStart: async (options = {}) => await this.traceStart(options),
      traceStop: async (options = {}) => await this.traceStop(options),
      audit: async (options = {}) => await this.performanceAudit(options),
    });
    this.profiler = Object.freeze({
      cpuStart: async (options = {}) => await this.cpuStart(options),
      cpuStop: async (options = {}) => await this.cpuStop(options),
      coverageStart: async (options = {}) => await this.coverageStart(options),
      coverageStop: async (options = {}) => await this.coverageStop(options),
      cssCoverageStart: async () => await this.cssCoverageStart(),
      cssCoverageStop: async (options = {}) => await this.cssCoverageStop(options),
    });
    this.memory = Object.freeze({
      heapSnapshot: async (options = {}) => await this.heapSnapshot(options),
      samplingStart: async (options = {}) => await this.heapSamplingStart(options),
      samplingStop: async (options = {}) => await this.heapSamplingStop(options),
      collectGarbage: async () => await this.collectGarbage(),
    });
    this.emulation = Object.freeze({
      network: async (options = {}) => await this.emulateNetwork(options),
      cpu: async (rate = 1) => await this.emulateCpu(rate),
      reset: async () => await this.resetEmulation(),
    });
  }

  async cdp() {
    if (!this.cdpReady) this.cdpReady = this.context.newCDPSession(this.page);
    return await this.cdpReady;
  }

  async start(options = {}) {
    const started = {};
    if (options.performance !== false) started.performance = await this.performanceStart();
    if (options.network) started.network = await this.networkStart(options.network === true ? {} : options.network);
    if (options.console) started.console = await this.consoleStart();
    if (options.issues) started.issues = await this.issuesStart();
    if (options.cpu) started.cpu = await this.cpuStart(options.cpu === true ? {} : options.cpu);
    if (options.coverage) started.coverage = await this.coverageStart(options.coverage === true ? {} : options.coverage);
    if (options.cssCoverage) started.cssCoverage = await this.cssCoverageStart();
    if (options.trace) started.trace = await this.traceStart(options.trace === true ? {} : options.trace);
    return started;
  }

  async stop(options = {}) {
    const result = {};
    if (this.traceState) result.trace = await this.traceStop(options.trace ?? {});
    if (this.cpuState) result.cpu = await this.cpuStop(options.cpu ?? {});
    if (this.coverageState) result.coverage = await this.coverageStop(options.coverage ?? {});
    if (this.cssCoverageState) result.cssCoverage = await this.cssCoverageStop(options.cssCoverage ?? {});
    if (this.networkState) result.network = await this.networkStop(options.network ?? {});
    if (this.consoleState) result.console = await this.consoleStop(options.console ?? {});
    if (this.issuesState) result.issues = await this.issuesStop(options.issues ?? {});
    result.performance = await this.performanceSnapshot(options.performance ?? {});
    return result;
  }

  async send(method, params = {}) {
    if (BLOCKED_RAW_METHODS.has(method)) throw new Error(`${method} is unavailable because it can discover or foreground non-owned tabs`);
    return await (await this.cdp()).send(method, params);
  }

  async info() {
    const [version, frameTree] = await Promise.all([
      this.send("Browser.getVersion"),
      this.send("Page.getFrameTree"),
    ]);
    const [name, productVersion = ""] = String(version.product ?? "Chrome/").split("/");
    return { ...version, browser: { name, version: productVersion, product: version.product }, tabId: this.tabId, session: this.session, mainFrameId: frameTree.frameTree.frame.id, url: this.page.url(), artifactRunId: this.artifactRunId };
  }

  async artifactManifest() {
    await this.manifestTail;
    return { runId: this.artifactRunId, directory: this.artifactDirectory, artifacts: [...this.artifacts] };
  }

  async networkStart(options = {}) {
    if (this.networkState) throw new Error("Network capture is already active for this tab");
    const cdp = await this.cdp();
    const state = {
      startedAt: new Date().toISOString(),
      requests: new Map(),
      listeners: [],
      disableCache: options.disableCache === true,
      includeExtraInfo: options.includeExtraInfo !== false,
      maxRequests: clampInteger(options.maxRequests, 100, 100_000, 10_000),
      droppedRequests: 0,
    };
    state.remember = (id, item) => {
      if (!state.requests.has(id) && state.requests.size >= state.maxRequests) {
        const oldest = state.requests.keys().next().value;
        state.requests.delete(oldest);
        state.droppedRequests += 1;
      }
      state.requests.set(id, item);
    };
    const listen = (event, handler) => {
      cdp.on(event, handler);
      state.listeners.push([event, handler]);
    };
    listen("Network.requestWillBeSent", (event) => {
      const existing = state.requests.get(event.requestId);
      const redirectChain = existing?.redirectChain ?? [];
      if (event.redirectResponse) redirectChain.push(summarizeResponse(event.redirectResponse));
      state.remember(event.requestId, {
        requestId: event.requestId,
        loaderId: event.loaderId,
        documentURL: event.documentURL,
        type: event.type,
        frameId: event.frameId,
        initiator: summarizeInitiator(event.initiator),
        request: summarizeRequest(event.request),
        wallTime: event.wallTime,
        startTime: event.timestamp,
        redirectChain,
        requestExtra: existing?.requestExtra,
      });
    });
    listen("Network.requestWillBeSentExtraInfo", (event) => {
      const item = state.requests.get(event.requestId) ?? { requestId: event.requestId, redirectChain: [] };
      item.requestExtra = { headers: event.headers, associatedCookies: event.associatedCookies, connectTiming: event.connectTiming };
      state.remember(event.requestId, item);
    });
    listen("Network.responseReceived", (event) => {
      const item = state.requests.get(event.requestId) ?? { requestId: event.requestId, redirectChain: [] };
      item.response = summarizeResponse(event.response);
      item.responseTime = event.timestamp;
      item.type = item.type ?? event.type;
      state.remember(event.requestId, item);
    });
    listen("Network.responseReceivedExtraInfo", (event) => {
      const item = state.requests.get(event.requestId) ?? { requestId: event.requestId, redirectChain: [] };
      item.responseExtra = { statusCode: event.statusCode, headers: event.headers, blockedCookies: event.blockedCookies };
      state.remember(event.requestId, item);
    });
    listen("Network.loadingFinished", (event) => {
      const item = state.requests.get(event.requestId) ?? { requestId: event.requestId, redirectChain: [] };
      item.endTime = event.timestamp;
      item.encodedDataLength = event.encodedDataLength;
      state.remember(event.requestId, item);
    });
    listen("Network.loadingFailed", (event) => {
      const item = state.requests.get(event.requestId) ?? { requestId: event.requestId, redirectChain: [] };
      item.endTime = event.timestamp;
      item.failure = { errorText: event.errorText, canceled: event.canceled, blockedReason: event.blockedReason, corsErrorStatus: event.corsErrorStatus };
      state.remember(event.requestId, item);
    });
    await cdp.send("Network.enable", {
      maxTotalBufferSize: options.maxTotalBufferSize ?? 100_000_000,
      maxResourceBufferSize: options.maxResourceBufferSize ?? 10_000_000,
      maxPostDataSize: options.maxPostDataSize ?? 1_000_000,
      reportDirectSocketTraffic: options.reportDirectSocketTraffic === true,
      enableDurableMessages: options.enableDurableMessages === true,
    });
    if (state.disableCache) await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    this.networkState = state;
    return { capturing: true, cacheDisabled: state.disableCache, startedAt: state.startedAt };
  }

  async networkStop(options = {}) {
    const state = this.networkState;
    if (!state) return this.lastNetworkResult ? { ...this.lastNetworkResult, alreadyStopped: true } : { capturing: false, alreadyStopped: true };
    this.networkState = null;
    const cdp = await this.cdp();
    for (const [event, handler] of state.listeners) cdp.off(event, handler);
    const records = [...state.requests.values()].filter((item) => item.request?.url);
    const bodyLimit = clampInteger(options.bodyLimitBytes, 0, 10_000_000, 250_000);
    const totalBodyLimit = clampInteger(options.totalBodyLimitBytes, 0, 50_000_000, 2_000_000);
    let capturedBodyBytes = 0;
    if (options.includeBodies === true && bodyLimit > 0 && totalBodyLimit > 0) {
      for (const record of records) {
        if (!record.response || record.failure || capturedBodyBytes >= totalBodyLimit) continue;
        try {
          const body = await cdp.send("Network.getResponseBody", { requestId: record.requestId });
          const bytes = body.base64Encoded ? Buffer.from(body.body, "base64") : Buffer.from(body.body);
          const kept = bytes.subarray(0, Math.min(bytes.length, bodyLimit, totalBodyLimit - capturedBodyBytes));
          record.body = {
            base64Encoded: body.base64Encoded,
            truncated: kept.length < bytes.length,
            originalBytes: bytes.length,
            value: body.base64Encoded ? kept.toString("base64") : kept.toString("utf8"),
          };
          capturedBodyBytes += kept.length;
        } catch (error) {
          record.bodyError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    if (state.disableCache) await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
    const har = toHar(records, state.startedAt);
    const artifactPath = await this.writeJsonArtifact("network", har, options.name, ".har");
    const failures = records.filter((item) => item.failure || (item.response?.status ?? 0) >= 400);
    const statusCounts = {};
    for (const item of records) {
      const key = String(item.response?.status ?? "no-response");
      statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    }
    const slowest = records
      .map((item) => ({ url: item.request.url, method: item.request.method, status: item.response?.status ?? null, durationMs: durationMs(item), type: item.type }))
      .filter((item) => item.durationMs != null)
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, clampInteger(options.top, 1, 50, 10));
    const summary = {
      requestCount: records.length, failureCount: failures.length, statusCounts,
      transferredBytes: records.reduce((sum, item) => sum + (item.encodedDataLength ?? 0), 0),
      capturedBodyBytes, droppedRequests: state.droppedRequests, slowest,
    };
    const result = {
      capturing: false,
      artifactPath,
      artifact: { kind: "network", path: artifactPath },
      summary,
      requestCount: summary.requestCount,
      failureCount: summary.failureCount,
      failures: failures.slice(0, 25).map((item) => ({ url: item.request.url, status: item.response?.status ?? null, error: item.failure?.errorText ?? null })),
      statusCounts,
      transferredBytes: summary.transferredBytes,
      capturedBodyBytes,
      droppedRequests: state.droppedRequests,
      slowest,
    };
    this.lastNetworkResult = result;
    return result;
  }

  async consoleStart() {
    if (this.consoleState) throw new Error("Console capture is already active for this tab");
    const cdp = await this.cdp();
    const state = { startedAt: new Date().toISOString(), entries: [], listeners: [], maxEntries: 2000, droppedEntries: 0 };
    state.push = (entry) => {
      if (state.entries.length >= state.maxEntries) {
        state.entries.shift();
        state.droppedEntries += 1;
      }
      state.entries.push(entry);
    };
    const listen = (event, handler) => {
      cdp.on(event, handler);
      state.listeners.push([event, handler]);
    };
    listen("Runtime.consoleAPICalled", (event) => state.push({
      source: "console", type: event.type, timestamp: event.timestamp,
      text: event.args.map(remoteValue).join(" "), stackTrace: event.stackTrace,
    }));
    listen("Runtime.exceptionThrown", (event) => state.push({
      source: "exception", type: "error", timestamp: event.timestamp,
      text: event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "Uncaught exception",
      url: event.exceptionDetails?.url, lineNumber: event.exceptionDetails?.lineNumber,
      columnNumber: event.exceptionDetails?.columnNumber, stackTrace: event.exceptionDetails?.stackTrace,
    }));
    listen("Log.entryAdded", ({ entry }) => state.push({
      source: entry.source, type: entry.level, timestamp: entry.timestamp, text: entry.text,
      url: entry.url, lineNumber: entry.lineNumber, stackTrace: entry.stackTrace,
    }));
    await Promise.all([cdp.send("Runtime.enable"), cdp.send("Log.enable")]);
    this.consoleState = state;
    return { capturing: true, startedAt: state.startedAt };
  }

  async consoleStop(options = {}) {
    const state = this.consoleState;
    if (!state) return this.lastConsoleResult ? { ...this.lastConsoleResult, alreadyStopped: true } : { capturing: false, alreadyStopped: true };
    this.consoleState = null;
    const cdp = await this.cdp();
    for (const [event, handler] of state.listeners) cdp.off(event, handler);
    const artifactPath = await this.writeJsonArtifact("console", { startedAt: state.startedAt, stoppedAt: new Date().toISOString(), entries: state.entries }, options.name, ".json");
    const counts = {};
    for (const entry of state.entries) counts[entry.type] = (counts[entry.type] ?? 0) + 1;
    const summary = { entryCount: state.entries.length, droppedEntries: state.droppedEntries, counts };
    const result = { capturing: false, artifactPath, artifact: { kind: "console", path: artifactPath }, summary, ...summary, entries: state.entries.slice(-clampInteger(options.tail, 0, 100, 20)) };
    this.lastConsoleResult = result;
    return result;
  }

  async issuesStart() {
    if (this.issuesState) throw new Error("Inspector issue capture is already active for this tab");
    const cdp = await this.cdp();
    const state = { startedAt: new Date().toISOString(), issues: [] };
    state.listener = ({ issue }) => state.issues.push(issue);
    cdp.on("Audits.inspectorIssueAdded", state.listener);
    await cdp.send("Audits.enable");
    this.issuesState = state;
    return { capturing: true, startedAt: state.startedAt };
  }

  async issuesStop(options = {}) {
    const state = this.issuesState;
    if (!state) return this.lastIssuesResult ? { ...this.lastIssuesResult, alreadyStopped: true } : { capturing: false, alreadyStopped: true };
    this.issuesState = null;
    const cdp = await this.cdp();
    cdp.off("Audits.inspectorIssueAdded", state.listener);
    await cdp.send("Audits.disable").catch(() => {});
    const artifactPath = await this.writeJsonArtifact("issues", { startedAt: state.startedAt, stoppedAt: new Date().toISOString(), issues: state.issues }, options.name, ".json");
    const counts = {};
    for (const issue of state.issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
    const summary = { issueCount: state.issues.length, counts };
    const result = { capturing: false, artifactPath, artifact: { kind: "issues", path: artifactPath }, summary, ...summary, issues: state.issues.slice(0, clampInteger(options.top, 0, 100, 20)) };
    this.lastIssuesResult = result;
    return result;
  }

  async applicationSnapshot(options = {}) {
    const url = this.page.url();
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Application snapshot requires an http(s) page");
    const origin = parsed.origin;
    const cdp = await this.cdp();
    const maxRecords = clampInteger(options.maxRecordsPerStore, 0, 1000, 100);
    const maxCacheBodyBytes = options.includeCacheBodies === true ? clampInteger(options.maxCacheBodyBytes, 0, 1_000_000, 64_000) : 0;
    const [cookies, usage, pageData] = await Promise.all([
      this.context.cookies([url]),
      cdp.send("Storage.getUsageAndQuota", { origin }).catch((error) => ({ error: error.message })),
      this.page.evaluate(async ({ maxRecords, maxCacheBodyBytes }) => {
        const readStorage = (storage) => {
          try { return Object.fromEntries(Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(Boolean).map((key) => [key, storage.getItem(key)])); }
          catch (error) { return { __error: String(error) }; }
        };
        let indexedDBDatabases = [];
        try {
          const databases = typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
          indexedDBDatabases = await Promise.all(databases.map(async (database) => {
            if (!database.name) return database;
            return await new Promise((resolve) => {
              const request = indexedDB.open(database.name);
              request.onerror = () => resolve({ ...database, error: String(request.error) });
              request.onsuccess = async () => {
                const db = request.result;
                try {
                  const stores = await Promise.all([...db.objectStoreNames].map(async (storeName) => {
                    const tx = db.transaction(storeName, "readonly");
                    const store = tx.objectStore(storeName);
                    const schema = { name: store.name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: [...store.indexNames].map((name) => { const index = store.index(name); return { name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }; }) };
                    const count = await new Promise((done) => { const query = store.count(); query.onsuccess = () => done(query.result); query.onerror = () => done(null); });
                    const records = maxRecords > 0 ? await new Promise((done) => { const query = store.getAll(undefined, maxRecords); query.onsuccess = () => done(query.result); query.onerror = () => done([{ __error: String(query.error) }]); }) : [];
                    return { ...schema, count, records, recordsTruncated: count != null && count > records.length };
                  }));
                  resolve({ ...database, objectStores: stores });
                } catch (error) { resolve({ ...database, error: String(error) }); }
                finally { db.close(); }
              };
            });
          }));
        }
        catch (error) { indexedDBDatabases = [{ error: String(error) }]; }
        let cacheStorage = [];
        try {
          const names = await caches.keys();
          cacheStorage = await Promise.all(names.map(async (name) => {
            const cache = await caches.open(name);
            const requests = await cache.keys();
            const entries = await Promise.all(requests.slice(0, 200).map(async (request) => {
              const response = await cache.match(request);
              const entry = { url: request.url, method: request.method, status: response?.status ?? null, statusText: response?.statusText ?? null, type: response?.type ?? null, headers: response ? Object.fromEntries(response.headers) : {} };
              if (response && maxCacheBodyBytes > 0) {
                try {
                  const bytes = new Uint8Array(await response.clone().arrayBuffer());
                  const kept = bytes.slice(0, maxCacheBodyBytes);
                  entry.body = new TextDecoder().decode(kept);
                  entry.bodyBytes = bytes.length;
                  entry.bodyTruncated = kept.length < bytes.length;
                } catch (error) { entry.bodyError = String(error); }
              }
              return entry;
            }));
            return { name, requestCount: requests.length, entries, entriesTruncated: requests.length > entries.length };
          }));
        } catch (error) { cacheStorage = [{ error: String(error) }]; }
        let serviceWorkers = [];
        try {
          serviceWorkers = (await navigator.serviceWorker?.getRegistrations?.() ?? []).map((registration) => ({
            scope: registration.scope,
            installing: registration.installing && { scriptURL: registration.installing.scriptURL, state: registration.installing.state },
            waiting: registration.waiting && { scriptURL: registration.waiting.scriptURL, state: registration.waiting.state },
            active: registration.active && { scriptURL: registration.active.scriptURL, state: registration.active.state },
            updateViaCache: registration.updateViaCache,
          }));
        } catch (error) { serviceWorkers = [{ error: String(error) }]; }
        return {
          localStorage: readStorage(localStorage), sessionStorage: readStorage(sessionStorage),
          indexedDBDatabases, cacheStorage, serviceWorkers,
          manifestLink: document.querySelector('link[rel="manifest"]')?.href ?? null,
        };
      }, { maxRecords, maxCacheBodyBytes }),
    ]);
    const value = {
      capturedAt: new Date().toISOString(), url, origin,
      cookies: cookies.map(({ name, value, domain, path, expires, httpOnly, secure, sameSite, partitionKey }) => ({ name, value, domain, path, expires, httpOnly, secure, sameSite, partitionKey })),
      usageAndQuota: usage,
      ...pageData,
    };
    const artifactPath = options.save === false ? null : await this.writeJsonArtifact("application", value, options.name, ".json");
    return {
      artifactPath, origin, cookieCount: value.cookies.length,
      localStorageKeys: Object.keys(value.localStorage), sessionStorageKeys: Object.keys(value.sessionStorage),
      indexedDBDatabases: value.indexedDBDatabases, cacheStorage: value.cacheStorage,
      serviceWorkers: value.serviceWorkers, usageAndQuota: value.usageAndQuota,
    };
  }

  async performanceStart() {
    const cdp = await this.cdp();
    if (!this.performanceInstalled) {
      await this.page.addInitScript({ content: PERFORMANCE_INIT_SCRIPT });
      await this.page.evaluate(PERFORMANCE_INSTALL).catch(() => {});
      this.performanceInstalled = true;
    }
    await Promise.all([cdp.send("Performance.enable"), cdp.send("Page.setLifecycleEventsEnabled", { enabled: true })]);
    return { observing: true, installAppliesToFutureNavigations: true };
  }

  async performanceSnapshot(options = {}) {
    if (!this.performanceInstalled) await this.performanceStart();
    const cdp = await this.cdp();
    const [metricsResult, renderer] = await Promise.all([
      cdp.send("Performance.getMetrics"),
      this.page.evaluate(() => ({
        url: location.href,
        timeOrigin: performance.timeOrigin,
        navigation: performance.getEntriesByType("navigation").map((entry) => entry.toJSON?.() ?? {}),
        paint: performance.getEntriesByType("paint").map((entry) => entry.toJSON?.() ?? { name: entry.name, startTime: entry.startTime, duration: entry.duration }),
        resources: performance.getEntriesByType("resource").map((entry) => entry.toJSON?.() ?? {}).slice(-1000),
        measures: performance.getEntriesByType("measure").map((entry) => entry.toJSON?.() ?? {}).slice(-500),
        vitals: globalThis.__claudeDevtoolsVitals ?? { lcp: null, cls: 0, inp: null, longTasks: [] },
        memory: performance.memory ? { jsHeapSizeLimit: performance.memory.jsHeapSizeLimit, totalJSHeapSize: performance.memory.totalJSHeapSize, usedJSHeapSize: performance.memory.usedJSHeapSize } : null,
      })),
    ]);
    const metrics = Object.fromEntries(metricsResult.metrics.map(({ name, value }) => [name, value]));
    const value = { capturedAt: new Date().toISOString(), metrics, renderer };
    const artifactPath = options.save === false ? null : await this.writeJsonArtifact("performance", value, options.name, ".json");
    const navigation = renderer.navigation[0] ?? {};
    const result = {
      artifactPath,
      artifact: artifactPath ? { kind: "performance", path: artifactPath } : null,
      url: renderer.url,
      webVitals: {
        lcpMs: renderer.vitals.lcp?.startTime ?? null,
        cls: renderer.vitals.cls ?? 0,
        inpMs: renderer.vitals.inp?.duration ?? null,
        fcpMs: renderer.paint.find((entry) => entry.name === "first-contentful-paint")?.startTime ?? null,
        ttfbMs: navigation.responseStart ?? null,
      },
      longTaskCount: renderer.vitals.longTasks?.length ?? 0,
      longestTasks: [...(renderer.vitals.longTasks ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 10),
      resourceCount: renderer.resources.length,
      transferredBytes: renderer.resources.reduce((sum, entry) => sum + (entry.transferSize ?? 0), 0),
      jsHeap: renderer.memory,
      cdpMetrics: metrics,
    };
    result.summary = { url: result.url, webVitals: result.webVitals, longTaskCount: result.longTaskCount, resourceCount: result.resourceCount, transferredBytes: result.transferredBytes, jsHeap: result.jsHeap };
    return result;
  }

  async performanceAudit(options = {}) {
    const snapshot = await this.performanceSnapshot({ save: options.save !== false, name: options.name });
    const findings = [];
    const { lcpMs, cls, inpMs, fcpMs, ttfbMs } = snapshot.webVitals;
    if (ttfbMs != null && ttfbMs > 800) findings.push({ severity: "warning", metric: "TTFB", value: ttfbMs, threshold: 800, message: "Server response is slow." });
    if (fcpMs != null && fcpMs > 1800) findings.push({ severity: "warning", metric: "FCP", value: fcpMs, threshold: 1800, message: "First contentful paint is slower than the good range." });
    if (lcpMs != null && lcpMs > 2500) findings.push({ severity: "warning", metric: "LCP", value: lcpMs, threshold: 2500, message: "Largest contentful paint is slower than the good range." });
    if (cls != null && cls > 0.1) findings.push({ severity: "warning", metric: "CLS", value: cls, threshold: 0.1, message: "Layout instability exceeds the good range." });
    if (inpMs != null && inpMs > 200) findings.push({ severity: "warning", metric: "INP", value: inpMs, threshold: 200, message: "Interaction latency exceeds the good range." });
    if (snapshot.longTaskCount > 0) findings.push({ severity: "info", metric: "LongTask", value: snapshot.longTaskCount, threshold: 0, message: "Main-thread tasks over 50 ms were observed." });
    return { ...snapshot, grade: findings.some((item) => item.severity === "warning") ? "needs-attention" : "good", findings };
  }

  async traceStart(options = {}) {
    if (this.traceState) throw new Error("A performance trace is already active for this tab");
    const owner = `${this.session}:${this.tabId}`;
    if (traceLease && traceLease !== owner) throw new Error(`Tracing is browser-global and already active for ${traceLease}`);
    traceLease = owner;
    const cdp = await this.cdp();
    const categories = [...(options.categories ?? [
      "-*", "blink.user_timing", "loading", "rail", "toplevel", "v8", "devtools.timeline",
      "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
    ])];
    if (options.screenshots === true) categories.push("disabled-by-default-devtools.screenshot");
    try {
      await cdp.send("Tracing.start", {
        categories: [...new Set(categories)].join(","),
        options: options.options ?? "sampling-frequency=10000",
        transferMode: "ReturnAsStream",
        streamFormat: "json",
        streamCompression: "gzip",
        bufferUsageReportingInterval: 500,
      });
      this.traceState = { owner, startedAt: new Date().toISOString() };
      return { tracing: true, owner, startedAt: this.traceState.startedAt, screenshots: options.screenshots === true };
    } catch (error) {
      if (traceLease === owner) traceLease = null;
      throw error;
    }
  }

  async traceStop(options = {}) {
    const state = this.traceState;
    if (!state) throw new Error("A performance trace is not active for this tab");
    this.traceState = null;
    const cdp = await this.cdp();
    try {
      const completed = waitForEvent(cdp, "Tracing.tracingComplete", 60_000);
      await cdp.send("Tracing.end");
      const event = await completed;
      if (!event.stream) throw new Error("Chrome completed tracing without returning a stream");
      const artifactPath = await this.artifactPath("trace", options.name, ".json.gz");
      const temporaryPath = `${artifactPath}.partial-${randomUUID()}`;
      const stream = createWriteStream(temporaryPath, { flags: "wx" });
      try {
        while (true) {
          const item = await cdp.send("IO.read", { handle: event.stream, size: 1_048_576 });
          const chunk = item.base64Encoded ? Buffer.from(item.data, "base64") : Buffer.from(item.data);
          if (!stream.write(chunk)) await once(stream, "drain");
          if (item.eof) break;
        }
        await cdp.send("IO.close", { handle: event.stream }).catch(() => {});
        stream.end();
        await finished(stream);
        await rename(temporaryPath, artifactPath);
      } catch (error) {
        stream.destroy();
        await cdp.send("IO.close", { handle: event.stream }).catch(() => {});
        await unlink(temporaryPath).catch(() => {});
        throw error;
      }
      const info = await stat(artifactPath);
      await this.recordArtifact("trace", artifactPath);
      return { tracing: false, artifactPath, path: artifactPath, artifact: { kind: "trace", path: artifactPath }, bytes: info.size, size: info.size, dataLossOccurred: event.dataLossOccurred === true, traceLoss: event.dataLossOccurred === true, startedAt: state.startedAt, stoppedAt: new Date().toISOString() };
    } finally {
      if (traceLease === state.owner) traceLease = null;
    }
  }

  async cpuStart(options = {}) {
    if (this.cpuState) throw new Error("CPU profiling is already active for this tab");
    const cdp = await this.cdp();
    await cdp.send("Profiler.enable");
    if (options.samplingInterval != null) await cdp.send("Profiler.setSamplingInterval", { interval: clampInteger(options.samplingInterval, 100, 100_000, 1000) });
    await cdp.send("Profiler.start");
    this.cpuState = { startedAt: new Date().toISOString() };
    return { profiling: true, startedAt: this.cpuState.startedAt };
  }

  async cpuStop(options = {}) {
    const state = this.cpuState;
    if (!state) throw new Error("CPU profiling is not active for this tab");
    this.cpuState = null;
    const cdp = await this.cdp();
    const { profile } = await cdp.send("Profiler.stop");
    const artifactPath = await this.writeJsonArtifact("cpu", profile, options.name, ".cpuprofile");
    const hitCounts = new Map();
    for (const sample of profile.samples ?? []) hitCounts.set(sample, (hitCounts.get(sample) ?? 0) + 1);
    const hottest = (profile.nodes ?? []).map((node) => ({
      functionName: node.callFrame?.functionName || "(anonymous)", url: node.callFrame?.url || "", lineNumber: (node.callFrame?.lineNumber ?? -1) + 1,
      hits: hitCounts.get(node.id) ?? node.hitCount ?? 0,
    })).filter((item) => item.hits > 0).sort((a, b) => b.hits - a.hits).slice(0, clampInteger(options.top, 1, 50, 15));
    return { profiling: false, artifactPath, sampleCount: profile.samples?.length ?? 0, nodeCount: profile.nodes?.length ?? 0, hottest, startedAt: state.startedAt };
  }

  async coverageStart(options = {}) {
    if (this.coverageState) throw new Error("Precise JavaScript coverage is already active for this tab");
    const cdp = await this.cdp();
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.startPreciseCoverage", { callCount: options.callCount !== false, detailed: options.detailed !== false, allowTriggeredUpdates: false });
    this.coverageState = { startedAt: new Date().toISOString() };
    return { covering: true, startedAt: this.coverageState.startedAt };
  }

  async coverageStop(options = {}) {
    const state = this.coverageState;
    if (!state) return this.lastCoverageResult ? { ...this.lastCoverageResult, alreadyStopped: true } : { covering: false, alreadyStopped: true };
    this.coverageState = null;
    const cdp = await this.cdp();
    const result = await cdp.send("Profiler.takePreciseCoverage");
    await cdp.send("Profiler.stopPreciseCoverage");
    const artifactPath = await this.writeJsonArtifact("coverage", result, options.name, ".json");
    const scripts = result.result.map((script) => {
      let totalBytes = 0;
      const coverageRanges = [];
      for (const fn of script.functions) {
        for (const range of fn.ranges) {
          totalBytes = Math.max(totalBytes, range.endOffset);
          coverageRanges.push(range);
        }
      }
      const usedBytes = disjointCoveredBytes(coverageRanges);
      return { url: script.url || `(script ${script.scriptId})`, totalBytes, usedBytes, unusedBytes: totalBytes - usedBytes, usedPercent: totalBytes ? Math.round(usedBytes / totalBytes * 1000) / 10 : 100 };
    }).sort((a, b) => b.unusedBytes - a.unusedBytes);
    const totalBytes = scripts.reduce((sum, script) => sum + script.totalBytes, 0);
    const usedBytes = scripts.reduce((sum, script) => sum + script.usedBytes, 0);
    const summary = { scriptCount: scripts.length, totalBytes, usedBytes, unusedBytes: totalBytes - usedBytes, usedPercent: totalBytes ? Math.round(usedBytes / totalBytes * 1000) / 10 : 100 };
    const response = { covering: false, artifactPath, artifact: { kind: "coverage", path: artifactPath }, summary, ...summary, scripts: scripts.slice(0, clampInteger(options.top, 1, 100, 25)), startedAt: state.startedAt };
    this.lastCoverageResult = response;
    return response;
  }

  async cssCoverageStart() {
    if (this.cssCoverageState) throw new Error("CSS coverage is already active for this tab");
    const cdp = await this.cdp();
    const state = { startedAt: new Date().toISOString(), styleSheets: new Map() };
    state.listener = ({ header }) => state.styleSheets.set(header.styleSheetId, header);
    cdp.on("CSS.styleSheetAdded", state.listener);
    await Promise.all([cdp.send("DOM.enable"), cdp.send("CSS.enable")]);
    await cdp.send("CSS.startRuleUsageTracking");
    this.cssCoverageState = state;
    return { covering: true, startedAt: state.startedAt };
  }

  async cssCoverageStop(options = {}) {
    const state = this.cssCoverageState;
    if (!state) return this.lastCssCoverageResult ? { ...this.lastCssCoverageResult, alreadyStopped: true } : { covering: false, alreadyStopped: true };
    this.cssCoverageState = null;
    const cdp = await this.cdp();
    const { ruleUsage } = await cdp.send("CSS.stopRuleUsageTracking");
    cdp.off("CSS.styleSheetAdded", state.listener);
    const sheets = [];
    for (const [styleSheetId, header] of state.styleSheets) {
      const text = await cdp.send("CSS.getStyleSheetText", { styleSheetId }).then((value) => value.text, () => null);
      const rules = ruleUsage.filter((rule) => rule.styleSheetId === styleSheetId);
      const usedBytes = intervalBytes(rules.filter((rule) => rule.used).map((rule) => [rule.startOffset, rule.endOffset]));
      const totalBytes = text?.length ?? Math.max(0, ...rules.map((rule) => rule.endOffset));
      const unusedBytes = Math.max(0, totalBytes - usedBytes);
      const ruleCount = text ? (text.match(/\{/g) ?? []).length : rules.length;
      const usedRuleCount = new Set(rules.filter((rule) => rule.used).map((rule) => `${rule.startOffset}:${rule.endOffset}`)).size;
      sheets.push({ styleSheetId, sourceURL: header.sourceURL, title: header.title, text, rules, totalBytes, usedBytes, unusedBytes, ruleCount, usedRuleCount, unusedRuleCount: Math.max(0, ruleCount - usedRuleCount) });
    }
    await cdp.send("CSS.disable").catch(() => {});
    await cdp.send("DOM.disable").catch(() => {});
    const artifactPath = await this.writeJsonArtifact("css-coverage", { startedAt: state.startedAt, stoppedAt: new Date().toISOString(), sheets }, options.name, ".json");
    const result = {
      covering: false, artifactPath, styleSheetCount: sheets.length,
      artifact: { kind: "css-coverage", path: artifactPath },
      totalBytes: sheets.reduce((sum, sheet) => sum + sheet.totalBytes, 0),
      usedBytes: sheets.reduce((sum, sheet) => sum + sheet.usedBytes, 0),
      unusedBytes: sheets.reduce((sum, sheet) => sum + sheet.unusedBytes, 0),
      ruleCount: sheets.reduce((sum, sheet) => sum + sheet.ruleCount, 0),
      usedRuleCount: sheets.reduce((sum, sheet) => sum + sheet.usedRuleCount, 0),
      unusedRuleCount: sheets.reduce((sum, sheet) => sum + sheet.unusedRuleCount, 0),
      sheets: sheets.map(({ sourceURL, title, totalBytes, usedBytes, unusedBytes, ruleCount, usedRuleCount, unusedRuleCount }) => ({ sourceURL, title, totalBytes, usedBytes, unusedBytes, ruleCount, usedRuleCount, unusedRuleCount })).sort((a, b) => b.unusedBytes - a.unusedBytes).slice(0, clampInteger(options.top, 1, 100, 25)),
    };
    result.summary = { styleSheetCount: result.styleSheetCount, totalBytes: result.totalBytes, usedBytes: result.usedBytes, unusedBytes: result.unusedBytes, ruleCount: result.ruleCount, usedRuleCount: result.usedRuleCount, unusedRuleCount: result.unusedRuleCount };
    this.lastCssCoverageResult = result;
    return result;
  }

  async heapSnapshot(options = {}) {
    const cdp = await this.cdp();
    await cdp.send("HeapProfiler.enable");
    if (options.collectGarbage === true) await cdp.send("HeapProfiler.collectGarbage");
    const artifactPath = await this.artifactPath("heap", options.name, ".heapsnapshot");
    const temporaryPath = `${artifactPath}.partial-${randomUUID()}`;
    const stream = createWriteStream(temporaryPath, { flags: "wx" });
    const progress = { done: 0, total: 0, finished: false };
    const onChunk = ({ chunk }) => stream.write(chunk);
    const onProgress = (event) => Object.assign(progress, event);
    cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
    cdp.on("HeapProfiler.reportHeapSnapshotProgress", onProgress);
    try {
      await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: true, captureNumericValue: options.captureNumericValue === true, exposeInternals: options.exposeInternals === true });
      stream.end();
      await finished(stream);
      await rename(temporaryPath, artifactPath);
      const info = await stat(artifactPath);
      await this.recordArtifact("heap", artifactPath);
      return { artifactPath, path: artifactPath, artifact: { kind: "heap", path: artifactPath }, bytes: info.size, size: info.size, progress };
    } catch (error) {
      stream.destroy(error);
      await unlink(temporaryPath).catch(() => {});
      throw error;
    } finally {
      cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
      cdp.off("HeapProfiler.reportHeapSnapshotProgress", onProgress);
    }
  }

  async heapSamplingStart(options = {}) {
    const cdp = await this.cdp();
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.startSampling", {
      samplingInterval: clampInteger(options.samplingInterval, 16_384, 16_777_216, 32_768),
      includeObjectsCollectedByMajorGC: options.includeObjectsCollectedByMajorGC === true,
      includeObjectsCollectedByMinorGC: options.includeObjectsCollectedByMinorGC === true,
    });
    return { sampling: true };
  }

  async heapSamplingStop(options = {}) {
    const cdp = await this.cdp();
    const { profile } = await cdp.send("HeapProfiler.stopSampling");
    const artifactPath = await this.writeJsonArtifact("heap-sampling", profile, options.name, ".heapprofile");
    return { sampling: false, artifactPath, path: artifactPath, artifact: { kind: "heap-sampling", path: artifactPath }, sampleCount: countHeapSamples(profile?.head) };
  }

  async collectGarbage() {
    const cdp = await this.cdp();
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    return { collected: true };
  }

  async emulateNetwork(options = {}) {
    const cdp = await this.cdp();
    const offline = options.offline === true;
    const latency = Math.max(0, Number(options.latency ?? 0));
    const downloadThroughput = throughput(options.downloadKbps);
    const uploadThroughput = throughput(options.uploadKbps);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline, latency, downloadThroughput, uploadThroughput,
      connectionType: options.connectionType ?? (offline ? "none" : "other"),
    });
    if (options.disableCache === true) await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    this.emulationActive = true;
    return { offline, latency, downloadKbps: downloadThroughput < 0 ? null : Math.round(downloadThroughput * 8 / 1024), uploadKbps: uploadThroughput < 0 ? null : Math.round(uploadThroughput * 8 / 1024), cacheDisabled: options.disableCache === true };
  }

  async emulateCpu(rate = 1) {
    const normalized = Math.max(1, Math.min(100, Number(rate) || 1));
    await (await this.cdp()).send("Emulation.setCPUThrottlingRate", { rate: normalized });
    this.emulationActive = this.emulationActive || normalized !== 1;
    return { rate: normalized };
  }

  async resetEmulation() {
    if (!this.cdpReady) return { reset: true };
    const cdp = await this.cdp();
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "none" }).catch(() => {});
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    this.emulationActive = false;
    return { reset: true };
  }

  async artifactPath(kind, name, extension) {
    const directory = join(ARTIFACT_ROOT, safeSegment(this.session), safeSegment(this.tabId), this.artifactRunId);
    await mkdir(directory, { recursive: true });
    this.artifactDirectory = directory;
    const base = safeSegment(name || `${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
    return join(directory, `${base}${extension}`);
  }

  async writeJsonArtifact(kind, value, name, extension) {
    const path = await this.artifactPath(kind, name, extension);
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await this.recordArtifact(kind, path);
    return path;
  }

  async writeBufferArtifact(kind, value, name, extension) {
    const path = await this.artifactPath(kind, name, extension);
    await writeFile(path, value, { flag: "wx" });
    await this.recordArtifact(kind, path);
    return path;
  }

  async recordArtifact(kind, path) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const info = await stat(path);
    const item = { kind, path, bytes: info.size, sha256: hash.digest("hex") };
    this.artifacts.push(item);
    this.manifestTail = this.manifestTail.then(async () => {
      const manifestPath = join(this.artifactDirectory, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify({
        version: 1, runId: this.artifactRunId, session: this.session, tabId: this.tabId,
        url: this.page.url(), updatedAt: new Date().toISOString(), artifacts: this.artifacts,
      }, null, 2)}\n`);
    });
    await this.manifestTail;
    return item;
  }

  async dispose() {
    await this.preview.stop().catch(() => {});
    if (this.networkState) await this.networkStop({ name: "auto-network-cleanup" }).catch(() => {});
    if (this.consoleState) await this.consoleStop({ name: "auto-console-cleanup", tail: 0 }).catch(() => {});
    if (this.issuesState) await this.issuesStop({ name: "auto-issues-cleanup", top: 0 }).catch(() => {});
    if (this.traceState) await this.traceStop({ name: "auto-trace-cleanup" }).catch(() => {});
    if (this.cpuState) await this.cpuStop({ name: "auto-cpu-cleanup" }).catch(() => {});
    if (this.coverageState) await this.coverageStop({ name: "auto-coverage-cleanup" }).catch(() => {});
    if (this.cssCoverageState) await this.cssCoverageStop({ name: "auto-css-coverage-cleanup" }).catch(() => {});
    if (this.emulationActive) await this.resetEmulation().catch(() => {});
    const cdp = this.cdpReady ? await this.cdpReady.catch(() => null) : null;
    await cdp?.detach().catch(() => {});
  }
}

function summarizeRequest(request = {}) {
  return {
    url: request.url, method: request.method, headers: request.headers,
    postData: request.postData, hasPostData: request.hasPostData,
    mixedContentType: request.mixedContentType, initialPriority: request.initialPriority,
    referrerPolicy: request.referrerPolicy,
  };
}

function summarizeResponse(response = {}) {
  return {
    url: response.url, status: response.status, statusText: response.statusText,
    headers: response.headers, mimeType: response.mimeType, charset: response.charset,
    connectionReused: response.connectionReused, connectionId: response.connectionId,
    remoteIPAddress: response.remoteIPAddress, remotePort: response.remotePort,
    fromDiskCache: response.fromDiskCache, fromServiceWorker: response.fromServiceWorker,
    fromPrefetchCache: response.fromPrefetchCache, encodedDataLength: response.encodedDataLength,
    protocol: response.protocol, securityState: response.securityState,
    securityDetails: response.securityDetails, timing: response.timing,
  };
}

function summarizeInitiator(initiator = {}) {
  return { type: initiator.type, url: initiator.url, lineNumber: initiator.lineNumber, columnNumber: initiator.columnNumber, stack: initiator.stack };
}

function durationMs(item) {
  if (item.startTime == null || item.endTime == null) return null;
  return Math.round((item.endTime - item.startTime) * 100_000) / 100;
}

function toHar(records, startedAt) {
  const entries = records.map((item) => {
    const request = item.request;
    const response = item.response ?? {};
    const startedDateTime = item.wallTime ? new Date(item.wallTime * 1000).toISOString() : startedAt;
    const content = { size: response.encodedDataLength ?? item.encodedDataLength ?? -1, mimeType: response.mimeType ?? "" };
    if (item.body) {
      content.text = item.body.value;
      if (item.body.base64Encoded) content.encoding = "base64";
      if (item.body.truncated) content.comment = `Body truncated from ${item.body.originalBytes} bytes`;
    }
    return {
      startedDateTime,
      time: durationMs(item) ?? 0,
      request: {
        method: request.method, url: request.url, httpVersion: "HTTP/1.1",
        cookies: [], headers: headerArray(request.headers), queryString: queryArray(request.url),
        postData: request.postData == null ? undefined : { mimeType: headerValue(request.headers, "content-type") ?? "", text: request.postData },
        headersSize: -1, bodySize: request.postData ? Buffer.byteLength(request.postData) : 0,
      },
      response: {
        status: response.status ?? 0, statusText: response.statusText ?? "", httpVersion: response.protocol ?? "",
        cookies: [], headers: headerArray(response.headers), content,
        redirectURL: headerValue(response.headers, "location") ?? "", headersSize: -1,
        bodySize: item.encodedDataLength ?? response.encodedDataLength ?? -1,
        _failure: item.failure,
      },
      cache: {},
      timings: harTimings(response.timing, durationMs(item)),
      serverIPAddress: response.remoteIPAddress,
      connection: response.connectionId == null ? undefined : String(response.connectionId),
      _resourceType: item.type,
      _initiator: item.initiator,
      _redirectChain: item.redirectChain,
      _securityDetails: response.securityDetails,
    };
  });
  return { log: { version: "1.2", creator: { name: "open-computer-use", version: "0.1.0" }, pages: [], entries } };
}

function harTimings(timing, total) {
  if (!timing) return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: total ?? 0, receive: 0 };
  const delta = (start, end) => start >= 0 && end >= 0 ? Math.max(0, end - start) : -1;
  return {
    blocked: Math.max(0, timing.dnsStart ?? 0),
    dns: delta(timing.dnsStart, timing.dnsEnd),
    connect: delta(timing.connectStart, timing.connectEnd),
    ssl: delta(timing.sslStart, timing.sslEnd),
    send: delta(timing.sendStart, timing.sendEnd),
    wait: delta(timing.sendEnd, timing.receiveHeadersEnd),
    receive: total == null ? 0 : Math.max(0, total - (timing.receiveHeadersEnd ?? 0)),
  };
}

function headerArray(headers = {}) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function headerValue(headers = {}, wanted) {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted);
  return entry ? String(entry[1]) : null;
}

function queryArray(url) {
  try { return [...new URL(url).searchParams].map(([name, value]) => ({ name, value })); }
  catch { return []; }
}

function remoteValue(value) {
  if ("value" in value) return typeof value.value === "string" ? value.value : JSON.stringify(value.value);
  return value.unserializableValue ?? value.description ?? `[${value.type}]`;
}

function throughput(kbps) {
  if (kbps == null) return -1;
  return Math.max(0, Number(kbps)) * 1024 / 8;
}

function safeSegment(value) {
  const safe = String(value).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 96);
  return safe || "artifact";
}

function clampInteger(value, min, max, fallback) {
  if (value == null || !Number.isFinite(Number(value))) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(Number(value))));
}

function countHeapSamples(node) {
  if (!node) return 0;
  return (node.children ?? []).reduce((sum, child) => sum + countHeapSamples(child), (node.selfSize ?? 0) > 0 ? 1 : 0);
}

function intervalBytes(ranges) {
  const sorted = ranges
    .map(([start, end]) => [Math.max(0, start), Math.max(0, end)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let current = null;
  for (const range of sorted) {
    if (!current || range[0] > current[1]) {
      if (current) total += current[1] - current[0];
      current = [...range];
    } else current[1] = Math.max(current[1], range[1]);
  }
  if (current) total += current[1] - current[0];
  return total;
}

function disjointCoveredBytes(nestedRanges) {
  const points = [];
  for (const range of nestedRanges) {
    points.push({ offset: range.startOffset, type: 0, range });
    points.push({ offset: range.endOffset, type: 1, range });
  }
  points.sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (a.type !== b.type) return b.type - a.type;
    const aLength = a.range.endOffset - a.range.startOffset;
    const bLength = b.range.endOffset - b.range.startOffset;
    return a.type === 0 ? bLength - aLength : aLength - bLength;
  });
  const countStack = [];
  let total = 0;
  let lastOffset = 0;
  for (const point of points) {
    if (countStack.length && lastOffset < point.offset && countStack[countStack.length - 1] > 0) total += point.offset - lastOffset;
    lastOffset = point.offset;
    if (point.type === 0) countStack.push(point.range.count);
    else countStack.pop();
  }
  return total;
}

function waitForEvent(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error(`${event} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    emitter.once(event, handler);
  });
}

const PERFORMANCE_INIT_SCRIPT = `(${function installPerformanceObservers() {
  if (globalThis.__claudeDevtoolsVitals) return;
  const state = globalThis.__claudeDevtoolsVitals = { lcp: null, cls: 0, inp: null, longTasks: [], events: [] };
  const observe = (type, callback, options = {}) => {
    try {
      const observer = new PerformanceObserver((list) => list.getEntries().forEach(callback));
      observer.observe({ type, buffered: true, ...options });
    } catch {}
  };
  observe("largest-contentful-paint", (entry) => { state.lcp = entry.toJSON?.() ?? { startTime: entry.startTime, size: entry.size, url: entry.url }; });
  observe("layout-shift", (entry) => { if (!entry.hadRecentInput) state.cls += entry.value; });
  observe("event", (entry) => {
    const item = entry.toJSON?.() ?? { name: entry.name, startTime: entry.startTime, duration: entry.duration, interactionId: entry.interactionId };
    state.events.push(item);
    if (item.interactionId && (!state.inp || item.duration > state.inp.duration)) state.inp = item;
  }, { durationThreshold: 40 });
  observe("longtask", (entry) => state.longTasks.push(entry.toJSON?.() ?? { name: entry.name, startTime: entry.startTime, duration: entry.duration }));
}})();`;

const PERFORMANCE_INSTALL = new Function(PERFORMANCE_INIT_SCRIPT);
