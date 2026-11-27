const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createHarness(decodedAudio = null) {
  const sent = [];
  let pageListener;
  let storageListener;
  let messageListener;
  const revokedUrls = [];
  let pageHandler = async () => ({
    audioRes: { ok: false, reason: "No alternate audio tracks on this video" },
    subRes: { ok: true },
    caps: { audioTrackCount: 1, hasTargetAudio: false }
  });
  let runtimeHandler = async () => ({ ok: true });
  let decoderRate;
  const audios = [];
  const intervals = new Map();
  let nextInterval = 0;
  let time = 0;
  const videoListeners = new Map();
  const video = {
    dataset: {}, paused: true, muted: false, playbackRate: 1, volume: 1,
    pauseCount: 0, playCount: 0, seekWasPaused: null,
    get currentTime() { return time; },
    set currentTime(value) {
      time = value;
      this.seekWasPaused = this.paused;
      const listener = videoListeners.get("seeked");
      if (listener) queueMicrotask(listener);
    },
    addEventListener(type, listener) { videoListeners.set(type, listener); },
    removeEventListener(type) { videoListeners.delete(type); },
    pause() { this.pauseCount++; this.paused = true; },
    play() { this.playCount++; this.paused = false; return Promise.resolve(); }
  };
  class MockAudio {
    constructor() {
      this.listeners = new Map();
      this.paused = true;
      this.ended = false;
      this.readyState = 0;
      this.currentTime = 0;
      this.duration = 1;
      this.src = "";
      this.currentSrc = "";
      this.loadCount = 0;
      this.playCount = 0;
      audios.push(this);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    load() {
      this.loadCount++;
      this.currentSrc = this.src;
      this.readyState = 1;
      for (const listener of Array.from(this.listeners.get("loadedmetadata") || [])) listener();
    }
    play() { this.playCount++; this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  const window = {
    location: { href: "https://www.youtube.com/watch?v=video1" },
    addEventListener(type, listener) { if (type === "message") pageListener = listener; },
    postMessage(message) {
      if (message.action === "APPLY_PASS" || message.action === "GENERATE_BILINGUAL_SRT") {
        sent.push(message);
        Promise.resolve(pageHandler(message.payload, message.action)).then(result => pageListener({
          source: window,
          data: { source: "yt-lang-loop-page", id: message.id, result }
        }));
      }
    },
    OfflineAudioContext: class {
      constructor(channels, length, sampleRate) { decoderRate = sampleRate; }
      async decodeAudioData() { return decodedAudio; }
    }
  };
  const browser = {
    runtime: {
      getURL: value => value,
      onMessage: { addListener(listener) { messageListener = listener; } },
      async sendMessage(message) {
        sent.push(message);
        return runtimeHandler(message);
      }
    },
    storage: {
      local: { async get() { return {}; } },
      onChanged: { addListener(listener) { storageListener = listener; } }
    }
  };
  class MockURL extends URL {
    static createObjectURL() { return "blob:generated"; }
    static revokeObjectURL(url) { revokedUrls.push(url); }
  }
  const context = {
    window, browser, URL: MockURL, console, structuredClone,
    document: {
      readyState: "loading",
      head: { appendChild() {} },
      createElement() { return {}; },
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return video; }
    },
    Audio: MockAudio,
    atob: text => Buffer.from(text, "base64").toString("binary"),
    btoa: text => Buffer.from(text, "binary").toString("base64"),
    Blob,
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval(callback) { const id = ++nextInterval; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); }
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8")
    .replace(/\}\)\(\);\s*$/, `
      globalThis.testHooks = {
        setup(newSettings, newTts, newCues) {
          currentVideoId = "video1";
          settings = { ...structuredClone(DEFAULT_SETTINGS), ...newSettings };
          ttsSettings = { ...DEFAULT_TTS_SETTINGS, ...newTts };
          cues = newCues;
          blocks = buildBlocks(cues, settings.subtitlesPerLoop || 5);
          currentBlockIdx = 0;
          currentPassIdx = 0;
          videoCacheSuppressed = true;
        },
        setPass(index) { currentPassIdx = index; },
        setBlock(index) { currentBlockIdx = index; },
        setRetainedCues(active, loaded, starting, preloaded) {
          const key = index => makeDubCueKey(cues[index], index, cueTargetText(cues[index]));
          activeDubCueKey = key(active);
          loadedDubCueKey = key(loaded);
          startingDubCueKey = key(starting);
          preloadedDubCueKey = key(preloaded);
        },
        hasUrl(index) {
          return dubAudioUrls.has(makeDubCueKey(cues[index], index, cueTargetText(cues[index])));
        },
        setTickerState(videoId, enabled, active, waitEnd, waitBuffer) {
          currentVideoId = videoId;
          settings.enabled = enabled;
          loopActive = active;
          waitingForDubEnd = waitEnd;
          waitingForDubBuffer = waitBuffer;
          syncLoopTickerState();
        },
        normalizeTtsSettings,
        addUrl(index, url) {
          const cue = cues[index];
          dubAudioUrls.set(makeDubCueKey(cue, index, cueTargetText(cue)), url);
        },
        cacheCue(index) {
          const cue = cues[index];
          const key = makeDubCueKey(cue, index, cueTargetText(cue));
          storeDubCueAudio({ key, cueIdx: index, videoId: currentVideoId, generation: dubCacheGeneration }, "", "audio/wav");
        },
        shouldPrefetchAiDub, shouldUseAiDub, ensureDubPrefetchForCurrentBlock,
        applyPassSettings, runTransition, generateBilingualCuesForDubbing,
        findBatchSilences, splitBatchAudio, findDubCueIndexForTime, initForCurrentVideo,
        queue() { return translationQueue; },
        desired() { return Array.from(dubDesiredCueKeys); },
        currentResult() { return currentPassResult; },
        currentPass() { return currentPassIdx; },
        activeCue() { return activeDubCueIdx; }
      };
    })();`);
  vm.runInNewContext(source, context);
  return {
    hooks: context.testHooks, video, window, sent, audios, revokedUrls,
    intervalCount() { return intervals.size; },
    tick() { for (const callback of [...intervals.values()]) callback(); },
    message(message) { return messageListener(message); },
    setPageHandler(handler) { pageHandler = handler; },
    setRuntimeHandler(handler) { runtimeHandler = handler; },
    changeTts(value) { storageListener({ ttsSettings: { newValue: value } }, "local"); },
    changeSettings(value) { storageListener({ settings: { newValue: value } }, "local"); },
    decoderRate: () => decoderRate
  };
}

