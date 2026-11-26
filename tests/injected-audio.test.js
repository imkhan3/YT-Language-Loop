const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function createHarness(player) {
  let retries = 0;
  const window = {
    location: { href: "https://www.youtube.com/watch?v=video1", origin: "https://www.youtube.com" },
    fetch() {},
    addEventListener() {},
    postMessage() {}
  };
  class XMLHttpRequest {}
  XMLHttpRequest.prototype.open = function () {};
  XMLHttpRequest.prototype.send = function () {};
  const context = {
    window, XMLHttpRequest, URL, console,
    document: { getElementById() { return player; } },
    setTimeout(callback) { retries++; callback(); }
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "injected.js"), "utf8")
    .replace(/\}\)\(\);\s*$/, "globalThis.setAudioLanguage = setAudioLanguage; })();");
  vm.runInNewContext(source, context);
  return { setAudioLanguage: context.setAudioLanguage, retries: () => retries };
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
