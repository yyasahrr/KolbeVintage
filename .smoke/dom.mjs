import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";

/** jsdom has no layout engine: geometry is not measurable here, DOM is. */
export function makeDom({ mobile = false } = {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on("jsdomError", (error) => errors.push(String(error.message ?? error)));
  virtualConsole.on("error", (...args) => errors.push(args.join(" ")));

  const dom = new JSDOM(
    `<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"></head><body><div id="root"></div></body></html>`,
    { url: "https://kolbe.test/", pretendToBeVisual: true, runScripts: "outside-only", virtualConsole },
  );
  const { window } = dom;
  /* capability detection only — the desktop bundle is the pointer/min-1024 one */
  window.matchMedia = (query) => ({
    matches: !mobile && !/prefers-reduced-motion/.test(query) && /min-width:\s*1024px/.test(query),
    media: query,
    onchange: null,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
    dispatchEvent() { return false; },
  });
  /* jsdom ships neither observer; every browser the storefront targets has both */
  class NoopObserver {
    constructor(callback) { this.callback = callback; }
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  }
  window.ResizeObserver = NoopObserver;
  window.IntersectionObserver = NoopObserver;
  window.scrollTo = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  return { dom, window, document: window.document, errors };
}

export const wait = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

export async function boot(bundlePath, options = {}) {
  const env = makeDom(options);
  const code = fs.readFileSync(path.resolve(bundlePath), "utf8");
  env.window.eval(code);
  await wait(700);
  return env;
}

export const helpers = (document) => ({
  $: (selector, root = document) => root.querySelector(selector),
  $$: (selector, root = document) => Array.from(root.querySelectorAll(selector)),
  text: (selector, root = document) => (root.querySelector(selector)?.textContent ?? "").trim(),
  texts: (selector, root = document) => Array.from(root.querySelectorAll(selector)).map((node) => node.textContent.trim()),
  byText: (selector, needle, root = document) =>
    Array.from(root.querySelectorAll(selector)).find((node) => (node.textContent ?? "").includes(needle)) ?? null,
  async click(node, options = {}) {
    if (!node) throw new Error("click(): no node");
    node.dispatchEvent(new node.ownerDocument.defaultView.MouseEvent("click", { bubbles: true, cancelable: true, ...options }));
    await wait(160);
  },
});

/** Tiny reporter: records pass/fail and exits non-zero when anything failed. */
export function reporter(label) {
  const results = [];
  /* a check passes only when it returns true (or nothing); returning a string
     is the failure note, so a wrong value can never read as a pass */
  const check = (name, fn) => {
    try {
      const value = fn();
      const ok = value === true || value === undefined;
      results.push({ name, ok, note: ok ? "" : String(value) });
    } catch (error) {
      results.push({ name, ok: false, note: String(error?.message ?? error) });
    }
  };
  const done = (extra = {}) => {
    const failed = results.filter((result) => !result.ok);
    for (const result of results) {
      process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.ok && result.note ? `  (${result.note})` : ""}${result.ok ? "" : `\n        ↳ ${result.note}`}\n`);
    }
    process.stdout.write(`\n${label}: ${results.length - failed.length}/${results.length} passed${Object.keys(extra).length ? ` · ${JSON.stringify(extra)}` : ""}\n`);
    if (failed.length) process.exitCode = 1;
    return failed.length;
  };
  return { check, done, results };
}