const passes = [
  { audio: "source", subtitles: "target", speed: 1 },
  { audio: "target", subtitles: "target", speed: 0.75 },
  { audio: "target", subtitles: "target", speed: 1 }
];

test("prunes old and distant dub URLs while retaining adjacent blocks and playback decks", () => {
  const h = createHarness();
  const cues = Array.from({ length: 11 }, (_, i) => ({
    start: i, end: i + 1, sourceText: `source ${i}`, targetText: `target ${i}`
  }));
  h.hooks.setup({ playbacks: passes, subtitlesPerLoop: 1 }, { dubMode: "force", azureKey: "key" }, cues);
  cues.forEach((cue, i) => h.hooks.addUrl(i, `blob:${i}`));
  h.hooks.setBlock(6);
  h.hooks.setRetainedCues(0, 1, 2, 3);
  h.hooks.ensureDubPrefetchForCurrentBlock();
  assert.deepEqual(h.revokedUrls, ["blob:4", "blob:8", "blob:9", "blob:10"]);
  for (const index of [0, 1, 2, 3, 5, 6, 7]) assert.equal(h.hooks.hasUrl(index), true);
  for (const index of [4, 8, 9, 10]) assert.equal(h.hooks.hasUrl(index), false);
  assert.equal(h.hooks.desired().length, 2);
});

test("runs the ticker only for active loops or outstanding dub waits", () => {
  const h = createHarness();
  h.hooks.setTickerState("", true, true, false, false);
  assert.equal(h.intervalCount(), 0);
  h.hooks.setTickerState("video1", true, true, false, false);
  h.hooks.setTickerState("video1", true, true, false, false);
  assert.equal(h.intervalCount(), 1);
  h.hooks.setTickerState("video1", false, true, false, false);
  assert.equal(h.intervalCount(), 0);
  h.hooks.setTickerState("video1", true, false, true, false);
  assert.equal(h.intervalCount(), 1);
  h.hooks.setTickerState("video1", true, false, false, true);
  assert.equal(h.intervalCount(), 1);
  h.hooks.setTickerState("video1", true, false, false, false);
  assert.equal(h.intervalCount(), 0);
});

