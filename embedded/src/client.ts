// ExtensionFirefoxClient: implements the FirefoxDevTools facade surface that
// ../../src/tools/** calls, over the in-browser BiDi tunnel (browser.bidi experiment)
// instead of Selenium. Method semantics mirror ../../src/firefox/index.ts; divergences
// are documented in README.md.

import { formatSnapshotTree } from "../../src/firefox/snapshot/formatter.js";
import { getSnapshotSource } from "./snapshot-source.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TabInfo {
  actor: string; // BiDi context id
  title: string;
  url: string;
}

interface ConsoleMessage {
  level: string;
  text: string;
  timestamp: number;
  source?: string;
  args?: unknown[];
}

interface UidEntry {
  uid: string;
  css: string;
  xpath?: string;
}

export class ExtensionFirefoxClient {
  private tabs: TabInfo[] = [];
  private selectedTabIdx = 0;
  private currentContextId: string | null = null;
  private consoleMessages: ConsoleMessage[] = [];
  // Same record shape as upstream events/network.ts — the network tools filter and
  // sort on id/resourceType/isXHR/timings, so the fields must match exactly.
  private networkRecords = new Map<string, any>();
  private requestStartTimes = new Map<string, number>();
  private uidMap = new Map<string, UidEntry>();
  private snapshotContextId: string | null = null;
  private currentSnapshotId = 0;
  private injectedScript: string | null = null;
  private firefoxVersion: string | null = null;

  // ---------- lifecycle ----------

  async connect(): Promise<void> {
    await browser.bidi.subscribe([
      "log.entryAdded",
      "network.beforeRequestSent",
      "network.responseStarted",
      "network.responseCompleted",
      "browsingContext.load",
      "browsingContext.domContentLoaded",
    ]);
    try {
      await browser.bidi.subscribe(["moz:debugging.paused", "moz:debugging.resumed"]);
    } catch {
      // moz:debugging may be absent in older builds; logpoint tools will error on use.
    }
    browser.bidi.onEvent.addListener((event) => this.onBidiEvent(event));
    // Bare version string ("154.0a1") — upstream feeds this to compareVersions.
    const info = await (browser.runtime as any).getBrowserInfo?.().catch(() => null);
    this.firefoxVersion = info?.version ?? null;
    await this.refreshTabs();
    if (this.tabs.length) this.currentContextId = this.tabs[0].actor;
  }

  private onBidiEvent(event: { name: string; data: any }) {
    const d = event.data ?? {};
    switch (event.name) {
      case "log.entryAdded":
        this.consoleMessages.push({
          level: d.level ?? "info",
          text: d.text ?? (d.args ? JSON.stringify(d.args) : ""),
          timestamp: d.timestamp ?? Date.now(),
          source: d.source?.realm,
          args: d.args,
        });
        if (this.consoleMessages.length > 1000) this.consoleMessages.splice(0, 500);
        break;
      case "browsingContext.load":
      case "browsingContext.domContentLoaded":
        // Upstream: network autoClearOnNavigate=true, console=false, and the
        // onNavigate hook invalidates snapshot uids.
        this.networkRecords.clear();
        this.requestStartTimes.clear();
        if (d.context === this.snapshotContextId) this.clearSnapshot();
        break;
      case "network.beforeRequestSent": {
        const requestId = d.request?.request;
        if (!requestId) break;
        this.requestStartTimes.set(requestId, Date.now());
        this.networkRecords.set(requestId, {
          id: requestId,
          url: d.request?.url || "",
          method: d.request?.method || "GET",
          timestamp: Date.now(),
          resourceType: guessResourceType(d.request?.url || ""),
          isXHR: d.initiator?.type === "xmlhttprequest" || d.initiator?.type === "fetch",
          requestHeaders: parseHeaders(d.request?.headers || []),
          timings: { requestTime: Date.now() },
        });
        if (this.networkRecords.size > 500) {
          for (const key of [...this.networkRecords.keys()].slice(0, 250)) this.networkRecords.delete(key);
        }
        break;
      }
      case "network.responseStarted": {
        const existing = this.networkRecords.get(d.request?.request);
        if (existing) {
          existing.status = d.response?.status;
          existing.statusText = d.response?.statusText || "";
          existing.responseHeaders = parseHeaders(d.response?.headers || []);
        }
        break;
      }
      case "network.responseCompleted": {
        const requestId = d.request?.request;
        const existing = this.networkRecords.get(requestId);
        const startTime = this.requestStartTimes.get(requestId);
        if (existing && startTime) {
          existing.timings.responseTime = Date.now();
          existing.timings.duration = Date.now() - startTime;
          if (!existing.status && d.response?.status) {
            existing.status = d.response.status;
            existing.statusText = d.response.statusText || "";
          }
        }
        this.requestStartTimes.delete(requestId);
        break;
      }
      case "moz:debugging.paused": {
        const id = this.findLogpointByLocation(d.url, d.line);
        if (id) void this.handleLogpointPause(d.context, id);
        break;
      }
    }
  }

