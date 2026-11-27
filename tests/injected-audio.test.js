const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createHarness(player, fetch = async () => ({ ok: true, text: async () => "{}" })) {
  let retries = 0;
  const messages = [];
  const window = {
    location: {
      href: "https://www.youtube.com/watch?v=video1",
      origin: "https://www.youtube.com",
      host: "www.youtube.com"
    },
    fetch,
    addEventListener() {},
    postMessage(message) { messages.push(message); }
  };
  class XMLHttpRequest {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};
  const context = {
    window, XMLHttpRequest, URL, console,
    location: window.location,
    fetch(...args) { return window.fetch(...args); },
    document: { getElementById() { return player; }, querySelector() { return player; } },
    setTimeout(callback) { retries++; callback(); }
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "injected.js"), "utf8")
    .replace(/\}\)\(\);\s*$/, `
      globalThis.testHooks = {
        setAudioLanguage, handleCapturedTimedtext, timedtextCache,
        fetchSubtitlesForLang, generateBilingualSrt
      };
    })();`);
  vm.runInNewContext(source, context);
  return { ...context.testHooks, window, messages, retries: () => retries };
}

test("does not retry when available tracks do not include the requested language", async () => {
  let calls = 0;
  const h = createHarness({
    getAvailableAudioTracks() {
      calls++;
      return [{ id: "en" }, { id: "fr" }];
    }
  });
  const result = await h.setAudioLanguage("ar");
  assert.equal(result.reason, 'No audio track found for "ar"');
  assert.equal(calls, 1);
  assert.equal(h.retries(), 0);
});

test("retries when audio tracks are not available yet", async () => {
  let calls = 0;
  const track = { id: "ar" };
  const h = createHarness({
    getAvailableAudioTracks() {
      calls++;
      return calls < 3 ? [] : [{ id: "en" }, track];
    },
    getAudioTrack() { return track; }
  });
  const result = await h.setAudioLanguage("ar");
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
  assert.equal(h.retries(), 2);
});

test("caps captured and directly fetched timedtext without evicting on replacement", async () => {
  const player = {
    getPlayerResponse() {
      return { captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { languageCode: "ar", baseUrl: "https://www.youtube.com/api/timedtext?lang=ar" }
      ] } } };
    }
  };
  const h = createHarness(player);
  for (let i = 0; i < 12; i++) {
    h.handleCapturedTimedtext(`https://www.youtube.com/api/timedtext?v=old${i}&lang=en`, "captions");
  }
  h.handleCapturedTimedtext("https://www.youtube.com/api/timedtext?v=old0&lang=en", "updated");
  assert.equal(h.timedtextCache.size, 12);
  assert.equal(h.timedtextCache.has("old1:en"), true);
  h.window.location.href = "https://www.youtube.com/watch?v=video13";
  assert.equal((await h.fetchSubtitlesForLang("ar")).ok, true);
  assert.equal(h.timedtextCache.size, 12);
  assert.equal(h.timedtextCache.has("old0:en"), false);
  assert.equal(h.timedtextCache.has("video13:ar"), true);
});

test("bilingual generation uses the original fetch without recapturing timedtext", async () => {
  const player = {
    getPlayerResponse() {
      return { captions: { playerCaptionsTracklistRenderer: { captionTracks: [
        { languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext?lang=en" },
        { languageCode: "ar", baseUrl: "https://www.youtube.com/api/timedtext?lang=ar" }
      ] } } };
    }
  };
  let fetchCount = 0;
  const text = JSON.stringify({ events: [
    { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: "test" }] }
  ] });
  const fetch = async () => {
    fetchCount++;
    return { ok: true, text: async () => text, clone() { return this; } };
  };
  const h = createHarness(player, fetch);
  const srt = await h.generateBilingualSrt("en", "ar");
  assert.match(srt, /test/);
  assert.equal(fetchCount, 2);
  assert.equal(h.messages.length, 0);
  assert.equal(h.timedtextCache.size, 0);
});