test("settings and navigation stop and restart the ticker", async () => {
  const h = createHarness();
  h.hooks.setup({ playbacks: passes }, { dubMode: "off" }, [
    { start: 0, end: 1, sourceText: "source", targetText: "target" }
  ]);
  h.hooks.setTickerState("video1", true, true, false, false);
  h.changeSettings({ enabled: false });
  assert.equal(h.intervalCount(), 0);
  h.changeSettings({ enabled: true });
  assert.equal(h.intervalCount(), 1);
  h.window.location.href = "https://www.youtube.com/";
  await h.hooks.initForCurrentVideo();
  assert.equal(h.intervalCount(), 0);
});

test("the ticker stops when the final block finishes", () => {
  const h = createHarness();
  h.hooks.setup({ playbacks: passes, numPlaybacks: 1 }, { dubMode: "off" }, [
    { start: 0, end: 1, sourceText: "source", targetText: "target" }
  ]);
  h.video.paused = false;
  h.video.currentTime = 1;
  h.hooks.setTickerState("video1", true, true, false, false);
  h.tick();
  assert.equal(h.intervalCount(), 0);
});

test("normalizes the legacy Gemini key without retaining the obsolete property", () => {
  const h = createHarness();
  const normalized = h.hooks.normalizeTtsSettings({ geminiKey: "legacy" });
  assert.equal(normalized.geminiApiKey, "legacy");
  assert.equal("geminiKey" in normalized, false);
});

test("clearing audio cache revokes in-memory audio and restarts prefetch", async () => {
  const h = createHarness();
  const cues = [{ start: 0, end: 2, sourceText: "source", targetText: "target" }];
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  h.hooks.addUrl(0, "blob:old");
  h.setRuntimeHandler(() => new Promise(() => {}));
  assert.equal((await h.message({ type: "YTLL_TTS_CACHE_CLEARED" })).ok, true);
  assert.deepEqual(h.revokedUrls, ["blob:old"]);
  assert.equal(h.sent.some(message => message.type === "YTLL_TTS_SYNTHESIZE_BATCH"), true);
});

test("clearing audio cache does not resume a video paused for dub buffering", async () => {
  const h = createHarness();
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, [
    { start: 0, end: 1, sourceText: "source", targetText: "target" }
  ]);
  h.hooks.setTickerState("video1", true, true, false, true);
  h.setRuntimeHandler(() => new Promise(() => {}));
  await h.message({ type: "YTLL_TTS_CACHE_CLEARED" });
  assert.equal(h.video.paused, true);
  assert.equal(h.video.playCount, 0);
});

