const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createHarness() {
  const updates = [];
  const cacheWrites = [];
  let messageListener;
  let translate = async () => ({ ok: true, translations: {} });
  let pageResult;
  let windowMessageListener;
  let stored = {};
  let seekListener;
  let currentTime = 0;
  const video = {
    dataset: {},
    paused: true,
    muted: false,
    addEventListener(type, listener) {
      if (type === "seeked") seekListener = listener;
    },
    removeEventListener() {},
    get currentTime() { return currentTime; },
    set currentTime(value) {
      currentTime = value;
      queueMicrotask(() => seekListener?.());
    }
  };
  const window = {
    location: { href: "https://www.youtube.com/watch?v=video1" },
    addEventListener(type, listener) {
      if (type === "message") windowMessageListener = listener;
    },
    postMessage(message) {
      if (message.action === "GENERATE_BILINGUAL_SRT" && pageResult) {
        queueMicrotask(() => windowMessageListener({
          source: window,
          data: { source: "yt-lang-loop-page", id: message.id, result: pageResult }
        }));
      }
    }
  };
  const document = {
    readyState: "loading",
    head: { appendChild() {} },
    createElement() { return {}; },
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return video; }
  };
  const browser = {
    runtime: {
      getURL: value => value,
      onMessage: { addListener(listener) { messageListener = listener; } },
      async sendMessage(message) {
        if (message.type === "YTLL_TRANSCRIPT_UPDATED") updates.push(message);
        if (message.type === "YTLL_TRANSLATE_BATCH") return translate(message);
        if (message.type === "YTLL_VIDEO_CACHE_PUT") cacheWrites.push(message);
        return { ok: true };
      }
    },
    storage: {
      local: { async get() { return stored; } },
      onChanged: { addListener() {} }
    }
  };
  const context = {
    Audio: class {
      pause() {}
      addEventListener() {}
    },
    URL,
    browser,
    document,
    window,
    console,
    structuredClone,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {}
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8")
    .replace(/\}\)\(\);\s*$/, `
      globalThis.testHooks = {
        seed(videoId, newCues, blockSize = 5) {
          currentVideoId = videoId;
          cues = newCues;
          settings.enabled = false;
          settings.subtitlesPerLoop = blockSize;
          videoCacheSuppressed = true;
          usingSrt = false;
          usingGeneratedSrt = false;
          rebuildBlocksAndSync();
        },
        enableTranslation() {
          ttsSettings.geminiApiKey = "test-key";
          scheduleTranslationBatches();
        },
        saveCache() {
          videoCacheSuppressed = false;
          return saveVideoCache();
        },
        initForCurrentVideo,
        reloadGeneratedCaptions,
        reloadCaptionsForCurrentVideo
      };
    })();`);
  vm.runInNewContext(source, context);
  return {
    hooks: context.testHooks,
    message: message => messageListener(message),
    updates,
    cacheWrites,
    video,
    window,
    setTranslate(fn) { translate = fn; },
    setPageResult(result) { pageResult = result; },
    setStored(value) { stored = value; }
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const sampleCues = [
  { start: 0, end: 2, sourceText: "first", targetText: "one" },
  { start: 2, end: 4, sourceText: "second", targetText: "" },
  { start: 4, end: 6, sourceText: "third", targetText: "  " }
];

test("publishes and returns transcript snapshots, including empty navigation state", async () => {
  const h = createHarness();
  h.video.currentTime = 2.5;
  h.hooks.seed("video1", structuredClone(sampleCues));
  const expected = {
    ok: true, videoId: "video1", sourceLang: "en", targetLang: "ar",
    subtitlesPerLoop: 5, currentBlockIdx: 0, activeCueIdx: 1, translatedCount: 1,
    cues: sampleCues.map((cue, index) => ({ index, ...cue }))
  };
  assert.deepEqual(plain(await h.message({ type: "YTLL_GET_TRANSCRIPT" })), expected);
  assert.deepEqual(plain(h.updates.at(-1)), { type: "YTLL_TRANSCRIPT_UPDATED", ...expected });

  h.window.location.href = "https://www.youtube.com/";
  const empty = await h.message({ type: "YTLL_GET_TRANSCRIPT" });
  assert.equal(empty.videoId, "");
  assert.equal(empty.activeCueIdx, -1);
  assert.equal(empty.translatedCount, 0);
  assert.deepEqual(plain(empty.cues), []);
  await h.hooks.initForCurrentVideo();
  assert.deepEqual(plain(h.updates.at(-1).cues), []);
});

test("streams translation results and ignores stale batches", async () => {
  const h = createHarness();
  h.hooks.seed("video1", structuredClone(sampleCues));
  let finishTranslation;
  h.setTranslate(() => new Promise(resolve => { finishTranslation = resolve; }));
  h.hooks.enableTranslation();
  finishTranslation({ ok: true, translations: { 1: " two ", 2: "three" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.updates.at(-1).translatedCount, 3);
  assert.equal(h.updates.at(-1).cues[1].targetText, "two");

  h.hooks.seed("video1", structuredClone(sampleCues));
  h.hooks.enableTranslation();
  h.hooks.seed("video1", []);
  const updateCount = h.updates.length;
  finishTranslation({ ok: true, translations: { 1: "stale" } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.updates.length, updateCount);
});

test("seeks through block transitions and rejects invalid requests", async () => {
  const h = createHarness();
  h.hooks.seed("video1", structuredClone(sampleCues), 2);
  assert.deepEqual(plain(await h.message({ type: "YTLL_SEEK_TO_TIME", time: NaN })), {
    ok: false, reason: "A valid time and loaded subtitles are required."
  });
  assert.deepEqual(plain(await h.message({ type: "YTLL_SEEK_TO_TIME", time: 4.5 })), { ok: true });
  assert.equal(h.video.currentTime, 4.5);
  const payload = await h.message({ type: "YTLL_GET_TRANSCRIPT" });
  assert.equal(payload.currentBlockIdx, 1);
  assert.equal(payload.activeCueIdx, 2);

  h.hooks.seed("video1", []);
  assert.equal((await h.message({ type: "YTLL_SEEK_TO_TIME", time: 1 })).ok, false);
});

test("publishes loaded SRT cues and generated translations", async () => {
  const h = createHarness();
  h.setStored({ srt_video1: structuredClone(sampleCues) });
  await h.hooks.initForCurrentVideo();
  assert.equal(h.updates.at(-1).cues.length, 3);

  h.hooks.seed("video1", structuredClone(sampleCues));
  h.setPageResult({
    ok: true,
    srt: "1\n00:00:02,000 --> 00:00:04,000\nsecond\n\n" +
      "2\n00:00:02,000 --> 00:00:04,000\ntranslated\n"
  });
  await h.hooks.reloadGeneratedCaptions("video1", { sourceLang: "en", targetLang: "ar" }, 0);
  assert.equal(h.updates.at(-1).cues[1].targetText, "translated");
});

test("publishes cue resets on reload and preserves cues when cache is cleared", async () => {
  const h = createHarness();
  h.hooks.seed("video1", structuredClone(sampleCues));
  await h.message({ type: "YTLL_VIDEO_CACHE_CLEARED" });
  assert.equal(h.updates.at(-1).cues.length, 3);
  h.hooks.reloadCaptionsForCurrentVideo();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(plain(h.updates.at(-1).cues), []);
});

test("caches new translations after clearing the current video cache", async () => {
  const h = createHarness();
  h.hooks.seed("video1", structuredClone(sampleCues));
  await h.message({ type: "YTLL_VIDEO_CACHE_CLEARED" });
  h.setTranslate(async () => ({ ok: true, translations: { 1: "new translation" } }));
  h.hooks.enableTranslation();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.cacheWrites.length, 1);
  assert.equal(h.cacheWrites[0].cues[1].targetText, "new translation");
});

test("publishes an update after video cache persistence", async () => {
  const h = createHarness();
  h.hooks.seed("video1", structuredClone(sampleCues));
  const updateCount = h.updates.length;
  await h.hooks.saveCache();
  assert.equal(h.updates.length, updateCount + 1);
  assert.equal(h.updates.at(-1).translatedCount, 1);
});
