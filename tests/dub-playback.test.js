const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createHarness(cues, blockSize = 5, speed = 1, manualPreloadTimer = false) {
  const audios = [];
  const timers = new Map();
  let nextTimer = 0;
  let urlCount = 0;
  class MockAudio {
    constructor() {
      this.listeners = new Map();
      this.paused = true;
      this.ended = false;
      this.readyState = 0;
      this.duration = 1;
      this.currentTime = 0;
      this.currentSrc = "";
      this.src = "";
      this.autoLoad = true;
      this.loadCount = 0;
      this.playCount = 0;
      audios.push(this);
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(handler);
    }
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
    emit(type) {
      for (const handler of Array.from(this.listeners.get(type) || [])) {
        handler({ currentTarget: this });
      }
    }
    load() {
      this.loadCount++;
      this.readyState = 0;
      if (this.autoLoad) this.resolveLoad();
    }
    resolveLoad() {
      this.currentSrc = this.src;
      this.readyState = 1;
      this.emit("loadedmetadata");
    }
    play() {
      this.playCount++;
      this.paused = false;
      this.ended = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    finish() { this.paused = true; this.ended = true; this.emit("ended"); }
  }
  const video = {
    currentTime: 0.1, paused: false, seeking: false, muted: false, volume: 1,
    playCount: 0,
    play() { this.playCount++; this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }
  };
  class MockURL extends URL {
    static createObjectURL() { return `blob:cached-${++urlCount}`; }
    static revokeObjectURL() {}
  }
  const context = {
    Audio: MockAudio, URL: MockURL, Blob, console, structuredClone,
    atob: text => Buffer.from(text, "base64").toString("binary"),
    window: {
      location: { href: "https://www.youtube.com/watch?v=video1" },
      addEventListener() {}
    },
    document: {
      readyState: "loading",
      head: { appendChild() {} },
      createElement() { return {}; },
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return video; }
    },
    browser: {
      runtime: { getURL: value => value, onMessage: { addListener() {} }, async sendMessage() { return { ok: true }; } },
      storage: { onChanged: { addListener() {} } }
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      if (delay === 80 && !manualPreloadTimer) {
        queueMicrotask(() => {
          if (timers.delete(id)) callback();
        });
      }
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval() {}, clearInterval() {}
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8")
    .replace(/\}\)\(\);\s*$/, `
      globalThis.testHooks = {
        setup(newCues, size, speed) {
          currentVideoId = "video1";
          settings.enabled = true;
          settings.playbacks = [{ audio: "target", subtitles: "target", speed }];
          settings.numPlaybacks = 1;
          ttsSettings.dubMode = "force";
          ttsSettings.azureKey = "key";
          cues = newCues;
          blocks = buildBlocks(cues, size);
          currentBlockIdx = 0;
          currentPassIdx = 0;
          currentPassResult = { audioRes: { ok: false }, caps: { audioTrackCount: 1 } };
        },
        addUrl(index, url) {
          const cue = cues[index];
          dubAudioUrls.set(makeDubCueKey(cue, index, cueTargetText(cue)), url);
        },
        cacheCue(index) {
          const cue = cues[index];
          const key = makeDubCueKey(cue, index, cueTargetText(cue));
          dubDesiredCueKeys.add(key);
          storeDubCueAudio({ key, cueIdx: index, videoId: currentVideoId, generation: dubCacheGeneration }, "", "audio/wav");
        },
        syncDubPlayback, stopDubPlayback, preloadNextDubCue,
        waitForDubEnd() { waitingForDubEnd = true; },
        activeAudio() { return dubAudio; },
        activeIndex() { return activeDubCueIdx; },
        preloadKey() { return preloadedDubCueKey; },
        preloadResult() { return preloadPromise; }
      };
    })();`);
  vm.runInNewContext(source, context);
  context.testHooks.setup(cues, blockSize, speed);
  return {
    hooks: context.testHooks, audios, video,
    timerDelays() { return Array.from(timers.values(), timer => timer.delay); },
    fireTimers(delay) {
      for (const [id, timer] of timers) {
        if (timer.delay === delay) {
          timers.delete(id);
          timer.callback();
        }
      }
    }
  };
}

const cues = [
  { start: 0, end: 1, sourceText: "one", targetText: "one" },
  { start: 1, end: 2, sourceText: "two", targetText: "two" },
  { start: 2, end: 3, sourceText: "three", targetText: "three" }
];
const flush = () => new Promise(resolve => setImmediate(resolve));

