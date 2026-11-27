const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function createHarness(fetch) {
  const translations = new Map();
  const audio = new Map();
  const calls = { translationGetBatch: 0, translationPutBatch: 0, audioGetBatch: 0 };
  let listener;
  const context = {
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    fetch,
    btoa: text => Buffer.from(text, "binary").toString("base64"),
    atob: text => Buffer.from(text, "base64").toString("binary"),
    browser: {
      storage: { local: { async get() {
        return { ttsSettings: {
          geminiApiKey: "test-key", geminiModel: "test-model",
          azureKey: "azure-key", azureRegion: "eastus", azureVoice: "ar-SA-HamedNeural"
        } };
      } } },
      runtime: { onMessage: { addListener(fn) { listener = fn; } } }
    },
    YTLLTranslationCache: {
      async get(key) { return translations.get(key) || null; },
      async getBatch(keys) { calls.translationGetBatch++; return keys.map(key => translations.get(key) || null); },
      async put(record) { translations.set(record.key, record); },
      async putTranslationBatch(records) {
        calls.translationPutBatch++;
        for (const record of records) translations.set(record.key, record);
      }
    },
    YTLLTTSCache: {
      async get(key) { return audio.get(key) || null; },
      async getBatch(keys) { calls.audioGetBatch++; return keys.map(key => audio.get(key) || null); },
      async put(record) { audio.set(record.key, record); },
      async clear() { audio.clear(); }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8") +
    "\nglobalThis.testHooks = { createTranslationCacheKey, createCacheKey };";
  vm.runInNewContext(source, context);
  return { message: message => listener(message), hooks: context.testHooks, translations, audio, calls };
}

function geminiResponse(text) {
  return { ok: true, async json() { return { candidates: [{ content: { parts: [{ text }] } }] }; } };
}

test("batch translations use one cache read and write, header auth, and parallel missing fallbacks", async () => {
  const requests = [];
  const fallbackResolvers = [];
  const h = createHarness((url, options) => {
    requests.push({ url, options });
    const body = JSON.parse(options.body);
    if (body.generationConfig.responseMimeType) {
      return Promise.resolve(geminiResponse('[{"id":0,"translation":"batch"}]'));
    }
    return new Promise(resolve => fallbackResolvers.push(resolve));
  });
  const cachedKey = await h.hooks.createTranslationCacheKey("cached", "en", "ar", "test-model", []);
  h.translations.set(cachedKey, { key: cachedKey, translatedText: "cached-result" });
  const request = h.message({
    type: "YTLL_TRANSLATE_BATCH",
    items: [
      { index: 0, text: "cached" }, { index: 1, text: "one" },
      { index: 2, text: "two" }, { index: 3, text: "three" }
    ]
  });
  for (let i = 0; i < 50 && fallbackResolvers.length < 2; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(fallbackResolvers.length, 2, "both fallbacks must start before either completes");
  fallbackResolvers[0](geminiResponse("fallback-one"));
  fallbackResolvers[1](geminiResponse("fallback-two"));
  const result = await request;
  assert.deepEqual(JSON.parse(JSON.stringify(result.translations)), {
    0: "cached-result", 1: "batch", 2: "fallback-one", 3: "fallback-two"
  });
  assert.equal(result.cachedCount, 1);
  assert.equal(result.fetchedCount, 3);
  assert.equal(h.calls.translationGetBatch, 1);
  assert.equal(h.calls.translationPutBatch, 1);
  for (const { url, options } of requests) {
    assert.equal(url.includes("?"), false);
    assert.equal(url.includes("test-key"), false);
    assert.equal(options.headers["x-goog-api-key"], "test-key");
  }
});

test("shared translation batches map results to each caller's cue indices", async () => {
  let finish;
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  const h = createHarness(() => {
    requested();
    return new Promise(resolve => { finish = resolve; });
  });
  const first = h.message({ type: "YTLL_TRANSLATE_BATCH", items: [{ index: 1, text: "same" }] });
  await started;
  const second = h.message({ type: "YTLL_TRANSLATE_BATCH", items: [{ index: 9, text: "same" }] });
  await new Promise(resolve => setImmediate(resolve));
  finish(geminiResponse("translated"));
  assert.equal((await first).translations[1], "translated");
  assert.equal((await second).translations[9], "translated");
  assert.equal(h.calls.translationPutBatch, 1);
});

test("audio batches read all cache keys together", async () => {
  const h = createHarness(() => { throw new Error("Unexpected network request"); });
  for (const text of ["first", "second"]) {
    const key = await h.hooks.createCacheKey("ar-SA-HamedNeural", text);
    h.audio.set(key, { key, arrayBuffer: Uint8Array.from([1, 2]).buffer, mimeType: "audio/wav" });
  }
  const result = await h.message({
    type: "YTLL_TTS_SYNTHESIZE_BATCH",
    items: [{ key: "a", text: "first" }, { key: "b", text: "second" }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.cachedItems.length, 2);
  assert.equal(result.cachedItems[1].clientKey, "b");
  assert.equal(h.calls.audioGetBatch, 1);
});

test("clearing audio cache prevents an earlier synthesis from repopulating it", async () => {
  let finish;
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  const h = createHarness(() => {
    requested();
    return new Promise(resolve => { finish = resolve; });
  });
  const pending = h.message({ type: "YTLL_TTS_SYNTHESIZE", text: "hello" });
  await started;
  assert.equal((await h.message({ type: "YTLL_TTS_CLEAR_CACHE" })).ok, true);
  finish({ ok: true, async arrayBuffer() { return Uint8Array.from([1]).buffer; } });
  assert.equal((await pending).ok, true);
  assert.equal(h.audio.size, 0);
});
