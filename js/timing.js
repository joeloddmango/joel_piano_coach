/* =====================================================================
 * timing.js — compares detected note onsets with metronome beats.
 *
 * Every onset is matched to the nearest point of the "note grid"
 * (quarter notes, 8ths, triplets or 16ths — chosen per section to match
 * the fastest notes in the passage). deviation = onset − grid point,
 * after subtracting this device's calibrated latency.
 *
 * Negative deviation = early (rushing), positive = late (dragging).
 * ===================================================================== */

/**
 * @param {object} o
 *   onsets   [{time, db}] raw mic onsets (AudioContext seconds)
 *   grid     metronome.grid (all scheduled ticks incl. silent gap-mode ones)
 *   bpm, gridDiv, latency (seconds), tolMs, passPct
 *   tEnd     ignore onsets after this time (e.g. the screen tap)
 *   gapCycle play+mute bars (0 if gap mode off)
 * @returns analysis object (see bottom) — `n` < 4 means "not enough notes heard"
 */
export function analyzeRep({ onsets, grid, bpm, gridDiv = 2, latency = 0, tolMs = 40, passPct = 80, tEnd = Infinity, gapCycle = 0 }) {
  const period = 60 / bpm;
  const step = period / gridDiv;
  const beats = grid.filter(t => t.sub === 0 && !t.countIn && t.time <= tEnd + period);
  const empty = { n: 0, notes: [], pass: false, onTimePct: 0, meanMs: 0, sdMs: 0, gap: null };
  if (!beats.length) return empty;

  // Build the note grid between beats.
  const points = [];
  for (const b of beats) {
    for (let j = 0; j < gridDiv; j++) points.push({ time: b.time + j * step, audible: b.audible, bar: b.bar });
  }

  const tol = tolMs / 1000;
  const t0 = beats[0].time - step / 2;
  const notes = [];
  let pi = 0;
  for (const o of onsets) {
    const t = o.time - latency;
    if (t < t0 || t > tEnd - latency) continue;
    while (pi < points.length - 1 && Math.abs(points[pi + 1].time - t) <= Math.abs(points[pi].time - t)) pi++;
    const p = points[pi];
    const dev = t - p.time;
    const cls = dev < -tol ? 'early' : dev > tol ? 'late' : 'on';
    notes.push({ t, dev, cls, audible: p.audible, bar: p.bar, db: o.db });
  }

  const n = notes.length;
  if (n < 4) return { ...empty, n, notes };

  const devs = notes.map(x => x.dev);
  const mean = devs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(devs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const onTime = notes.filter(x => x.cls === 'on').length;
  const onTimePct = Math.round((onTime / n) * 100);

  // ---- gap mode: did tempo drift while the click was silent? ----
  let gap = null;
  const silent = notes.filter(x => !x.audible);
  if (gapCycle > 0 && silent.length >= 3) {
    const silentMean = silent.reduce((a, b) => a + b.dev, 0) / silent.length;
    // Slope of deviation over time within each silent stretch.
    const groups = {};
    silent.forEach(x => { const g = Math.floor(x.bar / gapCycle); (groups[g] = groups[g] || []).push(x); });
    let wSum = 0, slopeSum = 0;
    Object.values(groups).forEach(g => {
      if (g.length < 3) return;
      const s = slope(g.map(x => x.t), g.map(x => x.dev));
      slopeSum += s * g.length; wSum += g.length;
    });
    const sl = wSum ? slopeSum / wSum : 0;            // seconds of drift per second
    const estBpm = Math.round(bpm / (1 + sl));        // getting later = you slowed down
    const drift = Math.abs(estBpm - bpm) / bpm;
    gap = {
      notes: silent.length,
      meanMs: Math.round(silentMean * 1000),
      estBpm,
      verdict: drift < 0.03 && Math.abs(silentMean) < tol ? 'steady' : (estBpm > bpm || silentMean < 0 ? 'rushed' : 'dragged'),
    };
  }

  return {
    n, notes, onTimePct,
    meanMs: Math.round(mean * 1000),
    sdMs: Math.round(sd * 1000),
    pass: onTimePct >= passPct,
    gap,
    // FUTURE "touch evenness" meter: notes[i].db holds each note's loudness.
  };
}

/**
 * Latency calibration: you play one key along with a click for ~10 s.
 * The typical (median) offset between your notes and the beats is the
 * device's round-trip delay (speaker/earphone out + mic in).
 * Returns {latencyMs, spreadMs, count} or null if too few notes.
 */
export function computeLatency(onsets, grid) {
  const beats = grid.filter(t => t.sub === 0).slice(2);   // skip first 2 beats (getting started)
  if (!beats.length) return null;
  const devs = [];
  for (const o of onsets) {
    if (o.time < beats[0].time - 0.3) continue;
    let best = Infinity;
    for (const b of beats) { const d = o.time - b.time; if (Math.abs(d) < Math.abs(best)) best = d; }
    if (best > -0.15 && best < 0.4) devs.push(best);
  }
  if (devs.length < 6) return null;
  const med = median(devs);
  const spread = median(devs.map(d => Math.abs(d - med)));
  return { latencyMs: Math.round(med * 1000), spreadMs: Math.round(spread * 1000), count: devs.length };
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function slope(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : 0;
}
