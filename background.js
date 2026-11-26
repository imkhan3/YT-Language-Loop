const TTS_TEST_PHRASE = "مرحباً بكم، هذا اختبار للصوت العربي الفصيح.";
const inFlight = new Map();
const translationInFlight = new Map();

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

async function getTranslationSettings() {
  const stored = await browser.storage.local.get("ttsSettings");
  const settings = stored.ttsSettings || {};
  return {
    geminiApiKey: typeof settings.geminiApiKey === "string" ? settings.geminiApiKey : "",
    geminiModel: typeof settings.geminiModel === "string" && settings.geminiModel.trim()
      ? settings.geminiModel.trim()
      : "gemini-2.5-flash"
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

function textToSsml(text, voice) {
  const cleaned = cleanText(text);
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return "";

  if (!voice.toLowerCase().includes("multilingual")) {
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ar-SA"><voice name="${escapeXml(voice)}">${escapeXml(cleaned)}</voice></speak>`;
  }

  const parts = cleaned.split(/([A-Za-z][A-Za-z0-9'’.-]*(?:\s+[A-Za-z][A-Za-z0-9'’.-]*)*)/g);
  const escapedText = parts.map((part, index) => {
    const escaped = escapeXml(part);
    return index % 2 === 1 ? `<lang xml:lang="en-US">${escaped}</lang>` : escaped;
  }).join("");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ar-SA"><voice name="${escapeXml(voice)}">${escapedText}</voice></speak>`;
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

async function requestSpeech(text, key, region, voice) {
  validateCredentials(key, region, voice);
  const ssml = textToSsml(text, voice.trim());
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

function toBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
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
      return { ok: true, audioBase64: toBase64(cached.arrayBuffer), mimeType: "audio/mpeg", cached: true };
    }
  }

  if (inFlight.has(key)) {
    const audio = await inFlight.get(key);
    return { ok: true, audioBase64: toBase64(audio), mimeType: "audio/mpeg", cached: false };
  }

  const synthesis = (async () => {
    validateCredentials(settings.azureKey, settings.azureRegion, voiceName);
    const arrayBuffer = await requestSpeech(text, settings.azureKey, settings.azureRegion, voiceName);
    await YTLLTTSCache.put({ key, arrayBuffer, createdAt: Date.now() });
    return arrayBuffer;
  })();
  inFlight.set(key, synthesis);
  try {
    const audio = await synthesis;
    return { ok: true, audioBase64: toBase64(audio), mimeType: "audio/mpeg", cached: false };
  } finally {
    inFlight.delete(key);
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