test("clearing during audio decoding prevents stale split clips from being cached", async () => {
  let finishDecode;
  const decoded = new Promise(resolve => { finishDecode = resolve; });
  const h = createHarness(decoded);
  const cues = [
    { start: 0, end: 1, sourceText: "first", targetText: "one" },
    { start: 1, end: 2, sourceText: "second", targetText: "two" }
  ];
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  let batchCount = 0;
  h.setRuntimeHandler(message => {
    if (message.type !== "YTLL_TTS_SYNTHESIZE_BATCH") return Promise.resolve({ ok: true });
    if (batchCount++ > 0) return new Promise(() => {});
    return Promise.resolve({
      ok: true,
      batchAudioBase64: "AA==",
      batchedItems: message.items.map(item => ({ clientKey: item.key }))
    });
  });
  h.hooks.ensureDubPrefetchForCurrentBlock();
  for (let i = 0; i < 10 && !h.decoderRate(); i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(h.decoderRate(), 24000);
  await h.message({ type: "YTLL_TTS_CACHE_CLEARED" });
  const samples = new Float32Array(48000).fill(0.1);
  samples.fill(0, 12000, 38000);
  finishDecode({
    sampleRate: 24000, length: samples.length, numberOfChannels: 1,
    getChannelData() { return samples; }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sent.some(message => message.type === "YTLL_TTS_CACHE_PUT"), false);
});

test("prefetches the whole first block on the source pass without activating dub playback", () => {
  const h = createHarness();
  const cues = Array.from({ length: 5 }, (_, i) => ({
    start: i, end: i + 1, sourceText: `source ${i}`, targetText: `target ${i}`
  }));
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  h.video.currentTime = 3.5;
  h.setRuntimeHandler(() => new Promise(() => {}));
  assert.equal(h.hooks.shouldPrefetchAiDub(), true);
  assert.equal(h.hooks.shouldUseAiDub(), false);
  h.hooks.ensureDubPrefetchForCurrentBlock();
  const batch = h.sent.find(message => message.type === "YTLL_TTS_SYNTHESIZE_BATCH");
  assert.equal(batch.items.length, 5);
  assert.equal(h.hooks.desired().length, 5);
  assert.equal(h.video.muted, false);
});

test("keeps in-flight first-block audio wanted during the pass rewind", async () => {
  const h = createHarness();
  const cues = Array.from({ length: 5 }, (_, i) => ({
    start: i, end: i + 1, sourceText: `source ${i}`, targetText: `target ${i}`
  }));
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  h.video.currentTime = 3.5;
  h.setRuntimeHandler(message => message.type === "YTLL_TTS_SYNTHESIZE_BATCH"
    ? new Promise(() => {}) : Promise.resolve({ ok: true }));
  h.hooks.ensureDubPrefetchForCurrentBlock();
  const keys = Array.from(h.hooks.desired());
  const transition = h.hooks.runTransition(0, 1, null);
  assert.deepEqual(Array.from(h.hooks.desired()), keys);
  await transition;
  assert.deepEqual(Array.from(h.hooks.desired()), keys);
  assert.equal(h.sent.filter(message => message.type === "YTLL_TTS_SYNTHESIZE_BATCH").length, 1);
});

test("prefetch policy respects configured target passes, credentials, and native audio", async () => {
  const h = createHarness();
  h.hooks.setup({ playbacks: passes }, { dubMode: "auto", azureKey: "key" }, []);
  h.setPageHandler(async () => ({
    audioRes: { ok: true, unchanged: true }, subRes: { ok: true },
    caps: { audioTrackCount: 2, hasTargetAudio: true }
  }));
  await h.hooks.applyPassSettings(0);
  assert.equal(h.hooks.shouldPrefetchAiDub(), false);
  let finish;
  h.setPageHandler(() => new Promise(resolve => { finish = resolve; }));
  h.hooks.setPass(1);
  const pending = h.hooks.applyPassSettings(1);
  assert.equal(h.hooks.shouldPrefetchAiDub(), false);
  finish({ audioRes: { ok: true }, subRes: { ok: true }, caps: { audioTrackCount: 2, hasTargetAudio: true } });
  await pending;
  h.hooks.setup({ playbacks: [passes[0]], numPlaybacks: 1 }, { dubMode: "force", azureKey: "key" }, []);
  assert.equal(h.hooks.shouldPrefetchAiDub(), false);
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "" }, []);
  assert.equal(h.hooks.shouldPrefetchAiDub(), false);
});

test("does not rebuild translation queue while needed batches are in flight or queued", () => {
  const h = createHarness();
  const cues = Array.from({ length: 30 }, (_, i) => ({
    start: i, end: i + 1, sourceText: `source ${i}`, targetText: ""
  }));
  h.hooks.setup({ playbacks: passes, subtitlesPerLoop: 25 },
    { dubMode: "force", azureKey: "key", geminiApiKey: "key" }, cues);
  h.setRuntimeHandler(message => message.type === "YTLL_TRANSLATE_BATCH"
    ? new Promise(() => {}) : Promise.resolve({ ok: true }));
  h.hooks.ensureDubPrefetchForCurrentBlock();
  const queue = h.hooks.queue();
  assert.equal(queue.length, 1);
  for (let i = 0; i < 10; i++) h.hooks.ensureDubPrefetchForCurrentBlock();
  assert.equal(h.hooks.queue(), queue);
  assert.equal(h.sent.filter(message => message.type === "YTLL_TRANSLATE_BATCH").length, 1);
});

