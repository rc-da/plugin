// A runtime stand-in for the "obsidian" module, rich enough to load the *built*
// main.js in Node and drive it: plugin lifecycle, commands, status bar, settings
// tab rendering, notices, and requestUrl routed to an in-memory GitHub.
// Only for tests/bundle.test.ts. Semantics follow obsidian.d.ts.

import type { HttpClient } from "../../src/adapters/http";

/** Minimal element with the HTMLElement extensions Obsidian adds (createEl, addClass, …). */
export class FakeEl {
  tag: string;
  cls = new Set<string>();
  text = "";
  children: FakeEl[] = [];
  listeners = new Map<string, ((ev: unknown) => void)[]>();
  hidden = false;
  value = "";
  checked = false;
  type = "";
  min = "";
  max = "";
  rows = 0;
  scrollTop = 0;
  scrollHeight = 0;
  constructor(tag = "div", opts: { cls?: string; text?: string; type?: string } = {}) {
    this.tag = tag;
    if (opts.cls) for (const c of opts.cls.split(/\s+/)) if (c) this.cls.add(c);
    if (opts.text) this.text = opts.text;
    if (opts.type) this.type = opts.type;
  }
  addClass(...c: string[]) { for (const x of c) this.cls.add(x); }
  removeClass(...c: string[]) { for (const x of c) this.cls.delete(x); }
  toggleClass(c: string, on: boolean) { if (on) this.cls.add(c); else this.cls.delete(c); }
  hasClass(c: string) { return this.cls.has(c); }
  createEl(tag: string, opts: { cls?: string; text?: string; type?: string } = {}) { const e = new FakeEl(tag, opts); this.children.push(e); return e; }
  createDiv(opts: { cls?: string; text?: string } = {}) { return this.createEl("div", opts); }
  createSpan(opts: { cls?: string; text?: string } = {}) { return this.createEl("span", opts); }
  setText(t: string) { this.text = t; }
  appendText(t: string) { this.text += t; }
  empty() { this.children = []; this.text = ""; }
  hide() { this.hidden = true; }
  show() { this.hidden = false; }
  addEventListener(type: string, fn: (ev: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  dispatchEvent(ev: { type: string }) { for (const fn of this.listeners.get(ev.type) ?? []) fn(ev); return true; }
  click() { this.dispatchEvent({ type: "click" }); }
  /** All descendant text, for assertions. */
  allText(): string { return [this.text, ...this.children.map(c => c.allText())].filter(Boolean).join(" | "); }
  find(pred: (e: FakeEl) => boolean): FakeEl[] {
    return [...(pred(this) ? [this] : []), ...this.children.flatMap(c => c.find(pred))];
  }
}

/** Chainable component stub: every setter returns itself, callbacks are recorded. */
function component(): Record<string, unknown> {
  const target: Record<string, unknown> = { inputEl: new FakeEl("input"), buttonEl: new FakeEl("button"), handlers: [] as unknown[] };
  const proxy: Record<string, unknown> = new Proxy(target, {
    get(t, prop: string | symbol) {
      if (typeof prop === "symbol" || prop in t) return t[prop as string];
      if (prop === "then") return undefined; // not a thenable
      return (...args: unknown[]) => {
        if (prop === "onChange" || prop === "onClick") (t.handlers as unknown[]).push(args[0]);
        return proxy;
      };
    },
  });
  return proxy;
}

export interface RuntimeLog {
  notices: string[];
  icons: string[];
  tooltips: string[];
  settings: { name: string; desc: string }[];
}

export function makeObsidianRuntime(http: HttpClient, log: RuntimeLog) {
  class Plugin {
    app: unknown;
    manifest: { id: string; version: string };
    data: unknown;
    commands: { id: string; name: string; callback: () => void }[] = [];
    ribbons: { icon: string; title: string; cb: () => void }[] = [];
    tabs: { display(): void; containerEl: FakeEl }[] = [];
    statusItems: FakeEl[] = [];
    intervals: number[] = [];
    constructor(app: unknown, manifest: { id: string; version: string }) { this.app = app; this.manifest = manifest; }
    async loadData() { return this.data ?? null; }
    async saveData(d: unknown) { this.data = JSON.parse(JSON.stringify(d)); }
    addCommand(c: { id: string; name: string; callback: () => void }) { this.commands.push(c); return c; }
    addRibbonIcon(icon: string, title: string, cb: () => void) { this.ribbons.push({ icon, title, cb }); return new FakeEl(); }
    addStatusBarItem() { const e = new FakeEl(); this.statusItems.push(e); return e; }
    addSettingTab(t: { display(): void; containerEl: FakeEl }) { this.tabs.push(t); }
    registerEvent() {}
    registerDomEvent(el: { addEventListener(t: string, f: (e: unknown) => void): void }, type: string, cb: (e: unknown) => void) { el.addEventListener(type, cb); }
    registerInterval(id: number) { this.intervals.push(id); return id; }
    /** Test helper: what Obsidian does on disable. */
    unloadForTest() { for (const id of this.intervals) clearInterval(id); (this as unknown as { onunload(): void }).onunload(); }
  }

  class PluginSettingTab {
    app: unknown;
    containerEl = new FakeEl();
    constructor(app: unknown) { this.app = app; }
  }

  class Setting {
    descEl = new FakeEl();
    private entry = { name: "", desc: "" };
    constructor(public containerEl: FakeEl) { log.settings.push(this.entry); containerEl.createDiv({ cls: "setting-item" }); }
    setName(n: string) { this.entry.name = n; return this; }
    setDesc(d: string) { this.entry.desc = d; return this; }
    setHeading() { return this; }
    setClass() { return this; }
    private add(cb: (c: unknown) => unknown) { cb(component()); return this; }
    addText(cb: (c: unknown) => unknown) { return this.add(cb); }
    addTextArea(cb: (c: unknown) => unknown) { return this.add(cb); }
    addToggle(cb: (c: unknown) => unknown) { return this.add(cb); }
    addButton(cb: (c: unknown) => unknown) { return this.add(cb); }
    addDropdown(cb: (c: unknown) => unknown) { return this.add(cb); }
    addExtraButton(cb: (c: unknown) => unknown) { return this.add(cb); }
    addComponent(cb: (el: FakeEl) => unknown) { cb(new FakeEl()); return this; }
  }

  class Chainable { constructor() { return component(); } }

  class Notice { constructor(msg: string) { log.notices.push(msg); } }

  class Modal {
    app: unknown; modalEl = new FakeEl(); titleEl = new FakeEl(); contentEl = new FakeEl();
    constructor(app: unknown) { this.app = app; }
    open() { (this as unknown as { onOpen(): void }).onOpen(); }
    close() { (this as unknown as { onClose(): void }).onClose(); }
    setTitle(t: string) { this.titleEl.setText(t); return this; }
  }

  class Menu {
    items: { title: string; onClick?: () => void }[] = [];
    addItem(cb: (i: unknown) => void) {
      const item: { title: string; onClick?: () => void } = { title: "" };
      const api = { setTitle: (t: string) => { item.title = t; return api; }, setIcon: () => api, onClick: (f: () => void) => { item.onClick = f; return api; } };
      cb(api);
      this.items.push(item);
      return this;
    }
    showAtMouseEvent() { return this; }
  }

  class AbstractInputSuggest { constructor(_app: unknown, _el: unknown) {} setValue() {} close() {} }
  class FileSystemAdapter {}

  const requestUrl = async (p: { url: string; method?: string; headers?: Record<string, string>; contentType?: string; body?: string | ArrayBuffer; throw?: boolean }) => {
    const headers = { ...(p.headers ?? {}) };
    if (p.contentType) headers["Content-Type"] = p.contentType;
    const res = await http({ url: p.url, method: (p.method ?? "GET") as "GET", headers, body: p.body });
    if (p.throw !== false && res.status >= 400) throw new Error(`status ${res.status}`);
    return { status: res.status, headers: res.headers, arrayBuffer: res.body };
  };

  return {
    Plugin, PluginSettingTab, Setting, Notice, Modal, Menu, AbstractInputSuggest, FileSystemAdapter,
    SecretComponent: Chainable,
    Platform: { isMobile: false, isDesktopApp: true, isMobileApp: false, isIosApp: false, isAndroidApp: false, isMacOS: false, isWin: false, isLinux: true },
    requestUrl,
    setIcon: (_el: unknown, icon: string) => { log.icons.push(icon); },
    setTooltip: (_el: unknown, tip: string) => { log.tooltips.push(tip); },
    normalizePath: (p: string) => p.replace(/\\/g, "/"),
  };
}
