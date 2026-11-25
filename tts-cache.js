(function () {
  const DB_NAME = "ytll_tts_cache";
  const STORE_NAME = "audio";
  const MAX_ENTRIES = 1500;

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("lastAccessedAt", "lastAccessedAt");
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

  async function get(key) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const record = await requestResult(store.get(key));
      if (record) {
        record.lastAccessedAt = Date.now();
        store.put(record);
      }
      await transactionDone(transaction);
      return record || null;
    } finally {
      database.close();
    }
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("TTS audio cache transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("TTS audio cache transaction was aborted"));
    });
  }

  async function put(record) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      store.put({
        key: record.key,
        arrayBuffer: record.arrayBuffer,
        createdAt: record.createdAt || Date.now(),
        lastAccessedAt: Date.now()
      });

      const count = await requestResult(store.count());
      const excess = count - MAX_ENTRIES;
      if (excess > 0) {
        const index = store.index("lastAccessedAt");
        const cursorRequest = index.openCursor();
        let removed = 0;
        await new Promise((resolve, reject) => {
          cursorRequest.onerror = () => reject(cursorRequest.error || new Error("Could not evict TTS cache entries"));
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor || removed >= excess) {
              resolve();
              return;
            }
            cursor.delete();
            removed += 1;
            cursor.continue();
          };
        });
      }
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

  globalThis.YTLLTTSCache = { get, put, clear };
})();