test("keeps the current pass if proactive caption generation finishes after a transition", async () => {
  const h = createHarness();
  const cues = [{ start: 0, end: 2, sourceText: "source", targetText: "" }];
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  let finish;
  h.setPageHandler((payload, action) => action === "GENERATE_BILINGUAL_SRT"
    ? new Promise(resolve => { finish = resolve; })
    : Promise.resolve({
      audioRes: { ok: false, reason: "No alternate audio tracks on this video" },
      subRes: { ok: true }, caps: { audioTrackCount: 1, hasTargetAudio: false }
    }));
  const pending = h.hooks.generateBilingualCuesForDubbing(cues);
  await new Promise(resolve => setImmediate(resolve));
  h.hooks.setPass(1);
  finish({
    ok: true,
    srt: "1\n00:00:00,000 --> 00:00:02,000\nsource\n\n" +
      "2\n00:00:00,000 --> 00:00:02,000\ntranslated\n"
  });
  await pending;
  assert.equal(h.hooks.currentPass(), 1);
});

test("reuses matching applied pass configuration, but invalidates it on settings changes", async () => {
  const h = createHarness();
  h.hooks.setup({ playbacks: passes }, {}, []);
  await h.hooks.applyPassSettings(1);
  h.hooks.setPass(1);
  await h.hooks.applyPassSettings(1);
  h.hooks.setPass(2);
  const result = await h.hooks.applyPassSettings(2);
  assert.equal(h.sent.filter(message => message.action === "APPLY_PASS").length, 2);
  assert.equal(h.video.playbackRate, 1);
  assert.equal(result.audioRes.unchanged, true);
  h.changeTts({ dubMode: "off" });
  await h.hooks.applyPassSettings(2);
  assert.equal(h.sent.filter(message => message.action === "APPLY_PASS").length, 3);
});

test("reuses the source track and custom overlay for both AI dub passes", async () => {
  const h = createHarness();
  const cues = [{ start: 2, end: 3, sourceText: "source", targetText: "target" }];
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  h.hooks.addUrl(0, "blob:first");
  h.setPageHandler(async () => ({
    audioRes: { ok: true, unchanged: true }, subRes: { ok: true },
    caps: { audioTrackCount: 2, hasTargetAudio: true }
  }));
  await h.hooks.applyPassSettings(0);
  h.video.currentTime = 2.8;
  h.video.paused = false;

  const transition = h.hooks.runTransition(0, 1, 1.97);
  assert.equal(h.video.seekWasPaused, true);
  assert.equal(h.audios[1].src, "blob:first");
  assert.equal(h.audios[1].loadCount, 1);
  assert.equal(h.audios[1].playCount, 0);
  await transition;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.pauseCount, 1);
  assert.equal(h.video.playCount, 1);
  assert.equal(h.audios[1].playCount, 1);
  assert.equal(h.audios[0].loadCount, 0);
  assert.equal(h.hooks.activeCue(), 0);
  assert.equal(h.video.muted, true);
  assert.equal(h.sent.filter(message => message.action === "APPLY_PASS").length, 1);

  h.video.currentTime = 2.8;
  await h.hooks.runTransition(0, 2, 1.97);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.video.seekWasPaused, true);
  assert.equal(h.video.playCount, 2);
  assert.equal(h.audios[0].playCount, 1);
  assert.equal(h.sent.filter(message => message.action === "APPLY_PASS").length, 1);
});

test("auto dubbing reuses source audio when no native target track exists", async () => {
  const h = createHarness();
  const cues = [{ start: 0, end: 1, sourceText: "source", targetText: "target" }];
  const differentSubtitles = [
    { ...passes[0], subtitles: "source" },
    { ...passes[1], subtitles: "target" }
  ];
  h.hooks.setup({ playbacks: differentSubtitles, numPlaybacks: 2 },
    { dubMode: "auto", azureKey: "key" }, cues);
  h.hooks.addUrl(0, "blob:first");
  h.setPageHandler(async () => ({
    audioRes: { ok: true, unchanged: true }, subRes: { ok: true },
    caps: { audioTrackCount: 2, hasTargetAudio: false }
  }));
  await h.hooks.applyPassSettings(0);
  h.hooks.setPass(1);
  await h.hooks.applyPassSettings(1);
  assert.equal(h.sent.filter(message => message.action === "APPLY_PASS").length, 1);
  assert.equal(h.hooks.shouldUseAiDub(), true);
  assert.equal(h.video.muted, true);
});

