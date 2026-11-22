(function (global) {
  "use strict";

  const Carline = (global.Carline = global.Carline || {});
  const { drawing, physics, carSpecs } = Carline.CONFIG;

  function dist(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function polylineLength(pts, closed) {
    if (!pts || pts.length < 2) return 0;
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += dist(pts[i - 1], pts[i]);
    }
    if (closed) {
      len += dist(pts[pts.length - 1], pts[0]);
    }
    return len;
  }

  function closeStrokeSmoothly(pts) {
    const cleaned = [];
    for (const p of pts) {
      if (cleaned.length === 0 || dist(cleaned[cleaned.length - 1], p) >= 3) {
        cleaned.push({ x: p.x, y: p.y });
      }
    }
    if (cleaned.length < 4) return cleaned;

    while (cleaned.length > 6 && dist(cleaned[cleaned.length - 1], cleaned[0]) < 14) {
      cleaned.pop();
    }

    const n = cleaned.length;
    const pLast = cleaned[n - 1];
    const pPrev = cleaned[n - 2];
    const pFirst = cleaned[0];
    const pNext = cleaned[1];

    const gap = dist(pLast, pFirst);
    if (gap <= 10) {
      return cleaned;
    }

    const tangentScale = Math.min(gap * 0.45, 70);
    const outLen = dist(pPrev, pLast) || 1;
    const inLen = dist(pFirst, pNext) || 1;

    const m0x = ((pLast.x - pPrev.x) / outLen) * tangentScale;
    const m0y = ((pLast.y - pPrev.y) / outLen) * tangentScale;
    const m1x = ((pNext.x - pFirst.x) / inLen) * tangentScale;
    const m1y = ((pNext.y - pFirst.y) / inLen) * tangentScale;

    const bridgeSteps = Math.max(3, Math.min(18, Math.round(gap / 10)));
    const result = cleaned.slice();

    for (let step = 1; step < bridgeSteps; step++) {
      const t = step / bridgeSteps;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;

      result.push({
        x: h00 * pLast.x + h10 * m0x + h01 * pFirst.x + h11 * m1x,
        y: h00 * pLast.y + h10 * m0y + h01 * pFirst.y + h11 * m1y
      });
    }

    return result;
  }

  function smoothClosedLoop(pts, iterations) {
    let ring = closeStrokeSmoothly(pts);
    if (ring.length < 3) return ring;

    for (let iter = 0; iter < iterations; iter++) {
      const next = [];
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p0 = ring[i];
        const p1 = ring[(i + 1) % n];
        next.push({
          x: 0.75 * p0.x + 0.25 * p1.x,
          y: 0.75 * p0.y + 0.25 * p1.y
        });
        next.push({
          x: 0.25 * p0.x + 0.75 * p1.x,
          y: 0.25 * p0.y + 0.75 * p1.y
        });
      }
      ring = next;
    }
    return ring;
  }

  function fitLoopToViewport(ring, width, height, padding) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);
    const availW = Math.max(40, width - padding * 2);
    const availH = Math.max(40, height - padding * 2);
    const scale = Math.min(availW / spanX, availH / spanY);

    const scaledW = spanX * scale;
    const scaledH = spanY * scale;
    const offsetX = (width - scaledW) * 0.5 - minX * scale;
    const offsetY = (height - scaledH) * 0.5 - minY * scale;

    return ring.map((p) => ({
      x: p.x * scale + offsetX,
      y: p.y * scale + offsetY
    }));
  }

  function resampleClosedLoop(ring, count, magnetGrip) {
    const n = ring.length;
    if (n < 3) return { samples: [], totalLength: 0 };

    const cum = [0];
    for (let i = 1; i <= n; i++) {
      const a = ring[i - 1];
      const b = ring[i % n];
      cum.push(cum[i - 1] + dist(a, b));
    }

    const totalLength = cum[n];
    if (totalLength <= 1) return { samples: [], totalLength: 0 };

    const samples = [];
    let segIdx = 0;

    for (let k = 0; k < count; k++) {
      const targetS = (k / count) * totalLength;
      while (segIdx < n - 1 && cum[segIdx + 1] < targetS) {
        segIdx++;
      }
      const s0 = cum[segIdx];
      const s1 = cum[segIdx + 1];
      const t = s1 > s0 ? (targetS - s0) / (s1 - s0) : 0;
      const a = ring[segIdx];
      const b = ring[(segIdx + 1) % n];

      samples.push({
        index: k,
        s: targetS,
        tNorm: k / count,
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        tx: 1,
        ty: 0,
        signedCurvature: 0,
        curvature: 0,
        maxSafeSpeed: physics.maxSpeed,
        dangerRatio: 0
      });
    }

    const m = samples.length;
    const rawCurvs = new Array(m).fill(0);
    const signedCurvs = new Array(m).fill(0);

    for (let i = 0; i < m; i++) {
      const prev = samples[(i - 4 + m) % m];
      const curr = samples[i];
      const next = samples[(i + 4) % m];

      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const dLen = Math.hypot(dx, dy) || 1;
      curr.tx = dx / dLen;
      curr.ty = dy / dLen;

      const v1x = curr.x - prev.x;
      const v1y = curr.y - prev.y;
      const v2x = next.x - curr.x;
      const v2y = next.y - curr.y;
      const l1 = Math.hypot(v1x, v1y) || 1;
      const l2 = Math.hypot(v2x, v2y) || 1;
      const crossSigned = (v1x * v2y - v1y * v2x) / (l1 * l2);
      const chord = Math.max(12, (l1 + l2) * 0.5);
      signedCurvs[i] = Math.max(-0.03, Math.min(0.03, crossSigned / chord));
      rawCurvs[i] = Math.abs(signedCurvs[i]);
    }

    const grip = magnetGrip || physics.magnetGripBase;
    for (let i = 0; i < m; i++) {
      const c2 = rawCurvs[(i - 2 + m) % m];
      const c1 = rawCurvs[(i - 1 + m) % m];
      const c0 = rawCurvs[i];
      const cn1 = rawCurvs[(i + 1) % m];
      const cn2 = rawCurvs[(i + 2) % m];
      const smoothCurv = 0.1 * c2 + 0.22 * c1 + 0.36 * c0 + 0.22 * cn1 + 0.1 * cn2;
      samples[i].curvature = smoothCurv;
      samples[i].signedCurvature = signedCurvs[i];

      const safeFromMagnet = smoothCurv > 0.00035
        ? Math.sqrt(grip / smoothCurv)
        : physics.maxSpeed;
      const clampedSafe = Math.max(physics.autoMinCornerSpeed, Math.min(physics.maxSpeed, safeFromMagnet));
      samples[i].maxSafeSpeed = clampedSafe;
      samples[i].dangerRatio = Math.max(0, Math.min(1, 1 - (clampedSafe - 68) / (physics.maxSpeed - 68)));
    }

    return {
      samples,
      totalLength
    };
  }

  function segmentIntersection(p1, p2, q1, q2) {
    const rX = p2.x - p1.x;
    const rY = p2.y - p1.y;
    const sX = q2.x - q1.x;
    const sY = q2.y - q1.y;
    const denom = rX * sY - rY * sX;
    if (Math.abs(denom) < 1e-6) return null;

    const qpX = q1.x - p1.x;
    const qpY = q1.y - p1.y;
    const t = (qpX * sY - qpY * sX) / denom;
    const u = (qpX * rY - qpY * rX) / denom;

    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return {
        x: p1.x + t * rX,
        y: p1.y + t * rY,
        t,
        u
      };
    }
    return null;
  }

  function detectCrossings(samples) {
    const n = samples.length;
    if (n < 16) return [];
    const crossings = [];
    const minIndexGap = Math.max(6, Math.floor(n * 0.02));

    for (let i = 0; i < n; i++) {
      const a1 = samples[i];
      const a2 = samples[(i + 1) % n];

      for (let j = i + minIndexGap; j < n; j++) {
        if (i === 0 && j >= n - minIndexGap) continue;
        const b1 = samples[j];
        const b2 = samples[(j + 1) % n];
        const hit = segmentIntersection(a1, a2, b1, b2);
        if (hit) {
          const alreadyNear = crossings.some((c) => Math.hypot(c.x - hit.x, c.y - hit.y) < 10);
          if (!alreadyNear) {
            crossings.push({
              x: hit.x,
              y: hit.y,
              underIndex: i,
              overIndex: j
            });
          }
        }
      }
    }
    return crossings;
  }

  function getSpec(carStyleId) {
    return carSpecs[carStyleId] || carSpecs.classic_car;
  }

  Carline.Engine = {
    generateRandomStroke(width, height) {
      const cx = width * 0.5;
      const cy = height * 0.5;
      const rx = Math.max(80, width * 0.36);
      const ry = Math.max(110, height * 0.38);
      const pts = [];
      const steps = 48;
      const variant = Math.floor(Math.random() * 3);
      const phaseOffset = Math.random() * Math.PI * 2;

      for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        let x = cx;
        let y = cy;
        if (variant === 0) {
          x = cx + rx * Math.sin(t + phaseOffset) * 0.92;
          y = cy + ry * Math.sin(2 * t + phaseOffset) * 0.92;
        } else if (variant === 1) {
          x = cx + rx * (0.68 * Math.cos(t) + 0.32 * Math.cos(3 * t + phaseOffset));
          y = cy + ry * (0.72 * Math.sin(t) + 0.28 * Math.sin(2 * t + phaseOffset));
        } else {
          x = cx + rx * Math.sin(2 * t + phaseOffset) * 0.9;
          y = cy + ry * Math.sin(3 * t + phaseOffset) * 0.9;
        }
        pts.push({ x, y, t: i * 16 });
      }
      return pts;
    },

    validateStroke(rawPoints) {
      if (!Array.isArray(rawPoints) || rawPoints.length < 6) {
        return { valid: false, reason: "too_short" };
      }
      const len = polylineLength(rawPoints, true);
      if (len < drawing.minTrackLength) {
        return { valid: false, reason: "too_short" };
      }
      return { valid: true, length: len };
    },

    buildTrack(rawPoints, viewportWidth, viewportHeight, difficulty) {
      const grip = physics.magnetGripDifficulties[difficulty] || physics.magnetGripBase;
      const smoothed = smoothClosedLoop(rawPoints, drawing.smoothingIterations);
      const fitted = fitLoopToViewport(
        smoothed,
        viewportWidth,
        viewportHeight,
        drawing.canvasPadding
      );
      const resampled = resampleClosedLoop(fitted, drawing.sampleCount, grip);
      const crossings = detectCrossings(resampled.samples);

      const track = {
        loopPoints: fitted,
        samples: resampled.samples,
        totalLength: resampled.totalLength,
        crossings,
        magnetGrip: grip,
        autoSingleLapSec: 5
      };

      track.autoSingleLapSec = Carline.Engine.simulateAutoLapTime(track);
      return track;
    },

    simulateAutoLapTime(track) {
      if (!track || !track.samples || track.samples.length === 0) return 5.0;
      const simCar = Carline.Engine.createCarState();
      simCar.speed = 90;
      const dt = 0.025;
      let elapsed = 0;
      const maxTime = 90;

      while (simCar.lapsCompleted < 1 && elapsed < maxTime) {
        Carline.Engine.stepCar(simCar, track, "auto", dt, "classic_car", null);
        elapsed += dt;
      }
      return Math.max(1.5, elapsed);
    },

    sampleAtDistance(track, distanceS) {
      if (!track || !track.samples || track.samples.length === 0) {
        return {
          x: 0,
          y: 0,
          tx: 1,
          ty: 0,
          signedCurvature: 0,
          curvature: 0,
          maxSafeSpeed: physics.maxSpeed,
          dangerRatio: 0,
          sampleIndex: 0
        };
      }
      const total = track.totalLength;
      const wrappedS = ((distanceS % total) + total) % total;
      const ratio = wrappedS / total;
      const exactIdx = ratio * track.samples.length;
      const idx0 = Math.floor(exactIdx) % track.samples.length;
      const idx1 = (idx0 + 1) % track.samples.length;
      const frac = exactIdx - Math.floor(exactIdx);

      const s0 = track.samples[idx0];
      const s1 = track.samples[idx1];

      return {
        x: s0.x + (s1.x - s0.x) * frac,
        y: s0.y + (s1.y - s0.y) * frac,
        tx: s0.tx + (s1.tx - s0.tx) * frac,
        ty: s0.ty + (s1.ty - s0.ty) * frac,
        signedCurvature: s0.signedCurvature + (s1.signedCurvature - s0.signedCurvature) * frac,
        curvature: s0.curvature + (s1.curvature - s0.curvature) * frac,
        maxSafeSpeed: s0.maxSafeSpeed + (s1.maxSafeSpeed - s0.maxSafeSpeed) * frac,
        dangerRatio: s0.dangerRatio + (s1.dangerRatio - s0.dangerRatio) * frac,
        sampleIndex: idx0
      };
    },

    computeAutoLookaheadSpeed(track, currentS) {
      if (!track || !track.samples || track.samples.length === 0) {
        return physics.autoCruiseMax;
      }
      const lookaheadSteps = Math.max(12, Math.floor(track.samples.length * physics.autoLookaheadRatio));
      const stepDist = track.totalLength / track.samples.length;
      let allowed = physics.autoCruiseMax;

      for (let k = 0; k <= lookaheadSteps; k++) {
        const aheadPt = Carline.Engine.sampleAtDistance(track, currentS + k * stepDist);
        const weight = 1 - (k / (lookaheadSteps + 1)) * 0.25;
        const safeAtPt = (aheadPt.maxSafeSpeed * physics.autoSafetyFactor) / weight;
        if (safeAtPt < allowed) {
          allowed = safeAtPt;
        }
      }
      return Math.max(physics.autoMinCornerSpeed, Math.min(physics.autoCruiseMax, allowed));
    },

    createCarState() {
      return {
        s: 0,
        speed: 0,
        targetSpeed: physics.autoCruiseMax,
        phase: "driving",
        phaseTimer: 0,
        flightStartX: 0,
        flightStartY: 0,
        flightDirX: 1,
        flightDirY: 0,
        returnS: 0,
        returnX: 0,
        returnY: 0,
        lapProgress: 0,
        lapsCompleted: 0,
        offTrackCount: 0,
        gripLoadRatio: 0,
        driftAngle: 0,
        accelLoad: 0,
        brakeLoad: 0,
        sampleIndex: 0,
        finished: false,
        x: 0,
        y: 0,
        angle: 0,
        scale: 1,
        visible: true
      };
    },

    stepCar(car, track, mode, dt, carStyleId, callbacks) {
      if (!track || !track.samples || track.samples.length === 0 || dt <= 0) {
        return { event: null };
      }

      if (car.finished) {
        car.speed = 0;
        car.accelLoad = 0;
        car.brakeLoad = 0;
        return { event: "finished" };
      }

      const clampedDt = Math.min(dt, 0.05);
      const spec = getSpec(carStyleId);
      const pt = Carline.Engine.sampleAtDistance(track, car.s);
      car.sampleIndex = pt.sampleIndex;

      if (car.phase === "flying") {
        car.phaseTimer += clampedDt;
        const progress = Math.min(1, car.phaseTimer / physics.flightDurationSec);
        const arcBoost = Math.sin(progress * Math.PI) * 34;
        car.x = car.flightStartX + car.flightDirX * (progress * 54);
        car.y = car.flightStartY + car.flightDirY * (progress * 54) - arcBoost;
        car.scale = 1 + Math.sin(progress * Math.PI) * 0.42;
        car.driftAngle += clampedDt * 9;
        car.visible = true;
        car.gripLoadRatio = 1.2;
        car.accelLoad = 0;
        car.brakeLoad = 0;

        if (progress >= 1) {
          car.phase = "dropped";
          car.phaseTimer = 0;
          car.visible = false;
        }
        return { event: null };
      }

      if (car.phase === "dropped") {
        car.phaseTimer += clampedDt;
        car.visible = false;
        car.driftAngle = 0;
        if (car.phaseTimer >= physics.dropPauseSec) {
          car.phase = "blinking";
          car.phaseTimer = 0;
          car.s = car.returnS;
          car.x = car.returnX;
          car.y = car.returnY;
          car.scale = 1;
          car.visible = true;
          car.gripLoadRatio = 0;
          car.speed = Math.min(car.speed, pt.maxSafeSpeed * physics.postCrashSpeedFactor);
          if (mode === "manual") {
            car.targetSpeed = car.speed;
          }
        }
        return { event: null };
      }

      if (car.phase === "blinking") {
        car.phaseTimer += clampedDt;
        car.x = car.returnX;
        car.y = car.returnY;
        car.scale = 1;
        car.gripLoadRatio = 0;
        car.driftAngle = 0;
        const cyclePhase = (car.phaseTimer / physics.blinkDurationSec) * physics.blinkCycles * 2;
        car.visible = Math.floor(cyclePhase) % 2 === 0;

        if (car.phaseTimer >= physics.blinkDurationSec) {
          car.phase = "driving";
          car.phaseTimer = 0;
          car.visible = true;
        }
        return { event: null };
      }

      car.visible = true;
      car.scale = 1;
      const prevSpeed = car.speed;

      if (mode === "auto") {
        const safeTarget = Carline.Engine.computeAutoLookaheadSpeed(track, car.s);
        car.targetSpeed = safeTarget;
        const diff = car.targetSpeed - car.speed;
        const rate = diff < 0 ? 9.5 : 4.5;
        car.speed += diff * Math.min(1, clampedDt * rate);
      } else {
        const effectiveMax = physics.maxSpeed * spec.maxSpeedMult;
        const clampedTarget = Math.max(physics.minSpeed, Math.min(effectiveMax, car.targetSpeed));
        car.targetSpeed = clampedTarget;
        const diff = car.targetSpeed - car.speed;
        car.speed += diff * Math.min(1, clampedDt * 7.5 * spec.accelMult);
      }

      const dv = (car.speed - prevSpeed) / clampedDt;
      car.accelLoad = dv > 12 ? Math.min(1, dv / 220) : 0;
      car.brakeLoad = dv < -25 ? Math.min(1, Math.abs(dv) / 260) : 0;

      const effectiveSafeLimit = pt.maxSafeSpeed * Math.sqrt(spec.gripMult);
      car.gripLoadRatio = effectiveSafeLimit > 0 ? car.speed / effectiveSafeLimit : 0;

      if (mode === "manual" && car.gripLoadRatio > 0.78 && pt.curvature > 0.001) {
        const slipIntensity = Math.min(1, (car.gripLoadRatio - 0.78) / 0.22);
        const turnSign = pt.signedCurvature >= 0 ? 1 : -1;
        car.driftAngle = turnSign * slipIntensity * 0.36;
      } else {
        car.driftAngle *= Math.max(0, 1 - clampedDt * 12);
      }

      if (mode === "manual" && car.gripLoadRatio > 1.0 && car.speed > 85) {
        car.offTrackCount += 1;
        car.phase = "flying";
        car.phaseTimer = 0;
        car.flightStartX = pt.x;
        car.flightStartY = pt.y;
        car.returnS = car.s;
        car.returnX = pt.x;
        car.returnY = pt.y;

        const nx = -pt.ty;
        const ny = pt.tx;
        car.flightDirX = pt.tx * 0.55 + nx * 0.85;
        car.flightDirY = pt.ty * 0.55 + ny * 0.85;
        const dirLen = Math.hypot(car.flightDirX, car.flightDirY) || 1;
        car.flightDirX /= dirLen;
        car.flightDirY /= dirLen;

        if (callbacks && typeof callbacks.onOffTrack === "function") {
          callbacks.onOffTrack(car.offTrackCount);
        }
        return { event: "off_track" };
      }

      const deltaS = car.speed * clampedDt;
      car.s += deltaS;
      car.lapProgress += deltaS / track.totalLength;

      const updatedPt = Carline.Engine.sampleAtDistance(track, car.s);
      car.x = updatedPt.x;
      car.y = updatedPt.y;
      car.angle = Math.atan2(updatedPt.ty, updatedPt.tx);
      car.sampleIndex = updatedPt.sampleIndex;

      let lapEvent = null;
      if (car.lapProgress >= 1) {
        car.lapProgress -= 1;
        car.lapsCompleted += 1;
        lapEvent = "lap_completed";
        if (callbacks && typeof callbacks.onLapCompleted === "function") {
          callbacks.onLapCompleted(car.lapsCompleted);
        }
      }

      return { event: lapEvent };
    }
  };
})(window);
