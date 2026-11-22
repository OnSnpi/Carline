(function (global) {
  "use strict";

  const Carline = (global.Carline = global.Carline || {});
  const { CONFIG, Engine, detectLanguage, getText } = Carline;

  const state = {
    lang: "cs",
    profile: JSON.parse(JSON.stringify(CONFIG.defaults.profile)),
    settings: JSON.parse(JSON.stringify(CONFIG.defaults.settings)),
    phase: "drawing",
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

  const dom = {};

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
      dom.statusActionSlot.innerHTML = `<button id="btnStartRace" class="action-pill-btn start-race" type="button">${getText(state.lang, "btnStartRace")}</button>`;
      document.getElementById("btnStartRace").addEventListener("click", () => {
        if (performance.now() < state.suppressClickUntil) return;
        initContinuousAudio();
        startManualRace();
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

  function getCarBridgeSpanBonus(carStyleId) {
    if (carStyleId === "truck") return 4;
    if (carStyleId === "bus") return 3;
    if (carStyleId === "prototype") return 2;
    return 1;
  }

  function isCarUnderBridge(track, carObj, carStyleId) {
    if (!track || !track.crossings || track.crossings.length === 0 || !carObj) return false;
    const n = track.samples.length;
    const sampleIdx = carObj.sampleIndex || 0;
    const lengthBonus = getCarBridgeSpanBonus(carStyleId);
    const overPrioritySpan = 9;
    const underSpan = 10 + lengthBonus;

    function circularDiff(a, b) {
      let diff = Math.abs(a - b);
      if (diff > n * 0.5) diff = n - diff;
      return diff;
    }

    for (const cr of track.crossings) {
      if (circularDiff(sampleIdx, cr.overIndex) <= overPrioritySpan) {
        return false;
      }
    }

    for (const cr of track.crossings) {
      if (circularDiff(sampleIdx, cr.underIndex) <= underSpan) {
        return true;
      }
      if (
        typeof carObj.x === "number" &&
        typeof carObj.y === "number" &&
        Math.hypot(carObj.x - cr.x, carObj.y - cr.y) <= 21 + lengthBonus * 2
      ) {
        return true;
      }
    }
    return false;
  }

  function drawBridgeOverpassSegment(ctx, track, cr, styles) {
    const pts = track.samples;
    const n = pts.length;
    const halfSpan = 10;

    ctx.save();
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";

    ctx.beginPath();
    for (let k = -halfSpan; k <= halfSpan; k++) {
      const idx = (cr.overIndex + k + n) % n;
      const p = pts[idx];
      if (k === -halfSpan) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = "rgba(0, 0, 0, 0.34)";
    ctx.lineWidth = 28;
    ctx.stroke();

    ctx.strokeStyle = styles.cardBg;
    ctx.lineWidth = 25;
    ctx.stroke();

    ctx.strokeStyle = styles.trackBed;
    ctx.lineWidth = 21;
    ctx.stroke();

    ctx.strokeStyle = styles.trackOver;
    ctx.lineWidth = 9;
    ctx.stroke();

    ctx.restore();
  }

  function drawTrackBase(ctx, styles) {
    const track = state.track;
    if (!track || !track.samples || track.samples.length < 2) return;
    const pts = track.samples;
    const isTournament = state.profile.selectedTheme === "tournament";

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.closePath();

    ctx.strokeStyle = styles.trackBed;
    ctx.lineWidth = 22;
    ctx.stroke();

    if (isTournament) {
      for (let i = 0; i < pts.length; i += 2) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % pts.length];
        if (p0.dangerRatio > 0.32) {
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.strokeStyle = Math.floor(i / 2) % 2 === 0 ? "#ef4444" : "#ffffff";
          ctx.lineWidth = 24;
          ctx.stroke();
        }
      }
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.closePath();
      ctx.strokeStyle = "#334155";
      ctx.lineWidth = 17;
      ctx.stroke();
    }

    ctx.strokeStyle = styles.trackRail;
    ctx.lineWidth = 9;
    ctx.stroke();

    if (state.showBrakingZones) {
      for (let i = 0; i < pts.length; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % pts.length];
        if (p0.dangerRatio > 0.38) {
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.strokeStyle = p0.dangerRatio > 0.66 ? "#e11d48" : "#d97706";
          ctx.lineWidth = 5;
          ctx.stroke();
        }
      }
    }

    const startPt = pts[0];
    const startAngle = Math.atan2(startPt.ty, startPt.tx);
    ctx.save();
    ctx.translate(startPt.x, startPt.y);
    ctx.rotate(startAngle);

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(-4, -12, 8, 24);
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(-4, -12, 4, 6);
    ctx.fillRect(0, -6, 4, 6);
    ctx.fillRect(-4, 0, 4, 6);
    ctx.fillRect(0, 6, 4, 6);

    ctx.strokeStyle = styles.startColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(-4.5, -12.5, 9, 25);
    ctx.restore();

    ctx.restore();
  }

  function drawAllBridges(ctx, styles) {
    const track = state.track;
    if (!track || !track.crossings) return;
    for (const cr of track.crossings) {
      drawBridgeOverpassSegment(ctx, track, cr, styles);
    }
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
      // Aerodynamický Le Mans klín se zúženou přídí, kapkovitou kabinou a zadním křídlem
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

      // Zadní přítlačné křídlo
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(-13.5, -8, 2.8, 16);

      // Středová kapkovitá kabina
      ctx.beginPath();
      ctx.ellipse(1.5, 0, 4.5, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (carStyle === "bus") {
      // Prodloužený autobus s panoramatickým čelním sklem a střešními okny
      ctx.beginPath();
      ctx.roundRect(-14.5, -7.5, 29, 15, 3.5);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(8.5, -5.2, 3.8, 10.4);
      ctx.fillRect(-10, -4.2, 4.5, 8.4);
      ctx.fillRect(-2.5, -4.2, 4.5, 8.4);
    } else if (carStyle === "truck") {
      // Návěs vzadu
      ctx.beginPath();
      ctx.roundRect(-16.5, -7.5, 19, 15, 2.5);
      ctx.fill();
      ctx.stroke();

      // Závěs / točna
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(2.5, -2.5, 2.5, 5);

      // Přední kabina tahače
      ctx.fillStyle = fillColor;
      ctx.beginPath();
      ctx.roundRect(4.5, -7, 9.5, 14, 3);
      ctx.fill();
      ctx.stroke();

      // Čelní sklo tahače
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(10, -4.8, 2.8, 9.6);
    } else {
      ctx.beginPath();
      ctx.roundRect(-11, -7, 22, 14, 4);
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

    drawTrackBase(dom.ctx, styles);

    if (state.phase === "demo") {
      const carUnder =
        state.car.phase === "driving" &&
        isCarUnderBridge(state.track, state.car, state.profile.selectedCar);
      if (carUnder) {
        drawCarEntity(dom.ctx, state.car, styles.carColor, false);
        drawAllBridges(dom.ctx, styles);
      } else {
        drawAllBridges(dom.ctx, styles);
        drawCarEntity(dom.ctx, state.car, styles.carColor, false);
      }
      return;
    }

    if (state.phase === "racing") {
      updateAndDrawSparks(dom.ctx, dt || 0.016);
      const ghostUnder = isCarUnderBridge(state.track, state.ghostCar, "classic_car");
      const playerUnder =
        state.car.phase === "driving" &&
        isCarUnderBridge(state.track, state.car, state.profile.selectedCar);

      if (ghostUnder) {
        drawCarEntity(dom.ctx, state.ghostCar, styles.ghostColor, true);
      }
      if (playerUnder) {
        drawCarEntity(dom.ctx, state.car, styles.carColor, false);
      }

      drawAllBridges(dom.ctx, styles);

      if (!ghostUnder) {
        drawCarEntity(dom.ctx, state.ghostCar, styles.ghostColor, true);
      }
      if (!playerUnder) {
        drawCarEntity(dom.ctx, state.car, styles.carColor, false);
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

    state.lang = detectLanguage(state.settings.lang);
    refreshUnlocks();
    applyTheme();
    applyI18n();
    updateHud();
    resizeCanvas();

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

    renderCanvas(0.016);
    bindEvents();
    global.requestAnimationFrame(gameLoop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