test("preloads the first cue if its audio arrives while seeking", async () => {
  const h = createHarness();
  const cues = [{ start: 2, end: 3, sourceText: "source", targetText: "target" }];
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  h.setRuntimeHandler(message => message.type === "YTLL_TTS_SYNTHESIZE_BATCH"
    ? new Promise(() => {}) : Promise.resolve({ ok: true }));
  await h.hooks.applyPassSettings(0);
  h.video.currentTime = 2.8;
  h.video.paused = false;
  const transition = h.hooks.runTransition(0, 1, 1.97);
  assert.equal(h.audios[1].loadCount, 0);
  h.hooks.cacheCue(0);
  assert.equal(h.audios[1].src, "blob:generated");
  assert.equal(h.audios[1].loadCount, 1);
  await transition;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.audios[1].playCount, 1);
});

test("starts the first cue after an asynchronously resumed video begins playing", async () => {
  const h = createHarness();
  const cues = [{ start: 2, end: 3, sourceText: "source", targetText: "target" }];
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  h.hooks.addUrl(0, "blob:first");
  await h.hooks.applyPassSettings(0);
  h.video.currentTime = 2.8;
  h.video.paused = false;
  let resume;
  h.video.play = () => new Promise(resolve => {
    resume = () => { h.video.paused = false; resolve(); };
  });
  await h.hooks.runTransition(0, 1, 1.97);
  assert.equal(h.audios[1].playCount, 0);
  resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.audios[1].playCount, 1);
});

test("does not resume a video that was already paused", async () => {
  const h = createHarness();
  const cues = [{ start: 2, end: 3, sourceText: "source", targetText: "target" }];
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  h.hooks.addUrl(0, "blob:first");
  await h.hooks.applyPassSettings(0);
  await h.hooks.runTransition(0, 1, 1.97);
  assert.equal(h.video.paused, true);
  assert.equal(h.video.playCount, 0);
  assert.equal(h.audios[1].playCount, 0);
});

test("switches the native track when AI dubbing cannot handle the target pass", async () => {
  for (const [mode, key, hasTargetAudio] of [
    ["off", "key", false], ["force", "", false], ["auto", "key", true]
  ]) {
    const h = createHarness();
    const cues = [{ start: 0, end: 1, sourceText: "source", targetText: "target" }];
    h.hooks.setup({ playbacks: passes }, { dubMode: mode, azureKey: key }, cues);
    h.setPageHandler(async () => ({
      audioRes: { ok: true, unchanged: true }, subRes: { ok: true },
      caps: { audioTrackCount: 2, hasTargetAudio }
    }));
    await h.hooks.applyPassSettings(0);
    h.hooks.setPass(1);
    await h.hooks.applyPassSettings(1);
    const requests = h.sent.filter(message => message.action === "APPLY_PASS");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].payload.audioLang, "ar");
  }
});

test("restores the target track if AI dubbing is disabled after source-track reuse", async () => {
  const h = createHarness();
  const cues = [{ start: 0, end: 1, sourceText: "source", targetText: "target" }];
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  h.hooks.addUrl(0, "blob:first");
  h.setPageHandler(async () => ({
    audioRes: { ok: true, unchanged: true }, subRes: { ok: true },
    caps: { audioTrackCount: 2, hasTargetAudio: true }
  }));
  await h.hooks.applyPassSettings(0);
  h.hooks.setPass(1);
  await h.hooks.applyPassSettings(1);
  h.changeTts({ dubMode: "force", azureKey: "key", azureVoice: "ar-SA-ZariyahNeural" });
  h.changeTts({ dubMode: "off", azureKey: "key" });
  await new Promise(resolve => setImmediate(resolve));
  const requests = h.sent.filter(message => message.action === "APPLY_PASS");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].payload.audioLang, "ar");
  assert.equal(h.video.muted, false);
});

