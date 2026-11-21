(function (global) {
  "use strict";

  const Carline = global.Carline = global.Carline || {};
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
    drawingPointerId: null,
    manualPointerId: null,
    manualLastX: null,
    modalOpenedAt: 0,
    bannerMessage: null,
    bannerSub: null,
    bannerTimeoutId: null,
    lastFrameTime: 0,
    lastEngineSoundMs: 0,
    lastHapticMs: 0,
    audioCtx: null
  };

  const dom = {};

  function cacheDom() {
    dom.statWins = document.getElementById("statWins");
    dom.statLaps = document.getElementById("statLaps");
    dom.statOffTrack = document.getElementById("statOffTrack");
    dom.btnNewTrack = document.getElementById("btnNewTrack");
    dom.btnProfile = document.getElementById("btnProfile");
    dom.btnModeAuto = document.getElementById("btnModeAuto");
    dom.btnModeManual = document.getElementById("btnModeManual");
    dom.speedValue = document.getElementById("speedValue");
    dom.modeHintText = document.getElementById("modeHintText");
    dom.canvasStage = document.getElementById("canvasStage");
    dom.canvas = document.getElementById("trackCanvas");
    dom.ctx = dom.canvas.getContext("2d");
    dom.phaseMainText = document.getElementById("phaseMainText");
    dom.phaseSubText = document.getElementById("phaseSubText");
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
    if (speed < 12) return;
    const norm = Math.min(1, speed / CONFIG.physics.maxSpeed);
    const freq = CONFIG.audio.engineBaseFreq + norm * (CONFIG.audio.engineMaxFreq - CONFIG.audio.engineBaseFreq);
    playTone(freq, 0.075, CONFIG.audio.engineGain, "sawtooth");
  }

  function playOffTrackSound() {
    playTone(210, 0.18, 0.08, "square");
  }

  function playWinSound() {
    playTone(523.25, 0.16, 0.07, "triangle");
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
    const allowed = state.profile.unlockedThemes;
    const chosen = allowed.includes(state.profile.selectedTheme)
      ? state.profile.selectedTheme
      : "classic";
    state.profile.selectedTheme = chosen;
    document.body.setAttribute("data-theme", chosen);
  }

  function refreshUnlocks() {
    let unlockedChanged = false;
    for (const theme of CONFIG.themes) {
      if (
        state.profile.wins >= theme.requiredWins &&
        !state.profile.unlockedThemes.includes(theme.id)
      ) {
        state.profile.unlockedThemes.push(theme.id);
        unlockedChanged = true;
      }
    }
    return unlockedChanged;
  }

  function setTemporaryBanner(mainKey, subKey, durationMs) {
    state.bannerMessage = getText(state.lang, mainKey);
    state.bannerSub = subKey ? getText(state.lang, subKey) : "";
    renderBanner();

    if (state.bannerTimeoutId) {
      clearTimeout(state.bannerTimeoutId);
      state.bannerTimeoutId = null;
    }

    if (durationMs > 0) {
      state.bannerTimeoutId = setTimeout(() => {
        state.bannerMessage = null;
        state.bannerSub = null;
        renderBanner();
      }, durationMs);
    }
  }

  function renderBanner() {
    if (state.bannerMessage) {
      dom.phaseMainText.textContent = state.bannerMessage;
      dom.phaseSubText.textContent = state.bannerSub || "";
      return;
    }

    if (state.phase === "drawing") {
      dom.phaseMainText.textContent = getText(state.lang, "drawPrompt");
      dom.phaseSubText.textContent = getText(state.lang, "drawSub");
    } else {
      dom.phaseMainText.textContent = getText(state.lang, "trackReady");
      dom.phaseSubText.textContent = getText(state.lang, "trackReadySub");
    }
  }

  function applyI18n() {
    document.documentElement.lang = state.lang;
    const nodes = document.querySelectorAll("[data-i18n]");
    for (const el of nodes) {
      const key = el.getAttribute("data-i18n");
      el.textContent = getText(state.lang, key);
    }
    dom.modeHintText.textContent = getText(
      state.lang,
      state.mode === "auto" ? "hintAuto" : "hintManual"
    );
    renderBanner();
  }

  function updateHud() {
    dom.statWins.textContent = String(state.profile.wins);
    dom.statLaps.textContent = String(state.profile.totalLaps);
    dom.statOffTrack.textContent = String(state.profile.totalOffTrack);
    dom.speedValue.textContent = String(Math.round(state.car.speed));

    dom.btnModeAuto.classList.toggle("active", state.mode === "auto");
    dom.btnModeManual.classList.toggle("active", state.mode === "manual");
  }

  function resizeCanvas() {
    const rect = dom.canvasStage.getBoundingClientRect();
    const dpr = Math.min(global.devicePixelRatio || 1, 2.5);
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    dom.canvas.width = Math.floor(width * dpr);
    dom.canvas.height = Math.floor(height * dpr);
    dom.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (state.phase === "driving" && Array.isArray(state.rawPoints) && state.rawPoints.length >= 6) {
      const prevRatio = state.track && state.track.totalLength > 0
        ? state.car.s / state.track.totalLength
        : 0;
      state.track = Engine.buildTrack(state.rawPoints, width, height);
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
      bgTrack: cs.getPropertyValue("--bg-track").trim(),
      trackStroke: cs.getPropertyValue("--track-stroke").trim(),
      trackUnder: cs.getPropertyValue("--track-under").trim(),
      trackOver: cs.getPropertyValue("--track-over").trim(),
      carColor: cs.getPropertyValue("--car-color").trim(),
      startColor: cs.getPropertyValue("--start-color").trim(),
      textMuted: cs.getPropertyValue("--text-muted").trim()
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
    ctx.strokeStyle = styles.bgTrack;
    ctx.lineWidth = 22;
    ctx.stroke();

    ctx.strokeStyle = styles.trackStroke;
    ctx.lineWidth = 10;
    ctx.stroke();

    for (const cr of track.crossings) {
      const underPt = pts[cr.underIndex];
      const overPt = pts[cr.overIndex];

      ctx.beginPath();
      ctx.arc(underPt.x, underPt.y, 11, 0, Math.PI * 2);
      ctx.fillStyle = styles.trackUnder;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(overPt.x, overPt.y, 7, 0, Math.PI * 2);
      ctx.fillStyle = styles.trackOver;
      ctx.fill();
    }

    const startPt = pts[0];
    ctx.beginPath();
    ctx.arc(startPt.x, startPt.y, 12, 0, Math.PI * 2);
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

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.rotate(angle);

    ctx.fillStyle = styles.carColor;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;

    const w = 22;
    const h = 14;
    ctx.beginPath();
    ctx.roundRect(-w * 0.5, -h * 0.5, w, h, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(w * 0.15, -3, 5, 6);

    ctx.restore();
  }

  function drawDrawingStroke(ctx, styles) {
    if (!Array.isArray(state.rawPoints) || state.rawPoints.length === 0) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = styles.trackStroke;
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
    const rect = dom.canvasStage.getBoundingClientRect();
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
      setTemporaryBanner("tooShortTrack", "drawSub", 2200);
      renderCanvas();
      return;
    }

    const rect = dom.canvasStage.getBoundingClientRect();
    state.track = Engine.buildTrack(state.rawPoints, rect.width, rect.height);
    state.car = Engine.createCarState();
    const startPt = Engine.sampleAtDistance(state.track, 0);
    state.car.x = startPt.x;
    state.car.y = startPt.y;
    state.car.angle = Math.atan2(startPt.ty, startPt.tx);
    state.car.targetSpeed = state.mode === "auto"
      ? CONFIG.physics.autoCruiseSpeed
      : CONFIG.physics.manualStartSpeed;

    state.phase = "driving";
    state.hasMoves = false;
    state.profile.tracksBuilt += 1;
    setTemporaryBanner("trackReady", "trackReadySub", 2600);
    updateHud();
    renderCanvas();
    persistProfile();
    persistSession();
  }

  function resetToNewTrack() {
    state.phase = "drawing";
    state.rawPoints = [];
    state.track = null;
    state.car = Engine.createCarState();
    state.hasMoves = false;
    state.drawingPointerId = null;
    state.manualPointerId = null;
    state.manualLastX = null;
    state.bannerMessage = null;
    state.bannerSub = null;
    updateHud();
    renderBanner();
    renderCanvas();
    persistSession();
  }

  function setMode(nextMode) {
    if (nextMode !== "auto" && nextMode !== "manual") return;
    state.mode = nextMode;
    if (nextMode === "manual") {
      state.car.targetSpeed = Math.max(CONFIG.physics.manualStartSpeed, state.car.speed);
    } else {
      state.car.targetSpeed = CONFIG.physics.autoCruiseSpeed;
    }
    dom.modeHintText.textContent = getText(
      state.lang,
      state.mode === "auto" ? "hintAuto" : "hintManual"
    );
    updateHud();
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
      ensureAudioContext();
      setMode("auto");
    });

    dom.btnModeManual.addEventListener("click", () => {
      ensureAudioContext();
      setMode("manual");
    });

    dom.btnNewTrack.addEventListener("click", () => {
      if (state.hasMoves || (state.phase === "drawing" && state.rawPoints.length > 0)) {
        openConfirmNewTrackModal();
      } else {
        resetToNewTrack();
      }
    });

    dom.btnProfile.addEventListener("click", () => {
      openProfileModal();
    });

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

  function openConfirmNewTrackModal() {
    state.modalOpenedAt = performance.now();
    dom.modalCard.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title">${getText(state.lang, "confirmNewTitle")}</h2>
      </div>
      <div class="modal-section">
        <p style="margin:0; font-size:14px; line-height:1.45;">${getText(state.lang, "confirmNewBody")}</p>
      </div>
      <div class="modal-actions">
        <button id="btnCancelNew" class="btn" type="button">${getText(state.lang, "cancel")}</button>
        <button id="btnConfirmNew" class="btn primary" type="button">${getText(state.lang, "confirmYes")}</button>
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

  function openProfileModal() {
    state.modalOpenedAt = performance.now();

    const themesHtml = CONFIG.themes.map((t) => {
      const unlocked = state.profile.unlockedThemes.includes(t.id);
      const isSelected = state.profile.selectedTheme === t.id;
      let actionControl = "";

      if (!unlocked) {
        actionControl = `<button class="btn" type="button" disabled>${getText(state.lang, "lockedBadge")}</button>`;
      } else if (isSelected) {
        actionControl = `<button class="btn active" type="button" disabled>${getText(state.lang, "activeTheme")}</button>`;
      } else {
        actionControl = `<button class="btn primary select-theme-btn" data-theme-id="${t.id}" type="button">${getText(state.lang, "useTheme")}</button>`;
      }

      return `
        <div class="theme-item">
          <div class="theme-item-info">
            <span class="theme-item-name">${getText(state.lang, t.nameKey)}</span>
            <span class="theme-item-req">${getText(state.lang, t.reqKey)}</span>
          </div>
          ${actionControl}
        </div>
      `;
    }).join("");

    dom.modalCard.innerHTML = `
      <div class="modal-header">
        <h2 class="modal-title">${getText(state.lang, "profileTitle")}</h2>
        <button id="btnCloseModalTop" class="btn" type="button">${getText(state.lang, "close")}</button>
      </div>

      <div class="modal-section">
        <div style="font-weight:700; margin-bottom:6px;">${getText(state.lang, "settingsHeading")}</div>
        <label class="setting-row">
          <span>${getText(state.lang, "soundToggle")}</span>
          <input id="chkSound" type="checkbox" ${state.settings.sound ? "checked" : ""} />
        </label>
        <label class="setting-row">
          <span>${getText(state.lang, "hapticsToggle")}</span>
          <input id="chkHaptics" type="checkbox" ${state.settings.haptics ? "checked" : ""} />
        </label>
        <div class="setting-row">
          <span>${getText(state.lang, "langLabel")}</span>
          <select id="selLang">
            <option value="cs" ${state.lang === "cs" ? "selected" : ""}>Čeština</option>
            <option value="en" ${state.lang === "en" ? "selected" : ""}>English</option>
          </select>
        </div>
      </div>

      <div class="modal-section">
        <div style="font-weight:700; margin-bottom:6px;">${getText(state.lang, "statsHeading")}</div>
        <div class="setting-row">
          <span>${getText(state.lang, "statWins")}</span>
          <strong>${state.profile.wins}</strong>
        </div>
        <div class="setting-row">
          <span>${getText(state.lang, "totalLapsLabel")}</span>
          <strong>${state.profile.totalLaps}</strong>
        </div>
        <div class="setting-row">
          <span>${getText(state.lang, "totalOffTrackLabel")}</span>
          <strong>${state.profile.totalOffTrack}</strong>
        </div>
        <div class="setting-row">
          <span>${getText(state.lang, "tracksBuiltLabel")}</span>
          <strong>${state.profile.tracksBuilt}</strong>
        </div>
      </div>

      <div class="modal-section">
        <div style="font-weight:700;">${getText(state.lang, "themesHeading")}</div>
        <div class="theme-grid">${themesHtml}</div>
      </div>

      <div class="modal-actions">
        <button id="btnCloseModalBottom" class="btn primary" type="button">${getText(state.lang, "close")}</button>
      </div>
    `;

    dom.modalBackdrop.classList.add("open");

    document.getElementById("chkSound").addEventListener("change", (e) => {
      state.settings.sound = Boolean(e.target.checked);
      if (state.settings.sound) {
        ensureAudioContext();
      }
      persistProfile();
    });

    document.getElementById("chkHaptics").addEventListener("change", (e) => {
      state.settings.haptics = Boolean(e.target.checked);
      persistProfile();
    });

    document.getElementById("selLang").addEventListener("change", (e) => {
      state.settings.lang = e.target.value;
      state.lang = detectLanguage(state.settings.lang);
      applyI18n();
      updateHud();
      persistProfile();
      openProfileModal();
    });

    const themeButtons = dom.modalCard.querySelectorAll(".select-theme-btn");
    for (const btn of themeButtons) {
      btn.addEventListener("click", () => {
        if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
        const themeId = btn.getAttribute("data-theme-id");
        if (state.profile.unlockedThemes.includes(themeId)) {
          state.profile.selectedTheme = themeId;
          applyTheme();
          renderCanvas();
          persistProfile();
          openProfileModal();
        }
      });
    }

    const closeHandler = () => {
      if (performance.now() - state.modalOpenedAt < CONFIG.ui.modalGuardMs) return;
      closeModal();
    };
    document.getElementById("btnCloseModalTop").addEventListener("click", closeHandler);
    document.getElementById("btnCloseModalBottom").addEventListener("click", closeHandler);
  }

  function gameLoop(now) {
    if (!state.lastFrameTime) {
      state.lastFrameTime = now;
    }
    const dt = (now - state.lastFrameTime) / 1000;
    state.lastFrameTime = now;

    if (state.phase === "driving" && state.track) {
      const res = Engine.stepCar(state.car, state.track, state.mode, dt, {
        onOffTrack: () => {
          state.hasMoves = true;
          state.profile.totalOffTrack += 1;
          playOffTrackSound();
          triggerHaptic("heavy");
          setTemporaryBanner("offTrackBanner", null, 1500);
          updateHud();
          persistProfile();
        },
        onLapCompleted: () => {
          state.hasMoves = true;
          state.profile.totalLaps += 1;
          state.profile.wins += 1;
          refreshUnlocks();
          playWinSound();
          triggerHaptic("light");
          setTemporaryBanner("winBanner", null, 1800);
          updateHud();
          persistProfile();
        }
      });

      if (res && res.event !== "off_track" && state.car.phase === "driving") {
        playEnginePulse(state.car.speed);
      }
      dom.speedValue.textContent = String(Math.round(state.car.speed));
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
        const rect = dom.canvasStage.getBoundingClientRect();
        state.rawPoints = savedSession.rawPoints;
        state.track = Engine.buildTrack(state.rawPoints, rect.width, rect.height);
        state.mode = savedSession.mode === "manual" ? "manual" : "auto";
        state.hasMoves = Boolean(savedSession.hasMoves);
        state.car = Object.assign(Engine.createCarState(), savedSession.car || {});
        state.car.phase = "driving";
        state.car.visible = true;
        const pt = Engine.sampleAtDistance(state.track, state.car.s);
        state.car.x = pt.x;
        state.car.y = pt.y;
        state.car.angle = Math.atan2(pt.ty, pt.tx);
        state.phase = "driving";
        renderBanner();
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
