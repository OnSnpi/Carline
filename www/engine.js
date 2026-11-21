(function (global) {
  "use strict";

  const Carline = global.Carline = global.Carline || {};
  const { drawing, physics } = Carline.CONFIG;

  function dist(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.hypot(dx, dy);
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

  function smoothClosedLoop(pts, iterations) {
    let ring = pts.map((p) => ({ x: p.x, y: p.y }));
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

  function resampleClosedLoop(ring, count) {
    const n = ring.length;
    if (n < 3) return [];

    const cum = [0];
    for (let i = 1; i <= n; i++) {
      const a = ring[i - 1];
      const b = ring[i % n];
      cum.push(cum[i - 1] + dist(a, b));
    }
    const totalLength = cum[n];
    if (totalLength <= 1) return [];

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
        curvature: 0,
        maxSafeSpeed: physics.maxSpeed
      });
    }

    const m = samples.length;
    for (let i = 0; i < m; i++) {
      const prev = samples[(i - 2 + m) % m];
      const curr = samples[i];
      const next = samples[(i + 2) % m];

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
      const cross = Math.abs(v1x * v2y - v1y * v2x) / (l1 * l2);
      const chord = Math.max(8, (l1 + l2) * 0.5);
      const rawCurv = cross / chord;
      curr.curvature = Math.min(0.04, rawCurv);

      const safeFromCurv = curr.curvature > 0.0004
        ? Math.sqrt(physics.gForceLimit / curr.curvature) * 1.65
        : physics.maxSpeed;
      curr.maxSafeSpeed = Math.max(70, Math.min(physics.maxSpeed, safeFromCurv));
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

    if (t > 0.05 && t < 0.95 && u > 0.05 && u < 0.95) {
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
    if (n < 12) return [];
    const crossings = [];
    const minIndexGap = Math.max(8, Math.floor(n * 0.04));

    for (let i = 0; i < n; i++) {
      const a1 = samples[i];
      const a2 = samples[(i + 1) % n];
      for (let j = i + minIndexGap; j < n; j++) {
        if (i === 0 && j >= n - minIndexGap) continue;
        const b1 = samples[j];
        const b2 = samples[(j + 1) % n];
        const hit = segmentIntersection(a1, a2, b1, b2);
        if (hit) {
          const underIndex = i < j ? i : j;
          const overIndex = i < j ? j : i;
          crossings.push({
            x: hit.x,
            y: hit.y,
            underIndex,
            overIndex
          });
        }
      }
    }

    return crossings;
  }

  Carline.Engine = {
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

    buildTrack(rawPoints, viewportWidth, viewportHeight) {
      const smoothed = smoothClosedLoop(rawPoints, drawing.smoothingIterations);
      const fitted = fitLoopToViewport(
        smoothed,
        viewportWidth,
        viewportHeight,
        drawing.canvasPadding
      );
      const resampled = resampleClosedLoop(fitted, drawing.sampleCount);
      const crossings = detectCrossings(resampled.samples);

      return {
        loopPoints: fitted,
        samples: resampled.samples,
        totalLength: resampled.totalLength,
        crossings
      };
    },

    sampleAtDistance(track, distanceS) {
      if (!track || !track.samples || track.samples.length === 0) {
        return {
          x: 0,
          y: 0,
          tx: 1,
          ty: 0,
          curvature: 0,
          maxSafeSpeed: physics.maxSpeed,
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
        curvature: s0.curvature + (s1.curvature - s0.curvature) * frac,
        maxSafeSpeed: s0.maxSafeSpeed + (s1.maxSafeSpeed - s0.maxSafeSpeed) * frac,
        sampleIndex: idx0
      };
    },

    createCarState() {
      return {
        s: 0,
        speed: 0,
        targetSpeed: physics.autoCruiseSpeed,
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
        offTrackCount: 0
      };
    },

    stepCar(car, track, mode, dt, callbacks) {
      if (!track || !track.samples || track.samples.length === 0 || dt <= 0) {
        return { event: null };
      }

      const clampedDt = Math.min(dt, 0.05);
      const pt = Carline.Engine.sampleAtDistance(track, car.s);

      if (car.phase === "flying") {
        car.phaseTimer += clampedDt;
        const progress = Math.min(1, car.phaseTimer / physics.flightDurationSec);
        const arcBoost = Math.sin(progress * Math.PI) * 34;
        car.x = car.flightStartX + car.flightDirX * (progress * 52);
        car.y = car.flightStartY + car.flightDirY * (progress * 52) - arcBoost;
        car.scale = 1 + Math.sin(progress * Math.PI) * 0.42;
        car.visible = true;

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
        if (car.phaseTimer >= physics.dropPauseSec) {
          car.phase = "blinking";
          car.phaseTimer = 0;
          car.s = car.returnS;
          car.x = car.returnX;
          car.y = car.returnY;
          car.scale = 1;
          car.visible = true;
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

      if (mode === "auto") {
        const safeTarget = Math.min(physics.autoCruiseSpeed, pt.maxSafeSpeed * 0.84);
        car.targetSpeed = safeTarget;
        const diff = car.targetSpeed - car.speed;
        car.speed += diff * Math.min(1, clampedDt * 5.5);
      } else {
        const clampedTarget = Math.max(physics.minSpeed, Math.min(physics.maxSpeed, car.targetSpeed));
        car.targetSpeed = clampedTarget;
        const diff = car.targetSpeed - car.speed;
        car.speed += diff * Math.min(1, clampedDt * 7.5);
      }

      const gForce = car.speed * car.speed * pt.curvature;
      if (gForce > physics.gForceLimit && car.speed > 55) {
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
        car.flightDirX = (pt.tx * 0.55 + nx * 0.85);
        car.flightDirY = (pt.ty * 0.55 + ny * 0.85);
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

      let lapEvent = null;
      if (car.lapProgress >= physics.lapWinThreshold) {
        car.lapProgress -= physics.lapWinThreshold;
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
