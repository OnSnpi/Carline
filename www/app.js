(function (global) {
  "use strict";

  const Carline = (global.Carline = global.Carline || {});
  const { CONFIG, Engine, detectLanguage, getText } = Carline;

  const state = {
    lang: "cs",
    profile: JSON.parse(JSON.stringify(CONFIG.defaults.profile)),
    settings: JSON.parse(JSON.stringify(CONFIG.defaults.settings)),
    phase: "drawing",
    viewMode: "top",
    rawPoints: [],
    track: null,
    car: Engine.createCarState(),
    ghostCar: Engine.createCarState(),
    raceElapsedSec: 0,
    targetSeriesSec: 0,
    sparks: [],
    hasMoves: false,
    showBrakingZones: false,
    drawingPointerId: null,
    manualPointerId: null,
    manualLastX: null,
    swipeStartX: null,
    swipeStartY: null,
    suppressClickUntil: 0,
    modalOpenedAt: 0,
    statusMessageKey: null,
    statusTone: "default",
    statusTimeoutId: null,
    lastFrameTime: 0,
    lastHapticMs: 0,
    audioEngine: null
  };

  const dom = {
    trackCacheCanvas: document.createElement("canvas"),
    trackCacheKey: ""
  };

  function cacheDom() {
    dom.appRoot = document.getElementById("appRoot");
    dom.hudWins = document.getElementById("hudWins");
    dom.hudLaps = document.getElementById("hudLaps");
    dom.hudTargetLaps = document.getElementById("hudTargetLaps");
    dom.btnSettings = document.getElementById("btnSettings");
    dom.statusBar = document.getElementById("statusBar");
    dom.statusText = document.getElementById("statusText");
    dom.statusSubText = document.getElementById("statusSubText");
    dom.statusActionSlot = document.getElementById("statusActionSlot");
    dom.boardCard = document.getElementById("boardCard");
    dom.canvas = document.getElementById("trackCanvas");
    dom.ctx = dom.canvas.getContext("2d");
    dom.btnUndo = document.getElementById("btnUndo");
    dom.btnGuide = document.getElementById("btnGuide");
    dom.btnHint = document.getElementById("btnHint");
    dom.btnNewGame = document.getElementById("btnNewGame");
    dom.modalBackdrop = document.getElementById("modalBackdrop");
    dom.modalCard = document.getElementById("modalCard");
  }

  function getCapacitorPrefs() {
    return global.Capacitor &&
      global.Capacitor.Plugins &&
      global.Capacitor.Plugins.Preferences
      ? global.Capacitor.Plugins.Preferences
      : null;
  }

  function getCapacitorHaptics() {
    return global.Capacitor &&
      global.Capacitor.Plugins &&
      global.Capacitor.Plugins.Haptics
      ? global.Capacitor.Plugins.Haptics
      : null;
  }

  async function saveStorage(key, obj) {
    const serialized = JSON.stringify(obj);
    try {
      global.localStorage.setItem(key, serialized);
    } catch (_) {}
    const prefs = getCapacitorPrefs();
    if (prefs) {
      try {
        await prefs.set({ key, value: serialized });
      } catch (_) {}
    }
  }

  async function loadStorage(key) {
    const prefs = getCapacitorPrefs();
    if (prefs) {
      try {
        const res = await prefs.get({ key });
        if (res && typeof res.value === "string" && res.value.length > 0) {
          return JSON.parse(res.value);
        }
      } catch (_) {}
    }
    try {
      const raw = global.localStorage.getItem(key);
      if (raw) {
        return JSON.parse(raw);
      }
    } catch (_) {}
    return null;
  }

  async function persistProfile() {
    await saveStorage(CONFIG.storageKeys.profile, {
      profile: state.profile,
      settings: state.settings
    });
  }

  async function persistSession() {
    await saveStorage(CONFIG.storageKeys.session, {
      phase: state.phase,
      viewMode: state.viewMode,
      rawPoints: state.rawPoints,
      hasMoves: state.hasMoves,
      showBrakingZones: state.showBrakingZones,
      raceElapsedSec: state.raceElapsedSec,
      car: state.car,
      ghostCar: state.ghostCar
    });
  }

  function jitter(value, ratio) {
    const delta = (Math.random() * 2 - 1) * ratio;
    return value * (1 + delta);
  }

  function initContinuousAudio() {
    if (!state.settings.sound) return null;
    if (!state.audioEngine) {
      const AudioCtx = global.AudioContext || global.webkitAudioContext;
      if (!AudioCtx) return null;
      const ctx = new AudioCtx();

      const oscPrimary = ctx.createOscillator();
      const oscSub = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const masterGain = ctx.createGain();

      oscPrimary.type = "triangle";
      oscSub.type = "sawtooth";
      oscPrimary.frequency.value = CONFIG.audio.engineIdleFreq;
      oscSub.frequency.value = CONFIG.audio.engineIdleFreq * 0.5;

      const subGain = ctx.createGain();
      subGain.gain.value = 0.35;

      filter.type = "lowpass";
      filter.frequency.value = 180;
      filter.Q.value = 2.4;

      masterGain.gain.value = 0.0001;

      oscPrimary.connect(filter);
      oscSub.connect(subGain);
      subGain.connect(filter);
      filter.connect(masterGain);
      masterGain.connect(ctx.destination);

      const bufferSize = ctx.sampleRate * 1;
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      noiseSource.loop = true;

      const screechFilter = ctx.createBiquadFilter();
      screechFilter.type = "bandpass";
      screechFilter.frequency.value = 1350;
      screechFilter.Q.value = 6.5;

      const screechGain = ctx.createGain();
      screechGain.gain.value = 0.0001;

      noiseSource.connect(screechFilter);
      screechFilter.connect(screechGain);
      screechGain.connect(ctx.destination);

      oscPrimary.start();
      oscSub.start();
      noiseSource.start();

      state.audioEngine = {
        ctx,
        oscPrimary,
        oscSub,
        filter,
        masterGain,
        screechGain,
        screechFilter
      };
    }

    if (state.audioEngine.ctx.state === "suspended") {
      state.audioEngine.ctx.resume().catch(() => {});
    }
    return state.audioEngine;
  }

  function updateEngineSound(car, isActive) {
    if (!state.settings.sound || !isActive || !car || car.phase !== "driving") {
      if (state.audioEngine) {
        const t = state.audioEngine.ctx.currentTime;
        state.audioEngine.masterGain.gain.setTargetAtTime(0.0001, t, 0.06);
        state.audioEngine.screechGain.gain.setTargetAtTime(0.0001, t, 0.04);
      }
      return;
    }

    const eng = initContinuousAudio();
    if (!eng) return;

    const t = eng.ctx.currentTime;
    const speedRatio = Math.max(0, Math.min(1, car.speed / CONFIG.physics.maxSpeed));
    const accelBoost = (car.accelLoad || 0) * 18;
    const baseFreq = CONFIG.audio.engineIdleFreq + speedRatio * (CONFIG.audio.engineMaxFreq - CONFIG.audio.engineIdleFreq) + accelBoost;
    const organicFreq = jitter(baseFreq, 0.025);

    eng.oscPrimary.frequency.setTargetAtTime(organicFreq, t, 0.045);
    eng.oscSub.frequency.setTargetAtTime(organicFreq * 0.5, t, 0.045);

    const cutoff = 140 + speedRatio * 560 + (car.accelLoad || 0) * 380;
    eng.filter.frequency.setTargetAtTime(cutoff, t, 0.05);

    const targetGain = car.speed < 4
      ? 0.006
      : CONFIG.audio.engineMasterGain * (0.45 + speedRatio * 0.55 + (car.accelLoad || 0) * 0.25);
    eng.masterGain.gain.setTargetAtTime(targetGain, t, 0.05);

    const slipScreech = Math.max(
      car.brakeLoad || 0,
      car.gripLoadRatio > 0.82 ? (car.gripLoadRatio - 0.82) / 0.18 : 0
    );
    if (slipScreech > 0.08 && car.speed > 45) {
      eng.screechFilter.frequency.setTargetAtTime(jitter(1280 + speedRatio * 420, 0.06), t, 0.03);
      eng.screechGain.gain.setTargetAtTime(Math.min(0.032, slipScreech * 0.03), t, 0.03);
    } else {
      eng.screechGain.gain.setTargetAtTime(0.0001, t, 0.04);
    }
  }

  function playOneShotTone(baseFreq, endFreq, durationSec, baseGain, type) {
    if (!state.settings.sound) return;
    const eng = initContinuousAudio();
    if (!eng) return;

    const ctx = eng.ctx;
    const freq0 = Math.max(24, jitter(baseFreq, 0.07));
    const freq1 = Math.max(22, jitter(endFreq, 0.07));
    const dur = Math.max(0.04, jitter(durationSec, 0.16));
    const peak = Math.max(0.01, jitter(baseGain, 0.15));

    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || "triangle";
    osc.frequency.setValueAtTime(freq0, t0);
    osc.frequency.exponentialRampToValueAtTime(freq1, t0 + dur);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.01);
  }

  function playOffTrackSound() {
    playOneShotTone(260, 75, 0.24, 0.085, "sawtooth");
  }

  function playWinSound() {
    playOneShotTone(523.25, 783.99, 0.22, 0.08, "triangle");
  }

  async function triggerHaptic(styleName) {
    if (!state.settings.haptics) return;
    const nowMs = performance.now();
    if (nowMs - state.lastHapticMs < CONFIG.audio.hapticCooldownMs) return;
    state.lastHapticMs = nowMs;

    const haptics = getCapacitorHaptics();
    if (haptics) {
      try {
        if (styleName === "heavy" && typeof haptics.notification === "function") {
          await haptics.notification({ type: "WARNING" });
          return;
        }
        if (typeof haptics.impact === "function") {
          await haptics.impact({ style: styleName === "heavy" ? "MEDIUM" : "LIGHT" });
          return;
        }
      } catch (_) {}
    }

    if (global.navigator && typeof global.navigator.vibrate === "function") {
      try {
        global.navigator.vibrate(styleName === "heavy" ? 45 : 14);
      } catch (_) {}
    }
  }

  function formatSec(sec) {
    return `${sec.toFixed(1)}s`;
  }

  function computeTargetSeriesTime() {
    if (!state.track) return 0;
    return state.track.autoSingleLapSec * state.settings.lapsToWin;
  }

  function applyTheme() {
    const allowedThemes = state.profile.unlockedThemes;
    const chosenTheme = allowedThemes.includes(state.profile.selectedTheme)
      ? state.profile.selectedTheme
      : "classic";
    state.profile.selectedTheme = chosenTheme;
    document.body.setAttribute("data-theme", chosenTheme);

    const allowedCars = state.profile.unlockedCars;
    if (!allowedCars.includes(state.profile.selectedCar)) {
      state.profile.selectedCar = "classic_car";
    }
  }

  function refreshUnlocks() {
    const newlyUnlocked = [];
    for (const theme of CONFIG.themes) {
      if (
        state.profile.wins >= theme.requiredWins &&
        !state.profile.unlockedThemes.includes(theme.id)
      ) {
        state.profile.unlockedThemes.push(theme.id);
        newlyUnlocked.push(getText(state.lang, theme.nameKey));
      }
    }
    for (const carStyle of CONFIG.carStyles) {
      if (
        state.profile.wins >= carStyle.requiredWins &&
        !state.profile.unlockedCars.includes(carStyle.id)
      ) {
        state.profile.unlockedCars.push(carStyle.id);
        newlyUnlocked.push(getText(state.lang, carStyle.nameKey));
      }
    }
    return newlyUnlocked;
  }

  function unlockNextBonusStep() {
    const allRewards = [
      ...CONFIG.themes.map((t) => ({ type: "theme", id: t.id, req: t.requiredWins })),
      ...CONFIG.carStyles.map((c) => ({ type: "car", id: c.id, req: c.requiredWins }))
    ].sort((a, b) => a.req - b.req);

    for (const item of allRewards) {
      if (item.type === "theme" && !state.profile.unlockedThemes.includes(item.id)) {
        state.profile.unlockedThemes.push(item.id);
        state.profile.wins = Math.max(state.profile.wins, item.req);
        return true;
      }
      if (item.type === "car" && !state.profile.unlockedCars.includes(item.id)) {
        state.profile.unlockedCars.push(item.id);
        state.profile.wins = Math.max(state.profile.wins, item.req);
        return true;
      }
    }
    state.profile.wins += 1;
    return false;
  }

  function setStatus(key, tone, durationMs) {
    state.statusMessageKey = key;
    state.statusTone = tone || "default";
    renderStatus();

    if (state.statusTimeoutId) {
      clearTimeout(state.statusTimeoutId);
      state.statusTimeoutId = null;
    }

    if (durationMs > 0) {
      state.statusTimeoutId = setTimeout(() => {
        state.statusMessageKey = null;
        state.statusTone = "default";
        renderStatus();
      }, durationMs);
    }
  }

  function renderStatusActionSlot() {
    if (state.phase === "drawing") {
      dom.statusActionSlot.innerHTML = `<button id="btnRandomTrack" class="action-pill-btn" type="button">${getText(state.lang, "btnRandomTrack")}</button>`;
      document.getElementById("btnRandomTrack").addEventListener("click", () => {
        if (performance.now() < state.suppressClickUntil) return;
        initContinuousAudio();
        const rect = dom.boardCard.getBoundingClientRect();
        state.rawPoints = Engine.generateRandomStroke(rect.width, rect.height);
        finalizeTrackFromStroke();
      });
    } else if (state.phase === "demo") {
      const viewLabel = state.viewMode === "cockpit"
        ? getText(state.lang, "btnViewTop")
        : getText(state.lang, "btnViewCockpit");
      dom.statusActionSlot.innerHTML = `
        <button id="btnToggleView" class="action-pill-btn" type="button">${viewLabel}</button>
        <button id="btnStartRace" class="action-pill-btn start-race" type="button">${getText(state.lang, "btnStartRace")}</button>
      `;
      document.getElementById("btnToggleView").addEventListener("click", () => {
        if (performance.now() < state.suppressClickUntil) return;
        state.viewMode = state.viewMode === "cockpit" ? "top" : "cockpit";
        triggerHaptic("light");
        renderStatusActionSlot();
        renderCanvas(0.016);
        persistSession();
      });
      document.getElementById("btnStartRace").addEventListener("click", () => {
        if (performance.now() < state.suppressClickUntil) return;
        initContinuousAudio();
        openRaceViewSelectModal();
      });
    } else {
      dom.statusActionSlot.innerHTML = `<span class="race-timer-badge" id="raceTimerBadge">${formatSec(state.raceElapsedSec)}</span>`;
    }
  }

  function renderStatus() {
    dom.statusBar.classList.remove("trial", "error", "success");
    if (state.statusTone === "trial") dom.statusBar.classList.add("trial");
    if (state.statusTone === "error") dom.statusBar.classList.add("error");
    if (state.statusTone === "success") dom.statusBar.classList.add("success");

    const targetSec = computeTargetSeriesTime();

    if (state.statusMessageKey) {
      dom.statusText.textContent = getText(state.lang, state.statusMessageKey);
    } else if (state.phase === "drawing") {
      dom.statusText.textContent = getText(state.lang, "statusDraw");
    } else if (state.phase === "demo") {
      dom.statusText.textContent = `${getText(state.lang, "statusDemoReady")} ${formatSec(targetSec)}`;
    } else {
      dom.statusText.textContent = `${getText(state.lang, "statusRacing")} ${formatSec(targetSec)}`;
    }

    if (state.phase === "drawing") {
      dom.statusSubText.textContent = getText(state.lang, "statusDrawSub");
    } else if (state.phase === "demo") {
      dom.statusSubText.textContent = getText(state.lang, "statusDemoSub");
    } else {
      const spd = Math.round(state.car.speed);
      let gripStr = getText(state.lang, "gripOk");
      if (state.car.phase === "flying" || state.car.phase === "dropped") {
        gripStr = getText(state.lang, "gripOut");
      } else if (state.car.gripLoadRatio > 0.78) {
        gripStr = getText(state.lang, "gripWarn");
      }
      dom.statusSubText.textContent = `${getText(state.lang, "speedLabel")}: ${spd} • ${gripStr} • ${getText(state.lang, "exitsShort")}: ${state.car.offTrackCount}`;
    }

    const timerEl = document.getElementById("raceTimerBadge");
    if (timerEl) {
      timerEl.textContent = formatSec(state.raceElapsedSec);
    }
  }

  function applyI18n() {
    document.documentElement.lang = state.lang;
    const nodes = document.querySelectorAll("[data-i18n]");
    for (const el of nodes) {
      const key = el.getAttribute("data-i18n");
      el.textContent = getText(state.lang, key);
    }
    renderStatusActionSlot();
    renderStatus();
  }

  function updateHud() {
    dom.hudWins.textContent = String(state.profile.wins);
    dom.hudLaps.textContent = state.phase === "racing" ? String(state.car.lapsCompleted) : "0";
    dom.hudTargetLaps.textContent = String(state.settings.lapsToWin);

    dom.btnHint.classList.toggle("active-hint", state.showBrakingZones);
    dom.btnUndo.disabled = state.phase === "drawing";
    dom.btnHint.disabled = state.phase === "drawing";

    renderStatus();
  }

  function resizeCanvas() {
    const rect = dom.boardCard.getBoundingClientRect();
    const dpr = Math.min(global.devicePixelRatio || 1, 2.5);
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    dom.canvas.width = Math.floor(width * dpr);
    dom.canvas.height = Math.floor(height * dpr);
    dom.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if ((state.phase === "demo" || state.phase === "racing") && Array.isArray(state.rawPoints) && state.rawPoints.length >= 6) {
      const prevRatio =
        state.track && state.track.totalLength > 0
          ? state.car.s / state.track.totalLength
          : 0;
      const prevGhostRatio =
        state.track && state.track.totalLength > 0
          ? state.ghostCar.s / state.track.totalLength
          : 0;
      state.track = Engine.buildTrack(state.rawPoints, width, height, state.settings.difficulty);
      state.car.s = prevRatio * state.track.totalLength;
      const pt = Engine.sampleAtDistance(state.track, state.car.s);
      state.car.x = pt.x;
      state.car.y = pt.y;
      state.car.angle = Math.atan2(pt.ty, pt.tx);
      state.car.sampleIndex = pt.sampleIndex;

      state.ghostCar.s = prevGhostRatio * state.track.totalLength;
      const gpt = Engine.sampleAtDistance(state.track, state.ghostCar.s);
      state.ghostCar.x = gpt.x;
      state.ghostCar.y = gpt.y;
      state.ghostCar.angle = Math.atan2(gpt.ty, gpt.tx);
      state.ghostCar.sampleIndex = gpt.sampleIndex;
    }
  }

  function getStyles() {
    const cs = global.getComputedStyle(document.body);
    return {
      cardBg: cs.getPropertyValue("--card").trim(),
      trackBed: cs.getPropertyValue("--track-bed").trim(),
      trackRail: cs.getPropertyValue("--track-rail").trim(),
      trackUnder: cs.getPropertyValue("--track-under").trim(),
      trackOver: cs.getPropertyValue("--track-over").trim(),
      carColor: cs.getPropertyValue("--car-color").trim(),
      ghostColor: cs.getPropertyValue("--ghost-color").trim(),
      startColor: cs.getPropertyValue("--start-color").trim(),
      wall: cs.getPropertyValue("--wall").trim()
    };
  }

  function spawnDriftSparks(car) {
    if (!car || car.phase !== "driving" || car.gripLoadRatio < 0.8) return;
    if (Math.random() > 0.55) return;
    const backX = car.x - Math.cos(car.angle) * 10;
    const backY = car.y - Math.sin(car.angle) * 10;
    const spread = (Math.random() - 0.5) * 1.4;
    const sparkAngle = car.angle + Math.PI + spread;
    const spd = 35 + Math.random() * 55;
    state.sparks.push({
      x: backX,
      y: backY,
      vx: Math.cos(sparkAngle) * spd,
      vy: Math.sin(sparkAngle) * spd,
      life: 0.22 + Math.random() * 0.14,
      maxLife: 0.36
    });
  }

  function updateAndDrawSparks(ctx, dt) {
    if (state.sparks.length === 0) return;
    ctx.save();
    for (let i = state.sparks.length - 1; i >= 0; i--) {
      const sp = state.sparks[i];
      sp.life -= dt;
      if (sp.life <= 0) {
        state.sparks.splice(i, 1);
        continue;
      }
      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
      const alpha = Math.max(0, sp.life / sp.maxLife);
      ctx.fillStyle = `rgba(251, 191, 36, ${alpha.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function buildTrackCacheKey(width, height) {
    return [
      width,
      height,
      state.profile.selectedTheme,
      state.showBrakingZones ? 1 : 0,
      state.track ? state.track.totalLength.toFixed(1) : "0",
      state.track && state.track.samples[0] ? state.track.samples[0].x.toFixed(1) : "0"
    ].join("|");
  }

  function ensureStaticTrackCache(width, height, styles) {
    const track = state.track;
    if (!track || !track.samples || track.samples.length < 2) return null;

    const dpr = Math.min(global.devicePixelRatio || 1, 2.5);
    const cacheKey = buildTrackCacheKey(width, height);
    const targetW = Math.max(1, Math.floor(width * dpr));
    const targetH = Math.max(1, Math.floor(height * dpr));

    if (
      dom.trackCacheKey === cacheKey &&
      dom.trackCacheCanvas.width === targetW &&
      dom.trackCacheCanvas.height === targetH
    ) {
      return dom.trackCacheCanvas;
    }

    dom.trackCacheCanvas.width = targetW;
    dom.trackCacheCanvas.height = targetH;
    dom.trackCacheKey = cacheKey;

    const octx = dom.trackCacheCanvas.getContext("2d");
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, width, height);

    const pts = track.samples;
    const n = pts.length;
    const isTournament = state.profile.selectedTheme === "tournament";

    octx.save();
    octx.lineCap = "round";
    octx.lineJoin = "round";

    // 1. Celá souvislá základní smyčka tratě najednou (bez přerušování na články)
    octx.beginPath();
    octx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < n; i++) {
      octx.lineTo(pts[i].x, pts[i].y);
    }
    octx.closePath();

    octx.strokeStyle = styles.trackBed;
    octx.lineWidth = 22;
    octx.stroke();

    if (isTournament) {
      for (let i = 0; i < n; i += 2) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % n];
        if (p0.dangerRatio > 0.32) {
          octx.beginPath();
          octx.moveTo(p0.x, p0.y);
          octx.lineTo(p1.x, p1.y);
          octx.strokeStyle = Math.floor(i / 2) % 2 === 0 ? "#ef4444" : "#ffffff";
          octx.lineWidth = 24;
          octx.stroke();
        }
      }
      octx.beginPath();
      octx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < n; i++) {
        octx.lineTo(pts[i].x, pts[i].y);
      }
      octx.closePath();
      octx.strokeStyle = "#334155";
      octx.lineWidth = 17;
      octx.stroke();
    }

    octx.strokeStyle = styles.trackRail;
    octx.lineWidth = 9;
    octx.stroke();

    if (state.showBrakingZones) {
      for (let i = 0; i < n; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % n];
        if (p0.dangerRatio > 0.38) {
          octx.beginPath();
          octx.moveTo(p0.x, p0.y);
          octx.lineTo(p1.x, p1.y);
          octx.strokeStyle = p0.dangerRatio > 0.66 ? "#e11d48" : "#d97706";
          octx.lineWidth = 5;
          octx.stroke();
        }
      }
    }

    // 2. Horní mosty v kříženích seřazené od spodnějšího k hornějšímu podle drawOrder
    const crossings = (track.crossings || []).slice().sort((a, b) => a.overOrder - b.overOrder);
    const halfSpan = 11;
    octx.lineCap = "butt";

    for (const cr of crossings) {
      octx.beginPath();
      for (let k = -halfSpan; k <= halfSpan; k++) {
        const idx = (cr.overIndex + k + n) % n;
        const p = pts[idx];
        if (k === -halfSpan) octx.moveTo(p.x, p.y);
        else octx.lineTo(p.x, p.y);
      }

      octx.strokeStyle = "rgba(0, 0, 0, 0.32)";
      octx.lineWidth = 27.5;
      octx.stroke();

      octx.strokeStyle = styles.cardBg;
      octx.lineWidth = 24.5;
      octx.stroke();

      octx.strokeStyle = styles.trackBed;
      octx.lineWidth = 21;
      octx.stroke();

      octx.strokeStyle = styles.trackOver;
      octx.lineWidth = 9;
      octx.stroke();
    }

    // Startovní / cílová čára
    const startPt = track.samples[0];
    const startAngle = Math.atan2(startPt.ty, startPt.tx);
    octx.save();
    octx.translate(startPt.x, startPt.y);
    octx.rotate(startAngle);

    octx.fillStyle = "#ffffff";
    octx.fillRect(-4, -12, 8, 24);
    octx.fillStyle = "#0f172a";
    octx.fillRect(-4, -12, 4, 6);
    octx.fillRect(0, -6, 4, 6);
    octx.fillRect(-4, 0, 4, 6);
    octx.fillRect(0, 6, 4, 6);

    octx.strokeStyle = styles.startColor;
    octx.lineWidth = 2;
    octx.strokeRect(-4.5, -12.5, 9, 25);
    octx.restore();

    octx.restore();
    return dom.trackCacheCanvas;
  }

  function stampHigherTrackLayersOverCar(ctx, cacheCanvas, width, height, carObj) {
    const track = state.track;
    if (!track || !cacheCanvas || !carObj || carObj.visible === false || carObj.phase === "flying") {
      return;
    }

    const pts = track.samples;
    const n = pts.length;
    const carIdx = Math.max(0, Math.min(n - 1, carObj.sampleIndex || 0));
    const carOrder = typeof pts[carIdx].drawOrder === "number" ? pts[carIdx].drawOrder : carIdx;

    // Vybereme pouze ty úseky tratě, které byly namalovány POZDĚJI než pozice auta (drawOrder > carOrder + rezerva),
    // a jsou blízko vozu, abychom nezatěžovali GPU zbytečnými cestami přes celé plátno
    const orderMargin = 14;
    const halfWidth = 12.2;
    let hasOverlay = false;

    ctx.save();
    ctx.beginPath();

    for (let i = 0; i < n; i++) {
      const p0 = pts[i];
      const order0 = typeof p0.drawOrder === "number" ? p0.drawOrder : i;
      if (order0 <= carOrder + orderMargin) continue;

      if (Math.hypot(p0.x - carObj.x, p0.y - carObj.y) > 48) continue;

      const p1 = pts[(i + 1) % n];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * halfWidth;
      const ny = (dx / len) * halfWidth;

      ctx.moveTo(p0.x + nx, p0.y + ny);
      ctx.lineTo(p1.x + nx, p1.y + ny);
      ctx.lineTo(p1.x - nx, p1.y - ny);
      ctx.lineTo(p0.x - nx, p0.y - ny);
      ctx.closePath();
      hasOverlay = true;
    }

    if (hasOverlay) {
      ctx.clip("nonzero");
      ctx.drawImage(cacheCanvas, 0, 0, width, height);
    }

    ctx.restore();
  }
  
  function roundRectPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function drawCarEntity(ctx, carObj, fillColor, isGhost) {
    if (!state.track || carObj.visible === false) return;

    const x = typeof carObj.x === "number" ? carObj.x : state.track.samples[0].x;
    const y = typeof carObj.y === "number" ? carObj.y : state.track.samples[0].y;
    const baseAngle = typeof carObj.angle === "number" ? carObj.angle : 0;
    const drift = isGhost ? 0 : (carObj.driftAngle || 0);
    const scale = carObj.scale || 1;
    const carStyle = isGhost ? "classic_car" : state.profile.selectedCar;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.rotate(baseAngle + drift);

    ctx.fillStyle = fillColor;
    ctx.strokeStyle = isGhost ? "rgba(255,255,255,0.65)" : "#ffffff";
    ctx.lineWidth = isGhost ? 1.5 : 2;

    if (carStyle === "neon_dot") {
      ctx.beginPath();
      ctx.arc(0, 0, 9.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(4, 0, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (carStyle === "formula") {
      ctx.beginPath();
      ctx.moveTo(13, 0);
      ctx.lineTo(-10, -7);
      ctx.lineTo(-7, 0);
      ctx.lineTo(-10, 7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (carStyle === "prototype") {
      ctx.beginPath();
      ctx.moveTo(14.5, 0);
      ctx.quadraticCurveTo(8, -6.5, -10, -7.5);
      ctx.lineTo(-13, -8.5);
      ctx.lineTo(-13, 8.5);
      ctx.lineTo(-10, 7.5);
      ctx.quadraticCurveTo(8, 6.5, 14.5, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-13.5, -8, 2.8, 16);

      ctx.beginPath();
      ctx.ellipse(1.5, 0, 4.5, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (carStyle === "bus") {
      roundRectPath(ctx, -14.5, -7.5, 29, 15, 3.5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(8.5, -5.2, 3.8, 10.4);
      ctx.fillRect(-10, -4.2, 4.5, 8.4);
      ctx.fillRect(-2.5, -4.2, 4.5, 8.4);
    } else if (carStyle === "truck") {
      roundRectPath(ctx, -16.5, -7.5, 19, 15, 2.5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(2.5, -2.5, 2.5, 5);

      ctx.fillStyle = fillColor;
      roundRectPath(ctx, 4.5, -7, 9.5, 14, 3);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(10, -4.8, 2.8, 9.6);
    } else {
      roundRectPath(ctx, -11, -7, 22, 14, 4);
      ctx.fill();
      ctx.stroke();
      if (!isGhost) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(3.5, -3, 4.5, 6);
      }
    }

    ctx.restore();
  }

  function drawDrawingStroke(ctx, styles) {
    if (!Array.isArray(state.rawPoints) || state.rawPoints.length === 0) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = styles.trackRail;
    ctx.lineWidth = 6;

    ctx.beginPath();
    ctx.moveTo(state.rawPoints[0].x, state.rawPoints[0].y);
    for (let i = 1; i < state.rawPoints.length; i++) {
      ctx.lineTo(state.rawPoints[i].x, state.rawPoints[i].y);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(state.rawPoints[0].x, state.rawPoints[0].y, 8, 0, Math.PI * 2);
    ctx.fillStyle = styles.startColor;
    ctx.fill();
    ctx.restore();
  }

  function getCockpitThemePalette() {
    const theme = state.profile.selectedTheme;
    if (theme === "emerald") {
      return {
        skyTop: "#022c22",
        skyBottom: "#065f46",
        ground: "#064e3b",
        road: "#047857",
        curbA: "#fbbf24",
        curbB: "#ecfdf5",
        rail: "#fde68a",
        pillar: "#022c22",
        dash: "#022c22",
        dashAccent: "#fbbf24"
      };
    }
    if (theme === "tournament") {
      return {
        skyTop: "#0f172a",
        skyBottom: "#1e293b",
        ground: "#1e293b",
        road: "#334155",
        curbA: "#ef4444",
        curbB: "#f8fafc",
        rail: "#94a3b8",
        pillar: "#0f172a",
        dash: "#0f172a",
        dashAccent: "#ef4444"
      };
    }
    if (theme === "royal") {
      return {
        skyTop: "#090d16",
        skyBottom: "#1e293b",
        ground: "#0f172a",
        road: "#1e293b",
        curbA: "#fbbf24",
        curbB: "#334155",
        rail: "#fbbf24",
        pillar: "#090d16",
        dash: "#090d16",
        dashAccent: "#fbbf24"
      };
    }
    return {
      skyTop: "#bae6fd",
      skyBottom: "#e0f2fe",
      ground: "#e2e8f0",
      road: "#475569",
      curbA: "#ef4444",
      curbB: "#ffffff",
      rail: "#cbd5e1",
      pillar: "#334155",
      dash: "#1e293b",
      dashAccent: "#2563eb"
    };
  }

  function renderCockpitView(ctx, width, height, styles) {
    const track = state.track;
    if (!track || !track.samples || track.samples.length === 0) return;

    const pal = getCockpitThemePalette();
    const car = state.car;
    const totalLen = track.totalLength;
    const n = track.samples.length;
    const stepDist = totalLen / n;

    const camPt = Engine.sampleAtDistance(track, car.s);
    const aheadSlopePt = Engine.sampleAtDistance(track, car.s + stepDist * 3);
    const slope = ((aheadSlopePt.z || 0) - (camPt.z || 0)) / Math.max(1, stepDist * 3);

    const speedRatio = Math.max(0, Math.min(1, car.speed / CONFIG.physics.maxSpeed));
    const turnForce = (camPt.signedCurvature || 0) * car.speed * 1.9;
    const clampedTurn = Math.max(-1, Math.min(1, turnForce));
    const driftVisual = car.driftAngle || 0;

    let rollAngle = -clampedTurn * 0.085 - driftVisual * 0.25;
    let pitchOffset = ((car.brakeLoad || 0) - (car.accelLoad || 0)) * 18 + slope * 420;
    let camHeight = 14 + (camPt.z || 0) * 34;

    if (car.phase === "flying") {
      const p = Math.min(1, car.phaseTimer / CONFIG.physics.flightDurationSec);
      camHeight += Math.sin(p * Math.PI) * 38;
      rollAngle += Math.sin(p * Math.PI * 2) * 0.45;
      pitchOffset -= Math.sin(p * Math.PI) * 35;
    }

    const horizonY = height * 0.44 + pitchOffset;
    const focal = width * 0.85;
    const halfRoadWorld = 11.5;
    const headingAngle = Math.atan2(camPt.ty, camPt.tx) + driftVisual * 0.45;
    const fwdX = Math.cos(headingAngle);
    const fwdY = Math.sin(headingAngle);
    const rightX = -fwdY;
    const rightY = fwdX;

    ctx.save();
    ctx.translate(width * 0.5, horizonY);
    ctx.rotate(rollAngle);
    ctx.translate(-width * 0.5, -horizonY);

    // 1. Obloha a horizont
    const skyGrad = ctx.createLinearGradient(0, -height * 0.5, 0, horizonY);
    skyGrad.addColorStop(0, pal.skyTop);
    skyGrad.addColorStop(1, pal.skyBottom);
    ctx.fillStyle = skyGrad;
    ctx.fillRect(-width * 0.5, -height * 0.5, width * 2, horizonY + height * 0.5 + 2);

    // 2. Zemina / povrch stolu pod tratí
    ctx.fillStyle = pal.ground;
    ctx.fillRect(-width * 0.5, horizonY, width * 2, height * 1.5);

    // 3. Projekce bodů tratě před vozidlem (od nejvzdálenějšího po nejbližší)
    const lookSteps = 105;
    const projected = [];

    function projectWorldPoint(wx, wy, wz) {
      const dx = wx - camPt.x;
      const dy = wy - camPt.y;
      const forward = dx * fwdX + dy * fwdY;
      if (forward <= 2.2) return null;
      const lateral = dx * rightX + dy * rightY;
      const relZ = wz * 34 - camHeight;
      const scale = focal / forward;
      return {
        sx: width * 0.5 + lateral * scale,
        sy: horizonY - relZ * scale,
        groundSy: horizonY + camHeight * scale,
        halfW: halfRoadWorld * scale,
        forward,
        scale
      };
    }

    for (let k = 1; k <= lookSteps; k++) {
      const distAhead = k * stepDist * 0.85;
      const sSample = car.s + distAhead;
      const sp = Engine.sampleAtDistance(track, sSample);
      const proj = projectWorldPoint(sp.x, sp.y, sp.z || 0);
      if (proj) {
        const globalSeg = Math.floor(sSample / (stepDist * 1.7));
        projected.push({
          proj,
          z: sp.z || 0,
          dangerRatio: sp.dangerRatio || 0,
          segIndex: globalSeg,
          isStart: ((sSample % totalLen) + totalLen) % totalLen < stepDist * 1.4
        });
      }
    }

    for (let i = projected.length - 1; i >= 1; i--) {
      const farNode = projected[i];
      const nearNode = projected[i - 1];
      const f = farNode.proj;
      const nr = nearNode.proj;

      // Mostní pilíře u nadjezdů
      if (nearNode.z > 0.22 && nearNode.segIndex % 3 === 0) {
        const pillarW = Math.max(2, nr.halfW * 0.24);
        ctx.fillStyle = pal.pillar;
        ctx.fillRect(nr.sx - nr.halfW * 0.78 - pillarW * 0.5, nr.sy, pillarW, Math.max(0, nr.groundSy - nr.sy));
        ctx.fillRect(nr.sx + nr.halfW * 0.78 - pillarW * 0.5, nr.sy, pillarW, Math.max(0, nr.groundSy - nr.sy));
      }

      // Krajnice / svodidla a patníky
      const curbScale = 1.24;
      const useAlt = Math.abs(nearNode.segIndex) % 2 === 0;
      let curbColor = useAlt ? pal.curbA : pal.curbB;
      if (state.showBrakingZones && nearNode.dangerRatio > 0.38) {
        curbColor = nearNode.dangerRatio > 0.66 ? "#e11d48" : "#f59e0b";
      }

      ctx.fillStyle = curbColor;
      ctx.beginPath();
      ctx.moveTo(nr.sx - nr.halfW * curbScale, nr.sy);
      ctx.lineTo(nr.sx + nr.halfW * curbScale, nr.sy);
      ctx.lineTo(f.sx + f.halfW * curbScale, f.sy);
      ctx.lineTo(f.sx - f.halfW * curbScale, f.sy);
      ctx.closePath();
      ctx.fill();

      // Svislé patníky u krajnic v popředí
      if (useAlt && nr.forward < 160) {
        const postH = Math.max(2, nr.halfW * 0.34);
        const postW = Math.max(1.5, nr.halfW * 0.08);
        ctx.fillStyle = pal.curbB;
        ctx.fillRect(nr.sx - nr.halfW * 1.18 - postW * 0.5, nr.sy - postH, postW, postH);
        ctx.fillRect(nr.sx + nr.halfW * 1.18 - postW * 0.5, nr.sy - postH, postW, postH);
      }

      // Vozovka
      ctx.fillStyle = nearNode.isStart ? styles.startColor : pal.road;
      ctx.beginPath();
      ctx.moveTo(nr.sx - nr.halfW, nr.sy);
      ctx.lineTo(nr.sx + nr.halfW, nr.sy);
      ctx.lineTo(f.sx + f.halfW, f.sy);
      ctx.lineTo(f.sx - f.halfW, f.sy);
      ctx.closePath();
      ctx.fill();

      // Středová vodicí kolejnice
      ctx.strokeStyle = nearNode.z > 0.25 ? styles.trackOver : pal.rail;
      ctx.lineWidth = Math.max(1, nr.halfW * 0.09);
      ctx.beginPath();
      ctx.moveTo(nr.sx, nr.sy);
      ctx.lineTo(f.sx, f.sy);
      ctx.stroke();
    }

    // 4. Duch soupeře na trati před hráčem (v režimu racing)
    let ghostDeltaS = 0;
    if (state.phase === "racing" && state.ghostCar && state.ghostCar.visible !== false) {
      let diffS = state.ghostCar.s - car.s;
      while (diffS > totalLen * 0.5) diffS -= totalLen;
      while (diffS < -totalLen * 0.5) diffS += totalLen;
      ghostDeltaS = diffS;

      if (diffS > 2 && diffS < lookSteps * stepDist * 0.85) {
        const gp = Engine.sampleAtDistance(track, state.ghostCar.s);
        const gProj = projectWorldPoint(gp.x, gp.y, gp.z || 0);
        if (gProj) {
          const gw = gProj.halfW * 1.05;
          const gh = gw * 0.52;
          ctx.save();
          ctx.fillStyle = styles.ghostColor;
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = Math.max(1, gw * 0.06);
          roundRectPath(ctx, gProj.sx - gw * 0.5, gProj.sy - gh, gw, gh, gh * 0.28);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "rgba(255,255,255,0.75)";
          roundRectPath(ctx, gProj.sx - gw * 0.32, gProj.sy - gh * 1.32, gw * 0.64, gh * 0.42, gh * 0.18);
          ctx.fill();
          ctx.restore();
        }
      }
    }

    ctx.restore();

    // 5. Kokpit vozidla v popředí (2D vrstva)
    const vibY = car.phase === "driving" ? Math.sin(performance.now() * 0.05) * (0.4 + speedRatio * 1.2) : 0;
    const dashTopY = height * 0.77 + vibY;

    // Kapota vozu před čelním sklem
    ctx.save();
    ctx.fillStyle = styles.carColor;
    ctx.beginPath();
    ctx.moveTo(width * 0.24, dashTopY + 6);
    ctx.lineTo(width * 0.34, height * 0.69 + vibY);
    ctx.lineTo(width * 0.66, height * 0.69 + vibY);
    ctx.lineTo(width * 0.76, dashTopY + 6);
    ctx.closePath();
    ctx.fill();

    // Palubní deska
    ctx.fillStyle = pal.dash;
    ctx.beginPath();
    ctx.moveTo(0, height);
    ctx.lineTo(0, dashTopY + 14);
    ctx.quadraticCurveTo(width * 0.5, dashTopY - 14, width, dashTopY + 14);
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = pal.dashAccent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, dashTopY + 14);
    ctx.quadraticCurveTo(width * 0.5, dashTopY - 14, width, dashTopY + 14);
    ctx.stroke();

    // Zpětné zrcátko (ukazuje ducha těsně za hráčem)
    const mirrorW = Math.min(116, width * 0.3);
    const mirrorH = 24;
    const mirrorX = (width - mirrorW) * 0.5;
    const mirrorY = 10;
    ctx.fillStyle = pal.dash;
    roundRectPath(ctx, mirrorX - 3, mirrorY - 3, mirrorW + 6, mirrorH + 6, 8);
    ctx.fill();
    ctx.fillStyle = pal.skyBottom;
    roundRectPath(ctx, mirrorX, mirrorY, mirrorW, mirrorH, 6);
    ctx.fill();
    ctx.fillStyle = pal.road;
    ctx.fillRect(mirrorX, mirrorY + mirrorH * 0.52, mirrorW, mirrorH * 0.48);

    if (state.phase === "racing" && ghostDeltaS < -1 && ghostDeltaS > -95) {
      const prox = 1 - Math.abs(ghostDeltaS) / 95;
      const mw = 10 + prox * 16;
      const mh = 5 + prox * 7;
      ctx.fillStyle = styles.ghostColor;
      roundRectPath(ctx, mirrorX + mirrorW * 0.5 - mw * 0.5, mirrorY + mirrorH * 0.65 - mh * 0.5, mw, mh, 2);
      ctx.fill();
    }

    // Volant (otáčí se podle zatáčky a smyku)
    const wheelX = width * 0.5 - clampedTurn * 10;
    const wheelY = height * 0.91 + vibY;
    const wheelR = Math.min(62, width * 0.165);
    const steerAngle = clampedTurn * 0.85 + driftVisual * 1.4;

    ctx.save();
    ctx.translate(wheelX, wheelY);
    ctx.rotate(steerAngle);

    ctx.strokeStyle = "#0f172a";
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.arc(0, 0, wheelR, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = pal.dashAccent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, wheelR, -Math.PI * 0.56, -Math.PI * 0.44);
    ctx.stroke();

    // Ramena volantu
    ctx.strokeStyle = "#334155";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(-wheelR + 4, 2);
    ctx.lineTo(wheelR - 4, 2);
    ctx.moveTo(0, 2);
    ctx.lineTo(0, wheelR - 4);
    ctx.stroke();

    ctx.fillStyle = pal.dash;
    ctx.beginPath();
    ctx.arc(0, 0, wheelR * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Digitální ukazatel rychlosti a přetížení magnetu na palubní desce
    const gaugeW = 84;
    const gaugeH = 26;
    const gaugeX = width * 0.5 - gaugeW * 0.5;
    const gaugeY = dashTopY + 4;
    ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
    roundRectPath(ctx, gaugeX, gaugeY, gaugeW, gaugeH, 7);
    ctx.fill();

    const gripRatio = Math.min(1, car.gripLoadRatio || 0);
    ctx.fillStyle = gripRatio > 0.82 ? "#ef4444" : gripRatio > 0.65 ? "#f59e0b" : "#22c55e";
    ctx.fillRect(gaugeX + 6, gaugeY + gaugeH - 5, (gaugeW - 12) * gripRatio, 2.5);

    ctx.fillStyle = "#f8fafc";
    ctx.font = "700 13px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(car.speed)}`, gaugeX + gaugeW * 0.5, gaugeY + 11);

    ctx.restore();
  }

  function renderCanvas(dt) {
    const rect = dom.boardCard.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const styles = getStyles();

    dom.ctx.clearRect(0, 0, width, height);

    if (state.phase === "drawing") {
      drawDrawingStroke(dom.ctx, styles);
      return;
    }

    if (state.viewMode === "cockpit") {
      renderCockpitView(dom.ctx, width, height, styles);
      return;
    }

    const trackImg = ensureStaticTrackCache(width, height, styles);
    if (trackImg) {
      dom.ctx.drawImage(trackImg, 0, 0, width, height);
    }

    if (state.phase === "demo") {
      drawCarEntity(dom.ctx, state.car, styles.carColor, false);
      if (trackImg) {
        stampHigherTrackLayersOverCar(dom.ctx, trackImg, width, height, state.car);
      }
      return;
    }

    if (state.phase === "racing") {
      updateAndDrawSparks(dom.ctx, dt || 0.016);
      drawCarEntity(dom.ctx, state.ghostCar, styles.ghostColor, true);
      if (trackImg) {
        stampHigherTrackLayersOverCar(dom.ctx, trackImg, width, height, state.ghostCar);
      }
      drawCarEntity(dom.ctx, state.car, styles.carColor, false);
      if (trackImg) {
        stampHigherTrackLayersOverCar(dom.ctx, trackImg, width, height, state.car);
      }
    }
  }
  
  function finalizeTrackFromStroke() {
    const check = Engine.validateStroke(state.rawPoints);
    if (!check.valid) {
      state.rawPoints = [];
      setStatus("statusTooShort", "error", 2200);
      renderCanvas(0.016);
      return;
    }

    const rect = dom.boardCard.getBoundingClientRect();
    state.track = Engine.buildTrack(state.rawPoints, rect.width, rect.height, state.settings.difficulty);
    state.car = Engine.createCarState();
    const startPt = Engine.sampleAtDistance(state.track, 0);
    state.car.x = startPt.x;
    state.car.y = startPt.y;
    state.car.angle = Math.atan2(startPt.ty, startPt.tx);
    state.car.targetSpeed = CONFIG.physics.autoCruiseMax;

    state.phase = "demo";
    state.hasMoves = false;
    state.sparks = [];
    state.profile.tracksBuilt += 1;

    renderStatusActionSlot();
    setStatus(null, "default", 0);
    updateHud();
    renderCanvas(0.016);
    persistProfile();
    persistSession();
  }

  function startManualRace() {
    if (!state.track) return;
    state.phase = "racing";
    state.hasMoves = true;
    state.raceElapsedSec = 0;
    state.targetSeriesSec = computeTargetSeriesTime();
    state.sparks = [];

    const startPt = Engine.sampleAtDistance(state.track, 0);
    const initialSpeed = state.settings.launchWithGas ? CONFIG.physics.manualStartSpeed : 0;

    state.car = Engine.createCarState();
    state.car.x = startPt.x;
    state.car.y = startPt.y;
    state.car.angle = Math.atan2(startPt.ty, startPt.tx);
    state.car.speed = initialSpeed;
    state.car.targetSpeed = initialSpeed;

    state.ghostCar = Engine.createCarState();
    state.ghostCar.x = startPt.x;
    state.ghostCar.y = startPt.y;
    state.ghostCar.angle = Math.atan2(startPt.ty, startPt.tx);
    state.ghostCar.speed = 90;
    state.ghostCar.targetSpeed = CONFIG.physics.autoCruiseMax;

    triggerHaptic("light");
    renderStatusActionSlot();
    setStatus("statusRaceStarted", "success", 2000);
    updateHud();
    renderCanvas(0.016);
    persistSession();
  }

  function returnCarToStart() {
    if ((state.phase !== "demo" && state.phase !== "racing") || !state.track) return;
    const startPt = Engine.sampleAtDistance(state.track, 0);
    state.sparks = [];

    if (state.phase === "demo") {
      state.car = Engine.createCarState();
      state.car.x = startPt.x;
      state.car.y = startPt.y;
      state.car.angle = Math.atan2(startPt.ty, startPt.tx);
      state.car.speed = 0;
      state.car.targetSpeed = CONFIG.physics.autoCruiseMax;

      triggerHaptic("light");
      setStatus("statusResetStart", "trial", 1600);
      updateHud();
      renderCanvas(0.016);
      persistSession();
      return;
    }

    const initialSpeed = state.settings.launchWithGas ? CONFIG.physics.manualStartSpeed : 0;
    state.raceElapsedSec = 0;

    state.car = Engine.createCarState();
    state.car.x = startPt.x;
    state.car.y = startPt.y;
    state.car.angle = Math.atan2(startPt.ty, startPt.tx);
    state.car.speed = initialSpeed;
    state.car.targetSpeed = initialSpeed;

    state.ghostCar = Engine.createCarState();
    state.ghostCar.x = startPt.x;
    state.ghostCar.y = startPt.y;
    state.ghostCar.angle = Math.atan2(startPt.ty, startPt.tx);
    state.ghostCar.speed = 90;
    state.ghostCar.targetSpeed = CONFIG.physics.autoCruiseMax;

    triggerHaptic("light");
    setStatus("statusResetStart", "trial", 1600);
    updateHud();
    renderCanvas(0.016);
    persistSession();
  }

  function resetToNewTrack() {
    state.phase = "drawing";
    state.viewMode = "top";
    state.rawPoints = [];
    state.track = null;
    state.car = Engine.createCarState();
    state.ghostCar = Engine.createCarState();
    state.raceElapsedSec = 0;
    state.sparks = [];
    state.hasMoves = false;
    state.showBrakingZones = false;
    state.drawingPointerId = null;
    state.manualPointerId = null;
    state.manualLastX = null;
    state.statusMessageKey = null;
    state.statusTone = "default";

    renderStatusActionSlot();
    updateHud();
    renderCanvas(0.016);
    persistSession();
  }

  function handleHintAction() {
    if (state.phase === "drawing" || !state.track) return;
    state.showBrakingZones = !state.showBrakingZones;
    setStatus(state.showBrakingZones ? "statusHintShown" : "statusHintHidden", "trial", 2200);
    triggerHaptic("light");
    updateHud();
    renderCanvas(0.016);
    persistSession();
  }

  function getCanvasCoords(ev) {
    const rect = dom.canvas.getBoundingClientRect();
    return {
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top
    };
  }

  function getThemePreviewSvg(id) {
    if (id === "emerald") {
      return `<svg width="22" height="22" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="4" fill="#065f46" stroke="#fbbf24" stroke-width="2.5"/><rect x="8" y="9" width="8" height="6" rx="1.5" fill="#ecfdf5"/></svg>`;
    }
    if (id === "tournament") {
      return `<svg width="22" height="22" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="4" fill="#1e293b" stroke="#ef4444" stroke-width="2.5"/><line x1="6" y1="12" x2="18" y2="12" stroke="#ffffff" stroke-width="2" stroke-dasharray="3 2"/></svg>`;
    }
    if (id === "royal") {
      return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18h18M4 15l2-9 6 5 6-5 2 9H4z"/></svg>`;
    }
    const classicStroke = state.profile.selectedTheme === "classic" ? "#1e293b" : "#ffffff";
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="${classicStroke}" stroke-width="2.2"><rect x="4" y="6" width="16" height="12" rx="3"/><line x1="12" y1="6" x2="12" y2="18"/></svg>`;
  }

  function getCarPreviewSvg(id) {
    const styles = getStyles();
    const fill = styles.carColor || "#e11d48";
    const stroke = styles.wall || "#1e293b";

    if (id === "formula") {
      return `<svg width="26" height="22" viewBox="0 0 28 22"><polygon points="24,11 5,4 8,11 5,18" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/></svg>`;
    }
    if (id === "prototype") {
      return `<svg width="28" height="22" viewBox="0 0 30 22"><path d="M26 11 Q19 5 5 4.5 L3 3.5 L3 18.5 L5 17.5 Q19 17 26 11 Z" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/><rect x="2.5" y="4" width="2.4" height="14" fill="#ffffff"/><ellipse cx="14.5" cy="11" rx="4" ry="2.6" fill="#ffffff"/></svg>`;
    }
    if (id === "bus") {
      return `<svg width="28" height="22" viewBox="0 0 30 22"><rect x="2.5" y="4.5" width="25" height="13" rx="3" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/><rect x="21.5" y="6.5" width="3.5" height="9" rx="0.8" fill="#ffffff"/><rect x="6" y="7" width="4" height="8" rx="0.8" fill="#ffffff"/><rect x="12.5" y="7" width="4" height="8" rx="0.8" fill="#ffffff"/></svg>`;
    }
    if (id === "truck") {
      return `<svg width="30" height="22" viewBox="0 0 32 22"><rect x="2" y="4.5" width="16" height="13" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/><rect x="18" y="8.8" width="2.5" height="4.4" fill="${stroke}"/><rect x="20" y="5" width="9.5" height="12" rx="2.5" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/><rect x="25" y="7" width="2.6" height="8" rx="0.6" fill="#ffffff"/></svg>`;
    }
    if (id === "neon_dot") {
      return `<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/><circle cx="15" cy="12" r="2.2" fill="#ffffff"/></svg>`;
    }
    return `<svg width="26" height="22" viewBox="0 0 28 22"><rect x="4" y="5" width="20" height="12" rx="3.5" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/><rect x="15" y="8.5" width="4.5" height="5" fill="#ffffff"/></svg>`;
  }

  function bindEvents() {
    global.addEventListener("resize", () => {
      resizeCanvas();
      renderCanvas(0.016);
    });

    dom.btnUndo.addEventListener("click", () => {
      if (performance.now() < state.suppressClickUntil) return;
      returnCarToStart();
    });

    dom.btnGuide.addEventListener("click", () => {
      if (performance.now() < state.suppressClickUntil) return;
      openGuideModal();
    });

    dom.btnHint.addEventListener("click", () => {
      if (performance.now() < state.suppressClickUntil) return;
      handleHintAction();
    });

    dom.btnNewGame.addEventListener("click", () => {
      if (performance.now() < state.suppressClickUntil) return;
      if (state.phase === "racing" || (state.phase === "drawing" && state.rawPoints.length > 0)) {
        openConfirmNewModal();
      } else {
        resetToNewTrack();
      }
    });

    dom.btnSettings.addEventListener("click", () => {
      if (performance.now() < state.suppressClickUntil) return;
      openSettingsModal();
    });

    dom.appRoot.addEventListener("touchstart", (ev) => {
      if (ev.target.closest("#boardCard")) return;
      if (ev.touches.length === 1) {
        state.swipeStartX = ev.touches[0].clientX;
        state.swipeStartY = ev.touches[0].clientY;
      }
    }, { passive: true });

    dom.appRoot.addEventListener("touchend", (ev) => {
      if (state.swipeStartX === null || ev.target.closest("#boardCard")) {
        state.swipeStartX = null;
        state.swipeStartY = null;
        return;
      }
      const touch = ev.changedTouches[0];
      const dx = touch.clientX - state.swipeStartX;
      const dy = touch.clientY - state.swipeStartY;
      state.swipeStartX = null;
      state.swipeStartY = null;

      if (dx < -55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        state.suppressClickUntil = performance.now() + 350;
        returnCarToStart();
      }
    }, { passive: true });

    dom.modalBackdrop.addEventListener("click", (ev) => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) {
        return;
      }
      if (ev.target === dom.modalBackdrop) {
        closeModal();
      }
    });

    dom.canvas.addEventListener("pointerdown", (ev) => {
      initContinuousAudio();

      if (state.phase === "drawing") {
        if (state.drawingPointerId !== null) return;
        state.drawingPointerId = ev.pointerId;
        dom.canvas.setPointerCapture(ev.pointerId);
        const pt = getCanvasCoords(ev);
        state.rawPoints = [{ x: pt.x, y: pt.y, t: performance.now() }];
        renderCanvas(0.016);
        return;
      }

      if (state.phase === "racing") {
        if (state.manualPointerId !== null) return;
        state.manualPointerId = ev.pointerId;
        state.manualLastX = ev.clientX;
        dom.canvas.setPointerCapture(ev.pointerId);
      }
    });

    dom.canvas.addEventListener("pointermove", (ev) => {
      if (state.phase === "drawing" && ev.pointerId === state.drawingPointerId) {
        const pt = getCanvasCoords(ev);
        const last = state.rawPoints[state.rawPoints.length - 1];
        if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) >= CONFIG.drawing.minPointDistance) {
          state.rawPoints.push({ x: pt.x, y: pt.y, t: performance.now() });
          renderCanvas(0.016);
        }
        return;
      }

      if (state.phase === "racing" && ev.pointerId === state.manualPointerId) {
        if (state.manualLastX === null) {
          state.manualLastX = ev.clientX;
          return;
        }
        const dx = ev.clientX - state.manualLastX;
        state.manualLastX = ev.clientX;
        if (Math.abs(dx) > 0.5) {
          state.hasMoves = true;
          const spec = CONFIG.carSpecs[state.profile.selectedCar] || CONFIG.carSpecs.classic_car;
          const maxAllowed = CONFIG.physics.maxSpeed * spec.maxSpeedMult;
          const nextTarget = state.car.targetSpeed + dx * CONFIG.physics.manualDragSensitivity;
          state.car.targetSpeed = Math.max(
            CONFIG.physics.minSpeed,
            Math.min(maxAllowed, nextTarget)
          );
          triggerHaptic("light");
        }
      }
    });

    function handlePointerRelease(ev) {
      if (state.phase === "drawing" && ev.pointerId === state.drawingPointerId) {
        state.drawingPointerId = null;
        try {
          dom.canvas.releasePointerCapture(ev.pointerId);
        } catch (_) {}
        finalizeTrackFromStroke();
        return;
      }

      if (ev.pointerId === state.manualPointerId) {
        state.manualPointerId = null;
        state.manualLastX = null;
        try {
          dom.canvas.releasePointerCapture(ev.pointerId);
        } catch (_) {}
      }
    }

    dom.canvas.addEventListener("pointerup", handlePointerRelease);
    dom.canvas.addEventListener("pointercancel", handlePointerRelease);
  }

  function closeModal() {
    dom.modalBackdrop.classList.remove("open");
    dom.modalCard.innerHTML = "";
  }

  function openRaceViewSelectModal() {
    state.modalOpenedAt = performance.now();
    dom.modalCard.innerHTML = `
      <h2 class="modal-title">${getText(state.lang, "raceViewModalTitle")}</h2>
      <p class="guide-p" style="text-align:center; color:var(--text-muted);">
        ${getText(state.lang, "raceViewModalDesc")}
      </p>
      <div class="tile-grid-2" style="margin-top:12px;">
        <button id="btnSelectTopView" class="visual-tile ${state.viewMode === "top" ? "active" : ""}" type="button">
          <span class="tile-icon" style="font-size:20px;">🗺️</span>
          <span class="tile-name">${getText(state.lang, "raceViewTopTitle")}</span>
          <span class="tile-sub">${getText(state.lang, "raceViewTopSub")}</span>
        </button>
        <button id="btnSelectCockpitView" class="visual-tile ${state.viewMode === "cockpit" ? "active" : ""}" type="button">
          <span class="tile-icon" style="font-size:20px;">🏎️</span>
          <span class="tile-name">${getText(state.lang, "raceViewCockpitTitle")}</span>
          <span class="tile-sub">${getText(state.lang, "raceViewCockpitSub")}</span>
        </button>
      </div>
      <div class="modal-row-btns">
        <button id="btnCancelRaceStart" class="modal-sec-btn" type="button">${getText(state.lang, "btnCancel")}</button>
      </div>
    `;
    dom.modalBackdrop.classList.add("open");

    document.getElementById("btnSelectTopView").addEventListener("click", () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      state.viewMode = "top";
      closeModal();
      startManualRace();
    });

    document.getElementById("btnSelectCockpitView").addEventListener("click", () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      state.viewMode = "cockpit";
      closeModal();
      startManualRace();
    });

    document.getElementById("btnCancelRaceStart").addEventListener("click", () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      closeModal();
    });
  }

  function openConfirmNewModal() {
    state.modalOpenedAt = performance.now();
    dom.modalCard.innerHTML = `
      <h2 class="modal-title">${getText(state.lang, "confirmNewTitle")}</h2>
      <div class="guide-box gray" style="margin:0;">${getText(state.lang, "confirmNewBody")}</div>
      <div class="modal-row-btns">
        <button id="btnCancelNew" class="modal-sec-btn" type="button">${getText(state.lang, "btnCancel")}</button>
        <button id="btnConfirmNew" class="modal-full-btn" style="margin-top:0;" type="button">${getText(state.lang, "btnConfirmYes")}</button>
      </div>
    `;
    dom.modalBackdrop.classList.add("open");

    document.getElementById("btnCancelNew").addEventListener("click", () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      closeModal();
    });

    document.getElementById("btnConfirmNew").addEventListener("click", () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      closeModal();
      resetToNewTrack();
    });
  }

  function openSettingsModal() {
    state.modalOpenedAt = performance.now();
    let titleTapCount = 0;
    let statsTapCount = 0;

    const themesHtml = CONFIG.themes.map((t) => {
      const unlocked = state.profile.unlockedThemes.includes(t.id);
      const selected = state.profile.selectedTheme === t.id;
      const cls = `visual-tile ${selected ? "active" : ""} ${!unlocked ? "locked" : ""}`;
      const subLabel = !unlocked
        ? `🔒 ${getText(state.lang, t.reqKey)}`
        : t.requiredWins === 0
          ? getText(state.lang, "reqDefault")
          : getText(state.lang, "unlockedText");
      return `
        <button class="${cls}" data-theme-id="${t.id}" type="button" ${!unlocked ? "disabled" : ""}>
          ${selected ? '<span class="tile-check">✓</span>' : ""}
          <span class="tile-icon">${getThemePreviewSvg(t.id)}</span>
          <span class="tile-name">${getText(state.lang, t.nameKey)}</span>
          <span class="tile-sub">${subLabel}</span>
        </button>
      `;
    }).join("");

    const carsHtml = CONFIG.carStyles.map((c) => {
      const unlocked = state.profile.unlockedCars.includes(c.id);
      const selected = state.profile.selectedCar === c.id;
      const cls = `visual-tile ${selected ? "active" : ""} ${!unlocked ? "locked" : ""}`;
      const subLabel = !unlocked
        ? `🔒 ${getText(state.lang, c.reqKey)}`
        : c.requiredWins === 0
          ? getText(state.lang, "reqDefault")
          : getText(state.lang, "unlockedText");
      return `
        <button class="${cls}" data-car-id="${c.id}" type="button" ${!unlocked ? "disabled" : ""}>
          ${selected ? '<span class="tile-check">✓</span>' : ""}
          <span class="tile-icon">${getCarPreviewSvg(c.id)}</span>
          <span class="tile-name">${getText(state.lang, c.nameKey)}</span>
          <span class="tile-trait">${getText(state.lang, c.traitKey)}</span>
          <span class="tile-sub">${subLabel}</span>
        </button>
      `;
    }).join("");

    dom.modalCard.innerHTML = `
      <h2 class="modal-title" id="settingsModalTitle">${getText(state.lang, "settingsTitle")}</h2>

      <div class="stats-grid-4">
        <div>
          <div class="stat-cell-lbl stats-reset-trigger">${getText(state.lang, "statWins")}</div>
          <div class="stat-cell-val">${state.profile.wins}</div>
        </div>
        <div>
          <div class="stat-cell-lbl stats-reset-trigger">👑 ${getText(state.lang, "statMaster")}</div>
          <div class="stat-cell-val gold">${state.profile.masterWins}</div>
        </div>
        <div>
          <div class="stat-cell-lbl stats-reset-trigger">${getText(state.lang, "statLaps")}</div>
          <div class="stat-cell-val">${state.profile.totalLaps}</div>
        </div>
        <div>
          <div class="stat-cell-lbl stats-reset-trigger">${getText(state.lang, "statTracks")}</div>
          <div class="stat-cell-val">${state.profile.tracksBuilt}</div>
        </div>
      </div>

      <div class="section-heading">${getText(state.lang, "langHeading")}</div>
      <div class="choice-grid-2">
        <button class="choice-btn ${state.lang === "cs" ? "active" : ""}" data-lang="cs" type="button">🇨🇿 Čeština</button>
        <button class="choice-btn ${state.lang === "en" ? "active" : ""}" data-lang="en" type="button">🇬🇧 English</button>
      </div>

      <div class="section-heading">${getText(state.lang, "soundVibHeading")}</div>
      <div class="choice-grid-2">
        <button id="btnToggleSound" class="choice-btn ${state.settings.sound ? "active" : ""}" type="button">
          🔊 ${getText(state.lang, state.settings.sound ? "soundOn" : "soundOff")}
        </button>
        <button id="btnToggleHaptics" class="choice-btn ${state.settings.haptics ? "active" : ""}" type="button">
          📳 ${getText(state.lang, state.settings.haptics ? "vibOn" : "vibOff")}
        </button>
      </div>

      <div class="section-heading">${getText(state.lang, "launchHeading")}</div>
      <div class="choice-grid-2">
        <button class="choice-btn ${state.settings.launchWithGas ? "active" : ""}" data-launch="gas" type="button">🚀 ${getText(state.lang, "launchWithGas")}</button>
        <button class="choice-btn ${!state.settings.launchWithGas ? "active" : ""}" data-launch="zero" type="button">🛑 ${getText(state.lang, "launchNoGas")}</button>
      </div>

      <div class="section-heading">${getText(state.lang, "magnetHeading")}</div>
      <div class="choice-grid-3">
        <button class="choice-btn ${state.settings.difficulty === "easy" ? "active" : ""}" data-diff="easy" type="button">${getText(state.lang, "diffEasy")}</button>
        <button class="choice-btn ${state.settings.difficulty === "normal" ? "active" : ""}" data-diff="normal" type="button">${getText(state.lang, "diffNormal")}</button>
        <button class="choice-btn ${state.settings.difficulty === "hard" ? "active" : ""}" data-diff="hard" type="button">${getText(state.lang, "diffHard")}</button>
      </div>

      <div class="section-heading">${getText(state.lang, "lapsGoalHeading")}</div>
      <div class="choice-grid-3">
        <button class="choice-btn ${state.settings.lapsToWin === 1 ? "active" : ""}" data-laps="1" type="button">${getText(state.lang, "lapsGoal1")}</button>
        <button class="choice-btn ${state.settings.lapsToWin === 3 ? "active" : ""}" data-laps="3" type="button">${getText(state.lang, "lapsGoal3")}</button>
        <button class="choice-btn ${state.settings.lapsToWin === 5 ? "active" : ""}" data-laps="5" type="button">${getText(state.lang, "lapsGoal5")}</button>
      </div>

      <div class="section-heading">${getText(state.lang, "themesHeading")}</div>
      <div class="tile-grid-2">${themesHtml}</div>

      <div class="section-heading">${getText(state.lang, "carsHeading")}</div>
      <div class="tile-grid-2">${carsHtml}</div>

      <div class="info-callout">${getText(state.lang, "unlockInfoHtml")}</div>

      <button id="btnSaveSettings" class="modal-full-btn" type="button">${getText(state.lang, "saveAndClose")}</button>
      <div class="author-footer">&copy; 2026 Ondrandy</div>
    `;

    dom.modalBackdrop.classList.add("open");

    document.getElementById("settingsModalTitle").addEventListener("click", () => {
      titleTapCount += 1;
      if (titleTapCount >= 5) {
        titleTapCount = 0;
        unlockNextBonusStep();
        triggerHaptic("light");
        updateHud();
        persistProfile();
        openSettingsModal();
      }
    });

    for (const lbl of dom.modalCard.querySelectorAll(".stats-reset-trigger")) {
      lbl.addEventListener("click", () => {
        statsTapCount += 1;
        if (statsTapCount >= 5) {
          statsTapCount = 0;
          state.profile.wins = 0;
          state.profile.masterWins = 0;
          state.profile.totalLaps = 0;
          state.profile.totalExits = 0;
          state.profile.tracksBuilt = 0;
          state.profile.unlockedThemes = ["classic"];
          state.profile.selectedTheme = "classic";
          state.profile.unlockedCars = ["classic_car", "formula"];
          state.profile.selectedCar = "classic_car";
          applyTheme();
          updateHud();
          renderCanvas(0.016);
          persistProfile();
          openSettingsModal();
        }
      });
    }

    for (const btn of dom.modalCard.querySelectorAll("[data-lang]")) {
      btn.addEventListener("click", () => {
        state.settings.lang = btn.getAttribute("data-lang");
        state.lang = detectLanguage(state.settings.lang);
        applyI18n();
        updateHud();
        persistProfile();
        openSettingsModal();
      });
    }

    document.getElementById("btnToggleSound").addEventListener("click", () => {
      state.settings.sound = !state.settings.sound;
      if (state.settings.sound) initContinuousAudio();
      persistProfile();
      openSettingsModal();
    });

    document.getElementById("btnToggleHaptics").addEventListener("click", () => {
      state.settings.haptics = !state.settings.haptics;
      persistProfile();
      openSettingsModal();
    });

    for (const btn of dom.modalCard.querySelectorAll("[data-launch]")) {
      btn.addEventListener("click", () => {
        state.settings.launchWithGas = btn.getAttribute("data-launch") === "gas";
        persistProfile();
        openSettingsModal();
      });
    }

    for (const btn of dom.modalCard.querySelectorAll("[data-diff]")) {
      btn.addEventListener("click", () => {
        state.settings.difficulty = btn.getAttribute("data-diff");
        resizeCanvas();
        renderCanvas(0.016);
        persistProfile();
        openSettingsModal();
      });
    }

    for (const btn of dom.modalCard.querySelectorAll("[data-laps]")) {
      btn.addEventListener("click", () => {
        state.settings.lapsToWin = Number(btn.getAttribute("data-laps")) || 3;
        updateHud();
        persistProfile();
        openSettingsModal();
      });
    }

    for (const btn of dom.modalCard.querySelectorAll("[data-theme-id]")) {
      btn.addEventListener("click", () => {
        if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
        const id = btn.getAttribute("data-theme-id");
        if (state.profile.unlockedThemes.includes(id)) {
          state.profile.selectedTheme = id;
          applyTheme();
          renderCanvas(0.016);
          persistProfile();
          openSettingsModal();
        }
      });
    }

    for (const btn of dom.modalCard.querySelectorAll("[data-car-id]")) {
      btn.addEventListener("click", () => {
        if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
        const id = btn.getAttribute("data-car-id");
        if (state.profile.unlockedCars.includes(id)) {
          state.profile.selectedCar = id;
          renderCanvas(0.016);
          persistProfile();
          openSettingsModal();
        }
      });
    }

    document.getElementById("btnSaveSettings").addEventListener("click", () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      persistProfile();
      closeModal();
    });
  }

  function openGuideModal() {
    state.modalOpenedAt = performance.now();
    dom.modalCard.innerHTML = `
      <h2 class="modal-title">${getText(state.lang, "guideTitle")}</h2>
      <p class="guide-p">${getText(state.lang, "guideGoal")}</p>

      <div class="section-heading" style="margin-top:0;">${getText(state.lang, "guideControlsTitle")}</div>
      <div class="guide-box gray">
        <ul>
          <li>${getText(state.lang, "guideCtrl1")}</li>
          <li>${getText(state.lang, "guideCtrl2")}</li>
          <li>${getText(state.lang, "guideCtrl3")}</li>
          <li>${getText(state.lang, "guideCtrl4")}</li>
        </ul>
      </div>

      <p class="guide-p">${getText(state.lang, "guideGoldenRule")}</p>

      <div class="guide-box green">
        <strong>${getText(state.lang, "guideGreenTitle")}</strong><br />
        ${getText(state.lang, "guideGreenBody")}
      </div>

      <p class="guide-warn">${getText(state.lang, "guideWarnHtml")}</p>
      <p class="guide-rewards">${getText(state.lang, "guideRewardsHtml")}</p>

      <button id="btnCloseGuide" class="modal-full-btn" type="button">${getText(state.lang, "guideGotIt")}</button>
      <div class="author-footer">&copy; 2026 Ondrandy</div>
    `;

    dom.modalBackdrop.classList.add("open");
    document.getElementById("btnCloseGuide").addEventListener("click", () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      closeModal();
    });
  }

  function triggerWinFlow(isDebugTest) {
    const targetSec = computeTargetSeriesTime();
    const beatGhost = isDebugTest || (state.raceElapsedSec > 0 && state.raceElapsedSec <= targetSec);
    const cleanRun = isDebugTest || state.car.offTrackCount === 0;

    state.profile.wins += 1;
    if (beatGhost || cleanRun) {
      state.profile.masterWins += 1;
    }
    const unlockedItems = refreshUnlocks();
    updateEngineSound(null, false);
    playWinSound();
    triggerHaptic("light");
    updateHud();
    persistProfile();

    state.modalOpenedAt = performance.now();
    const unlockBannerHtml =
      unlockedItems.length > 0
        ? `<div class="unlock-banner">${getText(state.lang, "winUnlockedPrefix")}${unlockedItems.join(", ")}</div>`
        : "";

    const badgeKey = beatGhost
      ? "winBadgeBeatGhost"
      : cleanRun
        ? "winBadgeClean"
        : "winBadgeStandard";

    dom.modalCard.innerHTML = `
      <div class="win-badge-wrap">
        <div class="win-icon-frame">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/>
            <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>
            <path d="M4 22h16"/>
            <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
            <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>
            <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>
          </svg>
        </div>
        <span class="win-pill">${getText(state.lang, badgeKey)}</span>
      </div>

      <h2 class="modal-title">${getText(state.lang, "winTitle")}</h2>
      <p class="guide-p" style="text-align:center; color:var(--text-muted);">
        ${getText(state.lang, "winCongrats")}
      </p>

      ${unlockBannerHtml}

      <div class="stats-grid-4">
        <div>
          <div class="stat-cell-val">${formatSec(state.raceElapsedSec)}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "winStatTime")}</div>
        </div>
        <div>
          <div class="stat-cell-val">${formatSec(targetSec)}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "winStatTarget")}</div>
        </div>
        <div>
          <div class="stat-cell-val">${state.car.offTrackCount}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "winStatExits")}</div>
        </div>
        <div>
          <div class="stat-cell-val gold">${state.profile.wins}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "winStatTotalWins")}</div>
        </div>
      </div>

      <div class="modal-row-btns">
        <button id="btnWinBoard" class="modal-sec-btn" type="button">${getText(state.lang, "btnBoard")}</button>
        <button id="btnWinAgain" class="modal-full-btn" style="margin-top:0;" type="button">${getText(state.lang, "btnPlayAgain")}</button>
      </div>
      <div class="author-footer">&copy; 2026 Ondrandy</div>
    `;

    dom.modalBackdrop.classList.add("open");

    document.getElementById("btnWinBoard").addEventListener("click", () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      state.phase = "demo";
      state.car.lapsCompleted = 0;
      state.car.offTrackCount = 0;
      state.car.phase = "driving";
      state.car.visible = true;
      state.car.driftAngle = 0;
      renderStatusActionSlot();
      updateHud();
      closeModal();
    });

    document.getElementById("btnWinAgain").addEventListener("click", () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      closeModal();
      resetToNewTrack();
    });
  }

  function gameLoop(now) {
    if (!state.lastFrameTime) {
      state.lastFrameTime = now;
    }
    const dt = Math.min(0.05, (now - state.lastFrameTime) / 1000);
    state.lastFrameTime = now;

    const modalOpen = dom.modalBackdrop.classList.contains("open");

    if ((state.phase === "demo" || state.phase === "racing") && state.track && !modalOpen) {
      if (state.phase === "demo") {
        Engine.stepCar(state.car, state.track, "auto", dt, state.profile.selectedCar, null);
        updateEngineSound(state.car, true);
        updateHud();
        renderCanvas(dt);
      } else if (state.phase === "racing") {
        state.raceElapsedSec += dt;
        Engine.stepCar(state.ghostCar, state.track, "auto", dt, "classic_car", {
          onLapCompleted: (ghostLaps) => {
            if (ghostLaps >= state.settings.lapsToWin) {
              state.ghostCar.finished = true;
              state.ghostCar.s = 0;
              state.ghostCar.lapProgress = 0;
              const startPt = Engine.sampleAtDistance(state.track, 0);
              state.ghostCar.x = startPt.x;
              state.ghostCar.y = startPt.y;
              state.ghostCar.angle = Math.atan2(startPt.ty, startPt.tx);
              state.ghostCar.sampleIndex = 0;
            }
          }
        });

        Engine.stepCar(state.car, state.track, "manual", dt, state.profile.selectedCar, {
          onOffTrack: () => {
            state.hasMoves = true;
            state.profile.totalExits += 1;
            updateEngineSound(null, false);
            playOffTrackSound();
            triggerHaptic("heavy");
            setStatus("statusOffTrack", "error", 1600);
            updateHud();
            persistProfile();
          },
          onLapCompleted: (laps) => {
            state.hasMoves = true;
            state.profile.totalLaps += 1;
            if (laps >= state.settings.lapsToWin) {
              triggerWinFlow(false);
            } else {
              playWinSound();
              triggerHaptic("light");
              setStatus("statusLapDone", "success", 1400);
              updateHud();
              persistProfile();
            }
          }
        });

        spawnDriftSparks(state.car);
        if (state.car.phase === "driving" && state.car.gripLoadRatio > 0.86) {
          triggerHaptic("light");
        }

        updateEngineSound(state.car, true);
        updateHud();
        renderCanvas(dt);
      }
    } else {
      updateEngineSound(null, false);
    }

    global.requestAnimationFrame(gameLoop);
  }

  async function init() {
    cacheDom();
    applyI18n();
    updateHud();
    resizeCanvas();
    bindEvents();

    try {
      const savedProfile = await loadStorage(CONFIG.storageKeys.profile);
      if (savedProfile) {
        if (savedProfile.profile) {
          state.profile = Object.assign(
            JSON.parse(JSON.stringify(CONFIG.defaults.profile)),
            savedProfile.profile
          );
        }
        if (savedProfile.settings) {
          state.settings = Object.assign(
            JSON.parse(JSON.stringify(CONFIG.defaults.settings)),
            savedProfile.settings
          );
        }
      }
    } catch (_) {}

    state.lang = detectLanguage(state.settings.lang);
    refreshUnlocks();
    applyTheme();
    applyI18n();
    updateHud();
    resizeCanvas();

    try {
      const savedSession = await loadStorage(CONFIG.storageKeys.session);
      if (
        savedSession &&
        (savedSession.phase === "demo" || savedSession.phase === "racing") &&
        Array.isArray(savedSession.rawPoints)
      ) {
        const check = Engine.validateStroke(savedSession.rawPoints);
        if (check.valid) {
          const rect = dom.boardCard.getBoundingClientRect();
          state.rawPoints = savedSession.rawPoints;
          state.track = Engine.buildTrack(state.rawPoints, rect.width, rect.height, state.settings.difficulty);
          state.phase = savedSession.phase;
          state.viewMode = savedSession.viewMode === "cockpit" ? "cockpit" : "top";
          state.hasMoves = Boolean(savedSession.hasMoves);
          state.showBrakingZones = Boolean(savedSession.showBrakingZones);
          state.raceElapsedSec = Number(savedSession.raceElapsedSec) || 0;
          state.car = Object.assign(Engine.createCarState(), savedSession.car || {});
          state.car.phase = "driving";
          state.car.visible = true;
          const pt = Engine.sampleAtDistance(state.track, state.car.s);
          state.car.x = pt.x;
          state.car.y = pt.y;
          state.car.angle = Math.atan2(pt.ty, pt.tx);
          state.car.sampleIndex = pt.sampleIndex;

          state.ghostCar = Object.assign(Engine.createCarState(), savedSession.ghostCar || {});
          const gpt = Engine.sampleAtDistance(state.track, state.ghostCar.s);
          state.ghostCar.x = gpt.x;
          state.ghostCar.y = gpt.y;
          state.ghostCar.angle = Math.atan2(gpt.ty, gpt.tx);
          state.ghostCar.sampleIndex = gpt.sampleIndex;

          renderStatusActionSlot();
          renderStatus();
          updateHud();
        }
      }
    } catch (_) {
      resetToNewTrack();
    }

    renderCanvas(0.016);
    global.requestAnimationFrame(gameLoop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