  // ---------- BiDi plumbing ----------

  async sendBiDiCommand(method: string, params: Record<string, any> = {}): Promise<any> {
    const dot = method.lastIndexOf(".");
    return browser.bidi.send(method.slice(0, dot), method.slice(dot + 1), params);
  }

  private context(): string {
    if (!this.currentContextId) throw new Error("No tab selected");
    return this.currentContextId;
  }

  private async callFunction(fn: string, args: unknown[] = [], context = this.context()): Promise<any> {
    const res = await browser.bidi.send("script", "callFunction", {
      functionDeclaration: fn,
      arguments: args.map((a) => serializeArg(a)),
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (res.type === "exception") {
      throw new Error(res.exceptionDetails?.text ?? "Script threw");
    }
    return fromRemoteValue(res.result);
  }

  // Classic executeScript semantics: run a function body, JSON round-trip the result.
  async evaluate(script: string): Promise<unknown> {
    const wrapped = `function() {
      const r = (function() { ${script} })();
      if (r === undefined) return null;
      try { return JSON.parse(JSON.stringify(r)); } catch { return String(r); }
    }`;
    return this.callFunction(wrapped);
  }

  async getContent(): Promise<string> {
    return (await this.callFunction("function() { return document.documentElement.outerHTML; }")) as string;
  }

  // ---------- selector interactions ----------

  // Upstream dom.ts polls up to 5s for existence and visibility before interacting;
  // a one-shot lookup would click 0x0 rects of hidden/late elements.
  private async selectorRect(selector: string): Promise<{ x: number; y: number }> {
    const deadline = Date.now() + 5000;
    let rect: { x: number; y: number; w: number; h: number } | null = null;
    for (;;) {
      rect = await this.callFunction(
        `function(sel) {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
          const b = el.getBoundingClientRect();
          return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), w: b.width, h: b.height };
        }`,
        [selector]
      );
      if (rect && rect.w > 0 && rect.h > 0) return { x: rect.x, y: rect.y };
      if (Date.now() > deadline) break;
      await sleep(100);
    }
    if (!rect) throw new Error(`No element matches selector: ${selector}`);
    throw new Error(`Element is not visible: ${selector}`);
  }

  // Upstream settles after input actions (rAF + 50ms) so follow-up snapshots see post-event state.
  private async settle(): Promise<void> {
    await this.callFunction("function() { return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))); }").catch(() => {});
  }

  private async performActions(actions: object[]): Promise<void> {
    await browser.bidi.send("input", "performActions", { context: this.context(), actions });
  }

  private async clickAt(x: number, y: number, clickCount = 1): Promise<void> {
    const pointer: object[] = [{ type: "pointerMove", x, y }];
    for (let i = 0; i < clickCount; i++) {
      pointer.push({ type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 });
    }
    await this.performActions([{ type: "pointer", id: "mouse", actions: pointer }]);
  }

  async clickBySelector(selector: string, dblClick = false): Promise<void> {
    const { x, y } = await this.selectorRect(selector);
    await this.clickAt(x, y, dblClick ? 2 : 1);
    await this.settle();
  }

  async hoverBySelector(selector: string): Promise<void> {
    const { x, y } = await this.selectorRect(selector);
    await this.performActions([{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x, y }] }]);
  }