test("preload waits for canplay and cleans up its grace timer and listeners", async () => {
  const h = createHarness(cues, 5, 1, true);
  h.hooks.addUrl(1, "blob:1");
  h.hooks.preloadNextDubCue(0);
  let settled = false;
  const ready = h.hooks.preloadResult().then(value => { settled = true; return value; });
  await flush();
  assert.equal(settled, false);
  assert.equal(h.timerDelays().includes(80), true);
  h.audios[1].readyState = 3;
  h.audios[1].emit("canplay");
  assert.equal(await ready, true);
  assert.equal(h.timerDelays().includes(80), false);
  assert.equal(h.audios[1].listeners.get("canplay").size, 0);
});

test("preload falls back to metadata after 80ms without canplay", async () => {
  const h = createHarness(cues, 5, 1, true);
  h.hooks.addUrl(1, "blob:1");
  h.hooks.preloadNextDubCue(0);
  const ready = h.hooks.preloadResult();
  h.fireTimers(80);
  assert.equal(await ready, true);
  assert.equal(h.timerDelays().includes(8000), false);
});

test("using a metadata-ready deck cancels its pending preload grace period", async () => {
  const h = createHarness(cues, 5, 1, true);
  h.hooks.addUrl(0, "blob:0");
  h.hooks.addUrl(1, "blob:1");
  h.hooks.syncDubPlayback(h.video);
  await flush();
  assert.equal(h.timerDelays().includes(80), true);
  h.video.currentTime = 0.95;
  h.audios[0].finish();
  await flush();
  assert.equal(h.audios[1].playCount, 1);
  assert.equal(h.timerDelays().includes(80), false);
  assert.equal(h.audios[1].listeners.get("canplay").size, 0);
});

test("preloads and alternates decks without reloading or restarting an early cue", async () => {
  const h = createHarness(cues);
  cues.forEach((cue, i) => h.hooks.addUrl(i, `blob:${i}`));
  h.hooks.syncDubPlayback(h.video);
  await flush();
  assert.equal(h.audios[0].playCount, 1);
  assert.equal(h.audios[1].src, "blob:1");
  assert.equal(h.audios[1].loadCount, 1);

  h.video.currentTime = 0.95;
  h.audios[0].finish();
  await flush();
  assert.equal(h.hooks.activeAudio(), h.audios[1]);
  assert.equal(h.audios[1].playCount, 1);
  assert.equal(h.audios[1].loadCount, 1);
  assert.equal(h.audios[0].src, "blob:2");
  h.audios[0].emit("ended");
  assert.equal(h.hooks.activeIndex(), 1);
  h.hooks.syncDubPlayback(h.video);
  assert.equal(h.hooks.activeIndex(), 1);
  assert.equal(h.audios[1].playCount, 1);

  h.video.currentTime = 1.95;
  h.audios[1].finish();
  await flush();
  assert.equal(h.hooks.activeAudio(), h.audios[0]);
  assert.equal(h.audios[0].playCount, 2);
  assert.equal(h.hooks.activeIndex(), 2);
});

test("preloads an upcoming cue as soon as its audio is cached", async () => {
  const h = createHarness(cues);
  h.hooks.addUrl(0, "blob:0");
  h.hooks.syncDubPlayback(h.video);
  await flush();
  assert.equal(h.audios[1].loadCount, 0);
  h.hooks.cacheCue(2);
  assert.equal(h.audios[1].src, "blob:cached-1");
  assert.equal(h.audios[1].loadCount, 1);
  h.hooks.cacheCue(1);
  assert.equal(h.audios[1].src, "blob:cached-2");
  assert.equal(h.audios[1].loadCount, 2);
});

test("reuses an in-progress preload once metadata is ready", async () => {
  const h = createHarness(cues);
  h.hooks.addUrl(0, "blob:0");
  h.hooks.addUrl(1, "blob:1");
  h.audios[1].autoLoad = false;
  h.hooks.syncDubPlayback(h.video);
  await flush();
  h.video.currentTime = 0.95;
  h.audios[0].finish();
  assert.equal(h.audios[1].playCount, 0);
  h.audios[1].resolveLoad();
  await flush();
  assert.equal(h.audios[1].playCount, 1);
  assert.equal(h.audios[1].loadCount, 1);
});

test("resumes the video after buffering an in-progress preload", async () => {
  const h = createHarness(cues);
  h.hooks.addUrl(0, "blob:0");
  h.hooks.addUrl(1, "blob:1");
  h.audios[1].autoLoad = false;
  h.hooks.syncDubPlayback(h.video);
  await flush();
  h.video.currentTime = 0.95;
  h.audios[0].finish();
  h.hooks.syncDubPlayback(h.video);
  assert.equal(h.video.paused, true);
  h.audios[1].resolveLoad();
  await flush();
  assert.equal(h.audios[1].playCount, 1);
  assert.equal(h.video.paused, false);
});

