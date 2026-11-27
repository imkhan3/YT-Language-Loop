const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadCache(indexedDB) {
  const context = { indexedDB, console };
  const source = fs.readFileSync(path.join(__dirname, "..", "tts-cache.js"), "utf8")
    .replace(/\}\)\(\);\s*$/, "globalThis.testEvict = evictOldestIfNeeded; })();");
  vm.runInNewContext(source, context);
  return context;
}

function cursorStore(records) {
  const removed = [];
  let visits = 0;
  return {
    removed,
    get visits() { return visits; },
    count() {
      const request = {};
      queueMicrotask(() => { request.result = records.length; request.onsuccess(); });
      return request;
    },
    index() {
      return { openCursor() {
        const request = {};
        let index = 0;
        const advance = () => queueMicrotask(() => {
          visits++;
          const record = records[index];
          request.result = record ? {
            key: record.lastAccessedAt,
            value: record,
            delete() { removed.push(record.key); },
            continue() { index++; advance(); }
          } : null;
          request.onsuccess();
        });
        advance();
        return request;
      } };
    }
  };
}

test("eviction stops at the first protected entry rather than scanning the index", async () => {
  const cache = loadCache({});
  const now = Date.now();
  const store = cursorStore(Array.from({ length: 5 }, (_, i) => ({
    key: String(i), lastAccessedAt: now + i
  })));
  await cache.testEvict(store, 4);
  assert.equal(store.visits, 1);
  assert.deepEqual(store.removed, []);
});

test("byte limit evicts oldest audio even when entries were recently accessed", async () => {
  const cache = loadCache({});
  const mib = 1024 * 1024;
  const now = Date.now();
  const store = cursorStore(["old", "new"].map((key, index) => ({
    key, lastAccessedAt: now + index, arrayBuffer: { byteLength: 80 * mib }
  })));
  const bytes = await cache.testEvict(store, 4000, 160 * mib, 150 * mib);
  assert.deepEqual(store.removed, ["old"]);
  assert.equal(bytes, 80 * mib);
});

test("connection failures are retried, connections are reused, and fresh reads stay readonly", async () => {
  let opens = 0;
  let connection;
  const modes = [];
  const record = { key: "key", translatedText: "value", lastAccessedAt: Date.now() };
  const indexedDB = {
    open() {
      const request = {};
      opens++;
      setImmediate(() => {
        if (opens === 1) {
          request.error = new Error("Open failed");
          request.onerror();
          return;
        }
        connection = {
          close() {},
          transaction(storeName, mode) {
            modes.push(mode);
            const transaction = {
              objectStore() {
                return {
                  get(key) {
                    const getRequest = {};
                    setImmediate(() => {
                      getRequest.result = key === record.key ? { ...record } : undefined;
                      getRequest.onsuccess();
                      setImmediate(() => transaction.oncomplete());
                    });
                    return getRequest;
                  }
                };
              }
            };
            return transaction;
          }
        };
        request.result = connection;
        request.onsuccess();
      });
      return request;
    }
  };
  const cache = loadCache(indexedDB);
  await assert.rejects(cache.YTLLTranslationCache.get("key"), /Open failed/);
  assert.equal((await cache.YTLLTranslationCache.get("key")).translatedText, "value");
  assert.equal((await cache.YTLLTranslationCache.get("key")).translatedText, "value");
  assert.equal(opens, 2);
  assert.deepEqual(modes, ["readonly", "readonly"]);
  connection.onversionchange();
  await cache.YTLLTranslationCache.get("key");
  assert.equal(opens, 3);
  connection.onclose();
  await cache.YTLLTranslationCache.get("key");
  assert.equal(opens, 4);
});