test("does not use a source-track failure to activate auto dub while restoring native audio", async () => {
  const h = createHarness();
  const cues = [{ start: 0, end: 1, sourceText: "source", targetText: "target" }];
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, cues);
  h.hooks.addUrl(0, "blob:first");
  h.setPageHandler(async () => ({
    audioRes: { ok: false, reason: 'No audio track found for "en"' },
    subRes: { ok: true }, caps: { audioTrackCount: 2, hasTargetAudio: true }
  }));
  await h.hooks.applyPassSettings(0);
  h.hooks.setPass(1);
  await h.hooks.applyPassSettings(1);
  let finish;
  h.setPageHandler(() => new Promise(resolve => { finish = resolve; }));
  h.changeTts({ dubMode: "auto", azureKey: "key" });
  assert.equal(h.hooks.shouldUseAiDub(), false);
  assert.equal(h.video.muted, false);
  finish({
    audioRes: { ok: true }, subRes: { ok: true },
    caps: { audioTrackCount: 2, hasTargetAudio: true }
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.hooks.shouldUseAiDub(), false);
});

test("recognizes the first cue up to 120ms before its start", () => {
  const h = createHarness();
  h.hooks.setup({ playbacks: passes }, {}, [
    { start: 2, end: 3, sourceText: "source", targetText: "target" }
  ]);
  assert.equal(h.hooks.findDubCueIndexForTime(1.879), -1);
  assert.equal(h.hooks.findDubCueIndexForTime(1.881), 0);
  assert.equal(h.hooks.findDubCueIndexForTime(3), -1);
});

test("ignores an in-flight pass result after settings disable the extension", async () => {
  const h = createHarness();
  h.hooks.setup({ playbacks: passes }, { dubMode: "force", azureKey: "key" }, []);
  h.hooks.setPass(1);
  let finish;
  h.setPageHandler(() => new Promise(resolve => { finish = resolve; }));
  const pending = h.hooks.applyPassSettings(1);
  h.changeSettings({ enabled: false, playbacks: passes });
  finish({
    audioRes: { ok: false, reason: "No alternate audio tracks on this video" },
    subRes: { ok: true },
    caps: { audioTrackCount: 1, hasTargetAudio: false }
  });
  await pending;
  assert.equal(h.hooks.currentResult(), null);
  assert.equal(h.video.muted, false);
});

function audioBuffer(parts) {
  const rate = 24000;
  const length = parts.reduce((sum, [seconds]) => sum + Math.round(seconds * rate), 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const [seconds, amplitude] of parts) {
    const end = offset + Math.round(seconds * rate);
    samples.fill(amplitude, offset, end);
    offset = end;
  }
  return { sampleRate: rate, numberOfChannels: 1, length, getChannelData: () => samples };
}

test("detects silence runs at the 0.55-second and 0.005 amplitude thresholds", () => {
  const h = createHarness();
  const minFrames = Math.ceil(24000 * 0.55);
  const audio = audioBuffer([
    [minFrames / 24000, 0.004], [0.01, 0.006], [0.549, 0],
    [0.01, 0.006], [minFrames / 24000, 0]
  ]);
  const runs = h.hooks.findBatchSilences(audio);
  assert.deepEqual(JSON.parse(JSON.stringify(runs)), [
    { start: 0, end: minFrames },
    { start: minFrames + 240 + 13176 + 240, end: audio.length }
  ]);
});

test("splits at silence edges and trims leading and trailing silence with 20ms pads", async () => {
  const audio = audioBuffer([[0.2, 0], [0.3, 0.5], [1.1, 0], [0.35, 0.5], [0.15, 0]]);
  const h = createHarness(audio);
  const chunks = await h.hooks.splitBatchAudio("", 2);
  assert.equal(h.decoderRate(), 24000);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].byteLength, 44 + 2 * Math.round(24000 * 0.34));
  assert.equal(chunks[1].byteLength, 44 + 2 * Math.round(24000 * 0.39));
  assert.equal(new DataView(chunks[0]).getUint32(24, true), 24000);
});

test("chooses longest separators when natural pauses occur, but rejects ambiguous short runs", async () => {
  const audio = audioBuffer([[0.3, 0.5], [0.6, 0], [0.2, 0.5], [1.1, 0], [0.3, 0.5]]);
  const h = createHarness(audio);
  const chunks = await h.hooks.splitBatchAudio("", 2);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].byteLength, 44 + 2 * Math.round(24000 * 1.12));
  const ambiguous = createHarness(audioBuffer([[0.3, 0.5], [0.6, 0], [0.2, 0.5], [0.6, 0], [0.3, 0.5]]));
  assert.equal(await ambiguous.hooks.splitBatchAudio("", 2), null);
});