  async fillBySelector(selector: string, text: string): Promise<void> {
    // Mirror Selenium clear()+sendKeys: focus, clear via JS + events, then trusted keys.
    const { x, y } = await this.selectorRect(selector);
    await this.clickAt(x, y);
    await this.callFunction(
      `function(sel) {
        const el = document.querySelector(sel);
        if (el && "value" in el) {
          el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }`,
      [selector]
    );
    const actions = [...text].flatMap((ch) => [
      { type: "keyDown", value: ch },
      { type: "keyUp", value: ch },
    ]);
    await this.performActions([{ type: "key", id: "kb", actions }]);
    await this.settle();
  }

  async dragAndDropBySelectors(source: string, target: string): Promise<void> {
    // Upstream uses JS drag events ("Actions DnD not used" — dom.ts) — same here.
    await this.callFunction(
      `function(srcSel, dstSel) {
        const src = document.querySelector(srcSel);
        const dst = document.querySelector(dstSel);
        if (!src || !dst) throw new Error("drag: element not found");
        const dt = new DataTransfer();
        for (const [type, tgt] of [["dragstart", src], ["dragover", dst], ["drop", dst], ["dragend", src]]) {
          tgt.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        }
      }`,
      [source, target]
    );
  }

  async uploadFileBySelector(selector: string, filePath: string): Promise<void> {
    const res = await browser.bidi.send("script", "callFunction", {
      functionDeclaration: "function(sel) { return document.querySelector(sel); }",
      arguments: [{ type: "string", value: selector }],
      target: { context: this.context() },
      awaitPromise: false,
      resultOwnership: "root",
    });
    if (res.result?.type !== "node" || !res.result.sharedId) {
      throw new Error(`No element matches selector: ${selector}`);
    }
    await browser.bidi.send("input", "setFiles", {
      context: this.context(),
      element: { sharedId: res.result.sharedId },
      files: [filePath],
    });
  }

  // ---------- uid interactions ----------

  // Error wording matches upstream snapshot/resolver.ts — tool handlers substring-match
  // on 'stale'/'Snapshot'/'UID'/'not found' to produce friendly retry guidance.
  resolveUidToSelector(uid: string): string {
    const uidSnapshotId = parseInt(uid.split("_")[0], 10);
    if (isNaN(uidSnapshotId)) throw new Error(`Invalid UID format: ${uid}`);
    if (uidSnapshotId !== this.currentSnapshotId) {
      throw new Error(
        `This uid is from a stale snapshot (snapshot ${uidSnapshotId}, current ${this.currentSnapshotId}). Take a fresh snapshot.`
      );
    }
    if (this.snapshotContextId !== this.currentContextId) {
      throw new Error("This uid is from a stale snapshot (different tab selected). Take a fresh snapshot.");
    }
    const entry = this.uidMap.get(uid);
    if (!entry) throw new Error(`UID not found: ${uid}. Take a fresh snapshot first.`);
    return entry.css;
  }

  // Upstream returns a Selenium WebElement; callers only use `await element.getId()`
  // (a BiDi sharedId), so a minimal shim keeps evaluate_script uid args working.
  async resolveUidToElement(uid: string): Promise<{ getId(): Promise<string> }> {
    const selector = this.resolveUidToSelector(uid);
    const res = await browser.bidi.send("script", "callFunction", {
      functionDeclaration: "function(sel) { return document.querySelector(sel); }",
      arguments: [{ type: "string", value: selector }],
      target: { context: this.context() },
      awaitPromise: false,
      resultOwnership: "root",
    });
    if (res.result?.type !== "node" || !res.result.sharedId) {
      throw new Error(`UID "${uid}" is stale: no element matches ${selector}`);
    }
    const sharedId = res.result.sharedId as string;
    return { getId: async () => sharedId };
  }

