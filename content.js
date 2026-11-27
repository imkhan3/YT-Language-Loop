(() => {
  const SOURCE_PAGE = "yt-lang-loop-page";
  const SOURCE_CONTENT = "yt-lang-loop-content";

  const DEFAULT_SETTINGS = {
    enabled: true,
    targetLang: "ar",
    sourceLang: "en",
    subtitlesPerLoop: 5,
    numPlaybacks: 3,
    playbacks: [
      { audio: "source", subtitles: "target", speed: 1.0 },
      { audio: "target", subtitles: "target", speed: 0.75 },
      { audio: "target", subtitles: "target", speed: 1.0 }
    ]
  };

  const DEFAULT_TTS_SETTINGS = {
    dubMode: "auto",
    geminiApiKey: "",
    azureKey: "",
    azureRegion: "eastus",
    azureVoice: "ar-SA-HamedNeural",
    overflowBehavior: "speedup"
  };
  const TRANSLATION_BATCH_SIZE = 25;

  let settings = structuredClone(DEFAULT_SETTINGS);
  let ttsSettings = { ...DEFAULT_TTS_SETTINGS };
  let currentVideoId = "";
  let cues = [];
  let blocks = [];
  let videoMetadata = { title: "", channel: "" };
  let videoCacheSource = "none";
  let videoCacheSavedAt = null;
  let videoCacheGeneration = 0;
  let videoCacheSuppressed = false;
  let videoCacheSavePromise = Promise.resolve();
  let translationQueue = [];
  let translationRunning = false;
  let translationGeneration = 0;
  const translationInFlight = new Set();
  let currentBlockIdx = 0;
  let currentPassIdx = 0;
  let loopActive = true;
  let programmaticSeekTarget = null;
  let transitionInProgress = false;
  let ignoreManualSeekUntil = 0;
  let manualSeeking = false;
  let lastTickTime = null;
  let lastProgrammaticSeekTo = null;
  let usingSrt = false;
  let usingGeneratedSrt = false;
  let captionLoadError = "";
  let captionGenerationRequest = 0;
  let generatedCueAttemptVideoId = "";
  let navigationTimer = null;
  let tickTimer = null;
  let reqCounter = 0;
  const pendingRequests = new Map();
  let dubAudio = new Audio();
  dubAudio.preload = "auto";
  dubAudio.preservesPitch = true;
  let preloadAudio = new Audio();
  preloadAudio.preload = "auto";
  preloadAudio.preservesPitch = true;
  let preloadedDubCueKey = "";
  let preloadPromise = null;
  let cancelDubPreload = null;
  let cancelDubAudioLoad = null;
  let dubAudioUnlocked = false;
  let dubAudioUnlocking = false;
  let dubAudioPlayBlocked = false;
  let silentAudioDataUrl = "";
  let dubMuteActive = false;
  let videoMutedBeforeDub = false;
  let dubMutedVideo = null;
  let currentPassResult = null;
  let lastKnownCaps = null;
  let lastAppliedPassConfig = null;
  let lastAppliedPassResult = null;
  let lastPlayerAudio = null;
  let passConfigRevision = 0;
  let passRequestsInFlight = 0;
  let passSettingsRequestId = 0;
  let dubAudioUrls = new Map();
  let dubPrefetchInFlight = new Map();
  let dubFailedCueKeys = new Set();
  let dubDesiredCueKeys = new Set();
  let dubPrefetchSignature = "";
  let dubCacheGeneration = 0;
  let dubPrefetchQueue = [];
  let dubPrefetchRunning = 0;
  let dubPlaybackRequest = 0;
  let activeDubCueIdx = -1;
  let activeDubPassIdx = -1;
  let activeDubCueKey = "";
  let loadedDubCueKey = "";
  let startingDubCueKey = "";
  let finishedDubCueKey = "";
  let waitingForDubEnd = false;
  let waitingForDubBuffer = false;
  let pendingBlockTransition = null;
  let dubFeedback = "";
  let dubFeedbackIsError = false;
  let dubFeedbackTimer = null;
  let lastMissingKeyNotice = "";

  let hud = {
    root: null,
    statusText: null,
    metaText: null,
    toggleBtn: null,
    prevBtn: null,
    repeatBtn: null,
    nextBtn: null,
    loadSrtBtn: null,
    clearSrtBtn: null,
    mobileTabBtn: null,
    subtitleOverlay: null,
    subtitleTargetLine: null,
    subtitleSourceLine: null
  };

  // Inject page-context bridge script ASAP (at document_start)
  function injectPageScript() {
    const script = document.createElement("script");
    script.src = browser.runtime.getURL("injected.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  injectPageScript();

  function sendToPage(action, payload = {}, timeoutMs = 6000) {
    return new Promise((resolve) => {
      const id = ++reqCounter;
      pendingRequests.set(id, resolve);
      window.postMessage({ source: SOURCE_CONTENT, id, action, payload }, "*");

      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          resolve({ ok: false, reason: "Timeout communicating with YouTube player" });
        }
      }, timeoutMs);
    });
  }

  async function loadLanguageSettings() {
    let sourceLang = "en";
    let targetLang = "ar";
    try {
      const stored = await browser.storage.local.get("settings");
      if (typeof stored.settings?.sourceLang === "string" && stored.settings.sourceLang) {
        sourceLang = stored.settings.sourceLang;
      }
      if (typeof stored.settings?.targetLang === "string" && stored.settings.targetLang) {
        targetLang = stored.settings.targetLang;
      }
    } catch (err) {
      console.error("[YT Lang Loop] Failed to load caption languages:", err);
    }
    settings.sourceLang = sourceLang;
    settings.targetLang = targetLang;
    return { sourceLang, targetLang };
  }

  function matchesLanguageCode(candidate, configured) {
    if (typeof candidate !== "string" || typeof configured !== "string") return false;
    const candidateCode = candidate.toLowerCase();
    const configuredCode = configured.toLowerCase();
    return candidateCode === configuredCode || candidateCode.startsWith(`${configuredCode}-`);
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window || !event.data || event.data.source !== SOURCE_PAGE) {
      return;
    }

    const { id, result, type, payload } = event.data;
    if (id && pendingRequests.has(id)) {
      const resolve = pendingRequests.get(id);
      pendingRequests.delete(id);
      resolve(result);
    }

    if (
      type === "TIMEDTEXT_CAPTURED" &&
      payload?.videoId === currentVideoId &&
      !usingSrt &&
      cues.length === 0 &&
      (matchesLanguageCode(payload.lang, settings.targetLang) ||
        matchesLanguageCode(payload.lang, settings.sourceLang))
    ) {
      let segmented = [];
      try {
        const json = JSON.parse(payload.raw);
        if (Array.isArray(json.events)) segmented = segmentRawEvents(json.events);
      } catch (_) {}
      if (segmented.length === 0) {
        segmented = parseSubtitles(payload.raw).map(cue => ({
          start: cue.start,
          end: cue.end,
          sourceText: cue.text,
          targetText: ""
        }));
      }
      if (segmented.length > 0) {
        cues = segmented;
        videoCacheSource = "live";
        captionLoadError = "";
        rebuildBlocksAndSync();
        if (ttsSettings.geminiApiKey.trim()) {
          scheduleTranslationBatches();
        } else if (cues.some(cueNeedsGeneratedTranslation)) {
          generateBilingualCuesForDubbing(cues);
        }
        await saveVideoCache();
        updateHud();
      }
    }
  });

  // Parse YouTube JSON3 or XML subtitle formats into [{ start, end, text }] (seconds)
  function parseSubtitles(raw) {
    if (!raw || typeof raw !== "string") return [];
    const trimmed = raw.trim();

    // Format 1: JSON3
    if (trimmed.startsWith("{")) {
      try {
        const json = JSON.parse(trimmed);
        const events = json.events || [];
        const out = [];
        for (const ev of events) {
          if (!ev.segs || typeof ev.tStartMs !== "number") continue;
          const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
          if (!text) continue;
          const start = ev.tStartMs / 1000;
          const dur = (ev.dDurationMs || 2000) / 1000;
          out.push({ start, end: start + dur, text });
        }
        return normalizeCues(out);
      } catch (_) {}
    }

    // Format 2: XML (<text> or <p>)
    try {
      const doc = new DOMParser().parseFromString(trimmed, "text/xml");
      const out = [];

      const textNodes = doc.querySelectorAll("text");
      if (textNodes.length > 0) {
        for (const node of textNodes) {
          const start = parseFloat(node.getAttribute("start") || "0");
          const dur = parseFloat(node.getAttribute("dur") || "2");
          const text = (node.textContent || "").replace(/\s+/g, " ").trim();
          if (text) out.push({ start, end: start + dur, text });
        }
        return normalizeCues(out);
      }

      const pNodes = doc.querySelectorAll("p");
      for (const node of pNodes) {
        const t = parseFloat(node.getAttribute("t") || "0") / 1000;
        const d = parseFloat(node.getAttribute("d") || "2000") / 1000;
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (text) out.push({ start: t, end: t + d, text });
      }
      return normalizeCues(out);
    } catch (_) {}

    return [];
  }

  function normalizeCues(list) {
    list.sort((a, b) => a.start - b.start);
    // Prevent overlapping durations from causing premature jumps
    for (let i = 0; i < list.length - 1; i++) {
      if (list[i].end > list[i + 1].start + 0.5) {
        list[i].end = Math.max(list[i].start + 0.3, list[i + 1].start);
      }
    }
    return list;
  }

  function cleanCaptionText(text) {
    if (typeof text !== "string") return "";
    const cleaned = text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return "";
    if (/^(?:\[|\(|♪).*(?:\]|\)|♪)$/.test(cleaned)) return "";
    if (/^(?:\[[^\]]+\]|[\u266A].*[\u266A])$/.test(cleaned)) return "";
    return cleaned;
  }

  function segmentRawEvents(events) {
    if (!Array.isArray(events)) return [];

    const fragments = [];
    for (const ev of events) {
      if (!ev?.segs || typeof ev.tStartMs !== "number") continue;
      const text = cleanCaptionText(ev.segs.map(seg => seg?.utf8 || "").join(""));
      if (!text) continue;
      const start = ev.tStartMs / 1000;
      const end = start + ((ev.dDurationMs || 2000) / 1000);
      fragments.push({ start, end: Math.max(end, start + 0.1), text });
    }

    const segments = [];
    let current = [];
    const flush = () => {
      if (current.length === 0) return;
      const sourceText = current.map(fragment => fragment.text).join(" ").replace(/\s+/g, " ").trim();
      if (sourceText) {
        segments.push({
          start: current[0].start,
          end: current[current.length - 1].end,
          sourceText,
          targetText: ""
        });
      }
      current = [];
    };

    const splitAtIndex = (fragmentIndex) => {
      const cut = Math.max(1, Math.min(fragmentIndex, current.length));
      const before = current.slice(0, cut);
      const after = current.slice(cut);
      if (before.length > 0) {
        current = before;
        flush();
      }
      current = after;
    };

    for (const fragment of fragments) {
      if (current.length > 0) {
        const previousEnd = current[current.length - 1].end;
        if (fragment.start - previousEnd > 1.5) flush();
      }
      current.push(fragment);

      const sourceText = current.map(item => item.text).join(" ");
      const duration = current[current.length - 1].end - current[0].start;
      const wordCount = sourceText.split(/\s+/).filter(Boolean).length;
      const endsInSentence = /[.!?。！？۔؟]$/.test(sourceText.trim());

      if (endsInSentence && (duration >= 3.5 || wordCount >= 7)) {
        flush();
        continue;
      }

      if (duration > 13 || wordCount > 20) {
        let cutIndex = -1;
        for (let i = 0; i < current.length - 1; i++) {
          if (/[.!?。！？۔؟]$/.test(current[i].text.trim())) {
            cutIndex = i + 1;
          }
        }
        for (let i = 0; i < current.length; i++) {
          if (cutIndex < 0 && /[,;，；、]$/.test(current[i].text.trim()) && i < current.length - 1) {
            cutIndex = i + 1;
          }
        }

        if (cutIndex < 0) {
          let largestGap = -1;
          for (let i = 1; i < current.length; i++) {
            const gap = current[i].start - current[i - 1].end;
            if (gap > largestGap) {
              largestGap = gap;
              cutIndex = i;
            }
          }
        }

        if (cutIndex > 0) splitAtIndex(cutIndex);
        else flush();
        continue;
      }

      if (duration >= 8) {
        let cutIndex = -1;
        for (let i = 0; i < current.length; i++) {
          if (/[,;，；、]$/.test(current[i].text.trim()) && i < current.length - 1) {
            cutIndex = i + 1;
          }
        }
        if (cutIndex < 0) {
          let largestGap = 0;
          let largestGapIndex = -1;
          for (let i = 1; i < current.length; i++) {
            const gap = current[i].start - current[i - 1].end;
            if (gap > largestGap) {
              largestGap = gap;
              largestGapIndex = i;
            }
          }
          if (largestGap > 0.35) cutIndex = largestGapIndex;
        }
        if (cutIndex > 0) splitAtIndex(cutIndex);
      }
    }
    flush();

    return normalizeCues(segments);
  }

  function parseSrtTimestamp(value) {
    const match = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value);
    if (!match) return null;
    const [, hours, minutes, seconds, milliseconds] = match;
    return (
      Number(hours) * 3600 +
      Number(minutes) * 60 +
      Number(seconds) +
      Number(milliseconds) / 1000
    );
  }

  function parseSrt(raw) {
    if (typeof raw !== "string" || !raw.trim()) return [];

    const rawCues = [];
    const cueBlocks = raw.replace(/^\uFEFF/, "").trim().split(/\r?\n\s*\r?\n/);
    let order = 0;
    for (const cueBlock of cueBlocks) {
      const lines = cueBlock.split(/\r?\n/);
      if (lines.length < 3 || !/^\d+$/.test(lines[0].trim())) continue;

      const timing = /^(\d{2}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{2}:\d{2}:\d{2}[,.]\d{3})$/.exec(
        lines[1].trim()
      );
      if (!timing) continue;

      const start = parseSrtTimestamp(timing[1]);
      const end = parseSrtTimestamp(timing[2]);
      const text = lines.slice(2).join("\n").trim();
      if (start === null || end === null || end <= start || !text) continue;
      rawCues.push({ start, end, text, order: order++ });
    }

    rawCues.sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order);
    const groups = [];
    for (const cue of rawCues) {
      let group = groups[groups.length - 1];
      if (
        !group ||
        Math.abs(cue.start - group.start) > 0.05 ||
        Math.abs(cue.end - group.end) > 0.05
      ) {
        group = { start: cue.start, end: cue.end, cues: [] };
        groups.push(group);
      }
      group.cues.push(cue);
    }

    return normalizeCues(
      groups.map((group) => {
        const targetLang = settings.targetLang || "";
        const targetScriptCues = ["ar", "he", "fa", "ur"].includes(targetLang)
          ? group.cues.filter((cue) => /[\u0590-\u08FF]/.test(cue.text))
          : [];
        const sourceScriptCues = targetScriptCues.length > 0
          ? group.cues.filter((cue) => !targetScriptCues.includes(cue))
          : [];
        let sourceText;
        let targetText;

        if (group.cues.length > 1 && targetScriptCues.length === 0) {
          sourceText = group.cues[0].text;
          targetText = group.cues[1].text;
          for (const cue of group.cues.slice(2)) {
            targetText += `\n${cue.text}`;
          }
        } else if (targetScriptCues.length > 0) {
          sourceText = sourceScriptCues.map((cue) => cue.text).join("\n");
          targetText = targetScriptCues.map((cue) => cue.text).join("\n");
        } else {
          sourceText = group.cues[0].text;
          targetText = group.cues.slice(1).map((cue) => cue.text).join("\n");
        }

        return {
          start: Math.min(...group.cues.map((cue) => cue.start)),
          end: Math.max(...group.cues.map((cue) => cue.end)),
          sourceText,
          targetText
        };
      })
    );
  }

  async function reloadGeneratedCaptions(videoId, languages = null, preservePassIdx = null) {
    const keepManualSrt = usingSrt && !usingGeneratedSrt;
    const requestId = ++captionGenerationRequest;
    const { sourceLang, targetLang } = languages || (await loadLanguageSettings());
    let reason = "Could not generate bilingual subtitles";

    for (let attempt = 0; attempt < 3; attempt++) {
      if (
        requestId !== captionGenerationRequest ||
        currentVideoId !== videoId ||
        getVideoIdFromUrl() !== videoId
      ) {
        return { ok: false, canceled: true };
      }

      const result = await sendToPage(
        "GENERATE_BILINGUAL_SRT",
        { sourceLang, targetLang },
        12000
      );
      if (
        requestId !== captionGenerationRequest ||
        getVideoIdFromUrl() !== videoId
      ) {
        return { ok: false, canceled: true };
      }

      if (result?.ok && typeof result.srt === "string") {
        const segments = parseSrt(result.srt);
        if (segments.length === 0) {
          reason = "Generated captions did not contain valid SRT cues";
          break;
        }

        if (keepManualSrt) {
          return { ok: true, manual: true, generatedSegments: segments.length };
        }

        usingSrt = false;
        usingGeneratedSrt = true;
        captionLoadError = "";
        if (preservePassIdx === null) {
          cues = segments;
          rebuildBlocksAndSync();
        } else {
          stopDubPlayback();
          clearDubAudioUrls();
          if (cues.length > 0) {
            for (const cue of cues) {
              const midpoint = (cue.start + cue.end) / 2;
              const overlapMatches = segments.filter(segment => {
                const overlap = Math.min(cue.end, segment.end) - Math.max(cue.start, segment.start);
                return overlap > 0 || (midpoint >= segment.start && midpoint < segment.end);
              });
              cue.targetText = overlapMatches
                .map(segment => segment.targetText)
                .filter(Boolean)
                .join("\n")
                .trim();
            }
          } else {
            cues = segments;
            blocks = buildBlocks(cues, settings.subtitlesPerLoop || 5);
            currentBlockIdx = findBlockIndexForTime(getVideoElement()?.currentTime || 0);
          }
          currentPassIdx = Math.min(currentPassIdx, (settings.numPlaybacks || 1) - 1);
          notifyTranscriptUpdated();
          if (settings.enabled && loopActive && blocks.length > 0) {
            await applyPassSettings(currentPassIdx);
          }
          updateHud();
          renderCustomSubtitle();
        }
        updateHud();
        return { ok: true, segments: segments.length };
      }

      reason = result?.reason || reason;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 600));
    }

    if (!keepManualSrt) {
      captionLoadError = reason;
      updateHud();
    }
    console.error("[YT Lang Loop] Failed to generate bilingual subtitles:", reason);
    return { ok: false, reason };
  }

  function isStoredSrt(value) {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every(
        (segment) =>
          Number.isFinite(segment.start) &&
          Number.isFinite(segment.end) &&
          segment.end > segment.start &&
          typeof segment.sourceText === "string" &&
          typeof segment.targetText === "string"
      )
    );
  }

  async function fetchSingleLanguageCaptions(videoId, requestId, maxAttempts = 8) {
    const languages = [...new Set([settings.targetLang, settings.sourceLang].filter(Boolean))];
    let reason = `No "${settings.targetLang}" or "${settings.sourceLang}" captions found`;
    const sourceFirstLanguages = [settings.sourceLang, settings.targetLang].filter(Boolean);
    const orderedLanguages = [...new Set([...sourceFirstLanguages, ...languages])];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (requestId !== captionGenerationRequest || getVideoIdFromUrl() !== videoId) {
        return { ok: false, canceled: true };
      }
      if (usingSrt) return { ok: true, manual: true, segments: cues.length };
      if (cues.length > 0) return { ok: true, segments: cues.length };

      for (const langCode of orderedLanguages) {
        const result = await sendToPage("FETCH_SOURCE_EVENTS", { langCode });
        if (requestId !== captionGenerationRequest || getVideoIdFromUrl() !== videoId) {
          return { ok: false, canceled: true };
        }
        if (usingSrt) return { ok: true, manual: true, segments: cues.length };
        if (cues.length > 0) return { ok: true, segments: cues.length };

        if (result?.ok && result.raw) {
          videoMetadata = {
            title: typeof result.metadata?.title === "string" ? result.metadata.title : "",
            channel: typeof result.metadata?.channel === "string" ? result.metadata.channel : ""
          };
          const segmented = Array.isArray(result.events) && result.events.length > 0
            ? segmentRawEvents(result.events)
            : (() => {
              const parsed = parseSubtitles(result.raw);
              return parsed.map(cue => ({
                start: cue.start,
                end: cue.end,
                sourceText: cue.text,
                targetText: ""
              }));
            })();
          if (segmented.length > 0) {
            cues = segmented;
            videoCacheSource = "live";
            captionLoadError = "";
            rebuildBlocksAndSync();
            if (ttsSettings.geminiApiKey.trim()) {
              scheduleTranslationBatches();
            } else if (cues.some(cueNeedsGeneratedTranslation)) {
              generateBilingualCuesForDubbing(cues);
            }
            await saveVideoCache();
            updateHud();
            return { ok: true, segments: cues.length };
          }
          reason = `Could not parse "${langCode}" YouTube captions`;
        } else if (result?.reason) {
          reason = result.reason;
        }
      }

      if (attempt < maxAttempts - 1) await new Promise((resolve) => setTimeout(resolve, 600));
    }

    captionLoadError = reason;
    updateHud();
    return { ok: false, reason };
  }

  function buildBlocks(cueList, size) {
    const result = [];
    for (let i = 0; i < cueList.length; i += size) {
      const slice = cueList.slice(i, i + size);
      const lastCue = slice[slice.length - 1];
      const nextCue = cueList[i + size];
      result.push({
        index: result.length,
        subStartNum: i + 1,
        subEndNum: i + slice.length,
        start: Math.max(0, slice[0].start - 0.03),
        end: nextCue
          ? Math.min(lastCue.end + 0.04, nextCue.start - 0.02)
          : lastCue.end + 0.04
      });
    }
    return result;
  }

  function getVideoElement() {
    return document.querySelector("video.html5-main-video") || document.querySelector("video");
  }

  function getVideoIdFromUrl() {
    try {
      const url = new URL(window.location.href);
      if (url.pathname !== "/watch") return "";
      return url.searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  function computePassSpeed(passIdx) {
    const pass = settings.playbacks?.[passIdx];
    let raw = pass?.speed;
    if (typeof raw !== "number" || Number.isNaN(raw)) {
      const first = typeof settings.firstSpeed === "number" ? settings.firstSpeed : 1.0;
      const inc = typeof settings.speedIncrement === "number" ? settings.speedIncrement : 0;
      raw = first + passIdx * inc;
    }
    const clamped = Math.min(2.0, Math.max(0.25, raw));
    return Math.round(clamped * 100) / 100;
  }

  function getPassConfig(passIdx) {
    const p = settings.playbacks?.[passIdx] || { audio: "target", subtitles: "target" };
    const audioLang = p.audio === "source" ? settings.sourceLang : settings.targetLang;
    const subMode = p.subtitles;
    const subLang =
      subMode === "source"
        ? settings.sourceLang
        : subMode === "target"
          ? settings.targetLang
          : "";
    return {
      audioMode: p.audio,
      audioLang,
      subMode,
      subLang,
      speed: computePassSpeed(passIdx)
    };
  }

  function showDubFeedback(message, isError = false, durationMs = isError ? 6000 : 3500) {
    dubFeedback = `AI Dub: ${message}`;
    dubFeedbackIsError = isError;
    clearTimeout(dubFeedbackTimer);
    if (durationMs > 0) {
      dubFeedbackTimer = setTimeout(() => {
        dubFeedback = "";
        dubFeedbackIsError = false;
        updateHud(currentPassResult?.caps, currentPassResult?.audioRes, currentPassResult?.subRes);
      }, durationMs);
    }
    updateHud(currentPassResult?.caps, currentPassResult?.audioRes, currentPassResult?.subRes);
  }

  function clearDubFeedback() {
    clearTimeout(dubFeedbackTimer);
    dubFeedback = "";
    dubFeedbackIsError = false;
    updateHud(currentPassResult?.caps, currentPassResult?.audioRes, currentPassResult?.subRes);
  }

  function getSilentAudioDataUrl() {
    if (silentAudioDataUrl) return silentAudioDataUrl;
    const sampleRate = 8000;
    const sampleCount = 640;
    const dataSize = sampleCount * 2;
    const bytes = new Uint8Array(44 + dataSize);
    const view = new DataView(bytes.buffer);
    const writeText = (offset, value) => {
      for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
    };

    writeText(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, dataSize, true);

    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    silentAudioDataUrl = `data:audio/wav;base64,${btoa(binary)}`;
    return silentAudioDataUrl;
  }

  function unlockDubAudio() {
    if (dubAudioUnlocked || dubAudioUnlocking) return;
    if (dubAudio.src && !dubAudio.paused && dubAudio.src !== silentAudioDataUrl) return;

    dubAudioUnlocking = true;
    const audio = dubAudio;
    const previousMuted = audio.muted;
    const previousVolume = audio.volume;
    const previousSrc = audio.src;
    const previousTime = audio.currentTime;
    const requestId = dubPlaybackRequest;
    const keepCurrentSource = Boolean(loadedDubCueKey && previousSrc);
    if (!keepCurrentSource) audio.src = getSilentAudioDataUrl();
    audio.muted = true;
    audio.volume = 0;

    const finishUnlock = (unlocked) => {
      if (requestId === dubPlaybackRequest) {
        audio.pause?.();
        if (keepCurrentSource) {
          audio.currentTime = previousTime;
        } else {
          audio.currentTime = 0;
          audio.removeAttribute?.("src");
          audio.load?.();
        }
      }
      audio.muted = previousMuted;
      audio.volume = requestId === dubPlaybackRequest
        ? previousVolume
        : (getVideoElement()?.volume ?? previousVolume);
      if (unlocked) {
        dubAudioUnlocked = true;
        dubAudioPlayBlocked = false;
        const video = getVideoElement();
        if (video && !video.paused) syncDubPlayback(video);
      }
    };

    let playPromise;
    try {
      playPromise = audio.play?.();
    } catch (error) {
      playPromise = Promise.reject(error);
    }
    Promise.resolve(playPromise).then(
      () => finishUnlock(true),
      () => finishUnlock(false)
    ).finally(() => {
      dubAudioUnlocking = false;
    });
  }

  function clearDubPreload() {
    if (cancelDubPreload) cancelDubPreload();
    preloadedDubCueKey = "";
    preloadPromise = null;
    preloadAudio.pause?.();
    try {
      preloadAudio.currentTime = 0;
    } catch (_) {}
  }

  function stopDubPlayback(resumeAfterWait = false) {
    const shouldResumeVideo = (waitingForDubEnd || waitingForDubBuffer) && resumeAfterWait;
    dubPlaybackRequest += 1;
    if (cancelDubAudioLoad) cancelDubAudioLoad();
    dubAudio.pause?.();
    try {
      dubAudio.currentTime = 0;
    } catch (_) {}
    clearDubPreload();
    activeDubCueIdx = -1;
    activeDubPassIdx = -1;
    activeDubCueKey = "";
    loadedDubCueKey = "";
    startingDubCueKey = "";
    finishedDubCueKey = "";
    waitingForDubEnd = false;
    waitingForDubBuffer = false;
    pendingBlockTransition = null;
    syncLoopTickerState();
    dubPrefetchSignature = "";
    dubPrefetchQueue = [];
    dubDesiredCueKeys = new Set();
    dubFailedCueKeys.clear();
    if (shouldResumeVideo) {
      const video = getVideoElement();
      if (video?.paused) {
        video.play().catch(error => {
          showDubFeedback(error.message || "Could not resume video after stopping the dub", true);
        });
      }
    }
  }

  function clearDubAudioUrls() {
    dubCacheGeneration += 1;
    clearDubPreload();
    for (const url of dubAudioUrls.values()) {
      URL.revokeObjectURL(url);
    }
    dubAudioUrls.clear();
    dubPrefetchInFlight.clear();
    dubFailedCueKeys.clear();
    dubDesiredCueKeys.clear();
    dubPrefetchQueue = [];
    dubPrefetchSignature = "";
  }

  function setDubMuteActive(active, video, userMutedOverride = null, resumeAfterWait = true) {
    if (active) {
      if (!video) return;
      if (!dubMuteActive) {
        videoMutedBeforeDub = userMutedOverride === null ? video.muted : userMutedOverride;
        dubMutedVideo = video;
      }
      dubMuteActive = true;
      video.muted = true;
      return;
    }

    const mutedVideo = dubMutedVideo || video;
    if (dubMuteActive && mutedVideo) {
      dubMuteActive = false;
      mutedVideo.muted = videoMutedBeforeDub;
      dubMutedVideo = null;
    } else {
      dubMuteActive = false;
    }
    stopDubPlayback(resumeAfterWait);
  }

  function isAiDubCandidate(passResult = currentPassResult) {
    const cfg = getPassConfig(currentPassIdx);
    if (
      !settings.enabled ||
      !loopActive ||
      cfg.audioMode !== "target" ||
      ttsSettings.dubMode === "off"
    ) {
      return false;
    }
    const noNativeTargetAudio = Boolean(passResult) &&
      (!passResult?.audioRes?.ok || passResult?.caps?.audioTrackCount <= 1 ||
        (passResult?.caps && !passResult.caps.hasTargetAudio));
    return ttsSettings.dubMode === "force" || noNativeTargetAudio;
  }

  function shouldUseAiDub(passResult = currentPassResult) {
    return isAiDubCandidate(passResult) && Boolean(ttsSettings.azureKey.trim());
  }

  function willAiDubHandlePass(passIdx, caps) {
    return Boolean(
      settings.enabled &&
      loopActive &&
      getPassConfig(passIdx).audioMode === "target" &&
      ttsSettings.dubMode !== "off" &&
      ttsSettings.azureKey.trim() &&
      (ttsSettings.dubMode === "force" ||
        (caps && !(caps.audioTrackCount > 1 && caps.hasTargetAudio)))
    );
  }

  function shouldPrefetchAiDub(passResult = currentPassResult) {
    if (
      !settings.enabled ||
      !loopActive ||
      ttsSettings.dubMode === "off" ||
      !ttsSettings.azureKey.trim() ||
      !(settings.playbacks || []).slice(0, settings.numPlaybacks || 1)
        .some(pass => pass.audio === "target")
    ) return false;
    if (ttsSettings.dubMode === "force") return true;
    const caps = passResult?.caps ||
      (lastKnownCaps?.videoId === currentVideoId ? lastKnownCaps.caps : null);
    return !(caps?.audioTrackCount > 1 && caps?.hasTargetAudio);
  }

  function syncDubActivation(passResult, userMutedOverride = null) {
    const video = getVideoElement();
    const active = shouldUseAiDub(passResult);
    setDubMuteActive(active, video, userMutedOverride);

    if (
      !active &&
      isAiDubCandidate(passResult) &&
      !ttsSettings.azureKey.trim()
    ) {
      const noticeKey = `${currentVideoId}:${currentPassIdx}`;
      if (lastMissingKeyNotice !== noticeKey) {
        lastMissingKeyNotice = noticeKey;
        showDubFeedback("Azure Speech key is missing", true);
      }
    } else if (active) {
      lastMissingKeyNotice = "";
    }
    if (shouldPrefetchAiDub(passResult)) ensureDubPrefetchForCurrentBlock();
  }

  function cueTargetText(cue) {
    if (typeof cue?.targetText === "string" && cue.targetText.trim()) {
      return cue.targetText.trim();
    }
    if (usingSrt) return "";
    return "";
  }

  function cueNeedsGeneratedTranslation(cue) {
    return (
      !usingSrt &&
      !(typeof cue?.targetText === "string" && cue.targetText.trim())
    );
  }

  async function generateBilingualCuesForDubbing(cuesToCheck) {
    if (usingSrt || !currentVideoId || !cuesToCheck.some(cueNeedsGeneratedTranslation)) return;

    if (ttsSettings.geminiApiKey.trim()) {
      scheduleTranslationBatches();
      return;
    }

    if (generatedCueAttemptVideoId === currentVideoId) return;
    const videoId = currentVideoId;
    const passIdx = currentPassIdx;
    generatedCueAttemptVideoId = videoId;
    showDubFeedback("Loading target captions…");
    const result = await reloadGeneratedCaptions(videoId, null, passIdx);
    if (!result?.ok && !result?.canceled && currentVideoId === videoId) {
      showDubFeedback(result?.reason || "Could not load target captions", true);
    }
  }

  function saveVideoCache() {
    if (!currentVideoId || usingSrt || videoCacheSuppressed || cues.length === 0) return Promise.resolve();
    const videoId = currentVideoId;
    const generation = videoCacheGeneration;
    const sourceLang = settings.sourceLang;
    const targetLang = settings.targetLang;
    const snapshot = cues.map(cue => ({
      start: cue.start,
      end: cue.end,
      sourceText: cue.sourceText || "",
      targetText: cue.targetText || ""
    }));
    const metadata = { ...videoMetadata };

    videoCacheSavePromise = videoCacheSavePromise.then(async () => {
      if (videoId !== currentVideoId || generation !== videoCacheGeneration || videoCacheSuppressed) return;
      const result = await browser.runtime.sendMessage({
        type: "YTLL_VIDEO_CACHE_PUT",
        videoId,
        sourceLang,
        targetLang,
        cues: snapshot,
        metadata
      });
      if (!result?.ok) throw new Error(result?.reason || "Could not save this video's caption cache.");
      if (videoId === currentVideoId && generation === videoCacheGeneration && !videoCacheSuppressed) {
        videoCacheSavedAt = result.savedAt || Date.now();
        if (videoCacheSource === "none") videoCacheSource = "live";
        updateHud();
        notifyTranscriptUpdated();
      }
    }).catch(error => {
      if (videoId === currentVideoId) {
        console.error("[YT Lang Loop] Failed to save video cache:", error);
        showDubFeedback(error.message || "Could not save video cache", true);
      }
    });
    return videoCacheSavePromise;
  }

  async function invalidatePendingTranslationsAndCacheWrites() {
    translationGeneration += 1;
    translationQueue = [];
    translationInFlight.clear();
    videoCacheGeneration += 1;
    await videoCacheSavePromise;
  }

  function scheduleTranslationBatches() {
    if (
      usingSrt ||
      !currentVideoId ||
      !ttsSettings.geminiApiKey.trim() ||
      cues.length === 0
    ) {
      return;
    }

    const currentBlock = blocks[currentBlockIdx];
    if (!currentBlock) return;
    const blockStart = currentBlock.subStartNum - 1;
    const blockEnd = currentBlock.subEndNum;
    const batchIds = new Set();
    for (let cueIndex = blockStart; cueIndex < blockEnd; cueIndex++) {
      batchIds.add(Math.floor(cueIndex / TRANSLATION_BATCH_SIZE));
    }

    const firstBatchId = Math.floor(blockStart / TRANSLATION_BATCH_SIZE);
    const firstBatchEnd = Math.min(cues.length, (firstBatchId + 1) * TRANSLATION_BATCH_SIZE);
    if (firstBatchEnd - blockEnd <= 5 && firstBatchEnd < cues.length) {
      batchIds.add(firstBatchId + 1);
    }
    const nextBlock = blocks[currentBlockIdx + 1];
    if (nextBlock) {
      const nextBlockStart = nextBlock.subStartNum - 1;
      const nextBatchId = Math.floor(nextBlockStart / TRANSLATION_BATCH_SIZE);
      if (nextBatchId > firstBatchId) batchIds.add(nextBatchId);
    }

    translationQueue = Array.from(batchIds)
      .sort((a, b) => a - b)
      .map(id => ({
        id,
        start: id * TRANSLATION_BATCH_SIZE,
        end: Math.min(cues.length, (id + 1) * TRANSLATION_BATCH_SIZE)
      }))
      .filter(batch =>
        !translationInFlight.has(batch.id) &&
        cues.slice(batch.start, batch.end).some(cueNeedsGeneratedTranslation)
      );

    pumpTranslationQueue();
  }

  async function pumpTranslationQueue() {
    if (translationRunning) return;
    translationRunning = true;
    try {
      while (translationQueue.length > 0) {
        const batch = translationQueue.shift();
        if (translationInFlight.has(batch.id)) continue;
        if (!cues.slice(batch.start, batch.end).some(cueNeedsGeneratedTranslation)) continue;

        const generation = translationGeneration;
        const videoId = currentVideoId;
        const cueList = cues;
        translationInFlight.add(batch.id);
        try {
          const batchItems = [];
          for (let cueIndex = batch.start; cueIndex < batch.end; cueIndex++) {
            const cue = cueList[cueIndex];
            if (!cue || !cueNeedsGeneratedTranslation(cue)) continue;
            const text = typeof cue.sourceText === "string"
              ? cue.sourceText.trim()
              : (typeof cue.text === "string" ? cue.text.trim() : "");
            if (!text) continue;
            batchItems.push({
              index: cueIndex,
              text,
              prevContext: cueList
                .slice(Math.max(0, cueIndex - 2), cueIndex)
                .map(previous => typeof previous.sourceText === "string" ? previous.sourceText.trim() : "")
                .filter(Boolean)
            });
          }
          if (batchItems.length > 0) {
            const result = await browser.runtime.sendMessage({
              type: "YTLL_TRANSLATE_BATCH",
              items: batchItems,
              sourceLang: settings.sourceLang,
              targetLang: settings.targetLang
            });
            if (!result?.ok) throw new Error(result?.reason || "Translation batch failed");
            if (generation === translationGeneration && videoId === currentVideoId && cueList === cues) {
              for (const item of batchItems) {
                const translatedText = result.translations?.[item.index];
                if (cueList[item.index] && typeof translatedText === "string" && translatedText.trim()) {
                  cueList[item.index].targetText = translatedText.trim();
                }
              }
              notifyTranscriptUpdated();
            }
          }
        } catch (error) {
          if (generation === translationGeneration && videoId === currentVideoId && cueList === cues) {
            showDubFeedback(error.message || "Translation failed", true);
          }
        } finally {
          translationInFlight.delete(batch.id);
        }

        if (generation === translationGeneration && videoId === currentVideoId) {
          await saveVideoCache();
          renderCustomSubtitle();
          ensureDubPrefetchForCurrentBlock();
          updateHud();
        }
      }
    } finally {
      translationRunning = false;
      if (translationQueue.length > 0) pumpTranslationQueue();
    }
  }

  function makeDubCueKey(cue, cueIdx, text) {
    return `${currentVideoId}::${ttsSettings.azureVoice}::${cueIdx}::${cue.start}::${text}`;
  }

  function audioBase64ToBlob(audioBase64, mimeType) {
    const binary = atob(audioBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType || "audio/mpeg" });
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function findBatchSilences(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const minFrames = Math.ceil(sampleRate * 0.55);
    const channels = Array.from({ length: audioBuffer.numberOfChannels }, (_, i) => audioBuffer.getChannelData(i));
    const runs = [];
    let runStart = -1;

    for (let frame = 0; frame < audioBuffer.length; frame++) {
      let peak = 0;
      for (const channel of channels) {
        peak = Math.max(peak, Math.abs(channel[frame]));
      }
      if (peak < 0.005) {
        if (runStart < 0) runStart = frame;
      } else if (runStart >= 0) {
        if (frame - runStart >= minFrames) {
          runs.push({ start: runStart, end: frame });
        }
        runStart = -1;
      }
    }
    if (runStart >= 0 && audioBuffer.length - runStart >= minFrames) {
      runs.push({ start: runStart, end: audioBuffer.length });
    }
    return runs;
  }

  function encodeMonoWav(audioBuffer, startFrame, endFrame) {
    const sampleRate = audioBuffer.sampleRate;
    const frameCount = endFrame - startFrame;
    if (frameCount <= 0) return null;
    const channelData = Array.from(
      { length: audioBuffer.numberOfChannels },
      (_, i) => audioBuffer.getChannelData(i)
    );
    const buffer = new ArrayBuffer(44 + frameCount * 2);
    const view = new DataView(buffer);
    const writeString = (offset, value) => {
      for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + frameCount * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, frameCount * 2, true);
    for (let i = 0; i < frameCount; i++) {
      let sample = 0;
      for (const channel of channelData) sample += channel[startFrame + i] / channelData.length;
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    }
    return buffer;
  }

  async function splitBatchAudio(batchAudioBase64, itemCount) {
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineContext || itemCount < 2) return null;
    const decoder = new OfflineContext(1, 1, 24000);
    const decoded = await decoder.decodeAudioData(base64ToArrayBuffer(batchAudioBase64));
    let silences = findBatchSilences(decoded)
      .filter(silence => silence.start > 0 && silence.end < decoded.length);
    if (silences.length < itemCount - 1) return null;
    if (silences.length > itemCount - 1) {
      silences = silences
        .filter(silence => silence.end - silence.start >= decoded.sampleRate * 0.75)
        .sort((a, b) => (b.end - b.start) - (a.end - a.start))
        .slice(0, itemCount - 1);
      if (silences.length < itemCount - 1) return null;
    }

    const selected = silences.sort((a, b) => a.start - b.start);
    const paddingFrames = Math.floor(decoded.sampleRate * 0.02);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    const isSilentFrame = frame => channels.every(channel => Math.abs(channel[frame]) < 0.005);
    let firstSound = 0;
    while (firstSound < decoded.length && isSilentFrame(firstSound)) firstSound++;
    let lastSound = decoded.length;
    while (lastSound > firstSound && isSilentFrame(lastSound - 1)) lastSound--;
    const ranges = [];
    let startFrame = Math.max(0, firstSound - paddingFrames);
    for (const silence of selected) {
      const endFrame = Math.min(decoded.length, silence.start + paddingFrames);
      ranges.push([startFrame, endFrame]);
      startFrame = Math.max(0, silence.end - paddingFrames);
    }
    ranges.push([startFrame, Math.min(decoded.length, lastSound + paddingFrames)]);
    if (ranges.length !== itemCount || ranges.some(([start, end]) => end - start < decoded.sampleRate * 0.08)) {
      return null;
    }
    return ranges.map(([start, end]) => encodeMonoWav(decoded, start, end));
  }

  function markDubCueFailed(entry, error) {
    if (dubCacheGeneration !== entry.generation ||
        entry.videoId !== currentVideoId ||
        !dubDesiredCueKeys.has(entry.key)) return;
    dubFailedCueKeys.add(entry.key);
    showDubFeedback(error.message || "Cue synthesis failed", true);
    console.error("[YT Lang Loop] AI dub synthesis failed:", error);
    if (entry.key === activeDubCueKey && waitingForDubBuffer) {
      waitingForDubBuffer = false;
      syncLoopTickerState();
      const video = getVideoElement();
      if (video?.paused) {
        video.play().catch(playError => {
          showDubFeedback(playError.message || "Could not resume video after buffering failed", true);
        });
      }
    }
  }

  function storeDubCueAudio(entry, audioBase64, mimeType) {
    if (
      entry.generation !== dubCacheGeneration ||
      entry.videoId !== currentVideoId ||
      !dubDesiredCueKeys.has(entry.key)
    ) return;
    const url = URL.createObjectURL(audioBase64ToBlob(audioBase64, mimeType));
    const previousUrl = dubAudioUrls.get(entry.key);
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    dubAudioUrls.set(entry.key, url);
    if (entry.key === activeDubCueKey && waitingForDubBuffer) {
      startDubCue(cues[entry.cueIdx], entry.key, getVideoElement());
    } else if (transitionInProgress && entry.cueIdx === blocks[currentBlockIdx]?.subStartNum - 1 &&
        getPassConfig(currentPassIdx).audioMode === "target" && shouldPrefetchAiDub()) {
      preloadNextDubCue(entry.cueIdx - 1);
    } else if (loadedDubCueKey && activeDubCueIdx >= 0) {
      preloadNextDubCue(activeDubCueIdx);
    }
  }

  async function synthesizeCueIndividually(entry) {
    const result = await browser.runtime.sendMessage({
      type: "YTLL_TTS_SYNTHESIZE",
      text: entry.text,
      voice: ttsSettings.azureVoice
    });
    if (!result?.ok || !result.audioBase64) {
      throw new Error(result?.reason || "Could not synthesize this cue.");
    }
    storeDubCueAudio(entry, result.audioBase64, result.mimeType);
  }

  async function prefetchDubBatch(entries) {
    const generation = dubCacheGeneration;
    const videoId = currentVideoId;
    const activeEntries = entries.map(entry => ({ ...entry, generation, videoId }));
    try {
      const result = await browser.runtime.sendMessage({
        type: "YTLL_TTS_SYNTHESIZE_BATCH",
        items: activeEntries.map(entry => ({ key: entry.key, text: entry.text })),
        voice: ttsSettings.azureVoice
      });
      if (!result?.ok) throw new Error(result?.reason || "Could not synthesize these cues.");
      if (generation !== dubCacheGeneration || videoId !== currentVideoId) return;

      const byKey = new Map(activeEntries.map(entry => [entry.key, entry]));
      for (const cached of result.cachedItems || []) {
        const entry = byKey.get(cached.clientKey);
        if (entry && cached.audioBase64) storeDubCueAudio(entry, cached.audioBase64, cached.mimeType);
      }

      const batchedItems = Array.isArray(result.batchedItems) ? result.batchedItems : [];
      let splitAudio = null;
      if (result.batchAudioBase64 && batchedItems.length > 0) {
        try {
          splitAudio = await splitBatchAudio(
            result.batchAudioBase64,
            batchedItems.length
          );
        } catch (error) {
          console.warn("[YT Lang Loop] Could not decode batched speech audio; retrying cues individually:", error);
        }
      }

      if (generation !== dubCacheGeneration || videoId !== currentVideoId) return;
      if (splitAudio) {
        for (let i = 0; i < batchedItems.length; i++) {
          const entry = byKey.get(batchedItems[i].clientKey);
          if (!entry || !splitAudio[i]) continue;
          const audioBase64 = arrayBufferToBase64(splitAudio[i]);
          storeDubCueAudio(entry, audioBase64, "audio/wav");
          browser.runtime.sendMessage({
            type: "YTLL_TTS_CACHE_PUT",
            text: entry.text,
            audioBase64,
            mimeType: "audio/wav",
            voice: ttsSettings.azureVoice
          }).then(cacheResult => {
            if (!cacheResult?.ok) throw new Error(cacheResult?.reason || "Could not persist split cue audio.");
          }).catch(error => {
            console.error("[YT Lang Loop] Failed to persist split cue audio:", error);
            if (generation === dubCacheGeneration && videoId === currentVideoId) {
              showDubFeedback(error.message || "Could not cache split cue audio", true);
            }
          });
        }
      } else {
        const fallbackItems = batchedItems
          .map(item => byKey.get(item.clientKey))
          .filter(Boolean);
        for (const entry of fallbackItems) {
          if (generation !== dubCacheGeneration || videoId !== currentVideoId) return;
          try {
            await synthesizeCueIndividually(entry);
          } catch (error) {
            markDubCueFailed(entry, error);
          }
        }
      }

      for (const failed of result.failedItems || []) {
        if (generation !== dubCacheGeneration || videoId !== currentVideoId) return;
        const entry = byKey.get(failed.clientKey);
        if (!entry) continue;
        try {
          await synthesizeCueIndividually(entry);
        } catch (error) {
          markDubCueFailed(entry, error);
        }
      }
    } catch (error) {
      for (const entry of activeEntries) markDubCueFailed(entry, error);
    }
  }

  function pumpDubPrefetchQueue() {
    while (dubPrefetchRunning < 2 && dubPrefetchQueue.length > 0) {
      const batch = [];
      let chars = 0;
      while (dubPrefetchQueue.length > 0 && batch.length < 8) {
        const entry = dubPrefetchQueue[0];
        if (
          !dubDesiredCueKeys.has(entry.key) ||
          dubAudioUrls.has(entry.key) ||
          dubFailedCueKeys.has(entry.key) ||
          dubPrefetchInFlight.has(entry.key)
        ) {
          dubPrefetchQueue.shift();
          continue;
        }
        const nextChars = entry.text.length;
        if (batch.length > 0 && chars + nextChars > 2200) break;
        dubPrefetchQueue.shift();
        batch.push(entry);
        chars += nextChars;
      }
      if (batch.length === 0) break;

      dubPrefetchRunning += 1;
      const request = prefetchDubBatch(batch).finally(() => {
        for (const entry of batch) {
          if (dubPrefetchInFlight.get(entry.key) === request) {
            dubPrefetchInFlight.delete(entry.key);
          }
        }
        dubPrefetchRunning -= 1;
        pumpDubPrefetchQueue();
      });
      for (const entry of batch) dubPrefetchInFlight.set(entry.key, request);
    }
  }

  function ensureDubPrefetchForCurrentBlock() {
    if (!shouldPrefetchAiDub()) return;

    const video = getVideoElement();
    const activeCueIdx = video ? findCueIndexForTime(video.currentTime) : -1;
    const entries = [];
    const cuesNeedingTranslation = [];
    const lookaheadBlocks = blocks.slice(currentBlockIdx, currentBlockIdx + 2);
    for (let blockOffset = 0; blockOffset < lookaheadBlocks.length; blockOffset++) {
      const block = lookaheadBlocks[blockOffset];
      const firstCueIdx = block.subStartNum - 1;
      for (let cueIdx = firstCueIdx; cueIdx < block.subEndNum; cueIdx++) {
        const cue = cues[cueIdx];
        if (!cue) continue;
        const batchId = Math.floor(cueIdx / TRANSLATION_BATCH_SIZE);
        if (
          cueNeedsGeneratedTranslation(cue) &&
          (!ttsSettings.geminiApiKey.trim() ||
            (!translationInFlight.has(batchId) && !translationQueue.some(batch => batch.id === batchId)))
        ) {
          cuesNeedingTranslation.push(cue);
        }
        const text = cueTargetText(cue);
        if (!text) continue;
        entries.push({ cue, cueIdx, text, key: makeDubCueKey(cue, cueIdx, text) });
      }
    }
    if (cuesNeedingTranslation.length > 0) {
      generateBilingualCuesForDubbing(cuesNeedingTranslation);
    }

    const keepKeys = new Set(entries.map(entry => entry.key));
    dubDesiredCueKeys = keepKeys;
    const retainedKeys = new Set([
      ...keepKeys, activeDubCueKey, loadedDubCueKey, startingDubCueKey, preloadedDubCueKey
    ]);
    for (const block of blocks.slice(Math.max(0, currentBlockIdx - 1), currentBlockIdx)) {
      for (let cueIdx = block.subStartNum - 1; cueIdx < block.subEndNum; cueIdx++) {
        const cue = cues[cueIdx];
        if (!cue) continue;
        const text = cueTargetText(cue);
        if (text) retainedKeys.add(makeDubCueKey(cue, cueIdx, text));
      }
    }
    for (const [key, url] of dubAudioUrls) {
      if (!retainedKeys.has(key)) {
        URL.revokeObjectURL(url);
        dubAudioUrls.delete(key);
      }
    }
    const signature = `${currentVideoId}:${currentBlockIdx}:${ttsSettings.azureVoice}:${activeCueIdx}`;
    const currentBlock = blocks[currentBlockIdx];
    const hasMissingTargetText = usingSrt && currentBlock &&
      cues.slice(currentBlock.subStartNum - 1, currentBlock.subEndNum).some(cue => !cueTargetText(cue));
    if (signature !== dubPrefetchSignature) {
      dubPrefetchSignature = signature;
      if (hasMissingTargetText) {
        showDubFeedback("The current SRT has cues without target text", true);
      } else if (entries.some(entry => !dubAudioUrls.has(entry.key))) {
        showDubFeedback("Preparing cue audio…");
      }
    }
    dubPrefetchQueue = entries.filter(entry =>
      !dubAudioUrls.has(entry.key) &&
      !dubFailedCueKeys.has(entry.key) &&
      !dubPrefetchInFlight.has(entry.key)
    );
    pumpDubPrefetchQueue();
  }

  function preloadNextDubCue(fromCueIdx) {
    const lastBlock = blocks[Math.min(currentBlockIdx + 1, blocks.length - 1)];
    if (!lastBlock || fromCueIdx < -1) return;
    for (let cueIdx = fromCueIdx + 1; cueIdx < lastBlock.subEndNum; cueIdx++) {
      const cue = cues[cueIdx];
      const text = cueTargetText(cue);
      if (!text) continue;
      const key = makeDubCueKey(cue, cueIdx, text);
      const url = dubAudioUrls.get(key);
      if (!url || key === loadedDubCueKey) continue;
      if (key === preloadedDubCueKey && preloadAudio.src === url) return;

      clearDubPreload();
      const audio = preloadAudio;
      if (typeof audio.addEventListener !== "function" || typeof audio.load !== "function") return;
      preloadedDubCueKey = key;
      preloadPromise = new Promise(resolve => {
        let finished = false;
        const finish = ready => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          audio.removeEventListener?.("loadedmetadata", onLoaded);
          audio.removeEventListener?.("error", onError);
          cancelDubPreload = null;
          if (!ready && preloadedDubCueKey === key) preloadedDubCueKey = "";
          resolve(ready);
        };
        const onLoaded = () => finish(true);
        const onError = () => {
          console.warn("[YT Lang Loop] Could not preload synthesized audio.");
          finish(false);
        };
        const timeout = setTimeout(() => {
          console.warn("[YT Lang Loop] Timed out preloading synthesized audio.");
          finish(false);
        }, 8000);
        cancelDubPreload = () => finish(false);
        audio.addEventListener("loadedmetadata", onLoaded);
        audio.addEventListener("error", onError);
        try {
          audio.src = url;
          audio.load();
          if (audio.readyState >= 1) finish(true);
        } catch (error) {
          console.warn("[YT Lang Loop] Could not preload synthesized audio:", error);
          finish(false);
        }
      });
      return;
    }
  }

  async function loadDubAudioSource(url, key) {
    const requestId = dubPlaybackRequest;
    if (!dubAudioUnlocking && preloadedDubCueKey === key && preloadAudio.src === url) {
      const ready = preloadAudio.readyState >= 1 || (preloadPromise && await preloadPromise);
      if (requestId !== dubPlaybackRequest) return;
      if (!dubAudioUnlocking && ready && preloadedDubCueKey === key &&
          preloadAudio.src === url && preloadAudio.readyState >= 1) {
        const previousAudio = dubAudio;
        dubAudio = preloadAudio;
        preloadAudio = previousAudio;
        preloadedDubCueKey = "";
        preloadPromise = null;
        preloadAudio.pause?.();
        try {
          preloadAudio.currentTime = 0;
        } catch (_) {}
        return;
      }
    }
    const audio = dubAudio;
    if (
      audio.currentSrc === url &&
      audio.readyState >= 1 &&
      Number.isFinite(audio.duration) &&
      audio.duration > 0
    ) {
      return;
    }
    await new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => {
        clearTimeout(timeout);
        audio.removeEventListener?.("loadedmetadata", onLoaded);
        audio.removeEventListener?.("error", onError);
        if (cancelDubAudioLoad === cancel) cancelDubAudioLoad = null;
      };
      const finish = error => {
        if (finished) return;
        finished = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish();
      const onLoaded = () => finish();
      const onError = () => finish(new Error("Could not load synthesized audio"));
      const timeout = setTimeout(() => {
        finish(new Error("Timed out loading synthesized audio"));
      }, 8000);
      cancelDubAudioLoad = cancel;
      if (typeof audio.addEventListener !== "function" || typeof audio.load !== "function") {
        finish(new Error("Synthesized audio loading is unavailable"));
        return;
      }
      audio.addEventListener("loadedmetadata", onLoaded);
      audio.addEventListener("error", onError);
      try {
        audio.src = url;
        audio.load();
      } catch (error) {
        finish(error);
      }
    });
  }

  async function startDubCue(cue, key, video) {
    const url = dubAudioUrls.get(key);
    if (!cue || !video || !url || startingDubCueKey === key || loadedDubCueKey === key) return;
    const requestId = ++dubPlaybackRequest;
    if (cancelDubAudioLoad) cancelDubAudioLoad();
    startingDubCueKey = key;

    try {
      await loadDubAudioSource(url, key);
      if (
        requestId !== dubPlaybackRequest ||
        activeDubCueKey !== key ||
        !shouldUseAiDub() ||
        (video.paused && !waitingForDubBuffer) ||
        video.seeking ||
        transitionInProgress ||
        manualSeeking
      ) {
        return;
      }

      const passSpeed = computePassSpeed(currentPassIdx);
      const availableVideoSec = Math.max(0, cue.end - Math.max(cue.start, video.currentTime)) / passSpeed;
      const audio = dubAudio;
      let playbackRate = passSpeed;
      if (
        ttsSettings.overflowBehavior === "speedup" &&
        availableVideoSec > 0 &&
        audio.duration / passSpeed > availableVideoSec
      ) {
        playbackRate = Math.min(
          audio.duration / availableVideoSec,
          passSpeed * 1.45,
          2.0
        );
      }
      audio.playbackRate = playbackRate;
      audio.volume = video.volume;
      finishedDubCueKey = "";
      loadedDubCueKey = key;
      if (typeof audio.play !== "function") throw new Error("Synthesized audio playback is unavailable");
      await audio.play();
      if (requestId !== dubPlaybackRequest) {
        if (audio !== dubAudio || !loadedDubCueKey) audio.pause?.();
        return;
      }
      dubAudioUnlocked = true;
      dubAudioPlayBlocked = false;
      preloadNextDubCue(activeDubCueIdx);
      if (waitingForDubBuffer) {
        waitingForDubBuffer = false;
        syncLoopTickerState();
        if (dubFeedback === "AI Dub: Buffering cue…") clearDubFeedback();
        if (video.paused) {
          video.play().catch(error => {
            showDubFeedback(error.message || "Could not resume video after buffering", true);
          });
        }
      }
    } catch (error) {
      if (requestId === dubPlaybackRequest) {
        dubAudioPlayBlocked = true;
        dubFailedCueKeys.add(key);
        loadedDubCueKey = "";
        showDubFeedback(error.message || "Could not play synthesized audio", true);
        console.error("[YT Lang Loop] AI dub playback failed:", error);
        if (waitingForDubBuffer) {
          waitingForDubBuffer = false;
          syncLoopTickerState();
          if (video.paused) {
            video.play().catch(playError => {
              showDubFeedback(playError.message || "Could not resume video after buffering failed", true);
            });
          }
        }
      }
    } finally {
      if (requestId === dubPlaybackRequest && startingDubCueKey === key) startingDubCueKey = "";
    }
  }

  function findDubCueIndexForTime(timeSec) {
    const block = blocks[currentBlockIdx];
    if (block && activeDubCueIdx < 0) {
      const firstIdx = block.subStartNum - 1;
      const firstCue = cues[firstIdx];
      if (firstCue && timeSec >= firstCue.start - 0.12 && timeSec < firstCue.end) {
        return firstIdx;
      }
    }
    if (block && activeDubPassIdx === currentPassIdx && activeDubCueIdx >= block.subStartNum - 1 &&
        activeDubCueIdx < block.subEndNum) {
      const activeCue = cues[activeDubCueIdx];
      if (activeCue && activeDubCueKey && timeSec < activeCue.start && timeSec >= activeCue.start - 0.08) {
        return activeDubCueIdx;
      }
      const nextIdx = activeDubCueIdx + 1;
      const nextCue = nextIdx < block.subEndNum ? cues[nextIdx] : null;
      if (
        nextCue && activeCue && finishedDubCueKey && finishedDubCueKey === activeDubCueKey &&
        nextCue.start - activeCue.end <= 0.25 &&
        timeSec >= nextCue.start - 0.08 && timeSec < nextCue.end
      ) {
        return nextIdx;
      }
    }
    return findCueIndexForTime(timeSec);
  }

  function syncDubPlayback(video) {
    if (!shouldUseAiDub() || transitionInProgress || video.seeking || manualSeeking) {
      if (!waitingForDubEnd && !waitingForDubBuffer) dubAudio.pause?.();
      return;
    }

    if (waitingForDubEnd || waitingForDubBuffer) return;

    const cueIdx = findDubCueIndexForTime(video.currentTime);
    if (cueIdx < 0) {
      return;
    }

    const cue = cues[cueIdx];
    if (cueNeedsGeneratedTranslation(cue)) {
      return;
    }
    const text = cueTargetText(cue);
    if (!text) return;
    const key = makeDubCueKey(cue, cueIdx, text);

    if (cueIdx !== activeDubCueIdx || currentPassIdx !== activeDubPassIdx) {
      if (!dubAudio.paused && !dubAudio.ended && loadedDubCueKey) return;
      activeDubCueIdx = cueIdx;
      activeDubPassIdx = currentPassIdx;
      activeDubCueKey = key;
      loadedDubCueKey = "";
      startingDubCueKey = "";
      finishedDubCueKey = "";
    }

    if (dubFailedCueKeys.has(key)) return;
    if (finishedDubCueKey === key) return;
    if (!dubAudioUrls.has(key) || startingDubCueKey === key) {
      if (!video.paused) {
        waitingForDubBuffer = true;
        showDubFeedback("Buffering cue…", false, 0);
        video.pause();
      }
      return;
    }

    if (loadedDubCueKey === key) {
      if (
        !dubAudioPlayBlocked &&
        finishedDubCueKey !== key &&
        dubAudio.paused &&
        !video.paused
      ) {
        Promise.resolve(dubAudio.play?.()).then(() => {
          dubAudioUnlocked = true;
        }).catch(error => {
          dubAudioPlayBlocked = true;
          showDubFeedback(error.message || "Could not resume synthesized audio", true);
        });
      }
      return;
    }
    startDubCue(cue, key, video);
  }

  function onDubAudioEnded(event) {
    if (event.currentTarget !== dubAudio || !loadedDubCueKey) return;
    finishedDubCueKey = activeDubCueKey;
    loadedDubCueKey = "";
    startingDubCueKey = "";
    dubAudioPlayBlocked = false;
    if (waitingForDubEnd) {
      const pending = pendingBlockTransition;
      if (pending) {
        pendingBlockTransition = null;
        if (pending.finish) {
          waitingForDubEnd = false;
          loopActive = false;
          setDubMuteActive(false, getVideoElement(), null, false);
          const video = getVideoElement();
          if (video) {
            video.playbackRate = 1.0;
            if (video.paused) {
              video.play().catch(error => {
                showDubFeedback(error.message || "Could not resume video after the final dub", true);
              });
            }
          }
          updateHud();
          return;
        }
        runTransition(pending.nextBlockIdx, pending.nextPassIdx, pending.seekTarget);
        return;
      }
      waitingForDubEnd = false;
      syncLoopTickerState();
      const video = getVideoElement();
      if (video) {
        const nextIdx = activeDubCueIdx + 1;
        const nextCue = nextIdx < (blocks[currentBlockIdx]?.subEndNum || 0) ? cues[nextIdx] : null;
        const syncNext = nextCue && Math.abs(nextCue.start - video.currentTime) <= 0.15;
        const requestId = dubPlaybackRequest;
        Promise.resolve(video.play?.()).then(() => {
          if (syncNext && requestId === dubPlaybackRequest && getVideoElement() === video && !video.paused) {
            syncDubPlayback(video);
          }
        }).catch(error => {
          showDubFeedback(error.message || "Could not resume video after the dub", true);
        });
      }
      return;
    }

    const video = getVideoElement();
    if (video && !video.paused && shouldUseAiDub()) {
      syncDubPlayback(video);
    }
  }

  dubAudio.addEventListener?.("ended", onDubAudioEnded);
  preloadAudio.addEventListener?.("ended", onDubAudioEnded);

  async function applyPassSettings(passIdx, userMutedOverride = null) {
    const video = getVideoElement();
    if (!video || !settings.enabled) {
      passSettingsRequestId += 1;
      currentPassResult = null;
      setDubMuteActive(false, video);
      return null;
    }

    const requestId = ++passSettingsRequestId;
    const cfg = getPassConfig(passIdx);
    if (loopActive) video.playbackRate = cfg.speed;

    const customOverlay = hasCustomOverlaySubs();
    const subMode = cfg.subMode === "both" && !customOverlay ? "target" : cfg.subMode;
    const subLang = subMode === "source" ? settings.sourceLang : settings.targetLang;
    const caps = lastKnownCaps?.videoId === currentVideoId ? lastKnownCaps.caps : null;
    const aiDubAudio = willAiDubHandlePass(passIdx, caps);
    const passConfig = {
      videoId: currentVideoId,
      audioLang: aiDubAudio && lastAppliedPassConfig?.videoId === currentVideoId
        ? lastAppliedPassConfig.audioLang
        : cfg.audioLang,
      subMode: customOverlay ? "__custom__" : subMode,
      subLang: customOverlay ? "__custom__" : subLang,
      useCustomSubs: customOverlay
    };
    if (
      passRequestsInFlight === 0 &&
      lastKnownCaps?.videoId === currentVideoId &&
      lastAppliedPassResult &&
      lastAppliedPassConfig &&
      Object.keys(passConfig).every(key => passConfig[key] === lastAppliedPassConfig[key])
    ) {
      currentPassResult = lastAppliedPassResult;
      syncDubActivation(currentPassResult, userMutedOverride);
      updateHud(currentPassResult.caps, currentPassResult.audioRes, currentPassResult.subRes);
      return {
        ...currentPassResult,
        audioRes: { ...currentPassResult.audioRes, unchanged: true }
      };
    }

    currentPassResult = null;
    lastAppliedPassConfig = null;
    const revision = passConfigRevision;
    passRequestsInFlight++;
    let res;
    try {
      res = await sendToPage("APPLY_PASS", {
        audioLang: passConfig.audioLang,
        subMode,
        subLang,
        useCustomSubs: passConfig.useCustomSubs,
        targetLang: settings.targetLang,
        sourceLang: settings.sourceLang
      });
    } finally {
      passRequestsInFlight--;
    }

    if (requestId !== passSettingsRequestId || passIdx !== currentPassIdx) {
      lastAppliedPassConfig = null;
      if (passConfig.videoId === currentVideoId) lastPlayerAudio = null;
      return res;
    }
    currentPassResult = res;
    if (res?.caps) {
      lastKnownCaps = { videoId: currentVideoId, caps: res.caps };
      if (res.audioRes) {
        lastPlayerAudio = { videoId: currentVideoId, audioLang: passConfig.audioLang };
      }
      const audioReason = res.audioRes?.reason || "";
      const stableAudioResult = res.audioRes?.ok ||
        audioReason === "No alternate audio tracks on this video" ||
        audioReason.startsWith("No audio track found for ");
      if (revision === passConfigRevision && stableAudioResult && res.subRes?.ok) {
        lastAppliedPassConfig = passConfig;
        lastAppliedPassResult = res;
      }
    }
    syncDubActivation(res, userMutedOverride);
    updateHud(res?.caps, res?.audioRes, res?.subRes);
    return res;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function seekAndWait(targetSeconds, blockEnd) {
    return new Promise((resolve) => {
      const video = getVideoElement();
      if (!video) {
        resolve();
        return;
      }

      const target = Math.max(0, targetSeconds);
      let done = false;
      let timer = null;

      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };

      const onSeeked = () => {
        if (Math.abs(video.currentTime - target) < 1.5 || video.currentTime < blockEnd - 0.1) {
          finish();
        }
      };

      programmaticSeekTarget = target;
      video.addEventListener("seeked", onSeeked);
      timer = setTimeout(finish, 1500);
      video.currentTime = target;
    });
  }

  async function runTransition(nextBlockIdx, nextPassIdx, seekTarget) {
    if (transitionInProgress) return;
    const video = getVideoElement();
    const shouldResumeAfterTransition = Boolean(
      video && (waitingForDubEnd || waitingForDubBuffer || !video.paused)
    );
    transitionInProgress = true;
    const userMuted = video
      ? dubMuteActive
        ? videoMutedBeforeDub
        : video.muted
      : false;
    if (video && !video.paused && seekTarget !== null) video.pause?.();
    stopDubPlayback(false);

    try {
      currentBlockIdx = nextBlockIdx;
      currentPassIdx = nextPassIdx;
      currentPassResult = null;
      updateHud();
      renderCustomSubtitle();
      scheduleTranslationBatches();
      ensureDubPrefetchForCurrentBlock();

      if (video) video.muted = true;
      const blk = blocks[currentBlockIdx];
      if (blk && getPassConfig(currentPassIdx).audioMode === "target" && shouldPrefetchAiDub()) {
        preloadNextDubCue(blk.subStartNum - 2);
      }
      const blockEnd = blk ? blk.end : seekTarget + 1;
      const target = seekTarget === null ? null : Math.max(0, seekTarget);
      if (target !== null) {
        await seekAndWait(target, blockEnd);
      }

      const res = await applyPassSettings(currentPassIdx, userMuted);

      if (target !== null && res?.audioRes?.ok && !res.audioRes.unchanged) {
        await wait(350);
        if (video && Math.abs(video.currentTime - target) > 0.25) {
          await seekAndWait(target, blockEnd);
        }
      }
    } finally {
      if (video) video.muted = dubMuteActive ? true : userMuted;
      programmaticSeekTarget = null;
      ignoreManualSeekUntil = Date.now() + 300;
      lastProgrammaticSeekTo = seekTarget === null ? null : Math.max(0, seekTarget);
      lastTickTime = video ? video.currentTime : null;
      manualSeeking = false;
      transitionInProgress = false;
      ensureDubPrefetchForCurrentBlock();
      updateHud();
      renderCustomSubtitle();
      if (shouldResumeAfterTransition && video?.paused) {
        const requestId = passSettingsRequestId;
        const playPromise = video.play();
        if (shouldUseAiDub()) syncDubPlayback(video);
        Promise.resolve(playPromise).then(() => {
          if (requestId === passSettingsRequestId && getVideoElement() === video &&
              !video.paused && !startingDubCueKey && !loadedDubCueKey && shouldUseAiDub()) {
            syncDubPlayback(video);
          }
        }).catch(error => {
          if (requestId === passSettingsRequestId && getVideoElement() === video) {
            dubAudio.pause?.();
          }
          showDubFeedback(error.message || "Could not resume video after transition", true);
        });
      }
    }
  }

  function seekVideoTo(seconds) {
    const video = getVideoElement();
    if (!video) return false;
    const target = Math.max(0, seconds);
    if (!video.seeking && Math.abs(video.currentTime - target) < 0.05) return false;
    programmaticSeekTarget = target;
    video.currentTime = target;
    return true;
  }

  function findBlockIndexForTime(timeSec) {
    if (blocks.length === 0) return 0;
    for (let i = 0; i < blocks.length; i++) {
      if (timeSec <= blocks[i].end) {
        return i;
      }
    }
    return blocks.length - 1;
  }

  function findCueIndexForTime(timeSec) {
    let low = 0;
    let high = cues.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const cue = cues[mid];
      if (timeSec < cue.start) {
        high = mid - 1;
      } else if (timeSec >= cue.end) {
        low = mid + 1;
      } else {
        return mid;
      }
    }
    return -1;
  }

  function buildTranscriptPayload() {
    return {
      ok: true,
      videoId: currentVideoId,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      subtitlesPerLoop: settings.subtitlesPerLoop || 5,
      currentBlockIdx,
      activeCueIdx: findCueIndexForTime(getVideoElement()?.currentTime ?? -1),
      translatedCount: cues.filter(cue =>
        typeof cue.targetText === "string" && cue.targetText.trim()
      ).length,
      cues: cues.map((cue, index) => ({
        index,
        start: cue.start,
        end: cue.end,
        sourceText: cue.sourceText || "",
        targetText: cue.targetText || ""
      }))
    };
  }

  function notifyTranscriptUpdated() {
    browser.runtime.sendMessage({ type: "YTLL_TRANSCRIPT_UPDATED", ...buildTranscriptPayload() })
      .catch(() => {});
  }

  function rebuildBlocksAndSync() {
    stopDubPlayback();
    clearDubAudioUrls();
    translationGeneration += 1;
    translationQueue = [];
    translationInFlight.clear();
    blocks = buildBlocks(cues, settings.subtitlesPerLoop || 5);
    const video = getVideoElement();
    const curTime = video ? video.currentTime : 0;
    currentBlockIdx = findBlockIndexForTime(curTime);
    currentPassIdx = 0;
    notifyTranscriptUpdated();
    if (settings.enabled && loopActive && blocks.length > 0) {
      applyPassSettings(0);
    }
    updateHud();
    renderCustomSubtitle();
    if (!usingSrt && ttsSettings.geminiApiKey.trim()) {
      scheduleTranslationBatches();
    }
  }

  function hasCustomOverlaySubs() {
    return usingSrt || cues.length > 0;
  }

  function renderCustomSubtitle() {
    if (!hud.subtitleOverlay) return;

    const overlay = hud.subtitleOverlay;
    const video = getVideoElement();
    const subMode = getPassConfig(currentPassIdx).subMode;
    const targetLine = hud.subtitleTargetLine;
    const sourceLine = hud.subtitleSourceLine;
    targetLine.dir = ["ar", "he", "fa", "ur"].includes(settings.targetLang)
      ? "rtl"
      : "ltr";
    if (!hasCustomOverlaySubs() || !settings.enabled || !video || subMode === "off") {
      targetLine.hidden = true;
      sourceLine.hidden = true;
      overlay.hidden = true;
      return;
    }

    const cueIdx = findCueIndexForTime(video.currentTime);
    const segment = cueIdx >= 0 ? cues[cueIdx] : null;
    const targetText =
      segment && (subMode === "target" || subMode === "both") ? segment.targetText : "";
    const sourceText =
      segment && (subMode === "source" || subMode === "both") ? segment.sourceText : "";
    targetLine.textContent = targetText;
    sourceLine.textContent = sourceText;
    targetLine.hidden = !targetText;
    sourceLine.hidden = !sourceText;
    overlay.hidden = !targetText && !sourceText;
  }

  function setHudStatus(message) {
    if (!hud.root) ensureHudMounted();
    if (hud.statusText) hud.statusText.textContent = message;
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result || "")), { once: true });
      reader.addEventListener(
        "error",
        () => reject(reader.error || new Error("Could not read the selected file")),
        { once: true }
      );
      reader.readAsText(file);
    });
  }

  async function handleSrtFile(file, videoId) {
    captionGenerationRequest++;
    try {
      const segments = parseSrt(await readFileAsText(file));
      if (segments.length === 0) {
        throw new Error("No valid dual-language SRT cues were found");
      }

      await browser.storage.local.set({ [`srt_${videoId}`]: segments });
      if (getVideoIdFromUrl() !== videoId) {
        setHudStatus(`SRT saved for video ${videoId}`);
        return;
      }

      currentVideoId = videoId;
      usingSrt = true;
      usingGeneratedSrt = false;
      videoCacheSource = "none";
      videoCacheSavedAt = null;
      captionLoadError = "";
      generatedCueAttemptVideoId = "";
      cues = segments;
      rebuildBlocksAndSync();
      updateHud();
    } catch (err) {
      console.error("[YT Lang Loop] Failed to load SRT:", err);
      setHudStatus(`SRT load failed: ${err.message}`);
    }
  }

  async function clearSrtForCurrentVideo() {
    const videoId = getVideoIdFromUrl();
    if (!videoId) return;
    captionGenerationRequest++;
    passSettingsRequestId++;
    setDubMuteActive(false, getVideoElement());

    try {
      await browser.storage.local.remove(`srt_${videoId}`);
      if (getVideoIdFromUrl() !== videoId) return;
      usingSrt = false;
      usingGeneratedSrt = false;
      captionLoadError = "";
      generatedCueAttemptVideoId = "";
      cues = [];
      blocks = [];
      await initForCurrentVideo();
    } catch (err) {
      console.error("[YT Lang Loop] Failed to clear SRT:", err);
      setHudStatus(`SRT clear failed: ${err.message}`);
    }
  }

  function ensureHudMounted() {
    const player = document.getElementById("movie_player");
    if (!player) return;

    const mobileLayout = window.matchMedia(
      "(max-width: 700px), (max-height: 500px) and (pointer: coarse)"
    ).matches;
    const hudParent = mobileLayout ? document.documentElement : player;
    if (hud.root && hud.root.isConnected) {
      if (hud.root.parentElement !== hudParent) hudParent.appendChild(hud.root);
      return;
    }

    const root = document.createElement("div");
    root.id = "yt-lang-loop-hud";

    const mobileTabBtn = document.createElement("button");
    mobileTabBtn.type = "button";
    mobileTabBtn.className = "ytll-mobile-tab";
    mobileTabBtn.textContent = "Loop";
    mobileTabBtn.title = "Open loop controls";
    mobileTabBtn.setAttribute("aria-label", "Open loop controls");
    mobileTabBtn.setAttribute("aria-expanded", "false");
    mobileTabBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      unlockDubAudio();
      const isOpen = root.classList.toggle("ytll-mobile-open");
      mobileTabBtn.title = isOpen ? "Close loop controls" : "Open loop controls";
      mobileTabBtn.setAttribute("aria-label", mobileTabBtn.title);
      mobileTabBtn.setAttribute("aria-expanded", String(isOpen));
    });

    const info = document.createElement("div");
    info.className = "ytll-info";

    const statusText = document.createElement("span");
    statusText.className = "ytll-status";

    const metaText = document.createElement("span");
    metaText.className = "ytll-meta";

    info.appendChild(statusText);
    info.appendChild(metaText);

    const actions = document.createElement("div");
    actions.className = "ytll-actions";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.textContent = "Prev";
    prevBtn.title = "Previous subtitle block";

    const repeatBtn = document.createElement("button");
    repeatBtn.type = "button";
    repeatBtn.textContent = "Repeat";
    repeatBtn.title = "Restart current block from Pass 1";

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.textContent = "Next";
    nextBtn.title = "Next subtitle block";

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "ytll-toggle";

    const loadSrtBtn = document.createElement("button");
    loadSrtBtn.type = "button";
    loadSrtBtn.textContent = "Load .SRT";
    loadSrtBtn.title = "Load dual-language subtitles for this video";

    const clearSrtBtn = document.createElement("button");
    clearSrtBtn.type = "button";
    clearSrtBtn.textContent = "Clear .SRT";
    clearSrtBtn.title = "Remove saved SRT subtitles for this video";
    clearSrtBtn.hidden = !usingSrt;

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".srt,text/plain";
    fileInput.className = "ytll-file-input";
    fileInput.tabIndex = -1;
    fileInput.setAttribute("aria-label", "Choose a dual-language SRT file");
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      const videoId = fileInput.dataset.videoId;
      fileInput.value = "";
      if (file && videoId) handleSrtFile(file, videoId);
    });

    loadSrtBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const videoId = getVideoIdFromUrl();
      if (!videoId) {
        setHudStatus("Open a YouTube video before loading an SRT");
        return;
      }
      fileInput.dataset.videoId = videoId;
      try {
        if (typeof fileInput.showPicker === "function") {
          fileInput.showPicker();
        } else {
          fileInput.click();
        }
      } catch (err) {
        try {
          fileInput.click();
        } catch (fallbackErr) {
          console.error("[YT Lang Loop] Failed to open the SRT file picker:", fallbackErr);
          setHudStatus(`Could not open the file picker: ${fallbackErr.message || err.message}`);
        }
      }
    });

    clearSrtBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearSrtForCurrentVideo();
    });

    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      unlockDubAudio();
      if (blocks.length === 0) return;
      const idx = Math.max(0, currentBlockIdx - 1);
      runTransition(idx, 0, blocks[idx].start);
      scheduleTranslationBatches();
    });

    repeatBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      unlockDubAudio();
      if (blocks.length === 0) return;
      runTransition(currentBlockIdx, 0, blocks[currentBlockIdx].start);
    });

    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      unlockDubAudio();
      if (blocks.length === 0) return;
      const idx = Math.min(blocks.length - 1, currentBlockIdx + 1);
      runTransition(idx, 0, blocks[idx].start);
    });

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      unlockDubAudio();
      loopActive = !loopActive;
      const video = getVideoElement();
      if (!loopActive && video) {
        setDubMuteActive(false, video);
        waitingForDubEnd = false;
        video.playbackRate = 1.0;
      } else if (loopActive && settings.enabled && blocks.length > 0) {
        applyPassSettings(currentPassIdx);
      }
      syncLoopTickerState();
      updateHud();
    });

    actions.appendChild(prevBtn);
    actions.appendChild(repeatBtn);
    actions.appendChild(nextBtn);
    actions.appendChild(toggleBtn);
    actions.appendChild(loadSrtBtn);
    actions.appendChild(clearSrtBtn);

    root.appendChild(mobileTabBtn);
    root.appendChild(info);
    root.appendChild(actions);
    root.appendChild(fileInput);

    const subtitleOverlay = document.createElement("div");
    subtitleOverlay.id = "yt-lang-loop-subtitle";
    subtitleOverlay.hidden = true;
    const subtitleTargetLine = document.createElement("div");
    subtitleTargetLine.className = "ytll-subtitle-target-line";
    subtitleTargetLine.hidden = true;
    const subtitleSourceLine = document.createElement("div");
    subtitleSourceLine.className = "ytll-subtitle-source-line";
    subtitleSourceLine.hidden = true;
    subtitleOverlay.appendChild(subtitleTargetLine);
    subtitleOverlay.appendChild(subtitleSourceLine);
    player.appendChild(subtitleOverlay);
    hudParent.appendChild(root);

    hud = {
      root,
      statusText,
      metaText,
      toggleBtn,
      prevBtn,
      repeatBtn,
      nextBtn,
      loadSrtBtn,
      clearSrtBtn,
      mobileTabBtn,
      subtitleOverlay,
      subtitleTargetLine,
      subtitleSourceLine
    };
  }

  function videoStorageStatus() {
    if (usingSrt) return `SRT: ${cues.length} segments`;
    if (videoCacheSource === "none") return "Not stored";
    if (!videoCacheSavedAt) return "Not stored";
    const ageHours = Math.floor(Math.max(0, Date.now() - videoCacheSavedAt) / 3600000);
    return ageHours > 0 ? `Stored (${ageHours}h ago)` : "Stored";
  }

  function updateHud(caps, audioRes, subRes) {
    if (!hud.root) ensureHudMounted();
    if (!hud.root) return;

    hud.clearSrtBtn.hidden = !usingSrt;
    hud.metaText.classList.toggle("ytll-ai-dub-active", dubMuteActive);
    hud.metaText.classList.toggle("ytll-ai-dub-error", dubFeedbackIsError);
    renderCustomSubtitle();

    if (!settings.enabled) {
      hud.root.classList.add("ytll-hidden");
      return;
    }
    hud.root.classList.remove("ytll-hidden");

    hud.toggleBtn.textContent = loopActive ? "Pause Loop" : "Resume Loop";
    hud.toggleBtn.classList.toggle("ytll-paused", !loopActive);

    if (blocks.length === 0) {
      hud.statusText.textContent = "Loop: Waiting for captions (enable CC or Load .SRT)...";
      hud.metaText.textContent = [videoStorageStatus(), captionLoadError, dubFeedback].filter(Boolean).join(" | ");
      return;
    }

    if (!loopActive) {
      hud.statusText.textContent = "Loop Paused (1.00x)";
      hud.metaText.textContent = [
        `Block ${currentBlockIdx + 1}/${blocks.length}`,
        videoStorageStatus(),
        dubFeedback
      ].filter(Boolean).join(" | ");
      return;
    }

    const blk = blocks[currentBlockIdx];
    const cfg = getPassConfig(currentPassIdx);
    const totalPasses = settings.numPlaybacks || 1;

    hud.statusText.textContent =
      `Subs ${blk.subStartNum}–${blk.subEndNum} (${currentBlockIdx + 1}/${blocks.length}) • ` +
      `Pass ${currentPassIdx + 1}/${totalPasses} • ${cfg.speed.toFixed(2)}x`;

    const subDisplay =
      cfg.subMode === "off"
        ? "Off"
        : cfg.subMode === "both"
          ? hasCustomOverlaySubs()
            ? "Both"
            : "Both (load dual-language SRT)"
          : cfg.subLang;
    const audioDescription = dubMuteActive
      ? `Audio: ${cfg.audioLang} (AI Dub)`
      : `Audio: ${cfg.audioLang}`;
    let meta = `${videoStorageStatus()} | ${audioDescription} | Subs: ${subDisplay}`;

    if (!dubMuteActive) {
      if (caps && caps.audioTrackCount <= 1) {
        meta += " (single audio track)";
      } else if (audioRes && !audioRes.ok) {
        meta += ` (${audioRes.reason})`;
      }
    }
    if (subRes && !subRes.ok) {
      meta += ` (subtitles: ${subRes.reason})`;
    }
    if (captionLoadError) {
      meta += ` | ${captionLoadError}`;
    }
    if (dubFeedback) {
      meta += ` | ${dubFeedback}`;
    }

    hud.metaText.textContent = meta;
  }

  function syncLoopTickerState() {
    const shouldRun = (currentVideoId && settings.enabled && loopActive) ||
      waitingForDubEnd || waitingForDubBuffer;
    if (shouldRun && tickTimer === null) {
      startLoopTicker();
    } else if (!shouldRun && tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
      lastTickTime = null;
    }
  }

  function startLoopTicker() {
    tickTimer = setInterval(() => {
      const video = getVideoElement();
      if (video) attachVideoListeners();
      renderCustomSubtitle();
      if (!video) {
        lastTickTime = null;
        return;
      }

      const nowTime = video.currentTime;
      if (
        blocks.length > 0 &&
        lastTickTime !== null &&
        !transitionInProgress &&
        programmaticSeekTarget === null &&
        Math.abs(nowTime - lastTickTime) > 0.75
      ) {
        stopDubPlayback();
        currentBlockIdx = findBlockIndexForTime(nowTime);
        currentPassIdx = 0;
      }
      lastTickTime = nowTime;

      if (!settings.enabled || !loopActive || blocks.length === 0 || manualSeeking) {
        if (!waitingForDubEnd && !waitingForDubBuffer) dubAudio.pause();
        return;
      }

      ensureDubPrefetchForCurrentBlock();

      if (waitingForDubEnd || waitingForDubBuffer) return;

      if (
        video.paused ||
        video.seeking ||
        programmaticSeekTarget !== null ||
        transitionInProgress
      ) {
        if (!waitingForDubEnd && !waitingForDubBuffer) dubAudio.pause();
        return;
      }

      const blk = blocks[currentBlockIdx];
      if (!blk) return;

      // Enforce speed in case YouTube resets it
      const expectedSpeed = computePassSpeed(currentPassIdx);
      if (Math.abs(video.playbackRate - expectedSpeed) > 0.01) {
        video.playbackRate = expectedSpeed;
      }
      syncDubPlayback(video);
      if (waitingForDubEnd || waitingForDubBuffer) return;

      if (nowTime > blocks[blocks.length - 1].end + 0.5) return;

      const endThreshold =
        blk.end - Math.min(0.14, 0.04 * (video.playbackRate || 1));
      const dubStillSpeaking =
        shouldUseAiDub() &&
        activeDubCueIdx >= 0 &&
        loadedDubCueKey !== "" &&
        !dubAudio.paused &&
        !dubAudio.ended;
      if (dubStillSpeaking) {
        const cueEndThreshold = cues[activeDubCueIdx]?.end - 0.05;
        if (nowTime >= endThreshold) {
          const totalPasses = settings.numPlaybacks || 1;
          if (currentPassIdx < totalPasses - 1) {
            pendingBlockTransition = {
              nextBlockIdx: currentBlockIdx,
              nextPassIdx: currentPassIdx + 1,
              seekTarget: blk.start
            };
          } else if (currentBlockIdx < blocks.length - 1) {
            const nextIdx = currentBlockIdx + 1;
            pendingBlockTransition = {
              nextBlockIdx: nextIdx,
              nextPassIdx: 0,
              seekTarget: blocks[nextIdx].start
            };
          } else {
            pendingBlockTransition = { finish: true };
          }
          waitingForDubEnd = true;
          video.pause();
          return;
        }
        if (Number.isFinite(cueEndThreshold) && nowTime >= cueEndThreshold) {
          waitingForDubEnd = true;
          video.pause();
          return;
        }
      }

      if (nowTime >= endThreshold) {
        const totalPasses = settings.numPlaybacks || 1;

        if (currentPassIdx < totalPasses - 1) {
          runTransition(currentBlockIdx, currentPassIdx + 1, blk.start);
        } else if (currentBlockIdx < blocks.length - 1) {
          const nextIdx = currentBlockIdx + 1;
          runTransition(nextIdx, 0, blocks[nextIdx].start);
        } else {
          // Finished the last block of the video
          currentPassIdx = 0;
          loopActive = false;
          setDubMuteActive(false, video);
          video.playbackRate = 1.0;
          syncLoopTickerState();
          updateHud();
        }
      }
    }, 30);
  }

  function attachVideoListeners() {
    const video = getVideoElement();
    if (!video) return;
    if (dubMuteActive && dubMutedVideo !== video) {
      if (dubMutedVideo) dubMutedVideo.muted = videoMutedBeforeDub;
      videoMutedBeforeDub = video.muted;
      dubMutedVideo = video;
      video.muted = true;
    }
    if (video.dataset.ytllAttached) return;
    programmaticSeekTarget = null;
    transitionInProgress = false;
    ignoreManualSeekUntil = 0;
    manualSeeking = false;
    lastTickTime = video.currentTime;
    lastProgrammaticSeekTo = null;
    video.dataset.ytllAttached = "true";

    video.addEventListener("timeupdate", renderCustomSubtitle);
    video.addEventListener("play", unlockDubAudio);
    video.addEventListener("pause", () => {
      if (!waitingForDubEnd && !waitingForDubBuffer) dubAudio.pause();
    });
    video.addEventListener("volumechange", () => {
      if (dubMuteActive && !video.muted) {
        videoMutedBeforeDub = false;
        video.muted = true;
      }
      if (dubMuteActive) dubAudio.volume = video.volume;
    });
    video.addEventListener("seeking", () => {
      if (transitionInProgress || programmaticSeekTarget !== null) return;
      manualSeeking = true;
      stopDubPlayback();
      if (blocks.length === 0) return;
      currentBlockIdx = findBlockIndexForTime(video.currentTime);
      currentPassIdx = 0;
      scheduleTranslationBatches();
    });
    video.addEventListener("seeked", () => {
      if (transitionInProgress || programmaticSeekTarget !== null) return;

      const isRecentProgrammaticSeek =
        Date.now() < ignoreManualSeekUntil &&
        lastProgrammaticSeekTo !== null &&
        Math.abs(video.currentTime - lastProgrammaticSeekTo) < 0.75;
      if (isRecentProgrammaticSeek) {
        manualSeeking = false;
        lastTickTime = video.currentTime;
        return;
      }
      manualSeeking = false;
      lastTickTime = video.currentTime;
      if (!settings.enabled || !loopActive || blocks.length === 0) return;

      currentBlockIdx = findBlockIndexForTime(video.currentTime);
      currentPassIdx = 0;
      currentPassResult = null;
      scheduleTranslationBatches();
      applyPassSettings(0);
    });
  }

  async function initForCurrentVideo() {
    const videoId = getVideoIdFromUrl();
    if (!videoId) {
      const previousVideo = getVideoElement();
      setDubMuteActive(false, getVideoElement(), null, false);
      clearDubAudioUrls();
      if (previousVideo) previousVideo.playbackRate = 1.0;
      captionGenerationRequest++;
      passSettingsRequestId++;
      clearTimeout(dubFeedbackTimer);
      dubFeedback = "";
      dubFeedbackIsError = false;
      currentVideoId = "";
      syncLoopTickerState();
      videoCacheSource = "none";
      videoCacheSavedAt = null;
      videoCacheSuppressed = false;
      videoMetadata = { title: "", channel: "" };
      currentPassResult = null;
      lastKnownCaps = null;
      lastAppliedPassConfig = null;
      lastAppliedPassResult = null;
      lastPlayerAudio = null;
      passConfigRevision++;
      generatedCueAttemptVideoId = "";
      usingSrt = false;
      usingGeneratedSrt = false;
      captionLoadError = "";
      programmaticSeekTarget = null;
      transitionInProgress = false;
      ignoreManualSeekUntil = 0;
      manualSeeking = false;
      lastTickTime = null;
      lastProgrammaticSeekTo = null;
      cues = [];
      blocks = [];
      currentBlockIdx = 0;
      notifyTranscriptUpdated();
      renderCustomSubtitle();
      if (hud.root) hud.root.classList.add("ytll-hidden");
      return;
    }

    if (videoId === currentVideoId && cues.length > 0) {
      syncLoopTickerState();
      ensureHudMounted();
      attachVideoListeners();
      updateHud();
      return;
    }

    const previousVideo = getVideoElement();
    setDubMuteActive(false, getVideoElement(), null, false);
    clearDubAudioUrls();
    if (previousVideo) previousVideo.playbackRate = 1.0;
    passSettingsRequestId++;
    clearTimeout(dubFeedbackTimer);
    dubFeedback = "";
    dubFeedbackIsError = false;
    currentVideoId = videoId;
    syncLoopTickerState();
    videoCacheSource = "none";
    videoCacheSavedAt = null;
    videoCacheSuppressed = false;
    videoMetadata = { title: "", channel: "" };
    currentPassResult = null;
    lastKnownCaps = null;
    lastAppliedPassConfig = null;
    lastAppliedPassResult = null;
    lastPlayerAudio = null;
    passConfigRevision++;
    generatedCueAttemptVideoId = "";
    lastMissingKeyNotice = "";
    const loadRequest = ++captionGenerationRequest;
    programmaticSeekTarget = null;
    transitionInProgress = false;
    ignoreManualSeekUntil = 0;
    manualSeeking = false;
    lastTickTime = null;
    lastProgrammaticSeekTo = null;
    usingSrt = false;
    usingGeneratedSrt = false;
    captionLoadError = "";
    cues = [];
    blocks = [];
    currentBlockIdx = 0;
    currentPassIdx = 0;
    notifyTranscriptUpdated();

    ensureHudMounted();
    attachVideoListeners();
    updateHud();

    await loadLanguageSettings();
    if (loadRequest !== captionGenerationRequest || getVideoIdFromUrl() !== videoId) return;

    const storageKey = `srt_${videoId}`;
    try {
      const stored = await browser.storage.local.get(storageKey);
      if (loadRequest !== captionGenerationRequest || getVideoIdFromUrl() !== videoId) return;
      if (isStoredSrt(stored[storageKey])) {
        usingSrt = true;
        usingGeneratedSrt = false;
        cues = stored[storageKey];
        rebuildBlocksAndSync();
        updateHud();
        return;
      }
      if (stored[storageKey] !== undefined) {
        console.warn(`[YT Lang Loop] Ignoring invalid saved SRT data for ${videoId}`);
      }
    } catch (err) {
      console.error("[YT Lang Loop] Failed to load saved SRT:", err);
    }

    try {
      const cached = await browser.runtime.sendMessage({
        type: "YTLL_VIDEO_CACHE_GET",
        videoId,
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang
      });
      if (loadRequest !== captionGenerationRequest || getVideoIdFromUrl() !== videoId) return;
      if (cached?.ok && cached.found && isStoredSrt(cached.cues)) {
        cues = cached.cues;
        videoMetadata = {
          title: typeof cached.metadata?.title === "string" ? cached.metadata.title : "",
          channel: typeof cached.metadata?.channel === "string" ? cached.metadata.channel : ""
        };
        videoCacheSource = "cache";
        videoCacheSavedAt = Number.isFinite(cached.updatedAt) ? cached.updatedAt : null;
        rebuildBlocksAndSync();
        if (ttsSettings.geminiApiKey.trim() && cues.some(cueNeedsGeneratedTranslation)) {
          scheduleTranslationBatches();
        } else if (cues.some(cueNeedsGeneratedTranslation)) {
          generateBilingualCuesForDubbing(cues);
        }
        updateHud();
        return;
      }
      if (cached && !cached.ok) {
        console.error("[YT Lang Loop] Failed to load video cache:", cached.reason);
      }
    } catch (err) {
      console.error("[YT Lang Loop] Failed to load video cache:", err);
    }

    if (!settings.enabled) return;
    return fetchSingleLanguageCaptions(videoId, loadRequest);
  }

  function normalizeTtsSettings(value) {
    const stored = value && typeof value === "object" ? value : {};
    const geminiApiKey =
      typeof stored.geminiApiKey === "string" ? stored.geminiApiKey :
      typeof stored.geminiKey === "string" ? stored.geminiKey :
      DEFAULT_TTS_SETTINGS.geminiApiKey;
    return {
      dubMode: ["auto", "force", "off"].includes(stored.dubMode)
        ? stored.dubMode
        : DEFAULT_TTS_SETTINGS.dubMode,
      geminiApiKey,
      azureKey: typeof stored.azureKey === "string" ? stored.azureKey : DEFAULT_TTS_SETTINGS.azureKey,
      azureRegion: typeof stored.azureRegion === "string" ? stored.azureRegion : DEFAULT_TTS_SETTINGS.azureRegion,
      azureVoice: typeof stored.azureVoice === "string" ? stored.azureVoice : DEFAULT_TTS_SETTINGS.azureVoice,
      overflowBehavior: ["speedup", "pause"].includes(stored.overflowBehavior)
        ? stored.overflowBehavior
        : DEFAULT_TTS_SETTINGS.overflowBehavior
    };
  }

  async function loadSettings() {
    try {
      const stored = await browser.storage.local.get(["settings", "ttsSettings"]);
      if (stored.settings) {
        settings = { ...structuredClone(DEFAULT_SETTINGS), ...stored.settings };
      }
      ttsSettings = normalizeTtsSettings(stored.ttsSettings);
    } catch (err) {
      console.error("[YT Lang Loop] Failed to load extension settings:", err);
    }
  }

  async function reloadCaptionsForCurrentVideo() {
    const videoId = getVideoIdFromUrl();
    if (!videoId) {
      return { ok: false, reason: "Open a YouTube video before reloading captions" };
    }

    if (videoId !== currentVideoId) {
      await loadLanguageSettings();
      videoCacheSuppressed = true;
      await invalidatePendingTranslationsAndCacheWrites();
      const deleted = await browser.runtime.sendMessage({
        type: "YTLL_VIDEO_CACHE_DELETE",
        videoId,
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang
      });
      if (!deleted?.ok) throw new Error(deleted?.reason || "Could not delete the saved video cache.");
      videoCacheSuppressed = false;
      const initialized = await initForCurrentVideo();
      if (getVideoIdFromUrl() !== videoId || currentVideoId !== videoId) {
        return { ok: false, canceled: true };
      }
      if (usingSrt) return { ok: true, manual: true, segments: cues.length };
      if (cues.length > 0) return { ok: true, segments: cues.length };
      if (initialized?.ok === false) return initialized;
    }

    if (usingSrt) return { ok: true, manual: true, segments: cues.length };

    videoCacheSuppressed = true;
    await invalidatePendingTranslationsAndCacheWrites();
    const deleted = await browser.runtime.sendMessage({
      type: "YTLL_VIDEO_CACHE_DELETE",
      videoId,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang
    });
    if (!deleted?.ok) throw new Error(deleted?.reason || "Could not delete the saved video cache.");
    videoCacheSuppressed = false;
    const requestId = ++captionGenerationRequest;
    passSettingsRequestId++;
    setDubMuteActive(false, getVideoElement());
    cues = [];
    blocks = [];
    currentBlockIdx = 0;
    currentPassIdx = 0;
    generatedCueAttemptVideoId = "";
    videoCacheSource = "none";
    videoCacheSavedAt = null;
    videoMetadata = { title: "", channel: "" };
    captionLoadError = "";
    notifyTranscriptUpdated();
    updateHud();
    return fetchSingleLanguageCaptions(videoId, requestId);
  }

  browser.runtime.onMessage.addListener(async message => {
    if (message?.type === "YTLL_TTS_CACHE_CLEARED") {
      stopDubPlayback(false);
      clearDubAudioUrls();
      if (shouldPrefetchAiDub()) ensureDubPrefetchForCurrentBlock();
      return { ok: true };
    }
    if (message?.type === "YTLL_GET_TRANSCRIPT") {
      if (!getVideoIdFromUrl()) {
        return {
          ...buildTranscriptPayload(),
          videoId: "",
          currentBlockIdx: 0,
          activeCueIdx: -1,
          translatedCount: 0,
          cues: []
        };
      }
      return buildTranscriptPayload();
    }
    if (message?.type === "YTLL_SEEK_TO_TIME") {
      if (!Number.isFinite(message.time) || blocks.length === 0) {
        return { ok: false, reason: "A valid time and loaded subtitles are required." };
      }
      const blockIdx = findBlockIndexForTime(message.time);
      runTransition(blockIdx, 0, message.time);
      scheduleTranslationBatches();
      return { ok: true };
    }
    if (message?.type === "YTLL_RELOAD_CAPTIONS") {
      return reloadCaptionsForCurrentVideo();
    }
    if (message?.type === "YTLL_VIDEO_CACHE_CLEARED") {
      videoCacheSuppressed = true;
      videoCacheGeneration += 1;
      await videoCacheSavePromise;
      if (currentVideoId) {
        const deleted = await browser.runtime.sendMessage({
          type: "YTLL_VIDEO_CACHE_DELETE",
          videoId: currentVideoId,
          sourceLang: settings.sourceLang,
          targetLang: settings.targetLang
        });
        if (!deleted?.ok) throw new Error(deleted?.reason || "Could not delete the active video cache.");
      }
      videoCacheSuppressed = false;
      videoCacheSource = "none";
      videoCacheSavedAt = null;
      notifyTranscriptUpdated();
      updateHud();
      return { ok: true };
    }
    if (message?.type !== "YTLL_GET_VIDEO_STATUS") return undefined;

    const videoId = message.videoId || getVideoIdFromUrl();
    if (!videoId) {
      return {
        ok: true,
        videoId: "",
        stored: false,
        usingSrt: false,
        cacheSource: "none",
        savedAt: null,
        cueCount: 0,
        translatedCount: 0
      };
    }

    const sameVideo = videoId === currentVideoId;
    const sourceLang = message.sourceLang || settings.sourceLang;
    const targetLang = message.targetLang || settings.targetLang;
    const cache = await browser.runtime.sendMessage({
      type: "YTLL_VIDEO_CACHE_GET",
      videoId,
      sourceLang,
      targetLang
    });
    if (!cache?.ok) return { ok: false, reason: cache?.reason || "Could not read video cache status." };

    const usingManualSrt = sameVideo && usingSrt;
    const statusCues = sameVideo ? cues : (cache.found && Array.isArray(cache.cues) ? cache.cues : []);
    const stored = Boolean(cache.found);
    return {
      ok: true,
      videoId,
      stored,
      usingSrt: usingManualSrt,
      cacheSource: sameVideo ? videoCacheSource : (stored ? "cache" : "none"),
      savedAt: cache.updatedAt || (sameVideo ? videoCacheSavedAt : null),
      cueCount: statusCues.length,
      translatedCount: statusCues.filter(cue =>
        typeof cue.targetText === "string" && cue.targetText.trim()
      ).length
    };
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.ttsSettings) {
      lastAppliedPassConfig = null;
      passConfigRevision++;
      const previousVoice = ttsSettings.azureVoice;
      const previousGeminiKey = ttsSettings.geminiApiKey;
      ttsSettings = normalizeTtsSettings(changes.ttsSettings.newValue);
      lastMissingKeyNotice = "";
      stopDubPlayback();
      if (previousVoice !== ttsSettings.azureVoice) clearDubAudioUrls();
      if (ttsSettings.geminiApiKey.trim() && ttsSettings.geminiApiKey !== previousGeminiKey) {
        scheduleTranslationBatches();
      }
      const caps = lastKnownCaps?.videoId === currentVideoId ? lastKnownCaps.caps : null;
      const currentConfig = getPassConfig(currentPassIdx);
      const needsAudioRestore = !changes.settings && settings.enabled && loopActive &&
        currentConfig.audioMode === "target" &&
        (lastPlayerAudio?.videoId !== currentVideoId || lastPlayerAudio.audioLang !== currentConfig.audioLang) &&
        !willAiDubHandlePass(currentPassIdx, caps);
      if (needsAudioRestore) currentPassResult = null;
      syncDubActivation(currentPassResult);
      updateHud(currentPassResult?.caps, currentPassResult?.audioRes, currentPassResult?.subRes);
      if (needsAudioRestore) {
        applyPassSettings(currentPassIdx);
      }
    }

    if (!changes.settings) return;
    lastAppliedPassConfig = null;
    passConfigRevision++;
    passSettingsRequestId++;
    const prevTarget = settings.targetLang;
    const prevSource = settings.sourceLang;
    const prevSize = settings.subtitlesPerLoop;
    const prevEnabled = settings.enabled;

    settings = { ...structuredClone(DEFAULT_SETTINGS), ...changes.settings.newValue };
    syncLoopTickerState();

    const video = getVideoElement();
    const languagesChanged =
      settings.targetLang !== prevTarget || settings.sourceLang !== prevSource;
    if (languagesChanged) {
      currentPassResult = null;
      lastKnownCaps = null;
    }
    if (
      languagesChanged &&
      (usingGeneratedSrt || !usingSrt)
    ) {
      captionGenerationRequest++;
      generatedCueAttemptVideoId = "";
      usingSrt = false;
      usingGeneratedSrt = false;
      cues = [];
      blocks = [];
      if (!settings.enabled) {
        setDubMuteActive(false, video);
        waitingForDubEnd = false;
        if (video) video.playbackRate = 1.0;
        notifyTranscriptUpdated();
      }
      if (settings.enabled) initForCurrentVideo();
      updateHud();
      return;
    }

    if (!settings.enabled) {
      setDubMuteActive(false, video);
      waitingForDubEnd = false;
      if (video) video.playbackRate = 1.0;
      notifyTranscriptUpdated();
      updateHud();
      return;
    }

    if (!prevEnabled) {
      if (cues.length > 0) applyPassSettings(currentPassIdx);
      else initForCurrentVideo();
      updateHud();
      return;
    }

    if (settings.targetLang !== prevTarget) {
      if (usingSrt) {
        applyPassSettings(currentPassIdx);
        updateHud();
      } else {
        cues = [];
        blocks = [];
        initForCurrentVideo();
      }
    } else if (settings.subtitlesPerLoop !== prevSize) {
      rebuildBlocksAndSync();
    } else if (usingSrt && settings.sourceLang !== prevSource) {
      applyPassSettings(currentPassIdx);
      updateHud();
    } else {
      if (currentPassIdx >= settings.numPlaybacks) {
        currentPassIdx = 0;
      }
      if (loopActive) applyPassSettings(currentPassIdx);
      else updateHud();
    }
    if (languagesChanged && usingSrt) notifyTranscriptUpdated();
  });

  // Start once DOM is ready
  async function boot() {
    await loadSettings();
    syncLoopTickerState();

    document.addEventListener("click", event => {
      const target = event.target;
      if (target && typeof target.closest === "function" && target.closest("#movie_player, #yt-lang-loop-hud")) {
        unlockDubAudio();
      }
    }, true);

    window.addEventListener("resize", ensureHudMounted);
    const handleNavigation = () => {
      clearTimeout(navigationTimer);
      navigationTimer = setTimeout(initForCurrentVideo, 300);
    };
    window.addEventListener("yt-navigate-finish", handleNavigation);
    document.addEventListener("yt-navigate-finish", handleNavigation);
    window.addEventListener("popstate", handleNavigation);
    setInterval(() => {
      if (getVideoIdFromUrl() !== currentVideoId) initForCurrentVideo();
    }, 1000);

    // Fallback watcher for initial load
    setTimeout(initForCurrentVideo, 800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();