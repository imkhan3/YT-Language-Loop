const LANGUAGES = [
  { code: "ar", name: "Arabic (ar)" },
  { code: "en", name: "English (en)" },
  { code: "es", name: "Spanish (es)" },
  { code: "fr", name: "French (fr)" },
  { code: "de", name: "German (de)" },
  { code: "tr", name: "Turkish (tr)" },
  { code: "ja", name: "Japanese (ja)" },
  { code: "ko", name: "Korean (ko)" },
  { code: "zh", name: "Chinese (zh)" },
  { code: "hi", name: "Hindi (hi)" },
  { code: "pt", name: "Portuguese (pt)" },
  { code: "ru", name: "Russian (ru)" }
];

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

let state = structuredClone(DEFAULT_SETTINGS);
// Keeps previously configured rows in memory if user temporarily lowers numPlaybacks
let playbackCache = structuredClone(DEFAULT_SETTINGS.playbacks);
let statusTimer = null;

const els = {
  enabled: document.getElementById("enabled"),
  main: document.getElementById("settings-form"),
  targetLang: document.getElementById("targetLang"),
  sourceLang: document.getElementById("sourceLang"),
  subtitlesPerLoop: document.getElementById("subtitlesPerLoop"),
  numPlaybacks: document.getElementById("numPlaybacks"),
  playbackList: document.getElementById("playback-list"),
  resetBtn: document.getElementById("resetBtn"),
  reloadCaptionsBtn: document.getElementById("reloadCaptionsBtn"),
  status: document.getElementById("status")
};

function populateLanguageSelect(selectEl) {
  const frag = document.createDocumentFragment();
  for (const lang of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = lang.code;
    opt.textContent = lang.name;
    frag.appendChild(opt);
  }
  selectEl.appendChild(frag);
}

function clamp(val, min, max, fallback) {
  if (Number.isNaN(val)) return fallback;
  return Math.min(max, Math.max(min, val));
}

function normalizeSpeed(val, fallback = 1.0) {
  const clamped = clamp(Number(val), 0.25, 2.0, fallback);
  return Math.round(clamped * 100) / 100;
}

function showStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.classList.toggle("error", isError);
  els.status.classList.add("visible");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    els.status.classList.remove("visible");
  }, 1400);
}

function showSavedStatus() {
  showStatus("Saved");
}

async function saveSettings() {
  try {
    state.playbacks = playbackCache.slice(0, state.numPlaybacks);
    await browser.storage.local.set({ settings: state });
    showSavedStatus();
  } catch (err) {
    console.error("Failed to save settings:", err);
  }
}

function ensurePlaybackCacheSize(count) {
  while (playbackCache.length < count) {
    playbackCache.push({ audio: "target", subtitles: "target", speed: 1.0 });
  }
}

function renderPlaybacks() {
  ensurePlaybackCacheSize(state.numPlaybacks);
  els.playbackList.textContent = "";

  const frag = document.createDocumentFragment();

  for (let i = 0; i < state.numPlaybacks; i++) {
    const pb = playbackCache[i];
    if (typeof pb.speed !== "number") {
      pb.speed = 1.0;
    }

    const row = document.createElement("div");
    row.className = "playback-row";

    // Top line: Playback # and per-pass Speed input
    const top = document.createElement("div");
    top.className = "playback-top";

    const title = document.createElement("span");
    title.className = "playback-title";
    title.textContent = `Playback ${i + 1}`;

    const speedControl = document.createElement("label");
    speedControl.className = "speed-control";
    speedControl.setAttribute("for", `speed-${i}`);

    const speedLabel = document.createElement("span");
    speedLabel.textContent = "Speed:";

    const speedInput = document.createElement("input");
    speedInput.type = "number";
    speedInput.id = `speed-${i}`;
    speedInput.className = "speed-input";
    speedInput.min = "0.25";
    speedInput.max = "2.0";
    speedInput.step = "0.05";
    speedInput.value = normalizeSpeed(pb.speed, 1.0).toFixed(2);

    speedInput.addEventListener("input", () => {
      const parsed = parseFloat(speedInput.value);
      if (!Number.isNaN(parsed) && parsed >= 0.25 && parsed <= 2.0) {
        playbackCache[i].speed = normalizeSpeed(parsed, 1.0);
        saveSettings();
      }
    });

    speedInput.addEventListener("change", () => {
      const val = normalizeSpeed(parseFloat(speedInput.value), 1.0);
      playbackCache[i].speed = val;
      speedInput.value = val.toFixed(2);
      saveSettings();
    });

    const speedUnit = document.createElement("span");
    speedUnit.className = "speed-unit";
    speedUnit.textContent = "x";

    speedControl.appendChild(speedLabel);
    speedControl.appendChild(speedInput);
    speedControl.appendChild(speedUnit);

    top.appendChild(title);
    top.appendChild(speedControl);
    row.appendChild(top);

    // Controls line: Audio radio pills + Subtitles select
    const controls = document.createElement("div");
    controls.className = "playback-controls";

    // Audio group
    const audioGroup = document.createElement("div");
    audioGroup.className = "control-group";

    const audioLabel = document.createElement("span");
    audioLabel.className = "control-label";
    audioLabel.textContent = "Audio";
    audioGroup.appendChild(audioLabel);

    const pills = document.createElement("div");
    pills.className = "radio-pills";

    for (const mode of ["target", "source"]) {
      const label = document.createElement("label");
      label.className = "radio-pill";

      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = `audio-${i}`;
      radio.value = mode;
      radio.checked = pb.audio === mode;

      radio.addEventListener("change", () => {
        playbackCache[i].audio = mode;
        saveSettings();
      });

      const span = document.createElement("span");
      span.textContent =
        mode === "target"
          ? `Target (${state.targetLang})`
          : `Source (${state.sourceLang})`;

      label.appendChild(radio);
      label.appendChild(span);
      pills.appendChild(label);
    }

    audioGroup.appendChild(pills);
    controls.appendChild(audioGroup);

    // Subtitles group
    const subGroup = document.createElement("div");
    subGroup.className = "control-group";

    const subLabel = document.createElement("label");
    subLabel.className = "control-label";
    subLabel.setAttribute("for", `subs-${i}`);
    subLabel.textContent = "Subtitles";
    subGroup.appendChild(subLabel);

    const subSelect = document.createElement("select");
    subSelect.id = `subs-${i}`;

    const subOptions = [
      { value: "target", text: `Target (${state.targetLang})` },
      { value: "source", text: `Source (${state.sourceLang})` },
      { value: "both", text: "Both (dual-language SRT)" },
      { value: "off", text: "Off" }
    ];

    for (const optData of subOptions) {
      const opt = document.createElement("option");
      opt.value = optData.value;
      opt.textContent = optData.text;
      subSelect.appendChild(opt);
    }

    subSelect.value = pb.subtitles;
    subSelect.addEventListener("change", () => {
      playbackCache[i].subtitles = subSelect.value;
      saveSettings();
    });

    subGroup.appendChild(subSelect);
    controls.appendChild(subGroup);

    row.appendChild(controls);
    frag.appendChild(row);
  }

  els.playbackList.appendChild(frag);
}

