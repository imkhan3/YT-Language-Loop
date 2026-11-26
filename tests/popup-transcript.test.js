const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.textContent = "";
    this.open = false;
    this.scrollCount = 0;
    const classes = new Set();
    this.classList = {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains: name => classes.has(name),
      add: name => classes.add(name),
      remove: name => classes.delete(name)
    };
  }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  dispatch(type) { return this.listeners[type]?.({}); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  scrollIntoView() { this.scrollCount++; }
}

function createHarness() {
  const elements = new Map();
  const sent = [];
  let onMessage;
  let timer = null;
  let onGetTranscript = async () => ({ ok: true, videoId: "", cues: [] });
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    createElement() { return new Element(); }
  };
  const browser = {
    runtime: { onMessage: { addListener(listener) { onMessage = listener; } } },
    tabs: {
      async query() { return [{ id: 7 }]; },
      async sendMessage(id, message) {
        sent.push({ id, ...message });
        if (message.type === "YTLL_GET_TRANSCRIPT") return onGetTranscript();
        if (message.type === "YTLL_GET_VIDEO_STATUS") return { ok: true, stored: false };
        return { ok: true };
      }
    }
  };
  const context = {
    document,
    browser,
    window: { addEventListener() {} },
    console,
    structuredClone,
    setInterval(callback) { timer = callback; return 1; },
    clearInterval() { timer = null; },
    setTimeout() { return 1; },
    clearTimeout() {}
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8")
    .replace(/init\(\);\s*$/, `
      globalThis.testHooks = {
        bindEvents, renderTranscript, refreshTranscript,
        setTab(id) { activeTabId = id; }
      };
    `);
  vm.runInNewContext(source, context);
  context.testHooks.setTab(7);
  context.testHooks.bindEvents();
  return {
    hooks: context.testHooks,
    element: id => elements.get(id),
    sent,
    message: (payload, tabId) => onMessage(payload, { tab: { id: tabId } }),
    setGetTranscript(fn) { onGetTranscript = fn; },
    hasTimer: () => timer !== null
  };
}

function payload() {
  return {
    ok: true, videoId: "video1", targetLang: "ar", subtitlesPerLoop: 2,
    translatedCount: 1, activeCueIdx: 0,
    cues: [
      { index: 0, start: 0, sourceText: "<b>source</b>", targetText: "translated" },
      { index: 1, start: 65, sourceText: "second", targetText: "" },
      { index: 2, start: 70, sourceText: "third", targetText: "" }
    ]
  };
}

test("renders safe cue text, progress, direction, blocks, and seeks", async () => {
  const h = createHarness();
  h.hooks.renderTranscript(payload());
  const items = h.element("transcriptList").children;
  assert.equal(h.element("transcriptProgress").textContent, "1/3 translated");
  assert.equal(items[0].children[1].textContent, "<b>source</b>");
  assert.equal(items[0].children[2].dir, "rtl");
  assert.equal(items[1].children[0].textContent, "01:05 · #2");
  assert.equal(items[1].children[2].textContent, "Pending");
  assert.equal(items[1].children[2].classList.contains("pending"), true);
  assert.equal(items[0].classList.contains("active"), true);
  assert.equal(items[1].classList.contains("block-start"), false);
  assert.equal(items[2].classList.contains("block-start"), true);
  await items[1].dispatch("click");
  assert.equal(h.sent.find(message => message.type === "YTLL_SEEK_TO_TIME").time, 65);
});

test("accepts only active-tab updates and preserves the user's scroll position", () => {
  const h = createHarness();
  const data = payload();
  h.hooks.renderTranscript(data);
  const items = h.element("transcriptList").children;
  h.element("transcriptCard").open = true;
  h.element("transcriptList").dispatch("wheel");
  data.activeCueIdx = 2;
  data.cues[1].targetText = "new translation";
  data.translatedCount = 2;
  h.message({ type: "YTLL_TRANSCRIPT_UPDATED", ...data }, 8);
  assert.equal(h.element("transcriptProgress").textContent, "1/3 translated");
  h.message({ type: "YTLL_TRANSCRIPT_UPDATED", ...data }, 7);
  assert.equal(h.element("transcriptProgress").textContent, "2/3 translated");
  assert.equal(items[1].children[2].textContent, "new translation");
  assert.equal(items[2].classList.contains("active"), true);
  assert.equal(items[2].scrollCount, 0);
});

test("polls only when open and ignores stale responses after a live update", async () => {
  const h = createHarness();
  let finishRequest;
  h.setGetTranscript(() => new Promise(resolve => { finishRequest = resolve; }));
  const card = h.element("transcriptCard");
  card.open = true;
  card.dispatch("toggle");
  assert.equal(h.hasTimer(), true);
  const updated = payload();
  updated.translatedCount = 2;
  h.message({ type: "YTLL_TRANSCRIPT_UPDATED", ...updated }, 7);
  finishRequest(payload());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.element("transcriptProgress").textContent, "2/3 translated");
  assert.equal(h.element("transcriptList").children[0].scrollCount, 1);
  card.open = false;
  card.dispatch("toggle");
  assert.equal(h.hasTimer(), false);
});

test("accepts a slow poll even if a newer poll is still pending", async () => {
  const h = createHarness();
  const pending = [];
  h.setGetTranscript(() => new Promise(resolve => pending.push(resolve)));
  const first = h.hooks.refreshTranscript();
  const second = h.hooks.refreshTranscript();
  pending[0](payload());
  await first;
  assert.equal(h.element("transcriptProgress").textContent, "1/3 translated");
  const newer = payload();
  newer.translatedCount = 2;
  pending[1](newer);
  await second;
  assert.equal(h.element("transcriptProgress").textContent, "2/3 translated");
});

test("shows a helpful empty state when the active tab cannot provide a transcript", async () => {
  const h = createHarness();
  h.setGetTranscript(async () => { throw new Error("No receiving end"); });
  await h.hooks.refreshTranscript();
  assert.equal(
    h.element("transcriptList").children[0].textContent,
    "Open a YouTube video to view the transcript."
  );
});
