(function () {
  const DB_NAME = "ytll_tts_cache";
  const STORE_NAME = "audio";
  const TRANSLATION_STORE_NAME = "translations";
  const VIDEO_STORE_NAME = "videos";
  const META_STORE_NAME = "metadata";
  const AUDIO_BYTES_KEY = "audioBytes";
  const MAX_ENTRIES = 4000;
  const MAX_AUDIO_BYTES = 150 * 1024 * 1024;
  const MAX_VIDEOS = 100;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const VIDEO_TTL_MS = 7 * ONE_DAY_MS;
  const ACCESS_UPDATE_MS = 60 * 1000;
  const DB_VERSION = 4;
  let dbPromise = null;

  function audioSize(record) {
    return record?.arrayBuffer?.byteLength || 0;
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    const opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
          store.createIndex("lastAccessedAt", "lastAccessedAt");
        }
        if (!db.objectStoreNames.contains(TRANSLATION_STORE_NAME)) {
          const store = db.createObjectStore(TRANSLATION_STORE_NAME, { keyPath: "key" });
          store.createIndex("lastAccessedAt", "lastAccessedAt");
        }
        if (!db.objectStoreNames.contains(VIDEO_STORE_NAME)) {
          const store = db.createObjectStore(VIDEO_STORE_NAME, { keyPath: "key" });
          store.createIndex("lastAccessedAt", "lastAccessedAt");
          store.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains(META_STORE_NAME)) {
          const metadata = db.createObjectStore(META_STORE_NAME, { keyPath: "key" });
          const audioStore = request.transaction.objectStore(STORE_NAME);
          const cursorRequest = audioStore.openCursor();
          let totalBytes = 0;
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              evictOldestIfNeeded(audioStore, MAX_ENTRIES, totalBytes, MAX_AUDIO_BYTES)
                .then(remaining => metadata.put({ key: AUDIO_BYTES_KEY, value: remaining }))
                .catch(error => {
                  console.error("[YT Lang Loop] Could not migrate audio cache:", error);
                  request.transaction.abort();
                });
              return;
            }
            const record = cursor.value;
            totalBytes += audioSize(record);
            if (!Number.isFinite(record.lastAccessedAt)) {
              record.lastAccessedAt = record.updatedAt || record.createdAt || 0;
              cursor.update(record);
            }
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onclose = () => {
          if (dbPromise === cached) dbPromise = null;
        };
        database.onversionchange = () => {
          if (dbPromise === cached) dbPromise = null;
          database.close();
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error || new Error("Could not open TTS audio cache"));
    });
    const cached = opening.catch(error => {
      if (dbPromise === cached) dbPromise = null;
      throw error;
    });
    dbPromise = cached;
    return cached;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("TTS audio cache request failed"));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("TTS audio cache transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("TTS audio cache transaction was aborted"));
    });
  }

  async function withTransaction(storeNames, mode, action) {
    const database = await openDatabase();
    const transaction = database.transaction(storeNames, mode);
    const done = transactionDone(transaction);
    try {
      const result = await action(transaction);
      await done;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch (abortError) {
        if (abortError.name !== "InvalidStateError") {
          console.error("[YT Lang Loop] Could not abort cache transaction:", abortError);
        }
      }
      await done.catch(() => {});
      throw error;
    }
  }

  async function evictOldestIfNeeded(store, maxEntries, totalBytes = 0, maxBytes = Infinity) {
    const count = await requestResult(store.count());
    const excess = count - maxEntries;
    if (excess <= 0 && totalBytes <= maxBytes) return totalBytes;

    const cutoff = Date.now() - ONE_DAY_MS;
    const hardCap = Math.floor(maxEntries * 1.5);
    const cursorRequest = store.index("lastAccessedAt").openCursor();
    let removed = 0;

    await new Promise((resolve, reject) => {
      cursorRequest.onerror = () => reject(cursorRequest.error || new Error("Could not evict cache entries"));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || (removed >= excess && totalBytes <= maxBytes)) {
          resolve();
          return;
        }
        const record = cursor.value;
        const lastTouched = cursor.key;
        if (lastTouched >= cutoff && count - removed <= hardCap && totalBytes <= maxBytes) {
          resolve();
          return;
        }
        cursor.delete();
        removed += 1;
        totalBytes -= audioSize(record);
        cursor.continue();
      };
    });
    return totalBytes;
  }

  async function getRecords(storeName, keys) {
    if (!keys.length) return [];
    const records = await withTransaction(storeName, "readonly", transaction => {
      const store = transaction.objectStore(storeName);
      return Promise.all(keys.map(key => requestResult(store.get(key))));
    });
    const now = Date.now();
    const staleKeys = [...new Set(keys.filter((key, index) =>
      records[index] && now - (records[index].lastAccessedAt || 0) > ACCESS_UPDATE_MS
    ))];
    if (staleKeys.length) {
      await withTransaction(storeName, "readwrite", async transaction => {
        const store = transaction.objectStore(storeName);
        const current = await Promise.all(staleKeys.map(key => requestResult(store.get(key))));
        for (const record of current) {
          if (record && now - (record.lastAccessedAt || 0) > ACCESS_UPDATE_MS) {
            record.lastAccessedAt = now;
            store.put(record);
          }
        }
      });
    }
    return records.map(record => record || null);
  }

  async function getBatch(keys) {
    return getRecords(STORE_NAME, keys);
  }

  async function get(key) {
    return (await getBatch([key]))[0];
  }

  async function putBatch(records) {
    if (!records.length) return;
    const uniqueRecords = [...new Map(records.map(record => [record.key, record])).values()];
    await withTransaction([STORE_NAME, META_STORE_NAME], "readwrite", async transaction => {
      const store = transaction.objectStore(STORE_NAME);
      const metadata = transaction.objectStore(META_STORE_NAME);
      const [sizeRecord, ...existing] = await Promise.all([
        requestResult(metadata.get(AUDIO_BYTES_KEY)),
        ...uniqueRecords.map(record => requestResult(store.get(record.key)))
      ]);
      if (!sizeRecord || !Number.isFinite(sizeRecord.value)) {
        throw new Error("Audio cache size metadata is missing or invalid.");
      }
      let totalBytes = sizeRecord.value;
      const now = Date.now();
      uniqueRecords.forEach((record, index) => {
        totalBytes += audioSize(record) - audioSize(existing[index]);
        store.put({
          key: record.key,
          arrayBuffer: record.arrayBuffer,
          mimeType: record.mimeType || "audio/mpeg",
          createdAt: record.createdAt || now,
          lastAccessedAt: now
        });
      });
      totalBytes = await evictOldestIfNeeded(store, MAX_ENTRIES, totalBytes, MAX_AUDIO_BYTES);
      metadata.put({ key: AUDIO_BYTES_KEY, value: totalBytes });
    });
  }

  async function put(record) {
    await putBatch([record]);
  }

  async function clear() {
    await withTransaction([STORE_NAME, META_STORE_NAME], "readwrite", transaction => {
      transaction.objectStore(STORE_NAME).clear();
      transaction.objectStore(META_STORE_NAME).put({ key: AUDIO_BYTES_KEY, value: 0 });
    });
  }

  async function getTranslationBatch(keys) {
    return getRecords(TRANSLATION_STORE_NAME, keys);
  }

  async function getTranslation(key) {
    return (await getTranslationBatch([key]))[0];
  }

  async function putTranslationBatch(records) {
    if (!records.length) return;
    await withTransaction(TRANSLATION_STORE_NAME, "readwrite", async transaction => {
      const store = transaction.objectStore(TRANSLATION_STORE_NAME);
      const now = Date.now();
      for (const record of records) {
        store.put({
          key: record.key,
          translatedText: record.translatedText,
          createdAt: record.createdAt || now,
          lastAccessedAt: now
        });
      }
      await evictOldestIfNeeded(store, MAX_ENTRIES);
    });
  }

  async function putTranslation(record) {
    await putTranslationBatch([record]);
  }

  async function clearTranslations() {
    await withTransaction(TRANSLATION_STORE_NAME, "readwrite", transaction => {
      transaction.objectStore(TRANSLATION_STORE_NAME).clear();
    });
  }

  async function getVideo(key) {
    const record = await withTransaction(VIDEO_STORE_NAME, "readonly", transaction =>
      requestResult(transaction.objectStore(VIDEO_STORE_NAME).get(key))
    );
    if (!record) return null;
    const now = Date.now();
    const expired = value => now - (value.updatedAt || value.createdAt || 0) > VIDEO_TTL_MS;
    if (!expired(record) && now - (record.lastAccessedAt || 0) <= ACCESS_UPDATE_MS) return record;
    return withTransaction(VIDEO_STORE_NAME, "readwrite", async transaction => {
      const store = transaction.objectStore(VIDEO_STORE_NAME);
      const current = await requestResult(store.get(key));
      if (!current) return null;
      if (expired(current)) {
        store.delete(key);
        return null;
      }
      if (now - (current.lastAccessedAt || 0) > ACCESS_UPDATE_MS) {
        current.lastAccessedAt = now;
        store.put(current);
      }
      return current;
    });
  }

  async function putVideo(record) {
    return withTransaction(VIDEO_STORE_NAME, "readwrite", async transaction => {
      const store = transaction.objectStore(VIDEO_STORE_NAME);
      const existing = await requestResult(store.get(record.key));
      const now = Date.now();
      store.put({
        key: record.key,
        videoId: record.videoId,
        sourceLang: record.sourceLang,
        targetLang: record.targetLang,
        cues: Array.isArray(record.cues) ? record.cues : [],
        metadata: record.metadata || { title: "", channel: "" },
        createdAt: existing?.createdAt || record.createdAt || now,
        updatedAt: now,
        lastAccessedAt: now
      });
      await evictOldestIfNeeded(store, MAX_VIDEOS);
      return now;
    });
  }

  async function deleteVideo(key) {
    await withTransaction(VIDEO_STORE_NAME, "readwrite", transaction => {
      transaction.objectStore(VIDEO_STORE_NAME).delete(key);
    });
  }

  async function clearVideos() {
    await withTransaction(VIDEO_STORE_NAME, "readwrite", transaction => {
      transaction.objectStore(VIDEO_STORE_NAME).clear();
    });
  }

  async function clearAll() {
    await withTransaction(
      [STORE_NAME, TRANSLATION_STORE_NAME, VIDEO_STORE_NAME, META_STORE_NAME],
      "readwrite",
      transaction => {
        transaction.objectStore(STORE_NAME).clear();
        transaction.objectStore(TRANSLATION_STORE_NAME).clear();
        transaction.objectStore(VIDEO_STORE_NAME).clear();
        transaction.objectStore(META_STORE_NAME).put({ key: AUDIO_BYTES_KEY, value: 0 });
      }
    );
  }

  globalThis.YTLLTTSCache = { get, getBatch, put, putBatch, clear };
  globalThis.YTLLTranslationCache = {
    get: getTranslation,
    getBatch: getTranslationBatch,
    getTranslationBatch,
    put: putTranslation,
    putBatch: putTranslationBatch,
    putTranslationBatch,
    clear: clearTranslations
  };
  globalThis.YTLLVideoCache = {
    get: getVideo,
    put: putVideo,
    delete: deleteVideo,
    clear: clearVideos
  };
  globalThis.YTLLCache = {
    clearAll,
    clearTts: clear,
    clearTranslations,
    clearVideos
  };
})();
