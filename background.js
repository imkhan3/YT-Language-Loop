const TTS_TEST_PHRASE = "مرحباً بكم، هذا اختبار للصوت العربي الفصيح.";
const inFlight = new Map();
const translationInFlight = new Map();
const BATCH_SSML_BREAK = '<break time="1100ms"/>';

async function createTranslationCacheKey(text, sourceLang, targetLang, model, contextSentences = []) {
  const normalized = normalizeText(text);
  const context = Array.isArray(contextSentences)
    ? contextSentences.map(item => normalizeText(String(item))).join("||")
    : "";
  const identity = `${sourceLang.trim().toLowerCase()}::${targetLang.trim().toLowerCase()}::${model.trim()}::${context}::${normalized}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `gemini::${hash}`;
}

function makeVideoCacheKey(videoId, sourceLang, targetLang) {
  return `${String(videoId || "").trim()}::${String(sourceLang || "").trim().toLowerCase()}::${String(targetLang || "").trim().toLowerCase()}`;
}

async function getTranslationSettings() {
  const stored = await browser.storage.local.get("ttsSettings");
  const settings = stored.ttsSettings || {};
  return {
    geminiApiKey: typeof settings.geminiApiKey === "string" ? settings.geminiApiKey : "",
    geminiModel: typeof settings.geminiModel === "string" && settings.geminiModel.trim()
      ? settings.geminiModel.trim()
      : "gemini-3.1-flash-lite"
  };
}

function validateGeminiSettings(apiKey, model) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Enter a Gemini API key.");
  }
  if (typeof model !== "string" || !/^[A-Za-z0-9._-]+$/.test(model.trim())) {
    throw new Error("Enter a valid Gemini model name.");
  }
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const text = parts.map(part => typeof part?.text === "string" ? part.text : "").join("").trim();
    if (text) return text;
  }
  throw new Error("Gemini returned no translated text.");
}

async function requestGeminiTranslation(text, sourceLang, targetLang, apiKey, model, contextSentences = []) {
  validateGeminiSettings(apiKey, model);
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Translation text must not be empty.");
  }
  if (typeof sourceLang !== "string" || !sourceLang.trim() ||
      typeof targetLang !== "string" || !targetLang.trim()) {
    throw new Error("A source and target language are required.");
  }

  const contextBlock = Array.isArray(contextSentences) && contextSentences.length > 0
    ? `\nContext from preceding cues:\n${contextSentences.map(item => String(item).trim()).filter(Boolean).join("\n")}\n`
    : "";
  const prompt =
    `Translate the following text from ${sourceLang.trim()} to ${targetLang.trim()}.\n` +
    contextBlock +
    "Use natural Modern Standard Arabic where appropriate. Return only the translation, with no notes or quotations.\n\n" +
    text.trim();

  const modelName = encodeURIComponent(model.trim());
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey.trim())}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048
        }
      })
    }
  );

  if (!response.ok) {
    const details = (await response.text()).trim().slice(0, 300);
    throw new Error(`Gemini returned HTTP ${response.status}${details ? `: ${details}` : ""}`);
  }
  return extractGeminiText(await response.json());
}

function parseBatchTranslationJson(rawText) {
  const stripped = String(rawText || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = JSON.parse(stripped);
  if (!Array.isArray(parsed)) {
    throw new Error("Gemini batch translation did not return a JSON array.");
  }
  const byId = new Map();
  for (const entry of parsed) {
    if (
      entry &&
      Number.isInteger(entry.id) &&
      typeof entry.translation === "string" &&
      entry.translation.trim()
    ) {
      byId.set(entry.id, entry.translation.trim());
    }
  }
  return byId;
}

async function requestGeminiBatchTranslation(items, sourceLang, targetLang, apiKey, model) {
  validateGeminiSettings(apiKey, model);
  if (!Array.isArray(items) || items.length === 0) {
    return new Map();
  }

  const firstContext = Array.isArray(items[0]?.prevContext) && items[0].prevContext.length > 0
    ? `\nPreceding context (do not translate these, use only for continuity):\n${items[0].prevContext.join("\n")}\n`
    : "";

  const payloadItems = items.map((item, idx) => ({
    id: idx,
    text: String(item.text || "").trim()
  }));

  const prompt =
    `Translate each subtitle cue in the JSON array from ${sourceLang.trim()} to ${targetLang.trim()}.\n` +
    firstContext +
    "Use natural Modern Standard Arabic where appropriate. Keep each translation aligned 1-to-1 with its id.\n" +
    'Return ONLY a JSON array of objects in the form [{"id": 0, "translation": "..."}].\n\n' +
    JSON.stringify(payloadItems);

  const modelName = encodeURIComponent(model.trim());
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

  const sendRequest = async (useSchema) => {
    const generationConfig = {
      temperature: 0.2,
      maxOutputTokens: 8192
    };
    if (useSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "INTEGER" },
            translation: { type: "STRING" }
          },
          required: ["id", "translation"]
        }
      };
    }
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig
      })
    });
  };

  let response = await sendRequest(true);
  if (!response.ok && response.status === 400) {
    response = await sendRequest(false);
  }
  if (!response.ok) {
    const details = (await response.text()).trim().slice(0, 300);
    throw new Error(`Gemini returned HTTP ${response.status}${details ? `: ${details}` : ""}`);
  }

  const rawText = extractGeminiText(await response.json());
  return parseBatchTranslationJson(rawText);
}

async function translateCached(text, sourceLang, targetLang, forceRefresh, contextSentences = []) {
  const settings = await getTranslationSettings();
  const model = settings.geminiModel;
  validateGeminiSettings(settings.geminiApiKey, model);
  const key = await createTranslationCacheKey(text, sourceLang, targetLang, model, contextSentences);

  if (!forceRefresh) {
    const cached = await YTLLTranslationCache.get(key);
    if (cached?.translatedText) {
      return { ok: true, translatedText: cached.translatedText, cached: true };
    }
  }

  if (translationInFlight.has(key)) {
    const translatedText = await translationInFlight.get(key);
    return { ok: true, translatedText, cached: false };
  }

  const translation = (async () => {
    const translatedText = await requestGeminiTranslation(
      text,
      sourceLang,
      targetLang,
      settings.geminiApiKey,
      model,
      contextSentences
    );
    await YTLLTranslationCache.put({ key, translatedText, createdAt: Date.now() });
    return translatedText;
  })();
  translationInFlight.set(key, translation);
  try {
    const translatedText = await translation;
    return { ok: true, translatedText, cached: false };
  } finally {
    translationInFlight.delete(key);
  }
}

async function translateBatchCached(items, sourceLang, targetLang, forceRefresh) {
  const settings = await getTranslationSettings();
  const model = settings.geminiModel;
  validateGeminiSettings(settings.geminiApiKey, model);

  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, translations: {}, cachedCount: 0, fetchedCount: 0 };
  }

  const translations = {};
  const uncached = [];
  let cachedCount = 0;

  for (const item of items) {
    const index = item?.index;
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    const prevContext = Array.isArray(item?.prevContext) ? item.prevContext : [];
    if (!Number.isInteger(index) || !text) continue;

    const key = await createTranslationCacheKey(text, sourceLang, targetLang, model, prevContext);
    if (!forceRefresh) {
      const cached = await YTLLTranslationCache.get(key);
      if (cached?.translatedText) {
        translations[index] = cached.translatedText;
        cachedCount += 1;
        continue;
      }
    }
    uncached.push({ index, text, prevContext, key });
  }

  if (uncached.length === 0) {
    return { ok: true, translations, cachedCount, fetchedCount: 0 };
  }

  const batchKey = `batch::${uncached.map(item => item.key).join(",")}`;
  if (translationInFlight.has(batchKey)) {
    const shared = await translationInFlight.get(batchKey);
    return { ok: true, translations: { ...translations, ...shared }, cachedCount, fetchedCount: 0 };
  }

  const batchJob = (async () => {
    const batchResults = {};
    if (uncached.length === 1) {
      const single = uncached[0];
      const translatedText = await requestGeminiTranslation(
        single.text,
        sourceLang,
        targetLang,
        settings.geminiApiKey,
        model,
        single.prevContext
      );
      await YTLLTranslationCache.put({ key: single.key, translatedText, createdAt: Date.now() });
      batchResults[single.index] = translatedText;
      return batchResults;
    }

    const byId = await requestGeminiBatchTranslation(
      uncached,
      sourceLang,
      targetLang,
      settings.geminiApiKey,
      model
    );

    for (let i = 0; i < uncached.length; i++) {
      const item = uncached[i];
      let translatedText = byId.get(i);
      if (!translatedText) {
        translatedText = await requestGeminiTranslation(
          item.text,
          sourceLang,
          targetLang,
          settings.geminiApiKey,
          model,
          item.prevContext
        );
      }
      await YTLLTranslationCache.put({ key: item.key, translatedText, createdAt: Date.now() });
      batchResults[item.index] = translatedText;
    }
    return batchResults;
  })();

  translationInFlight.set(batchKey, batchJob);
  try {
    const batchResults = await batchJob;
    Object.assign(translations, batchResults);
    return {
      ok: true,
      translations,
      cachedCount,
      fetchedCount: uncached.length
    };
  } finally {
    translationInFlight.delete(batchKey);
  }
}

function normalizeText(text) {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

async function createCacheKey(voice, text) {
  const normalized = normalizeText(text);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return `${voice}::${hash}`;
}

function cleanText(text) {
  return text.replace(/\s*\(([^()]*)\)/g, (match, contents, offset, source) => {
    const isLatinGloss = /^[A-Za-z0-9\s'".,!?:;&-]+$/.test(contents);
    const hasArabicBefore = /[\u0600-\u06FF]/.test(source.slice(0, offset));
    return isLatinGloss && hasArabicBefore ? "" : match;
  }).replace(/\s+/g, " ").trim();
}

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function textToInnerSsml(text, voice) {
  const cleaned = cleanText(text);
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return "";

  if (!voice.toLowerCase().includes("multilingual")) {
    return escapeXml(cleaned);
  }

  const parts = cleaned.split(/([A-Za-z][A-Za-z0-9'’.-]*(?:\s+[A-Za-z][A-Za-z0-9'’.-]*)*)/g);
  return parts.map((part, index) => {
    const escaped = escapeXml(part);
    return index % 2 === 1 ? `<lang xml:lang="en-US">${escaped}</lang>` : escaped;
  }).join("");
}

function textToSsml(text, voice) {
  const inner = textToInnerSsml(text, voice);
  if (!inner) return "";
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ar-SA"><voice name="${escapeXml(voice)}">${inner}</voice></speak>`;
}

