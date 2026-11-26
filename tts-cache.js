(function () {
  const DB_NAME = "ytll_tts_cache";
  const STORE_NAME = "audio";
  const TRANSLATION_STORE_NAME = "translations";
  const VIDEO_STORE_NAME = "videos";
  const MAX_ENTRIES = 4000;
  const MAX_VIDEOS = 100;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const VIDEO_TTL_MS = 7 * ONE_DAY_MS;
  const DB_VERSION = 3;

  function openDatabase() {
    return new Promise((resolve, reject) => {
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
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open TTS audio cache"));
    });
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

  async function evictOldestIfNeeded(store, maxEntries, protectWithinMs = ONE_DAY_MS) {
    const count = await requestResult(store.count());
    const excess = count - maxEntries;
    if (excess <= 0) return;

    const cutoff = Date.now() - protectWithinMs;
    const hardCap = Math.floor(maxEntries * 1.5);
    const index = store.index("lastAccessedAt");
    const cursorRequest = index.openCursor();
    let removed = 0;

    await new Promise((resolve, reject) => {
      cursorRequest.onerror = () => reject(cursorRequest.error || new Error("Could not evict cache entries"));
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || removed >= excess) {
          resolve();
          return;
        }
        const record = cursor.value;
        const lastTouched = record.lastAccessedAt || record.updatedAt || record.createdAt || 0;
        const mustEvict = count - removed > hardCap;
        if (lastTouched < cutoff || mustEvict) {
          cursor.delete();
          removed += 1;
        }
        cursor.continue();
      };
    });
  }

  async function get(key) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const record = await requestResult(store.get(key));
      if (record && Date.now() - (record.lastAccessedAt || 0) > 60 * 1000) {
        record.lastAccessedAt = Date.now();
        store.put(record);
      }
      await transactionDone(transaction);
      return record || null;
    } finally {
      database.close();
    }
  }

  async function put(record) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const now = Date.now();
      store.put({
        key: record.key,
        arrayBuffer: record.arrayBuffer,
        mimeType: record.mimeType || "audio/mpeg",
        createdAt: record.createdAt || now,
        lastAccessedAt: now
      });

      await evictOldestIfNeeded(store, MAX_ENTRIES, ONE_DAY_MS);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async function clear() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).clear();
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async function getTranslation(key) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(TRANSLATION_STORE_NAME, "readwrite");
      const store = transaction.objectStore(TRANSLATION_STORE_NAME);
      const record = await requestResult(store.get(key));
      if (record && Date.now() - (record.lastAccessedAt || 0) > 60 * 1000) {
        record.lastAccessedAt = Date.now();
        store.put(record);
      }
      await transactionDone(transaction);
      return record || null;
    } finally {
      database.close();
    }
  }

  async function putTranslation(record) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(TRANSLATION_STORE_NAME, "readwrite");
      const store = transaction.objectStore(TRANSLATION_STORE_NAME);
      const now = Date.now();
      store.put({
        key: record.key,
        translatedText: record.translatedText,
        createdAt: record.createdAt || now,
        lastAccessedAt: now
      });

      await evictOldestIfNeeded(store, MAX_ENTRIES, ONE_DAY_MS);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async function clearTranslations() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(TRANSLATION_STORE_NAME, "readwrite");
      transaction.objectStore(TRANSLATION_STORE_NAME).clear();
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async function getVideo(key) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(VIDEO_STORE_NAME, "readwrite");
      const store = transaction.objectStore(VIDEO_STORE_NAME);
      const record = await requestResult(store.get(key));
      if (!record) {
        await transactionDone(transaction);
        return null;
      }
      const now = Date.now();
      if (now - (record.updatedAt || record.createdAt || 0) > VIDEO_TTL_MS) {
        store.delete(key);
        await transactionDone(transaction);
        return null;
      }
      if (now - (record.lastAccessedAt || 0) > 60 * 1000) {
        record.lastAccessedAt = now;
        store.put(record);
      }
      await transactionDone(transaction);
      return record;
    } finally {
      database.close();
    }
  }

  async function putVideo(record) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(VIDEO_STORE_NAME, "readwrite");
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

      await evictOldestIfNeeded(store, MAX_VIDEOS, ONE_DAY_MS);
      await transactionDone(transaction);
      return now;
    } finally {
      database.close();
    }
  }

  async function deleteVideo(key) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(VIDEO_STORE_NAME, "readwrite");
      transaction.objectStore(VIDEO_STORE_NAME).delete(key);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async function clearVideos() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(VIDEO_STORE_NAME, "readwrite");
      transaction.objectStore(VIDEO_STORE_NAME).clear();
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async function clearAll() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(
        [STORE_NAME, TRANSLATION_STORE_NAME, VIDEO_STORE_NAME],
        "readwrite"
      );
      transaction.objectStore(STORE_NAME).clear();
      transaction.objectStore(TRANSLATION_STORE_NAME).clear();
      transaction.objectStore(VIDEO_STORE_NAME).clear();
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  globalThis.YTLLTTSCache = { get, put, clear };
  globalThis.YTLLTranslationCache = {
    get: getTranslation,
    put: putTranslation,
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