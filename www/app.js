(function (global) {
  "use strict";

  const Carline = (global.Carline = global.Carline || {});
  const { CONFIG, Engine, detectLanguage, getText } = Carline;

  const state = {
    lang: "cs",
    profile: JSON.parse(JSON.stringify(CONFIG.defaults.profile)),
    settings: JSON.parse(JSON.stringify(CONFIG.defaults.settings)),
    phase: "drawing",
    mode: "auto",
    rawPoints: [],
    track: null,
    car: Engine.createCarState(),
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
    lastEngineSoundMs: 0,
    lastHapticMs: 0,
    audioCtx: null
  };

  const dom = {};

  function cacheDom() {
    dom.appRoot = document.getElementById("appRoot");
    dom.hudWins = document.getElementById("hudWins");
    dom.hudLaps = document.getElementById("hudLaps");
    dom.hudTargetLaps = document.getElementById("hudTargetLaps");
    dom.hudExits = document.getElementById("hudExits");
    dom.btnSettings = document.getElementById("btnSettings");
    dom.statusBar = document.getElementById("statusBar");
    dom.statusText = document.getElementById("statusText");
    dom.btnModeAuto = document.getElementById("btnModeAuto");
    dom.btnModeManual = document.getElementById("btnModeManual");
    dom.boardCard = document.getElementById("boardCard");
    dom.canvas = document.getElementById("trackCanvas");
    dom.ctx = dom.canvas.getContext("2d");
    dom.hudSpeed = document.getElementById("hudSpeed");
    dom.hudGripBadge = document.getElementById("hudGripBadge");
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
      mode: state.mode,
      rawPoints: state.rawPoints,
      hasMoves: state.hasMoves,
      showBrakingZones: state.showBrakingZones,
      car: state.car
    });
  }

  function jitter(value, ratio) {
    const delta = (Math.random() * 2 - 1) * ratio;
    return value * (1 + delta);
  }

  function ensureAudioContext() {
    if (!state.settings.sound) return null;
    if (!state.audioCtx) {
      const AudioCtx = global.AudioContext || global.webkitAudioContext;
      if (!AudioCtx) return null;
      state.audioCtx = new AudioCtx();
    }
    if (state.audioCtx.state === "suspended") {
      state.audioCtx.resume().catch(() => {});
    }
    return state.audioCtx;
  }

  function playTone(baseFreq, durationSec, baseGain, type) {
    if (!state.settings.sound) return;
    const nowMs = performance.now();
    if (nowMs - state.lastEngineSoundMs < CONFIG.audio.soundCooldownMs) return;
    state.lastEngineSoundMs = nowMs;

    const ctx = ensureAudioContext();
    if (!ctx) return;

    const freq = Math.max(24, jitter(baseFreq, 0.07));
    const dur = Math.max(0.025, jitter(durationSec, 0.16));
    const gainPeak = Math.max(0.005, jitter(baseGain, 0.15));
    const attackSec = Math.max(0.004, jitter(0.014, 0.15));

    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type || "triangle";
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(22, freq * 1.12), t0 + dur);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(gainPeak, t0 + attackSec);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(t0);
    osc.stop(t0 + dur + 0.01);
  }

  function playEnginePulse(speed) {
    if (speed < 15) return;
    const norm = Math.min(1, speed / CONFIG.physics.maxSpeed);
    const freq = CONFIG.audio.engineBaseFreq + norm * (CONFIG.audio.engineMaxFreq - CONFIG.audio.engineBaseFreq);
    playTone(freq, 0.075, CONFIG.audio.engineGain, "sawtooth");
  }

  function playOffTrackSound() {
    playTone(215, 0.18, 0.08, "square");
  }

  function playWinSound() {
    playTone(587.33, 0.18, 0.075, "triangle");
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

  function renderStatus() {
    dom.statusBar.classList.remove("trial", "error", "success");
    if (state.statusTone === "trial") dom.statusBar.classList.add("trial");
    if (state.statusTone === "error") dom.statusBar.classList.add("error");
    if (state.statusTone === "success") dom.statusBar.classList.add("success");

    if (state.statusMessageKey) {
      dom.statusText.textContent = getText(state.lang, state.statusMessageKey);
      return;
    }

    if (state.phase === "drawing") {
      dom.statusText.textContent = getText(state.lang, "statusDraw");
    } else if (state.mode === "auto") {
      dom.statusText.textContent = getText(state.lang, "statusAutoDemo");
    } else {
      dom.statusText.textContent = getText(state.lang, "statusManualDrive");
    }
  }

  function applyI18n() {
    document.documentElement.lang = state.lang;
    const nodes = document.querySelectorAll("[data-i18n]");
    for (const el of nodes) {
      const key = el.getAttribute("data-i18n");
      el.textContent = getText(state.lang, key);
    }
    renderStatus();
  }

  function updateHud() {
    dom.hudWins.textContent = String(state.profile.wins);
    dom.hudLaps.textContent = String(state.car.lapsCompleted);
    dom.hudTargetLaps.textContent = String(state.settings.lapsToWin);
    dom.hudExits.textContent = String(state.car.offTrackCount);
    dom.hudSpeed.textContent = String(Math.round(state.car.speed));

    dom.btnModeAuto.classList.toggle("active", state.mode === "auto");
    dom.btnModeManual.classList.toggle("active", state.mode === "manual");
    dom.btnHint.classList.toggle("active-hint", state.showBrakingZones);
    dom.btnUndo.disabled = state.phase !== "driving";
    dom.btnHint.disabled = state.phase !== "driving";

    if (state.car.phase === "flying" || state.car.phase === "dropped") {
      dom.hudGripBadge.textContent = getText(state.lang, "gripOut");
    } else if (state.mode === "manual" && state.car.gripLoadRatio > 0.82) {
      dom.hudGripBadge.textContent = getText(state.lang, "gripWarn");
    } else {
      dom.hudGripBadge.textContent = getText(state.lang, "gripOk");
    }
  }

  function resizeCanvas() {
    const rect = dom.boardCard.getBoundingClientRect();
    const dpr = Math.min(global.devicePixelRatio || 1, 2.5);
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    dom.canvas.width = Math.floor(width * dpr);
    dom.canvas.height = Math.floor(height * dpr);
    dom.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (state.phase === "driving" && Array.isArray(state.rawPoints) && state.rawPoints.length >= 6) {
      const prevRatio =
        state.track && state.track.totalLength > 0
          ? state.car.s / state.track.totalLength
          : 0;
      state.track = Engine.buildTrack(state.rawPoints, width, height, state.settings.difficulty);
      state.car.s = prevRatio * state.track.totalLength;
      const pt = Engine.sampleAtDistance(state.track, state.car.s);
      state.car.x = pt.x;
      state.car.y = pt.y;
      state.car.angle = Math.atan2(pt.ty, pt.tx);
    }
  }

  function getStyles() {
    const cs = global.getComputedStyle(document.body);
    return {
      trackBed: cs.getPropertyValue("--track-bed").trim(),
      trackRail: cs.getPropertyValue("--track-rail").trim(),
      trackUnder: cs.getPropertyValue("--track-under").trim(),
      trackOver: cs.getPropertyValue("--track-over").trim(),
      carColor: cs.getPropertyValue("--car-color").trim(),
      startColor: cs.getPropertyValue("--start-color").trim(),
      accent: cs.getPropertyValue("--accent").trim()
    };
  }

  function drawTrack(ctx, styles) {
    const track = state.track;
    if (!track || !track.samples || track.samples.length < 2) return;
    const pts = track.samples;

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

    for (const cr of track.crossings) {
      const underPt = pts[cr.underIndex];
      const overPt = pts[cr.overIndex];
      if (!underPt || !overPt) continue;

      ctx.beginPath();
      ctx.arc(underPt.x, underPt.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = styles.trackUnder;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(overPt.x, overPt.y, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = styles.trackOver;
      ctx.fill();
    }

    const startPt = pts[0];
    ctx.beginPath();
    ctx.arc(startPt.x, startPt.y, 11, 0, Math.PI * 2);
    ctx.fillStyle = styles.startColor;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    ctx.restore();
  }

  function drawCar(ctx, styles) {
    const car = state.car;
    if (!state.track || car.visible === false) return;

    const x = typeof car.x === "number" ? car.x : state.track.samples[0].x;
    const y = typeof car.y === "number" ? car.y : state.track.samples[0].y;
    const angle = typeof car.angle === "number" ? car.angle : 0;
    const scale = car.scale || 1;
    const carStyle = state.profile.selectedCar;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.rotate(angle);

    ctx.fillStyle = styles.carColor;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;

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
      ctx.roundRect(-12, -7.5, 24, 15, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(3, -4, 5, 8);
    } else {
      ctx.beginPath();
      ctx.roundRect(-11, -7, 22, 14, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(3.5, -3, 4.5, 6);
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

  function renderCanvas() {
    const rect = dom.boardCard.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const styles = getStyles();

    dom.ctx.clearRect(0, 0, width, height);

    if (state.phase === "drawing") {
      drawDrawingStroke(dom.ctx, styles);
    } else if (state.phase === "driving") {
      drawTrack(dom.ctx, styles);
      drawCar(dom.ctx, styles);
    }
  }

  function finalizeTrackFromStroke() {
    const check = Engine.validateStroke(state.rawPoints);
    if (!check.valid) {
      state.rawPoints = [];
      setStatus("statusTooShort", "error", 2200);
      renderCanvas();
      return;
    }

    const rect = dom.boardCard.getBoundingClientRect();
    state.track = Engine.buildTrack(state.rawPoints, rect.width, rect.height, state.settings.difficulty);
    state.car = Engine.createCarState();
    const startPt = Engine.sampleAtDistance(state.track, 0);
    state.car.x = startPt.x;
    state.car.y = startPt.y;
    state.car.angle = Math.atan2(startPt.ty, startPt.tx);
    state.car.targetSpeed =
      state.mode === "auto"
        ? CONFIG.physics.autoCruiseMax
        : CONFIG.physics.manualStartSpeed;

    state.phase = "driving";
    state.hasMoves = true;
    state.profile.tracksBuilt += 1;
    setStatus(null, "default", 0);
    updateHud();
    renderCanvas();
    persistProfile();
    persistSession();
  }

  function returnCarToStart() {
    if (state.phase !== "driving" || !state.track) return;
    state.car.s = 0;
    state.car.lapProgress = 0;
    state.car.speed = 0;
    state.car.phase = "driving";
    state.car.phaseTimer = 0;
    state.car.visible = true;
    state.car.scale = 1;
    state.car.gripLoadRatio = 0;
    const startPt = Engine.sampleAtDistance(state.track, 0);
    state.car.x = startPt.x;
    state.car.y = startPt.y;
    state.car.angle = Math.atan2(startPt.ty, startPt.tx);
    state.car.targetSpeed =
      state.mode === "auto"
        ? CONFIG.physics.autoCruiseMax
        : CONFIG.physics.manualStartSpeed;

    triggerHaptic("light");
    setStatus("statusResetStart", "trial", 1600);
    updateHud();
    renderCanvas();
    persistSession();
  }

  function resetToNewTrack() {
    state.phase = "drawing";
    state.rawPoints = [];
    state.track = null;
    state.car = Engine.createCarState();
    state.hasMoves = false;
    state.showBrakingZones = false;
    state.drawingPointerId = null;
    state.manualPointerId = null;
    state.manualLastX = null;
    state.statusMessageKey = null;
    state.statusTone = "default";
    updateHud();
    renderStatus();
    renderCanvas();
    persistSession();
  }

  function setMode(nextMode) {
    if (nextMode !== "auto" && nextMode !== "manual") return;
    state.mode = nextMode;
    if (nextMode === "manual") {
      state.car.targetSpeed = Math.max(CONFIG.physics.manualStartSpeed, state.car.speed);
    } else {
      state.car.targetSpeed = CONFIG.physics.autoCruiseMax;
    }
    setStatus(null, "default", 0);
    updateHud();
    persistSession();
  }

  function handleHintAction() {
    if (state.phase !== "driving" || !state.track) return;
    if (!state.showBrakingZones) {
      state.showBrakingZones = true;
      setStatus("statusHintShown", "trial", 2800);
    } else {
      setMode("auto");
      setStatus("statusHintApplied", "success", 2600);
    }
    triggerHaptic("light");
    updateHud();
    renderCanvas();
    persistSession();
  }

  function getCanvasCoords(ev) {
    const rect = dom.canvas.getBoundingClientRect();
    return {
      x: ev.clientX - rect.left,
      y: ev.clientY - rect.top
    };
  }

  function bindEvents() {
    global.addEventListener("resize", () => {
      resizeCanvas();
      renderCanvas();
    });

    dom.btnModeAuto.addEventListener("click", () => {
      if (performance.now() < state.suppressClickUntil) return;
      ensureAudioContext();
      setMode("auto");
    });

    dom.btnModeManual.addEventListener("click", () => {
      if (performance.now() < state.suppressClickUntil) return;
      ensureAudioContext();
      setMode("manual");
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
      if (state.hasMoves || (state.phase === "drawing" && state.rawPoints.length > 0)) {
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
      ensureAudioContext();

      if (state.phase === "drawing") {
        if (state.drawingPointerId !== null) return;
        state.drawingPointerId = ev.pointerId;
        dom.canvas.setPointerCapture(ev.pointerId);
        const pt = getCanvasCoords(ev);
        state.rawPoints = [{ x: pt.x, y: pt.y, t: performance.now() }];
        renderCanvas();
        return;
      }

      if (state.phase === "driving" && state.mode === "manual") {
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
          renderCanvas();
        }
        return;
      }

      if (state.phase === "driving" && state.mode === "manual" && ev.pointerId === state.manualPointerId) {
        if (state.manualLastX === null) {
          state.manualLastX = ev.clientX;
          return;
        }
        const dx = ev.clientX - state.manualLastX;
        state.manualLastX = ev.clientX;
        if (Math.abs(dx) > 0.5) {
          state.hasMoves = true;
          const nextTarget = state.car.targetSpeed + dx * CONFIG.physics.manualDragSensitivity;
          state.car.targetSpeed = Math.max(
            CONFIG.physics.minSpeed,
            Math.min(CONFIG.physics.maxSpeed, nextTarget)
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
      const cls = `reward-tile ${selected ? "selected" : ""} ${!unlocked ? "locked" : ""}`;
      return `
        <button class="${cls}" data-theme-id="${t.id}" type="button" ${!unlocked ? "disabled" : ""}>
          <span class="reward-name">${getText(state.lang, t.nameKey)}</span>
          <span class="reward-req">${getText(state.lang, t.reqKey)}</span>
        </button>
      `;
    }).join("");

    const carsHtml = CONFIG.carStyles.map((c) => {
      const unlocked = state.profile.unlockedCars.includes(c.id);
      const selected = state.profile.selectedCar === c.id;
      const cls = `reward-tile ${selected ? "selected" : ""} ${!unlocked ? "locked" : ""}`;
      return `
        <button class="${cls}" data-car-id="${c.id}" type="button" ${!unlocked ? "disabled" : ""}>
          <span class="reward-name">${getText(state.lang, c.nameKey)}</span>
          <span class="reward-req">${getText(state.lang, c.reqKey)}</span>
        </button>
      `;
    }).join("");

    dom.modalCard.innerHTML = `
      <h2 class="modal-title" id="settingsModalTitle">${getText(state.lang, "settingsTitle")}</h2>
      <div class="stats-grid-4" id="settingsStatsBox">
        <div>
          <div class="stat-cell-val">${state.profile.wins}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "statWins")}</div>
        </div>
        <div>
          <div class="stat-cell-val">${state.profile.masterWins}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "statMaster")}</div>
        </div>
        <div>
          <div class="stat-cell-val">${state.profile.totalLaps}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "statLaps")}</div>
        </div>
        <div>
          <div class="stat-cell-val">${state.profile.tracksBuilt}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "statTracks")}</div>
        </div>
      </div>

      <div class="settings-grid-2">
        <div class="setting-tile">
          <span>${getText(state.lang, "langLabel")}</span>
          <select id="selLang">
            <option value="cs" ${state.lang === "cs" ? "selected" : ""}>Čeština</option>
            <option value="en" ${state.lang === "en" ? "selected" : ""}>English</option>
          </select>
        </div>
        <div class="setting-tile">
          <span>${getText(state.lang, "diffLabel")}</span>
          <select id="selDiff">
            <option value="easy" ${state.settings.difficulty === "easy" ? "selected" : ""}>${getText(state.lang, "diffEasy")}</option>
            <option value="normal" ${state.settings.difficulty === "normal" ? "selected" : ""}>${getText(state.lang, "diffNormal")}</option>
            <option value="hard" ${state.settings.difficulty === "hard" ? "selected" : ""}>${getText(state.lang, "diffHard")}</option>
          </select>
        </div>
        <div class="setting-tile">
          <span>${getText(state.lang, "soundLabel")}</span>
          <button id="btnToggleSound" type="button">${getText(state.lang, state.settings.sound ? "onText" : "offText")}</button>
        </div>
        <div class="setting-tile">
          <span>${getText(state.lang, "hapticsLabel")}</span>
          <button id="btnToggleHaptics" type="button">${getText(state.lang, state.settings.haptics ? "onText" : "offText")}</button>
        </div>
        <div class="setting-tile" style="grid-column: span 2;">
          <span>${getText(state.lang, "lapsGoalLabel")}</span>
          <select id="selLapsGoal">
            <option value="1" ${state.settings.lapsToWin === 1 ? "selected" : ""}>1</option>
            <option value="3" ${state.settings.lapsToWin === 3 ? "selected" : ""}>3</option>
            <option value="5" ${state.settings.lapsToWin === 5 ? "selected" : ""}>5</option>
          </select>
        </div>
      </div>

      <div class="section-label">${getText(state.lang, "themesSection")}</div>
      <div class="reward-grid">${themesHtml}</div>

      <div class="section-label">${getText(state.lang, "carsSection")}</div>
      <div class="reward-grid">${carsHtml}</div>

      <button id="btnSaveSettings" class="modal-full-btn" type="button">${getText(state.lang, "saveAndClose")}</button>
    `;

    dom.modalBackdrop.classList.add("open");

    document.getElementById("settingsModalTitle").addEventListener("click", () => {
      titleTapCount += 1;
      if (titleTapCount >= 5) {
        titleTapCount = 0;
        closeModal();
        triggerWinFlow(true);
      }
    });

    document.getElementById("settingsStatsBox").addEventListener("click", () => {
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
        persistProfile();
        openSettingsModal();
      }
    });

    document.getElementById("selLang").addEventListener("change", (e) => {
      state.settings.lang = e.target.value;
      state.lang = detectLanguage(state.settings.lang);
      applyI18n();
      updateHud();
      persistProfile();
      openSettingsModal();
    });

    document.getElementById("selDiff").addEventListener("change", (e) => {
      state.settings.difficulty = e.target.value;
      resizeCanvas();
      renderCanvas();
      persistProfile();
    });

    document.getElementById("selLapsGoal").addEventListener("change", (e) => {
      state.settings.lapsToWin = Number(e.target.value) || 3;
      updateHud();
      persistProfile();
    });

    document.getElementById("btnToggleSound").addEventListener("click", () => {
      state.settings.sound = !state.settings.sound;
      if (state.settings.sound) ensureAudioContext();
      persistProfile();
      openSettingsModal();
    });

    document.getElementById("btnToggleHaptics").addEventListener("click", () => {
      state.settings.haptics = !state.settings.haptics;
      persistProfile();
      openSettingsModal();
    });

    for (const btn of dom.modalCard.querySelectorAll("[data-theme-id]")) {
      btn.addEventListener("click", () => {
        if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
        const id = btn.getAttribute("data-theme-id");
        if (state.profile.unlockedThemes.includes(id)) {
          state.profile.selectedTheme = id;
          applyTheme();
          renderCanvas();
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
          renderCanvas();
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
      <p style="margin:0 0 8px 0; font-size:13px; line-height:1.4;">${getText(state.lang, "guideGoal")}</p>

      <div class="guide-box gray">
        <strong>${getText(state.lang, "guideControlsTitle")}</strong>
        <ul>
          <li>${getText(state.lang, "guideCtrl1")}</li>
          <li>${getText(state.lang, "guideCtrl2")}</li>
          <li>${getText(state.lang, "guideCtrl3")}</li>
          <li>${getText(state.lang, "guideCtrl4")}</li>
        </ul>
      </div>

      <div class="guide-box green">
        <strong>${getText(state.lang, "guideMagnetTitle")}</strong><br />
        ${getText(state.lang, "guideMagnetBody")}
      </div>

      <div class="guide-box red">
        <strong>${getText(state.lang, "guideWarnTitle")}</strong><br />
        ${getText(state.lang, "guideWarnBody")}
      </div>

      <p style="margin:0 0 8px 0; font-size:12px; color:var(--text-muted); line-height:1.4;">
        ${getText(state.lang, "guideRewards")}
      </p>

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
    const cleanRun = isDebugTest || state.car.offTrackCount === 0;
    state.profile.wins += 1;
    if (cleanRun) {
      state.profile.masterWins += 1;
    }
    const unlockedItems = refreshUnlocks();
    playWinSound();
    triggerHaptic("light");
    updateHud();
    persistProfile();

    state.modalOpenedAt = performance.now();
    const crossingsCount = state.track ? state.track.crossings.length : 0;
    const unlockBannerHtml =
      unlockedItems.length > 0
        ? `<div class="unlock-banner">${getText(state.lang, "winUnlockedPrefix")}${unlockedItems.join(", ")}</div>`
        : "";

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
        <span class="win-pill">${getText(state.lang, cleanRun ? "winBadgeClean" : "winBadgeStandard")}</span>
      </div>

      <h2 class="modal-title">${getText(state.lang, "winTitle")}</h2>
      <p style="margin:0 0 10px 0; text-align:center; font-size:13px; color:var(--text-muted); line-height:1.4;">
        ${getText(state.lang, "winCongrats")}
      </p>

      ${unlockBannerHtml}

      <div class="stats-grid-4">
        <div>
          <div class="stat-cell-val">${state.car.lapsCompleted}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "winStatLaps")}</div>
        </div>
        <div>
          <div class="stat-cell-val">${state.car.offTrackCount}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "winStatExits")}</div>
        </div>
        <div>
          <div class="stat-cell-val">${crossingsCount}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "winStatCrossings")}</div>
        </div>
        <div>
          <div class="stat-cell-val">${state.profile.wins}</div>
          <div class="stat-cell-lbl">${getText(state.lang, "winStatTotalWins")}</div>
        </div>
      </div>

      <div class="modal-row-btns">
        <button id="btnWinBoard" class="modal-sec-btn" type="button">${getText(state.lang, "btnBoard")}</button>
        <button id="btnWinAgain" class="modal-full-btn" style="margin-top:0;" type="button">${getText(state.lang, "btnPlayAgain")}</button>
      </div>
    `;

    dom.modalBackdrop.classList.add("open");

    document.getElementById("btnWinBoard").addEventListener("click", () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      state.car.lapsCompleted = 0;
      state.car.offTrackCount = 0;
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
    const dt = (now - state.lastFrameTime) / 1000;
    state.lastFrameTime = now;

    if (state.phase === "driving" && state.track && !dom.modalBackdrop.classList.contains("open")) {
      const res = Engine.stepCar(state.car, state.track, state.mode, dt, {
        onOffTrack: () => {
          state.hasMoves = true;
          state.profile.totalExits += 1;
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

      if (res && res.event !== "off_track" && state.car.phase === "driving") {
        playEnginePulse(state.car.speed);
      }

      updateHud();
      renderCanvas();
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
    if (savedSession && savedSession.phase === "driving" && Array.isArray(savedSession.rawPoints)) {
      const check = Engine.validateStroke(savedSession.rawPoints);
      if (check.valid) {
        const rect = dom.boardCard.getBoundingClientRect();
        state.rawPoints = savedSession.rawPoints;
        state.track = Engine.buildTrack(state.rawPoints, rect.width, rect.height, state.settings.difficulty);
        state.mode = savedSession.mode === "manual" ? "manual" : "auto";
        state.hasMoves = Boolean(savedSession.hasMoves);
        state.showBrakingZones = Boolean(savedSession.showBrakingZones);
        state.car = Object.assign(Engine.createCarState(), savedSession.car || {});
        state.car.phase = "driving";
        state.car.visible = true;
        const pt = Engine.sampleAtDistance(state.track, state.car.s);
        state.car.x = pt.x;
        state.car.y = pt.y;
        state.car.angle = Math.atan2(pt.ty, pt.tx);
        state.phase = "driving";
        renderStatus();
        updateHud();
      }
    }

    renderCanvas();
    bindEvents();
    global.requestAnimationFrame(gameLoop);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})(window);