async function reloadCaptions() {
  els.reloadCaptionsBtn.disabled = true;
  showStatus("Reloading…");
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number") {
      throw new Error("No active tab found");
    }

    const result = await browser.tabs.sendMessage(tab.id, { type: "YTLL_RELOAD_CAPTIONS" });
    if (!result?.ok) {
      throw new Error(result?.reason || "Could not reload captions on this tab");
    }

    showStatus(result.manual ? "Manual SRT active" : "Captions reloaded");
  } catch (err) {
    console.error("Failed to reload captions:", err);
    showStatus(`Reload failed: ${err.message}`, true);
  } finally {
    els.reloadCaptionsBtn.disabled = false;
  }
}

function syncFormFromState() {
  els.enabled.checked = state.enabled;
  els.main.classList.toggle("disabled", !state.enabled);

  els.targetLang.value = state.targetLang;
  els.sourceLang.value = state.sourceLang;
  els.subtitlesPerLoop.value = state.subtitlesPerLoop;
  els.numPlaybacks.value = state.numPlaybacks;

  renderPlaybacks();
}

function bindEvents() {
  els.enabled.addEventListener("change", () => {
    state.enabled = els.enabled.checked;
    els.main.classList.toggle("disabled", !state.enabled);
    saveSettings();
  });

  els.targetLang.addEventListener("change", () => {
    state.targetLang = els.targetLang.value;
    renderPlaybacks();
    saveSettings();
  });

  els.sourceLang.addEventListener("change", () => {
    state.sourceLang = els.sourceLang.value;
    renderPlaybacks();
    saveSettings();
  });

  els.subtitlesPerLoop.addEventListener("change", () => {
    const val = clamp(parseInt(els.subtitlesPerLoop.value, 10), 1, 50, 5);
    state.subtitlesPerLoop = val;
    els.subtitlesPerLoop.value = val;
    saveSettings();
  });

  els.numPlaybacks.addEventListener("change", () => {
    const val = clamp(parseInt(els.numPlaybacks.value, 10), 1, 10, 3);
    state.numPlaybacks = val;
    els.numPlaybacks.value = val;
    renderPlaybacks();
    saveSettings();
  });

  els.resetBtn.addEventListener("click", () => {
    state = structuredClone(DEFAULT_SETTINGS);
    playbackCache = structuredClone(DEFAULT_SETTINGS.playbacks);
    syncFormFromState();
    saveSettings();
  });

  els.reloadCaptionsBtn.addEventListener("click", reloadCaptions);
}

async function init() {
  populateLanguageSelect(els.targetLang);
  populateLanguageSelect(els.sourceLang);

  try {
    const stored = await browser.storage.local.get("settings");
    if (stored.settings) {
      const prev = stored.settings;
      const oldFirst = typeof prev.firstSpeed === "number" ? prev.firstSpeed : 1.0;
      const oldInc = typeof prev.speedIncrement === "number" ? prev.speedIncrement : 0;

      state = {
        enabled: prev.enabled ?? DEFAULT_SETTINGS.enabled,
        targetLang: prev.targetLang || DEFAULT_SETTINGS.targetLang,
        sourceLang: prev.sourceLang || DEFAULT_SETTINGS.sourceLang,
        subtitlesPerLoop: prev.subtitlesPerLoop ?? DEFAULT_SETTINGS.subtitlesPerLoop,
        numPlaybacks: prev.numPlaybacks ?? DEFAULT_SETTINGS.numPlaybacks,
        playbacks: []
      };

      if (Array.isArray(prev.playbacks) && prev.playbacks.length > 0) {
        playbackCache = prev.playbacks.map((pb, idx) => ({
          audio: pb.audio === "source" ? "source" : "target",
          subtitles: ["target", "source", "both", "off"].includes(pb.subtitles) ? pb.subtitles : "target",
          speed: normalizeSpeed(pb.speed, oldFirst + idx * oldInc)
        }));
      }
      state.playbacks = playbackCache.slice(0, state.numPlaybacks);
    }
  } catch (err) {
    console.error("Failed to load settings:", err);
  }

  bindEvents();
  syncFormFromState();
}

init();