  async clickByUid(uid: string, dblClick = false): Promise<void> {
    await this.clickBySelector(this.resolveUidToSelector(uid), dblClick);
  }
  async hoverByUid(uid: string): Promise<void> {
    await this.hoverBySelector(this.resolveUidToSelector(uid));
  }
  async fillByUid(uid: string, value: string): Promise<void> {
    await this.fillBySelector(this.resolveUidToSelector(uid), value);
  }
  async dragByUidToUid(fromUid: string, toUid: string): Promise<void> {
    await this.dragAndDropBySelectors(this.resolveUidToSelector(fromUid), this.resolveUidToSelector(toUid));
  }
  async fillFormByUid(elements: Array<{ uid: string; value: string }>): Promise<void> {
    for (const { uid, value } of elements) await this.fillByUid(uid, value);
  }
  async uploadFileByUid(uid: string, filePath: string): Promise<void> {
    await this.uploadFileBySelector(this.resolveUidToSelector(uid), filePath);
  }

  // ---------- snapshot ----------

  private async ensureInjected(): Promise<void> {
    if (!this.injectedScript) {
      this.injectedScript = await getSnapshotSource();
    }
    const present = await this.callFunction("function() { return typeof window.__createSnapshot === 'function'; }");
    if (!present) {
      await browser.bidi.send("script", "evaluate", {
        expression: this.injectedScript,
        target: { context: this.context() },
        awaitPromise: false,
      });
    }
  }

  async takeSnapshot(options?: { includeAll?: boolean; selector?: string }): Promise<any> {
    await this.ensureInjected();
    const snapshotId = ++this.currentSnapshotId;
    const raw = await this.callFunction(
      "function(id, opts) { return JSON.stringify(window.__createSnapshot(id, opts)); }",
      [snapshotId, options ?? {}]
    );
    const result = JSON.parse(raw as string);
    if (result?.selectorError) throw new Error(result.selectorError);
    if (!result?.tree) throw new Error("Failed to generate snapshot");
    this.uidMap.clear();
    for (const entry of result.uidMap ?? []) this.uidMap.set(entry.uid, entry);
    this.snapshotContextId = this.currentContextId;
    return {
      text: formatSnapshotTree(result.tree),
      json: {
        root: result.tree,
        snapshotId,
        timestamp: Date.now(),
        truncated: result.truncated || false,
        uidMap: result.uidMap,
      },
    };
  }

  clearSnapshot(): void {
    this.uidMap.clear();
    this.snapshotContextId = null;
  }

  // ---------- screenshots ----------

  async takeScreenshotPage(): Promise<string> {
    const shot = await browser.bidi.send("browsingContext", "captureScreenshot", { context: this.context() });
    return shot.data;
  }

  async takeScreenshotByUid(uid: string): Promise<string> {
    const selector = this.resolveUidToSelector(uid);
    const rect = await this.callFunction(
      `function(sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      }`,
      [selector]
    );
    if (!rect || !rect.width || !rect.height) throw new Error(`Cannot screenshot uid "${uid}"`);
    const shot = await browser.bidi.send("browsingContext", "captureScreenshot", {
      context: this.context(),
      clip: { type: "box", ...rect },
    });
    return shot.data;
  }

  // ---------- console / network ----------

  // Upstream returns all contexts' messages/requests (no per-tab filtering).
  async getConsoleMessages(): Promise<ConsoleMessage[]> {
    return [...this.consoleMessages];
  }
  clearConsoleMessages(): void {
    this.consoleMessages.length = 0;
  }
  async startNetworkMonitoring(): Promise<void> {}
  async stopNetworkMonitoring(): Promise<void> {}
  async getNetworkRequests(): Promise<any[]> {
    return [...this.networkRecords.values()];
  }
  clearNetworkRequests(): void {
    this.networkRecords.clear();
    this.requestStartTimes.clear();
  }

  // ---------- navigation / dialogs / viewport ----------

  async navigate(url: string): Promise<void> {
    const context = this.context();
    this.clearSnapshot();
    // Upstream waits for "interactive" (DOMContentLoaded) so navigation errors reject;
    // "complete" can hang on slow subresources.
    await browser.bidi.send("browsingContext", "navigate", { context, url, wait: "interactive" });
    await this.refreshTabs();
  }