test("cancels a pending preload when playback stops", async () => {
  const h = createHarness(cues);
  h.hooks.addUrl(0, "blob:0");
  h.hooks.addUrl(1, "blob:1");
  h.audios[1].autoLoad = false;
  h.hooks.syncDubPlayback(h.video);
  await flush();
  h.video.currentTime = 0.95;
  h.audios[0].finish();
  h.hooks.stopDubPlayback();
  h.audios[1].resolveLoad();
  await flush();
  assert.equal(h.audios[1].playCount, 0);
  assert.equal(h.audios[0].paused, true);
  assert.equal(h.audios[1].paused, true);
  assert.equal(h.hooks.preloadKey(), "");
});

test("cancels a pending active-deck load before starting a different cue", async () => {
  const h = createHarness(cues);
  h.hooks.addUrl(0, "blob:0");
  h.hooks.addUrl(1, "blob:1");
  h.audios[0].autoLoad = false;
  h.hooks.syncDubPlayback(h.video);
  assert.equal(h.audios[0].listeners.get("loadedmetadata").size, 1);
  h.hooks.stopDubPlayback();
  assert.equal(h.audios[0].listeners.get("loadedmetadata").size, 0);
  h.video.currentTime = 1.1;
  h.hooks.syncDubPlayback(h.video);
  h.audios[0].resolveLoad();
  await flush();
  assert.equal(h.audios[0].src, "blob:1");
  assert.equal(h.audios[0].playCount, 1);
  assert.equal(h.hooks.activeIndex(), 1);
});

test("starts the next nearby cue immediately after resuming from a dub wait", async () => {
  const h = createHarness(cues);
  h.hooks.addUrl(0, "blob:0");
  h.hooks.addUrl(1, "blob:1");
  h.hooks.syncDubPlayback(h.video);
  await flush();
  h.video.currentTime = 0.95;
  h.video.paused = true;
  h.hooks.waitForDubEnd();
  h.audios[0].finish();
  await flush();
  assert.equal(h.video.playCount, 1);
  assert.equal(h.audios[1].playCount, 1);
});

test("does not start a cue early across a loop block or a large gap", async () => {
  const block = createHarness(cues, 1);
  block.hooks.addUrl(0, "blob:0");
  block.hooks.addUrl(1, "blob:1");
  block.hooks.syncDubPlayback(block.video);
  await flush();
  block.video.currentTime = 0.95;
  block.audios[0].finish();
  await flush();
  assert.equal(block.audios[1].playCount, 0);

  const spaced = createHarness([cues[0], { ...cues[1], start: 1.3, end: 2.3 }]);
  spaced.hooks.addUrl(0, "blob:0");
  spaced.hooks.addUrl(1, "blob:1");
  spaced.hooks.syncDubPlayback(spaced.video);
  await flush();
  spaced.video.currentTime = 1.25;
  spaced.audios[0].finish();
  await flush();
  assert.equal(spaced.audios[1].playCount, 0);
});

test("starts at most 80ms early when the cue gap is 250ms", async () => {
  const h = createHarness([cues[0], { ...cues[1], start: 1.25, end: 2.25 }]);
  h.hooks.addUrl(0, "blob:0");
  h.hooks.addUrl(1, "blob:1");
  h.hooks.syncDubPlayback(h.video);
  await flush();
  h.video.currentTime = 1.169;
  h.audios[0].finish();
  await flush();
  assert.equal(h.audios[1].playCount, 0);
  h.video.currentTime = 1.171;
  h.hooks.syncDubPlayback(h.video);
  await flush();
  assert.equal(h.audios[1].playCount, 1);
});

test("speeds up a late dub using the remaining cue time", async () => {
  const h = createHarness([{ start: 0, end: 2, sourceText: "one", targetText: "one" }], 5, 0.75);
  h.hooks.addUrl(0, "blob:0");
  h.audios[0].duration = 2;
  h.video.currentTime = 1;
  h.hooks.syncDubPlayback(h.video);
  await flush();
  assert.equal(h.audios[0].playbackRate, 0.75 * 1.45);
});

test("speeds up a dub to finish by the cue end when the next cue is close", async () => {
  const h = createHarness([cues[0], { ...cues[1], start: 1.4, end: 2.4 }]);
  h.hooks.addUrl(0, "blob:0");
  h.audios[0].duration = 1.2;
  h.video.currentTime = 0;
  h.hooks.syncDubPlayback(h.video);
  await flush();
  assert.equal(h.audios[0].playbackRate, 1.2);
});
