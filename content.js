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

  let settings = structuredClone(DEFAULT_SETTINGS);
  let currentVideoId = "";
  let cues = [];
  let blocks = [];
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
  let navigationTimer = null;
  let tickTimer = null;
  let reqCounter = 0;
  const pendingRequests = new Map();

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

  window.addEventListener("message", (event) => {
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
      const parsed = parseSubtitles(payload.raw);
      if (parsed.length > 0) {
        cues = parsed;
        captionLoadError = "";
        rebuildBlocksAndSync();
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
        const arabicCues = group.cues.filter((cue) => /[\u0600-\u06FF]/.test(cue.text));
        const englishCues = group.cues.filter((cue) => !/[\u0600-\u06FF]/.test(cue.text));
        let sourceText;
        let targetText;

        if (group.cues.length > 1 && (arabicCues.length === 0 || englishCues.length === 0)) {
          sourceText = group.cues[0].text;
          targetText = group.cues[1].text;
          for (const cue of group.cues.slice(2)) {
            if (/[\u0600-\u06FF]/.test(cue.text)) {
              targetText += `\n${cue.text}`;
            } else {
              sourceText += `\n${cue.text}`;
            }
          }
        } else {
          sourceText = englishCues.map((cue) => cue.text).join("\n");
          targetText = arabicCues.map((cue) => cue.text).join("\n");
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

  async function reloadGeneratedCaptions(videoId, languages = null) {
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

        usingSrt = true;
        usingGeneratedSrt = true;
        captionLoadError = "";
        cues = segments;
        rebuildBlocksAndSync();
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

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (requestId !== captionGenerationRequest || getVideoIdFromUrl() !== videoId) {
        return { ok: false, canceled: true };
      }
      if (usingSrt) return { ok: true, manual: true, segments: cues.length };
      if (cues.length > 0) return { ok: true, segments: cues.length };

      for (const langCode of languages) {
        const result = await sendToPage("FETCH_SUBTITLES", { langCode });
        if (requestId !== captionGenerationRequest || getVideoIdFromUrl() !== videoId) {
          return { ok: false, canceled: true };
        }
        if (usingSrt) return { ok: true, manual: true, segments: cues.length };
        if (cues.length > 0) return { ok: true, segments: cues.length };

        if (result?.ok && result.raw) {
          const parsed = parseSubtitles(result.raw);
          if (parsed.length > 0) {
            cues = parsed;
            captionLoadError = "";
            rebuildBlocksAndSync();
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

  async function applyPassSettings(passIdx) {
    const video = getVideoElement();
    if (!video || !settings.enabled) return null;

    const cfg = getPassConfig(passIdx);
    if (loopActive) video.playbackRate = cfg.speed;

    const subMode = cfg.subMode === "both" && !usingSrt ? "target" : cfg.subMode;
    const res = await sendToPage("APPLY_PASS", {
      audioLang: cfg.audioLang,
      subMode,
      subLang: subMode === "source" ? settings.sourceLang : settings.targetLang,
      useCustomSubs: usingSrt,
      targetLang: settings.targetLang,
      sourceLang: settings.sourceLang
    });

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
    transitionInProgress = true;
    const video = getVideoElement();
    const wasMuted = video ? video.muted : false;

    try {
      currentBlockIdx = nextBlockIdx;
      currentPassIdx = nextPassIdx;
      updateHud();
      renderCustomSubtitle();

      if (video) video.muted = true;
      const blk = blocks[currentBlockIdx];
      const blockEnd = blk ? blk.end : seekTarget + 1;
      const target = seekTarget === null ? null : Math.max(0, seekTarget);
      if (target !== null) {
        await seekAndWait(target, blockEnd);
      }

      const res = await applyPassSettings(currentPassIdx);

      if (target !== null && res?.audioRes?.ok && !res.audioRes.unchanged) {
        await wait(350);
        if (video && Math.abs(video.currentTime - target) > 0.25) {
          await seekAndWait(target, blockEnd);
        }
      }
    } finally {
      if (video) video.muted = wasMuted;
      programmaticSeekTarget = null;
      ignoreManualSeekUntil = Date.now() + 300;
      lastProgrammaticSeekTo = seekTarget === null ? null : Math.max(0, seekTarget);
      lastTickTime = video ? video.currentTime : null;
      manualSeeking = false;
      transitionInProgress = false;
      updateHud();
      renderCustomSubtitle();
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

  function rebuildBlocksAndSync() {
    blocks = buildBlocks(cues, settings.subtitlesPerLoop || 5);
    const video = getVideoElement();
    const curTime = video ? video.currentTime : 0;
    currentBlockIdx = findBlockIndexForTime(curTime);
    currentPassIdx = 0;
    if (settings.enabled && loopActive && blocks.length > 0) {
      applyPassSettings(0);
    }
    updateHud();
    renderCustomSubtitle();
  }

  function renderCustomSubtitle() {
    if (!hud.subtitleOverlay) return;

    const overlay = hud.subtitleOverlay;
    const video = getVideoElement();
    const subMode = getPassConfig(currentPassIdx).subMode;
    const targetLine = hud.subtitleTargetLine;
    const sourceLine = hud.subtitleSourceLine;
    if (!usingSrt || !settings.enabled || !video || subMode === "off") {
      targetLine.hidden = true;
      sourceLine.hidden = true;
      overlay.hidden = true;
      return;
    }

    const segment = cues.find(
      (cue) => video.currentTime >= cue.start && video.currentTime < cue.end
    );
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
      captionLoadError = "";
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

    try {
      await browser.storage.local.remove(`srt_${videoId}`);
      if (getVideoIdFromUrl() !== videoId) return;
      usingSrt = false;
      usingGeneratedSrt = false;
      captionLoadError = "";
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
      if (blocks.length === 0) return;
      const idx = Math.max(0, currentBlockIdx - 1);
      runTransition(idx, 0, blocks[idx].start);
    });

    repeatBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (blocks.length === 0) return;
      runTransition(currentBlockIdx, 0, blocks[currentBlockIdx].start);
    });

    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (blocks.length === 0) return;
      const idx = Math.min(blocks.length - 1, currentBlockIdx + 1);
      runTransition(idx, 0, blocks[idx].start);
    });

    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      loopActive = !loopActive;
      const video = getVideoElement();
      if (!loopActive && video) {
        video.playbackRate = 1.0;
      } else if (loopActive && settings.enabled && blocks.length > 0) {
        applyPassSettings(currentPassIdx);
      }
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

  function updateHud(caps, audioRes, subRes) {
    if (!hud.root) ensureHudMounted();
    if (!hud.root) return;

    hud.clearSrtBtn.hidden = !usingSrt;
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
      hud.metaText.textContent = captionLoadError;
      return;
    }

    if (!loopActive) {
      hud.statusText.textContent = "Loop Paused (1.00x)";
      hud.metaText.textContent = `Block ${currentBlockIdx + 1}/${blocks.length}`;
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
          ? usingSrt
            ? "Both"
            : "Both (load dual-language SRT)"
          : cfg.subLang;
    let meta = `${usingSrt ? `SRT: ${cues.length} segments | ` : ""}Audio: ${cfg.audioLang} | Subs: ${subDisplay}`;

    if (caps && caps.audioTrackCount <= 1) {
      meta += " (single audio track)";
    } else if (audioRes && !audioRes.ok) {
      meta += ` (${audioRes.reason})`;
    }
    if (subRes && !subRes.ok) {
      meta += ` (subtitles: ${subRes.reason})`;
    }
    if (captionLoadError) {
      meta += ` | ${captionLoadError}`;
    }

    hud.metaText.textContent = meta;
  }

  function startLoopTicker() {
    clearInterval(tickTimer);
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
        currentBlockIdx = findBlockIndexForTime(nowTime);
        currentPassIdx = 0;
      }
      lastTickTime = nowTime;

      if (!settings.enabled || !loopActive || blocks.length === 0 || manualSeeking) return;

      if (
        video.paused ||
        video.seeking ||
        programmaticSeekTarget !== null ||
        transitionInProgress
      ) {
        return;
      }

      const blk = blocks[currentBlockIdx];
      if (!blk) return;

      // Enforce speed in case YouTube resets it
      const expectedSpeed = computePassSpeed(currentPassIdx);
      if (Math.abs(video.playbackRate - expectedSpeed) > 0.01) {
        video.playbackRate = expectedSpeed;
      }

      if (nowTime > blocks[blocks.length - 1].end + 0.5) return;

      const endThreshold =
        blk.end - Math.min(0.14, 0.04 * (video.playbackRate || 1));
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
          video.playbackRate = 1.0;
          updateHud();
        }
      }
    }, 30);
  }

  function attachVideoListeners() {
    const video = getVideoElement();
    if (!video || video.dataset.ytllAttached) return;
    programmaticSeekTarget = null;
    transitionInProgress = false;
    ignoreManualSeekUntil = 0;
    manualSeeking = false;
    lastTickTime = video.currentTime;
    lastProgrammaticSeekTo = null;
    video.dataset.ytllAttached = "true";

    video.addEventListener("timeupdate", renderCustomSubtitle);
    video.addEventListener("seeking", () => {
      if (transitionInProgress || programmaticSeekTarget !== null) return;
      manualSeeking = true;
      if (blocks.length === 0) return;
      currentBlockIdx = findBlockIndexForTime(video.currentTime);
      currentPassIdx = 0;
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
      applyPassSettings(0);
    });
  }

  async function initForCurrentVideo() {
    const videoId = getVideoIdFromUrl();
    if (!videoId) {
      captionGenerationRequest++;
      currentVideoId = "";
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
      renderCustomSubtitle();
      if (hud.root) hud.root.classList.add("ytll-hidden");
      return;
    }

    if (videoId === currentVideoId && cues.length > 0) {
      ensureHudMounted();
      attachVideoListeners();
      updateHud();
      return;
    }

    currentVideoId = videoId;
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

    if (!settings.enabled) return;
    return fetchSingleLanguageCaptions(videoId, loadRequest);
  }

  async function loadSettings() {
    try {
      const stored = await browser.storage.local.get("settings");
      if (stored.settings) {
        settings = { ...structuredClone(DEFAULT_SETTINGS), ...stored.settings };
      }
    } catch (err) {
      console.error("[YT Lang Loop] Failed to load settings:", err);
    }
  }

  async function reloadCaptionsForCurrentVideo() {
    const videoId = getVideoIdFromUrl();
    if (!videoId) {
      return { ok: false, reason: "Open a YouTube video before reloading captions" };
    }

    if (videoId !== currentVideoId) {
      const initialized = await initForCurrentVideo();
      if (getVideoIdFromUrl() !== videoId || currentVideoId !== videoId) {
        return { ok: false, canceled: true };
      }
      if (usingSrt) return { ok: true, manual: true, segments: cues.length };
      if (cues.length > 0) return { ok: true, segments: cues.length };
      if (initialized?.ok === false) return initialized;
    }

    if (usingSrt) return { ok: true, manual: true, segments: cues.length };

    const requestId = ++captionGenerationRequest;
    cues = [];
    blocks = [];
    currentBlockIdx = 0;
    currentPassIdx = 0;
    captionLoadError = "";
    updateHud();
    return fetchSingleLanguageCaptions(videoId, requestId);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== "YTLL_RELOAD_CAPTIONS") return undefined;
    return reloadCaptionsForCurrentVideo();
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    const prevTarget = settings.targetLang;
    const prevSource = settings.sourceLang;
    const prevSize = settings.subtitlesPerLoop;
    const prevEnabled = settings.enabled;

    settings = { ...structuredClone(DEFAULT_SETTINGS), ...changes.settings.newValue };

    const video = getVideoElement();
    const languagesChanged =
      settings.targetLang !== prevTarget || settings.sourceLang !== prevSource;
    if (
      languagesChanged &&
      (usingGeneratedSrt || !usingSrt)
    ) {
      captionGenerationRequest++;
      usingSrt = false;
      usingGeneratedSrt = false;
      cues = [];
      blocks = [];
      if (settings.enabled) initForCurrentVideo();
      updateHud();
      return;
    }

    if (!settings.enabled) {
      if (video) video.playbackRate = 1.0;
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
  });

  // Start once DOM is ready
  async function boot() {
    await loadSettings();
    startLoopTicker();

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