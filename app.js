(() => {
  "use strict";

  const MIN_MANUAL_SWITCHES = 1;
  const PARTICIPANT_KEY = "participant_id";
  const MIN_SUBMIT_FEEDBACK_MS = 700;
  const NEXT_TRIAL_TIMEOUT_MS = 8000;

  const state = {
    participantId: null,
    config: null,
    queue: [],
    trialIndex: 0,
    trialStartedAt: 0,
    manualSwitchCount: 0,
    activeVersion: "A",
    playing: false,
    hasUserInteraction: false,
    currentAssignment: null,
    pseudoFullscreen: false,
    submittingVote: false
  };

  const el = {
    intro: document.getElementById("intro"),
    trialSection: document.getElementById("trialSection"),
    doneSection: document.getElementById("doneSection"),
    startBtn: document.getElementById("startBtn"),
    progressText: document.getElementById("progressText"),
    switchText: document.getElementById("switchText"),
    submitStatus: document.getElementById("submitStatus"),
    currentVersionText: document.getElementById("currentVersionText"),
    playState: document.getElementById("playState"),
    fullscreenBtn: document.getElementById("fullscreenBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    videoViewport: document.getElementById("videoViewport"),
    loadingOverlay: document.getElementById("loadingOverlay"),
    loadingText: document.getElementById("loadingText"),
    videoA: document.getElementById("videoA"),
    videoB: document.getElementById("videoB"),
    switchToV1: document.getElementById("switchToV1"),
    switchToV2: document.getElementById("switchToV2"),
    voteV1: document.getElementById("voteV1"),
    voteV2: document.getElementById("voteV2"),
    voteNoDiff: document.getElementById("voteNoDiff"),
    controlsOverlay: document.getElementById("controlsOverlay")
  };

  function enforceSilentPlayback() {
    [el.videoA, el.videoB].forEach((video) => {
      video.muted = true;
      video.defaultMuted = true;
      video.volume = 0;
    });
  }

  function getParticipantId() {
    const existing = localStorage.getItem(PARTICIPANT_KEY);
    if (existing) return existing;
    const id = generateUuid();
    localStorage.setItem(PARTICIPANT_KEY, id);
    return id;
  }

  function generateUuid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    if (window.crypto && typeof window.crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return `pid-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function getDeviceClass() {
    const ua = navigator.userAgent;
    if (/Mobi|Android/i.test(ua)) return "phone";
    return "laptop_desktop";
  }

  function shuffle(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function insertAtRandomPositions(base, inserts) {
    const out = base.slice();
    inserts.forEach((item) => {
      const idx = Math.floor(Math.random() * (out.length + 1));
      out.splice(idx, 0, item);
    });
    return out;
  }

  async function loadConfig() {
    const res = await fetch("config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load config.json (${res.status})`);
    return res.json();
  }

  async function ensureConfigLoaded() {
    if (state.config && state.queue.length > 0) return;
    state.config = await loadConfig();
    state.queue = buildTrialQueue(state.config);
    if (!state.queue.length) {
      throw new Error("No trials found in config.json");
    }
  }

  function buildTrialQueue(config) {
    const baseTrials = shuffle(config.trials || []).map((t) => ({
      ...t,
      trial_type: "main"
    }));

    const attentionChecks = (config.attention_checks || []).slice(0, 2).map((t, i) => ({
      id: t.id || `attention_${i + 1}`,
      clip_id: t.clip_id || `attention_${i + 1}`,
      baseline: t.baseline,
      candidate: t.candidate,
      candidate_profile: t.candidate_profile || `attention_${t.type || i + 1}`,
      trial_type: t.type || "attention"
    }));

    const combined = insertAtRandomPositions(baseTrials, attentionChecks);
    const parsedMax = Number(config.max_trials);
    const maxTrials = Number.isFinite(parsedMax) && parsedMax > 0 ? Math.floor(parsedMax) : 16;
    return combined.slice(0, Math.min(combined.length, maxTrials));
  }

  function randomizeAssignment(trial) {
    const baselineSide = Math.random() < 0.5 ? "A" : "B";
    return {
      trial,
      baselineSide,
      srcA: baselineSide === "A" ? trial.baseline : trial.candidate,
      srcB: baselineSide === "A" ? trial.candidate : trial.baseline
    };
  }

  function updateSwitchUI() {
    el.switchText.textContent = `Manual switches: ${state.manualSwitchCount} / ${MIN_MANUAL_SWITCHES}`;
    const canVote = state.manualSwitchCount >= MIN_MANUAL_SWITCHES;
    const lock = state.submittingVote;
    el.voteV1.disabled = lock || !canVote;
    el.voteV2.disabled = lock || !canVote;
    el.voteNoDiff.disabled = lock || !canVote;
  }

  function updateProgressUI() {
    el.progressText.textContent = `Trial ${state.trialIndex + 1} / ${state.queue.length}`;
  }

  function updateActiveVersionUI() {
    const label = state.activeVersion === "A" ? "Version 1" : "Version 2";
    el.currentVersionText.textContent = `Now showing: ${label}`;
    el.switchToV1.classList.toggle("active", state.activeVersion === "A");
    el.switchToV2.classList.toggle("active", state.activeVersion === "B");
  }

  function updatePlayStateUI() {
    if (state.playing) {
      el.playState.textContent = "Playing";
      el.playState.classList.remove("paused");
      el.playState.classList.add("playing");
      el.pauseBtn.textContent = "Pause";
    } else {
      el.playState.textContent = "Paused";
      el.playState.classList.remove("playing");
      el.playState.classList.add("paused");
      el.pauseBtn.textContent = "Play";
    }
  }

  function isFullscreenActive() {
    return state.pseudoFullscreen;
  }

  function updateFullscreenButtonUI() {
    el.fullscreenBtn.textContent = isFullscreenActive() ? "Exit Fullscreen" : "Fullscreen";
    el.videoViewport.classList.toggle("is-fullscreen", state.pseudoFullscreen);
    document.body.classList.toggle("pseudo-fullscreen", state.pseudoFullscreen);
  }

  async function toggleFullscreen() {
    state.pseudoFullscreen = !state.pseudoFullscreen;
    updateFullscreenButtonUI();
  }

  function activeVideoEl() {
    return state.activeVersion === "A" ? el.videoA : el.videoB;
  }

  function inactiveVideoEl() {
    return state.activeVersion === "A" ? el.videoB : el.videoA;
  }

  function showActiveVideo() {
    if (state.activeVersion === "A") {
      el.videoA.classList.remove("hidden-video");
      el.videoB.classList.add("hidden-video");
    } else {
      el.videoB.classList.remove("hidden-video");
      el.videoA.classList.add("hidden-video");
    }
    updateActiveVersionUI();
  }

  async function safePlay(video) {
    enforceSilentPlayback();
    try {
      await video.play();
      state.playing = true;
    } catch (_) {
      state.playing = false;
    }
    updatePlayStateUI();
  }

  function pauseAll() {
    el.videoA.pause();
    el.videoB.pause();
    state.playing = false;
    updatePlayStateUI();
  }

  function clampTime(t, video) {
    if (!Number.isFinite(t) || t < 0) return 0;
    const d = video.duration;
    if (!Number.isFinite(d) || d <= 0) return t;
    return Math.min(t, Math.max(0, d - 0.05));
  }

  function setPlaybackTime(video, timeSec) {
    const seek = () => {
      try {
        video.currentTime = clampTime(timeSec, video);
      } catch (_) {
        // Ignore decoder timing errors.
      }
    };

    if (video.readyState >= 1) {
      seek();
      return;
    }

    const onLoaded = () => {
      seek();
      video.removeEventListener("loadedmetadata", onLoaded);
    };
    video.addEventListener("loadedmetadata", onLoaded, { once: true });
  }

  async function waitForVideoReady(video, timeoutMs = 1200) {
    if (video.readyState >= 2) return;
    await new Promise((resolve) => {
      const done = () => {
        video.removeEventListener("loadeddata", done);
        video.removeEventListener("canplay", done);
        resolve();
      };
      const timer = window.setTimeout(() => {
        done();
        window.clearTimeout(timer);
      }, timeoutMs);
      video.addEventListener("loadeddata", done, { once: true });
      video.addEventListener("canplay", done, { once: true });
    });
  }

  async function seekVideo(video, timeSec, timeoutMs = 1000) {
    const target = clampTime(timeSec, video);
    if (!Number.isFinite(target)) return;
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      const onSeeked = () => finish();
      const timer = window.setTimeout(finish, timeoutMs);
      try {
        video.currentTime = target;
      } catch (_) {
        window.clearTimeout(timer);
        finish();
        return;
      }
      video.addEventListener("seeked", () => {
        window.clearTimeout(timer);
        onSeeked();
      }, { once: true });
    });
  }

  async function loadTrialMedia(srcA, srcB, timeoutMs = 5000) {
    el.videoA.removeAttribute("src");
    el.videoB.removeAttribute("src");
    el.videoA.load();
    el.videoB.load();

    await new Promise((resolve, reject) => {
      let settled = false;
      let loadedA = false;
      let loadedB = false;
      const timer = window.setTimeout(() => {
        if (!(loadedA && loadedB)) fail("timeout");
      }, timeoutMs);

      const cleanup = () => {
        window.clearTimeout(timer);
        el.videoA.removeEventListener("loadedmetadata", onLoadedA);
        el.videoB.removeEventListener("loadedmetadata", onLoadedB);
        el.videoA.removeEventListener("error", onErrorA);
        el.videoB.removeEventListener("error", onErrorB);
      };
      const done = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const fail = (which) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`failed_to_load_${which}`));
      };
      const onLoadedA = () => {
        loadedA = true;
        if (loadedA && loadedB) done();
      };
      const onLoadedB = () => {
        loadedB = true;
        if (loadedA && loadedB) done();
      };
      const onErrorA = () => fail("A");
      const onErrorB = () => fail("B");

      el.videoA.addEventListener("loadedmetadata", onLoadedA, { once: true });
      el.videoB.addEventListener("loadedmetadata", onLoadedB, { once: true });
      el.videoA.addEventListener("error", onErrorA, { once: true });
      el.videoB.addEventListener("error", onErrorB, { once: true });

      el.videoA.src = srcA;
      el.videoB.src = srcB;
      el.videoA.load();
      el.videoB.load();
    });
  }

  async function switchVersion(targetVersion, isManual) {
    if (state.activeVersion === targetVersion) return;

    const from = activeVideoEl();
    const to = inactiveVideoEl();
    const t = clampTime(from.currentTime, to);

    from.pause();
    await seekVideo(to, t);
    await waitForVideoReady(to);

    state.activeVersion = targetVersion;
    showActiveVideo();

    if (state.hasUserInteraction && state.playing) {
      await safePlay(to);
    }

    if (isManual) {
      state.manualSwitchCount += 1;
      updateSwitchUI();
    }
  }

  function trialExpectedChoice(trialType) {
    if (trialType === "obvious_low") return "baseline";
    if (trialType === "same_same") return "nodiff";
    return null;
  }

  function collectErrorTelemetry(reason, detail) {
    if (!state.currentAssignment) return null;
    const payload = collectTelemetry("error_skipped");
    payload.trial_outcome = "skipped_error";
    payload.error_reason = reason || "unknown";
    payload.error_detail = detail ? String(detail) : "";
    return payload;
  }

  function collectTelemetry(choice) {
    const assignment = state.currentAssignment;
    const trial = assignment.trial;
    const active = activeVideoEl();
    const rect = active.getBoundingClientRect();
    const navConn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

    return {
      participant_id: state.participantId,
      trial_id: `${trial.id}_${state.trialIndex + 1}`,
      clip_id: trial.clip_id,
      candidate_profile: trial.candidate_profile,
      trial_type: trial.trial_type,
      expected_choice: trialExpectedChoice(trial.trial_type),
      candidate_bitrate_mbps: trial.candidate_bitrate_mbps ?? null,
      candidate_size_mb: trial.candidate_size_mb ?? null,
      candidate_encode_sec: trial.candidate_encode_sec ?? null,
      baseline_size_mb: trial.baseline_size_mb ?? null,
      baseline_side: assignment.baselineSide,
      choice,
      switch_count: state.manualSwitchCount,
      time_to_answer_ms: Date.now() - state.trialStartedAt,
      device_class: getDeviceClass(),
      fullscreen: Boolean(document.fullscreenElement || document.webkitFullscreenElement),
      video_render_width: Math.round(rect.width || el.videoViewport.clientWidth || 0),
      video_render_height: Math.round(rect.height || el.videoViewport.clientHeight || 0),
      device_pixel_ratio: window.devicePixelRatio || 1,
      screen_width: window.screen.width,
      screen_height: window.screen.height,
      user_agent: navigator.userAgent,
      hardware_concurrency: navigator.hardwareConcurrency || null,
      device_memory: navigator.deviceMemory || null,
      connection_downlink: navConn && typeof navConn.downlink === "number" ? navConn.downlink : null,
      timestamp: new Date().toISOString()
    };
  }

  async function sendLog(payload) {
    const endpoints = resolveLogEndpoints(state.config || {});
    if (!endpoints.length) return;
    await Promise.allSettled(endpoints.map((endpoint) => postLog(endpoint, payload)));
  }

  async function logTrialSkip(reason, detail) {
    try {
      const payload = collectErrorTelemetry(reason, detail);
      if (!payload) return;
      await sendLog(payload);
    } catch (_) {
      // Best effort logging for skipped trials.
    }
  }

  async function postLog(endpoint, payload) {
    if (isGoogleScriptEndpoint(endpoint)) {
      try {
        await withTimeout(fetch(endpoint, {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(payload),
          keepalive: true,
          cache: "no-store"
        }), 3000);
      } catch (_) {
        // Ignore optional secondary logger failures.
      }
      return;
    }

    try {
      const res = await withTimeout(fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      }), 3000);
      if (!res.ok) throw new Error("log failed");
    } catch (_) {
      const data = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        const blob = new Blob([data], { type: "application/json" });
        navigator.sendBeacon(endpoint, blob);
      }
    }
  }

  function isGoogleScriptEndpoint(endpoint) {
    try {
      const u = new URL(endpoint, window.location.href);
      return u.hostname.includes("script.google.com") || u.hostname.includes("script.googleusercontent.com");
    } catch (_) {
      return false;
    }
  }

  function resolveLogEndpoint(raw) {
    if (!raw || typeof raw !== "string") return "";
    try {
      const u = new URL(raw, window.location.href);
      if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
        u.hostname = window.location.hostname;
      }
      return u.toString();
    } catch (_) {
      return raw;
    }
  }

  function resolveLogEndpoints(cfg) {
    const rawList = [];
    if (Array.isArray(cfg.log_endpoints)) {
      cfg.log_endpoints.forEach((x) => {
        if (typeof x === "string" && x.trim()) rawList.push(x.trim());
      });
    }
    if (typeof cfg.log_endpoint === "string" && cfg.log_endpoint.trim()) {
      rawList.push(cfg.log_endpoint.trim());
    }
    if (typeof cfg.google_log_endpoint === "string" && cfg.google_log_endpoint.trim()) {
      rawList.push(cfg.google_log_endpoint.trim());
    }

    const resolved = rawList.map(resolveLogEndpoint).filter(Boolean);
    return [...new Set(resolved)];
  }

  function withTimeout(promise, timeoutMs) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error("timeout")), timeoutMs);
      })
    ]);
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function setSubmittingState(isBusy, text = "") {
    state.submittingVote = isBusy;
    el.trialSection.classList.toggle("trial-busy", isBusy);
    el.switchToV1.disabled = isBusy;
    el.switchToV2.disabled = isBusy;
    el.pauseBtn.disabled = isBusy;
    el.fullscreenBtn.disabled = isBusy;
    if (el.loadingOverlay) {
      if (isBusy) {
        if (el.loadingText && text) el.loadingText.textContent = text;
        el.loadingOverlay.classList.remove("hidden");
        el.loadingOverlay.setAttribute("aria-hidden", "false");
      } else {
        el.loadingOverlay.classList.add("hidden");
        el.loadingOverlay.setAttribute("aria-hidden", "true");
      }
    }
    if (el.submitStatus) {
      if (isBusy && text) {
        el.submitStatus.textContent = text;
        el.submitStatus.classList.remove("hidden");
      } else {
        el.submitStatus.textContent = "";
        el.submitStatus.classList.add("hidden");
      }
    }
    updateSwitchUI();
  }

  async function loadCurrentTrial() {
    while (true) {
      const trial = state.queue[state.trialIndex];
      if (!trial) {
        pauseAll();
        setSubmittingState(false);
        el.trialSection.classList.add("hidden");
        el.doneSection.classList.remove("hidden");
        return;
      }

      const assignment = randomizeAssignment(trial);
      state.currentAssignment = assignment;
      state.manualSwitchCount = 0;
      state.activeVersion = "A";
      state.trialStartedAt = Date.now();
      state.playing = false;

      updateProgressUI();
      updateSwitchUI();
      updateActiveVersionUI();
      updatePlayStateUI();

      pauseAll();
      try {
        await loadTrialMedia(assignment.srcA, assignment.srcB);
      } catch (err) {
        console.error("Skipping broken trial media", assignment, err);
        await logTrialSkip("media_load_failed", err?.message || "load_error");
        state.trialIndex += 1;
        continue;
      }

      showActiveVideo();
      if (state.hasUserInteraction) {
        await safePlay(activeVideoEl());
      }
      setSubmittingState(false);
      return;
    }
  }

  async function loadNextTrialWithRecovery() {
    try {
      await withTimeout(loadCurrentTrial(), NEXT_TRIAL_TIMEOUT_MS);
      return;
    } catch (err) {
      console.error("Next trial transition failed, skipping one trial", err);
      await logTrialSkip("next_trial_transition_failed", err?.message || "transition_error");
      state.trialIndex += 1;
    }
    try {
      await loadCurrentTrial();
    } catch (err2) {
      console.error("Recovery load failed", err2);
      pauseAll();
      setSubmittingState(false);
      el.trialSection.classList.add("hidden");
      el.doneSection.classList.remove("hidden");
    }
  }

  async function submitVote(voteFor) {
    if (state.submittingVote) return;
    const assignment = state.currentAssignment;
    if (!assignment) return;

    let choice;
    if (voteFor === "nodiff") {
      choice = "nodiff";
    } else if (voteFor === "v1") {
      choice = assignment.baselineSide === "A" ? "baseline" : "candidate";
    } else {
      choice = assignment.baselineSide === "B" ? "baseline" : "candidate";
    }

    setSubmittingState(true, "Answer accepted. Loading next trial...");

    try {
      const payload = collectTelemetry(choice);
      await Promise.all([
        sendLog(payload),
        sleep(MIN_SUBMIT_FEEDBACK_MS)
      ]);

      state.trialIndex += 1;
      await loadNextTrialWithRecovery();
    } catch (err) {
      console.error(err);
      await logTrialSkip("submit_failed", err?.message || "submit_error");
      state.trialIndex += 1;
      await loadNextTrialWithRecovery();
    } finally {
      if (!state.currentAssignment) {
        setSubmittingState(false);
      }
    }
  }

  function bindEvents() {
    el.startBtn.addEventListener("click", async () => {
      state.hasUserInteraction = true;
      try {
        await ensureConfigLoaded();
      } catch (err) {
        console.error(err);
        alert(`Failed to load survey config: ${err?.message || "unknown error"}`);
        return;
      }
      el.intro.classList.add("hidden");
      el.trialSection.classList.remove("hidden");
      await loadCurrentTrial();
    });

    el.switchToV1.addEventListener("click", async () => {
      await switchVersion("A", true);
    });

    el.switchToV2.addEventListener("click", async () => {
      await switchVersion("B", true);
    });

    el.pauseBtn.addEventListener("click", async () => {
      if (state.playing) {
        pauseAll();
      } else {
        const active = activeVideoEl();
        await safePlay(active);
      }
    });

    el.fullscreenBtn.addEventListener("click", async () => {
      await toggleFullscreen();
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && state.pseudoFullscreen) {
        state.pseudoFullscreen = false;
        updateFullscreenButtonUI();
      }
    });

    el.voteV1.addEventListener("click", async () => {
      if (state.manualSwitchCount < MIN_MANUAL_SWITCHES) return;
      await submitVote("v1");
    });

    el.voteV2.addEventListener("click", async () => {
      if (state.manualSwitchCount < MIN_MANUAL_SWITCHES) return;
      await submitVote("v2");
    });

    el.voteNoDiff.addEventListener("click", async () => {
      if (state.manualSwitchCount < MIN_MANUAL_SWITCHES) return;
      await submitVote("nodiff");
    });
  }

  async function init() {
    enforceSilentPlayback();
    updatePlayStateUI();
    updateFullscreenButtonUI();
    state.participantId = getParticipantId();
    bindEvents();
    try {
      await ensureConfigLoaded();
    } catch (err) {
      console.error(err);
      alert(`Preload warning: ${err?.message || "unable to preload config"}. You can retry with Start.`);
    }
  }

  init().catch((err) => {
    console.error(err);
    alert(`Failed to initialize survey: ${err?.message || "unknown error"}`);
  });
})();
