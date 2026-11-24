(() => {
  if (window.__ytLangLoopInjected) return;
  window.__ytLangLoopInjected = true;

  const SOURCE_PAGE = "yt-lang-loop-page";
  const SOURCE_CONTENT = "yt-lang-loop-content";

  const LANG_NAMES = {
    ar: "arabic",
    en: "english",
    es: "spanish",
    fr: "french",
    de: "german",
    tr: "turkish",
    ja: "japanese",
    ko: "korean",
    zh: "chinese",
    hi: "hindi",
    pt: "portuguese",
    ru: "russian"
  };

  // Cache captured timedtext responses by videoId + languageCode
  const timedtextCache = new Map();
  let lastSetAudioTrack = null;

  function postToContent(type, payload = {}) {
    window.postMessage({ source: SOURCE_PAGE, type, payload }, "*");
  }

  function getPlayer() {
    return document.getElementById("movie_player");
  }

  function getVideoId() {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  function matchesLang(candidateStr, targetCode) {
    if (!candidateStr || !targetCode) return false;
    const lower = String(candidateStr).toLowerCase().trim();
    const code = targetCode.toLowerCase();
    const langName = LANG_NAMES[code] || "";

    if (lower === code || lower.startsWith(code + "-") || lower.startsWith(code + ".")) {
      return true;
    }
    if (langName && lower.includes(langName)) {
      return true;
    }
    return false;
  }

  // Hook fetch & XHR so if YouTube loads captions internally (with PoTokens), we capture them
  function handleCapturedTimedtext(urlStr, text) {
    try {
      if (!urlStr || !urlStr.includes("/api/timedtext")) return;
      const url = new URL(urlStr, window.location.origin);
      const v = url.searchParams.get("v") || getVideoId();
      const lang = url.searchParams.get("tlang") || url.searchParams.get("lang") || "";
      if (v && lang && text && text.trim().length > 0) {
        timedtextCache.set(`${v}:${lang.toLowerCase()}`, text);
        postToContent("TIMEDTEXT_CAPTURED", { videoId: v, lang: lang.toLowerCase(), raw: text });
      }
    } catch (_) {}
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await origFetch.apply(this, args);
    try {
      const reqUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
      if (reqUrl && reqUrl.includes("/api/timedtext")) {
        const clone = response.clone();
        clone.text().then((txt) => handleCapturedTimedtext(reqUrl, txt)).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ytLoopUrl = typeof url === "string" ? url : "";
    return origOpen.apply(this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__ytLoopUrl && this.__ytLoopUrl.includes("/api/timedtext")) {
      this.addEventListener("load", () => {
        try {
          if (typeof this.responseText === "string") {
            handleCapturedTimedtext(this.__ytLoopUrl, this.responseText);
          }
        } catch (_) {}
      });
    }
    return origSend.apply(this, args);
  };

  // Inspect YouTube's obfuscated audio track object safely
  // Read only the track's own language info (do NOT walk captionTracks)
  function inspectAudioTrack(track) {
    const strings = [];
    try {
      if (typeof track?.getLanguageInfo === "function") {
        const info = track.getLanguageInfo();
        if (info?.id) strings.push(String(info.id));
        if (info?.name) strings.push(String(info.name));
      }
    } catch (_) {}

    if (strings.length === 0 && track && typeof track === "object") {
      for (const key of ["id", "name", "languageCode", "languageName"]) {
        if (typeof track[key] === "string") strings.push(track[key]);
      }
    }
    return strings;
  }

  async function trySetAudioLanguage(langCode) {
    const player = getPlayer();
    if (!player || typeof player.getAvailableAudioTracks !== "function") {
      return { ok: false, reason: "Audio track API unavailable" };
    }

    const tracks = player.getAvailableAudioTracks() || [];
    if (tracks.length === 0) {
      return { ok: false, reason: "Audio tracks are not available yet" };
    }
    if (tracks.length === 1) {
      return { ok: false, reason: "No alternate audio tracks on this video" };
    }

    for (const track of tracks) {
      const infoStrings = inspectAudioTrack(track);
      if (infoStrings.some((s) => matchesLang(s, langCode))) {
        const hasCurrentTrackApi = typeof player.getAudioTrack === "function";
        let currentTrack = null;
        if (hasCurrentTrackApi) {
          try {
            currentTrack = player.getAudioTrack();
          } catch (err) {
            return { ok: false, reason: err.message };
          }
        }

        const currentTrackId = currentTrack?.getLanguageInfo?.()?.id || currentTrack?.id;
        const targetTrackId = track?.getLanguageInfo?.()?.id || track?.id;

        if (
          currentTrack === track ||
          (currentTrackId && targetTrackId && currentTrackId === targetTrackId) ||
          (!hasCurrentTrackApi &&
            lastSetAudioTrack?.player === player &&
            lastSetAudioTrack.track === track)
        ) {
          return { ok: true, matched: infoStrings.join(" | "), unchanged: true };
        }

        try {
          await player.setAudioTrack(track);
          lastSetAudioTrack = { player, track };
          return { ok: true, matched: infoStrings.join(" | ") };
        } catch (err) {
          return { ok: false, reason: err.message };
        }
      }
    }

    return { ok: false, reason: `No audio track found for "${langCode}"` };
  }

  async function setAudioLanguage(langCode) {
    let result;
    for (let attempt = 0; attempt < 5; attempt++) {
      result = await trySetAudioLanguage(langCode);
      const reason = result.reason || "";
      const retryable =
        reason === "Audio track API unavailable" ||
        reason === "Audio tracks are not available yet" ||
        reason.startsWith("No audio track found");
      if (
        result.ok ||
        !retryable ||
        attempt === 4
      ) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return result;
  }

  function setSubtitleLanguage(mode, langCode) {
    const player = getPlayer();
    if (!player || typeof player.setOption !== "function") {
      return { ok: false, reason: "Player captions API unavailable" };
    }

    try {
      if (mode === "off") {
        player.setOption("captions", "track", {});
        if (typeof player.unloadModule === "function") {
          player.unloadModule("captions");
          player.unloadModule("cc");
        }
        return { ok: true };
      }

      player.loadModule("captions");
      const tracklist = player.getOption("captions", "tracklist") || [];

      // Prefer exact match, then prefix match (e.g. ar-SA for ar), then non-ASR over ASR
      const matching = tracklist.filter((t) =>
        matchesLang(t.languageCode, langCode) || matchesLang(t.languageName, langCode)
      );

      if (matching.length === 0) {
        return { ok: false, reason: `No subtitle track found for "${langCode}"` };
      }

      matching.sort((a, b) => {
        const aExact = (a.languageCode || "").toLowerCase() === langCode.toLowerCase() ? 0 : 1;
        const bExact = (b.languageCode || "").toLowerCase() === langCode.toLowerCase() ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        const aAsr = a.kind === "asr" ? 1 : 0;
        const bAsr = b.kind === "asr" ? 1 : 0;
        return aAsr - bAsr;
      });

      player.setOption("captions", "track", matching[0]);
      return { ok: true, track: matching[0].languageCode };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  async function getCaptionTracks() {
    const player = getPlayer();
    let tracks = [];

    try {
      const resp = player?.getPlayerResponse?.();
      tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    } catch (_) {}

    if (tracks.length === 0 && window.ytInitialPlayerResponse) {
      tracks =
        window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ||
        [];
    }

    return tracks;
  }

  async function fetchSubtitlesForLang(langCode) {
    const videoId = getVideoId();
    if (!videoId) return { ok: false, reason: "No video ID" };

    // 1. Check cache first
    for (const [key, raw] of timedtextCache.entries()) {
      if (key.startsWith(`${videoId}:`) && matchesLang(key.split(":")[1], langCode)) {
        return { ok: true, raw, videoId, lang: langCode };
      }
    }

    // 2. Try fetching directly from captionTracks baseUrl
    const tracks = await getCaptionTracks();
    const matching = tracks.filter(
      (t) => matchesLang(t.languageCode, langCode) || matchesLang(t.name?.simpleText, langCode)
    );

    if (matching.length > 0) {
      matching.sort((a, b) => {
        const aAsr = a.kind === "asr" ? 1 : 0;
        const bAsr = b.kind === "asr" ? 1 : 0;
        return aAsr - bAsr;
      });

      const track = matching[0];
      try {
        const url = new URL(track.baseUrl, window.location.origin);
        url.searchParams.set("fmt", "json3");
        const res = await origFetch(url.toString(), { credentials: "include" });
        if (res.ok) {
          const text = await res.text();
          if (text && text.trim().length > 0) {
            timedtextCache.set(`${videoId}:${langCode.toLowerCase()}`, text);
            return { ok: true, raw: text, videoId, lang: langCode };
          }
        }
      } catch (_) {}
    }

    // 3. Fallback: trigger YouTube's caption module so its internal fetch gets captured
    const subRes = setSubtitleLanguage("target", langCode);
    if (subRes.ok) {
      // Wait briefly for YouTube's internal timedtext request to complete
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 200));
        for (const [key, raw] of timedtextCache.entries()) {
          if (key.startsWith(`${videoId}:`) && matchesLang(key.split(":")[1], langCode)) {
            return { ok: true, raw, videoId, lang: langCode };
          }
        }
      }
    }

    return { ok: false, reason: `Could not load "${langCode}" subtitles for this video` };
  }

  function getCapabilities(targetLang, sourceLang) {
    const player = getPlayer();
    const audioTracks = player?.getAvailableAudioTracks?.() || [];
    const hasTargetAudio = audioTracks.some((t) =>
      inspectAudioTrack(t).some((s) => matchesLang(s, targetLang))
    );
    const hasSourceAudio = audioTracks.some((t) =>
      inspectAudioTrack(t).some((s) => matchesLang(s, sourceLang))
    );

    return {
      audioTrackCount: audioTracks.length,
      hasTargetAudio,
      hasSourceAudio
    };
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== SOURCE_CONTENT) {
      return;
    }

    const { id, action, payload } = event.data;
    let result = null;

    if (action === "FETCH_SUBTITLES") {
      result = await fetchSubtitlesForLang(payload.langCode);
    } else if (action === "APPLY_PASS") {
      const audioRes = await setAudioLanguage(payload.audioLang);
      const subRes = payload.useCustomSubs
        ? setSubtitleLanguage("off", "")
        : setSubtitleLanguage(payload.subMode, payload.subLang);
      const caps = getCapabilities(payload.targetLang, payload.sourceLang);
      result = { audioRes, subRes, caps };
    } else if (action === "GET_CAPABILITIES") {
      result = getCapabilities(payload.targetLang, payload.sourceLang);
    }

    window.postMessage({ source: SOURCE_PAGE, id, result }, "*");
  });
})();