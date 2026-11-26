const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createHarness(decodedAudio = null) {
  const sent = [];
  let pageListener;
  let storageListener;
  let pageHandler = async () => ({
    audioRes: { ok: false, reason: "No alternate audio tracks on this video" },
    subRes: { ok: true },
    caps: { audioTrackCount: 1, hasTargetAudio: false }
  });
  let runtimeHandler = async () => ({ ok: true });
  let decoderRate;
  const video = {
    currentTime: 0, paused: true, muted: false, playbackRate: 1,
    addEventListener() {}, removeEventListener() {}
  };
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
      onMessage: { addListener() {} },
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
  const context = {
    window, browser, URL, console, structuredClone,
    document: {
      readyState: "loading",
      head: { appendChild() {} },
      createElement() { return {}; },
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return video; }
    },
    Audio: class { pause() {} addEventListener() {} },
    atob: text => Buffer.from(text, "base64").toString("binary"),
    btoa: text => Buffer.from(text, "binary").toString("base64"),
    Blob,
    setTimeout() { return 1; }, clearTimeout() {}, setInterval() {}
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
        shouldPrefetchAiDub, shouldUseAiDub, ensureDubPrefetchForCurrentBlock,
        applyPassSettings, runTransition, generateBilingualCuesForDubbing,
        findBatchSilences, splitBatchAudio,
        queue() { return translationQueue; },
        desired() { return Array.from(dubDesiredCueKeys); },
        currentResult() { return currentPassResult; },
        currentPass() { return currentPassIdx; }
      };
    })();`);
  vm.runInNewContext(source, context);
  return {
    hooks: context.testHooks, video, sent,
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