  async navigateBack(): Promise<void> {
    await browser.bidi.send("browsingContext", "traverseHistory", { context: this.context(), delta: -1 });
  }
  async navigateForward(): Promise<void> {
    await browser.bidi.send("browsingContext", "traverseHistory", { context: this.context(), delta: 1 });
  }

  async setViewportSize(width: number, height: number): Promise<void> {
    await browser.bidi.send("browsingContext", "setViewport", { context: this.context(), viewport: { width, height } });
  }

  async acceptDialog(promptText?: string): Promise<void> {
    try {
      await browser.bidi.send("browsingContext", "handleUserPrompt", {
        context: this.context(),
        accept: true,
        ...(promptText != null ? { userText: promptText } : {}),
      });
    } catch (e) {
      throw new Error(`Failed to accept dialog: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async dismissDialog(): Promise<void> {
    try {
      await browser.bidi.send("browsingContext", "handleUserPrompt", { context: this.context(), accept: false });
    } catch (e) {
      throw new Error(`Failed to dismiss dialog: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---------- tabs ----------

  getTabs(): TabInfo[] {
    return this.tabs;
  }
  getSelectedTabIdx(): number {
    return this.selectedTabIdx;
  }

  async refreshTabs(): Promise<void> {
    const tree = await browser.bidi.send("browsingContext", "getTree", {});
    this.tabs = ((tree?.contexts ?? []) as any[]).map((c) => ({
      actor: c.context,
      title: "",
      url: c.url ?? "",
    }));
    for (const tab of this.tabs) {
      tab.title = (await this.callFunction("function() { return document.title; }", [], tab.actor).catch(() => "")) as string;
    }
    const idx = this.tabs.findIndex((t) => t.actor === this.currentContextId);
    this.selectedTabIdx = idx === -1 ? 0 : idx;
    if (idx === -1 && this.tabs.length) this.currentContextId = this.tabs[0].actor;
  }

  async selectTab(index: number): Promise<void> {
    if (!this.tabs[index]) throw new Error(`No tab at index ${index}`);
    this.currentContextId = this.tabs[index].actor;
    this.selectedTabIdx = index;
    await browser.bidi.send("browsingContext", "activate", { context: this.currentContextId }).catch(() => {});
  }

  async createNewPage(url: string): Promise<number> {
    const created = await browser.bidi.send("browsingContext", "create", { type: "tab" });
    this.currentContextId = created.context;
    await this.navigate(url);
    await this.refreshTabs();
    return this.selectedTabIdx;
  }

  async closeTab(index: number): Promise<void> {
    if (!this.tabs[index]) throw new Error(`No tab at index ${index}`);
    await browser.bidi.send("browsingContext", "close", { context: this.tabs[index].actor });
    await this.refreshTabs();
    // Upstream switches to the first remaining tab after any close.
    if (this.tabs.length) {
      this.currentContextId = this.tabs[0].actor;
      this.selectedTabIdx = 0;
    }
  }

  // ---------- misc facade ----------

  getCurrentContextId(): string | null {
    return this.currentContextId;
  }
  setCurrentContextId(contextId: string): void {
    this.currentContextId = contextId;
  }
  async isConnected(): Promise<boolean> {
    return true;
  }
  getFirefoxVersion(): string | null {
    return this.firefoxVersion;
  }
  getOptions(): Record<string, unknown> {
    return { transport: "extension" };
  }
  getLogFilePath(): string | null {
    return null;
  }
  getDriver(): never {
    throw new Error("Selenium WebDriver is not available in the extension transport");
  }

  // Logpoints — ported from upstream events/debugging.ts, minus the Selenium socket.

  private logpoints = new Map<
    string,
    {
      expression: string;
      location: { url: string; line: number };
      results: Array<{ value: unknown; error?: string; timestamp: number }>;
      capped: boolean;
    }
  >();

  async setLogpoint(url: string, line: number, expression: string): Promise<string> {
    const result = await this.sendBiDiCommand("moz:debugging.setBreakpoint", {
      location: { url, line },
    });
    const logpointId = result.breakpoint as string;
    this.logpoints.set(logpointId, { expression, location: { url, line }, results: [], capped: false });
    return logpointId;
  }

  async removeLogpoint(logpointId: string): Promise<void> {
    await this.sendBiDiCommand("moz:debugging.removeBreakpoint", { breakpoint: logpointId });
    this.logpoints.delete(logpointId);
  }

  getLogpointResults(logpointId: string): Array<{ value: unknown; error?: string; timestamp: number }> | null {
    return this.logpoints.get(logpointId)?.results ?? null;
  }

  private findLogpointByLocation(url: string, line: number): string | null {
    for (const [id, entry] of this.logpoints) {
      if (entry.location.url === url && entry.location.line === line) return id;
    }
    return null;
  }

  private async handleLogpointPause(contextId: string, logpointId: string): Promise<void> {
    const entry = this.logpoints.get(logpointId);
    if (!entry) return;
    try {
      // Bug 2047506 (upstream note): script.callFunction fails while paused; use evaluate.
      const res = await this.sendBiDiCommand("script.evaluate", {
        expression: entry.expression,
        target: { context: contextId },
        awaitPromise: false,
      });
      if (res.type === "exception") {
        entry.results.push({ value: null, error: res.exceptionDetails?.text ?? "Unknown error", timestamp: Date.now() });
      } else {
        entry.results.push({ value: res.result, timestamp: Date.now() });
      }
    } catch (error) {
      entry.results.push({ value: null, error: String(error), timestamp: Date.now() });
    } finally {
      if (entry.results.length > 100) {
        entry.results.splice(0, entry.results.length - 100);
        entry.capped = true;
      }
      await this.sendBiDiCommand("moz:debugging.resume", { context: contextId }).catch(() => {});
    }
  }
}

// ---------- network record helpers (ported from upstream events/network.ts) ----------

function guessResourceType(url: string): string {
  const pathPart = url.split("?")[0];
  if (!pathPart) return "document";
  const parts = pathPart.split(".");
  const ext = (parts.length > 1 ? parts[parts.length - 1] || "" : "").toLowerCase();
  if (["js", "mjs"].includes(ext)) return "script";
  if (ext === "css") return "stylesheet";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "ico"].includes(ext)) return "image";
  if (["woff", "woff2", "ttf", "eot"].includes(ext)) return "font";
  if (["mp4", "webm", "ogg"].includes(ext)) return "media";
  if (url.includes("/api/") || url.includes(".json")) return "xhr";
  return "document";
}

function parseHeaders(headers: any[]): Record<string, string> {
  const result: Record<string, string> = {};
  const normalize = (value: unknown): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) {
      const parts = value.map(normalize).filter((v): v is string => !!v);
      return parts.length ? parts.join(", ") : null;
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if ("value" in obj) return normalize(obj.value);
      if ("bytes" in obj) return normalize(obj.bytes);
      try {
        return JSON.stringify(obj);
      } catch {
        return null;
      }
    }
    return null;
  };
  for (const h of headers) {
    const name = typeof h?.name === "string" ? h.name : null;
    const value = normalize(h?.value);
    if (name && value !== null) result[name] = value;
  }
  return result;
}

// ---------- RemoteValue helpers ----------

function serializeArg(a: unknown): object {
  if (a === null || a === undefined) return { type: "null" };
  switch (typeof a) {
    case "string": return { type: "string", value: a };
    case "number": return { type: "number", value: a };
    case "boolean": return { type: "boolean", value: a };
    default:
      return {
        type: "object",
        value: Object.entries(a as object).map(([k, v]) => [k, serializeArg(v)]),
      };
  }
}

function fromRemoteValue(v: any): any {
  if (v == null) return undefined;
  switch (v.type) {
    case "undefined": return undefined;
    case "null": return null;
    case "string": case "boolean": return v.value;
    case "number": return typeof v.value === "string" ? Number(v.value) : v.value;
    case "array": return (v.value ?? []).map(fromRemoteValue);
    case "object": {
      const out: Record<string, any> = {};
      for (const [k, val] of v.value ?? []) out[typeof k === "string" ? k : String(fromRemoteValue(k))] = fromRemoteValue(val);
      return out;
    }
    default: return `[${v.type}]`;
  }
}