function itemsToBatchSsml(texts, voice) {
  const segments = [];
  for (const text of texts) {
    const inner = textToInnerSsml(text, voice);
    if (!inner) return "";
    segments.push(inner);
  }
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ar-SA"><voice name="${escapeXml(voice)}">${segments.join(` ${BATCH_SSML_BREAK} `)}</voice></speak>`;
}

function validateVoice(voice) {
  if (typeof voice !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(voice.trim())) {
    throw new Error("Select or enter a valid Azure voice name.");
  }
}

function validateCredentials(key, region, voice) {
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("Enter an Azure Speech Key.");
  }
  if (typeof region !== "string" || !/^[a-z0-9-]+$/i.test(region.trim())) {
    throw new Error("Enter a valid Azure region, such as eastus.");
  }
  validateVoice(voice);
}

async function requestSpeechFromSsml(ssml, key, region, voice) {
  validateCredentials(key, region, voice);
  if (!ssml) {
    throw new Error("No speakable letters or numbers remain after text cleaning.");
  }
  const response = await fetch(`https://${region.trim()}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key.trim(),
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3"
    },
    body: ssml
  });

  if (!response.ok) {
    const details = (await response.text()).trim().slice(0, 300);
    throw new Error(`Azure Speech returned HTTP ${response.status}${details ? `: ${details}` : ""}`);
  }
  return await response.arrayBuffer();
}

async function requestSpeech(text, key, region, voice) {
  const ssml = textToSsml(text, voice.trim());
  return requestSpeechFromSsml(ssml, key, region, voice);
}

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getTtsSettings() {
  const stored = await browser.storage.local.get("ttsSettings");
  return stored.ttsSettings || {
    azureKey: "",
    azureRegion: "eastus",
    azureVoice: "ar-SA-HamedNeural"
  };
}

async function synthesizeCached(text, voice, forceRefresh) {
  const settings = await getTtsSettings();
  const selectedVoice = voice || settings.azureVoice;
  validateVoice(selectedVoice);
  const voiceName = selectedVoice.trim();
  const key = await createCacheKey(voiceName, text);

  if (!forceRefresh) {
    const cached = await YTLLTTSCache.get(key);
    if (cached) {
      return {
        ok: true,
        audioBase64: toBase64(cached.arrayBuffer),
        mimeType: cached.mimeType || "audio/mpeg",
        cached: true
      };
    }
  }

  if (inFlight.has(key)) {
    const audio = await inFlight.get(key);
    return {
      ok: true,
      audioBase64: toBase64(audio.arrayBuffer),
      mimeType: audio.mimeType || "audio/mpeg",
      cached: false
    };
  }

  const synthesis = (async () => {
    validateCredentials(settings.azureKey, settings.azureRegion, voiceName);
    const arrayBuffer = await requestSpeech(text, settings.azureKey, settings.azureRegion, voiceName);
    const mimeType = "audio/mpeg";
    await YTLLTTSCache.put({ key, arrayBuffer, mimeType, createdAt: Date.now() });
    return { arrayBuffer, mimeType };
  })();
  inFlight.set(key, synthesis);
  try {
    const audio = await synthesis;
    return {
      ok: true,
      audioBase64: toBase64(audio.arrayBuffer),
      mimeType: audio.mimeType,
      cached: false
    };
  } finally {
    inFlight.delete(key);
  }
}

async function synthesizeBatchCached(items, voice) {
  const settings = await getTtsSettings();
  const selectedVoice = voice || settings.azureVoice;
  validateVoice(selectedVoice);
  const voiceName = selectedVoice.trim();

  if (!Array.isArray(items) || items.length === 0) {
    return { ok: true, cachedItems: [], failedItems: [], batchAudioBase64: null, batchedItems: [] };
  }

  const cachedItems = [];
  const failedItems = [];
  const uncachedItems = [];

  for (const item of items) {
    const clientKey = item?.key;
    const text = typeof item?.text === "string" ? item.text : "";
    if (!clientKey || !text.trim()) continue;

    if (!textToInnerSsml(text, voiceName)) {
      failedItems.push({ clientKey, reason: "No speakable letters or numbers remain after text cleaning." });
      continue;
    }

    const cacheKey = await createCacheKey(voiceName, text);
    const cached = await YTLLTTSCache.get(cacheKey);
    if (cached) {
      cachedItems.push({
        clientKey,
        audioBase64: toBase64(cached.arrayBuffer),
        mimeType: cached.mimeType || "audio/mpeg",
        cached: true
      });
    } else {
      uncachedItems.push({ clientKey, text, cacheKey });
    }
  }

  if (uncachedItems.length === 0) {
    return { ok: true, cachedItems, failedItems, batchAudioBase64: null, batchedItems: [] };
  }

  if (uncachedItems.length === 1) {
    const single = uncachedItems[0];
    const singleRes = await synthesizeCached(single.text, voiceName, false);
    cachedItems.push({
      clientKey: single.clientKey,
      audioBase64: singleRes.audioBase64,
      mimeType: singleRes.mimeType,
      cached: singleRes.cached
    });
    return { ok: true, cachedItems, failedItems, batchAudioBase64: null, batchedItems: [] };
  }

  const batchCacheIdentity = `ttsbatch::${voiceName}::${uncachedItems.map(i => i.cacheKey).join(",")}`;
  if (inFlight.has(batchCacheIdentity)) {
    const shared = await inFlight.get(batchCacheIdentity);
    return {
      ok: true,
      cachedItems,
      failedItems,
      batchAudioBase64: shared.batchAudioBase64,
      batchMimeType: shared.batchMimeType,
      batchedItems: uncachedItems.map(i => ({ clientKey: i.clientKey, text: i.text }))
    };
  }

  const batchSynthesis = (async () => {
    validateCredentials(settings.azureKey, settings.azureRegion, voiceName);
    const ssml = itemsToBatchSsml(uncachedItems.map(i => i.text), voiceName);
    const arrayBuffer = await requestSpeechFromSsml(ssml, settings.azureKey, settings.azureRegion, voiceName);
    return {
      batchAudioBase64: toBase64(arrayBuffer),
      batchMimeType: "audio/mpeg"
    };
  })();

  inFlight.set(batchCacheIdentity, batchSynthesis);
  try {
    const result = await batchSynthesis;
    return {
      ok: true,
      cachedItems,
      failedItems,
      batchAudioBase64: result.batchAudioBase64,
      batchMimeType: result.batchMimeType,
      batchedItems: uncachedItems.map(i => ({ clientKey: i.clientKey, text: i.text }))
    };
  } finally {
    inFlight.delete(batchCacheIdentity);
  }
}

browser.runtime.onMessage.addListener(async message => {
  if (!message || typeof message.type !== "string") {
    return undefined;
  }

  try {
    if (message.type === "YTLL_TTS_SYNTHESIZE") {
      if (typeof message.text !== "string" || !message.text.trim()) {
        throw new Error("TTS text must not be empty.");
      }
      return await synthesizeCached(message.text, message.voice, message.forceRefresh === true);
    }
    if (message.type === "YTLL_TTS_SYNTHESIZE_BATCH") {
      return await synthesizeBatchCached(message.items, message.voice);
    }
    if (message.type === "YTLL_TTS_CACHE_PUT") {
      const settings = await getTtsSettings();
      const selectedVoice = message.voice || settings.azureVoice;
      validateVoice(selectedVoice);
      if (typeof message.text !== "string" || !message.text.trim() || typeof message.audioBase64 !== "string") {
        throw new Error("Invalid TTS cache payload.");
      }
      const key = await createCacheKey(selectedVoice.trim(), message.text);
      await YTLLTTSCache.put({
        key,
        arrayBuffer: fromBase64(message.audioBase64),
        mimeType: message.mimeType || "audio/wav",
        createdAt: Date.now()
      });
      return { ok: true };
    }
    if (message.type === "YTLL_TTS_TEST") {
      const { azureKey, azureRegion, azureVoice } = message;
      const audio = await requestSpeech(TTS_TEST_PHRASE, azureKey, azureRegion, azureVoice);
      return { ok: true, audioBase64: toBase64(audio), mimeType: "audio/mpeg" };
    }
    if (message.type === "YTLL_TTS_CLEAR_CACHE") {
      await YTLLTTSCache.clear();
      return { ok: true };
    }
    if (
      message.type === "YTLL_TRANSLATE" ||
      message.type === "YTLL_TRANSLATE_TEXT" ||
      message.type === "YTLL_GEMINI_TRANSLATE"
    ) {
      return await translateCached(
        message.text,
        message.sourceLang || "en",
        message.targetLang || "ar",
        message.forceRefresh === true,
        Array.isArray(message.contextSentences) ? message.contextSentences : []
      );
    }
    if (message.type === "YTLL_TRANSLATE_BATCH") {
      return await translateBatchCached(
        message.items,
        message.sourceLang || "en",
        message.targetLang || "ar",
        message.forceRefresh === true
      );
    }
    if (
      message.type === "YTLL_TRANSLATION_TEST" ||
      message.type === "YTLL_GEMINI_TEST"
    ) {
      const apiKey = typeof message.geminiApiKey === "string"
        ? message.geminiApiKey
        : (await getTranslationSettings()).geminiApiKey;
      const model = typeof message.geminiModel === "string"
        ? message.geminiModel
        : (await getTranslationSettings()).geminiModel;
      const translatedText = await requestGeminiTranslation(
        "Hello, this is a translation test.",
        "English",
        "Arabic",
        apiKey,
        model
      );
      return { ok: true, translatedText };
    }
    if (
      message.type === "YTLL_TRANSLATION_CLEAR_CACHE" ||
      message.type === "YTLL_GEMINI_CLEAR_CACHE"
    ) {
      await YTLLTranslationCache.clear();
      await YTLLVideoCache.clear();
      return { ok: true };
    }
    if (message.type === "YTLL_VIDEO_CACHE_GET") {
      const key = makeVideoCacheKey(message.videoId, message.sourceLang, message.targetLang);
      const record = await YTLLVideoCache.get(key);
      if (!record) return { ok: true, found: false };
      return {
        ok: true,
        found: true,
        cues: record.cues,
        metadata: record.metadata,
        updatedAt: record.updatedAt
      };
    }
    if (message.type === "YTLL_VIDEO_CACHE_PUT") {
      if (!message.videoId || !Array.isArray(message.cues) || message.cues.length === 0) {
        return { ok: false, reason: "Invalid video cache payload." };
      }
      const key = makeVideoCacheKey(message.videoId, message.sourceLang, message.targetLang);
      const savedAt = await YTLLVideoCache.put({
        key,
        videoId: message.videoId,
        sourceLang: message.sourceLang || "en",
        targetLang: message.targetLang || "ar",
        cues: message.cues,
        metadata: message.metadata || { title: "", channel: "" }
      });
      return { ok: true, savedAt };
    }
    if (message.type === "YTLL_VIDEO_CACHE_DELETE") {
      const key = makeVideoCacheKey(message.videoId, message.sourceLang, message.targetLang);
      await YTLLVideoCache.delete(key);
      return { ok: true };
    }
    if (message.type === "YTLL_VIDEO_CACHE_CLEAR") {
      await YTLLVideoCache.clear();
      return { ok: true };
    }
    if (message.type === "YTLL_CLEAR_ALL_CACHE") {
      await YTLLCache.clearAll();
      return { ok: true };
    }
    return undefined;
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : "TTS request failed." };
  }
});