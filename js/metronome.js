/* =====================================================================
 * metronome.js — sample-accurate metronome using the Web Audio
 * "lookahead scheduler" pattern (Chris Wilson, "A Tale of Two Clocks").
 *
 * A cheap JS timer (setInterval 25 ms) wakes up and schedules every tick
 * that falls in the next 120 ms directly on the AudioContext clock. The
 * JS timer can be sloppy; the SOUND is never sloppy, because the audio
 * hardware plays each tick at its exact scheduled time.
 *
 * Every scheduled tick is also stored in `this.grid` so the timing
 * analyser (timing.js) knows exactly when each beat happened, including
 * silent beats in gap mode.
 * ===================================================================== */

import { getCtx } from './audio.js';

const LOOKAHEAD_S = 0.12;   // how far ahead we schedule audio
const TIMER_MS = 25;        // how often the scheduler wakes up
const VOICE_WORDS = ['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];

export const SOUNDS = [
  { id: 'click', label: 'Click' },
  { id: 'woodblock', label: 'Woodblock' },
  { id: 'hihat', label: 'Hi-hat' },
  { id: 'voice', label: 'Voice count' },
];

export const SUBDIVISIONS = [
  { id: 1, label: 'None' },
  { id: 2, label: '8ths' },
  { id: 3, label: 'Triplets' },
  { id: 4, label: '16ths' },
];

export class Metronome {
  constructor() {
    this.bpm = 80;
    this.beatsPerBar = 4;
    this.subdivision = 1;        // clicks per beat
    this.sound = 'click';
    this.accent = true;          // accent beat 1
    this.volume = 0.8;
    this.gap = { enabled: false, playBars: 2, muteBars: 2 };
    this.countInBars = 0;        // bars of click before "bar 1" (always audible)

    this.running = false;
    this.grid = [];              // [{time, beat, sub, bar, audible, countIn}]
    this.startTime = 0;          // audio time of first tick
    this.musicStartTime = 0;     // audio time of bar 1 beat 1 (after count-in)

    this._timer = null;
    this._tick = 0;
    this._nextTime = 0;
    this._visualQueue = [];
    this._visualListeners = new Set();
    this._raf = null;
    this._noise = null;
    this._voice = {};            // decoded voice samples by number 1..12
    this._voiceLoading = null;
    this._taps = [];
  }

  /* ---------------- public API ---------------- */

  /** Start clicking. Must be called from a user tap on iPhone (after unlockAudio). */
  start({ countInBars = this.countInBars } = {}) {
    const ctx = getCtx();
    if (this.running) this.stop();
    if (this.sound === 'voice') this.loadVoice();
    this.countInBars = countInBars;
    this.running = true;
    this.grid = [];
    this._tick = 0;
    this._nextTime = ctx.currentTime + 0.1;     // small safety gap
    this.startTime = this._nextTime;
    this.musicStartTime = this.startTime + countInBars * this.beatsPerBar * (60 / this.bpm);
    this._scheduler();
    this._timer = setInterval(() => this._scheduler(), TIMER_MS);
    this._startVisualLoop();
  }

  stop() {
    this.running = false;
    clearInterval(this._timer); this._timer = null;
    this._visualQueue = [];
    cancelAnimationFrame(this._raf); this._raf = null;
  }

  setBpm(bpm) { this.bpm = clamp(Math.round(bpm), 20, 300); }

  /** Tap tempo: call on each tap. Returns the new BPM (or null if not enough taps yet). */
  tap() {
    const now = performance.now();
    if (this._taps.length && now - this._taps[this._taps.length - 1] > 2000) this._taps = [];
    this._taps.push(now);
    if (this._taps.length > 5) this._taps.shift();
    if (this._taps.length < 2) return null;
    const intervals = [];
    for (let i = 1; i < this._taps.length; i++) intervals.push(this._taps[i] - this._taps[i - 1]);
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    this.setBpm(60000 / avg);
    return this.bpm;
  }

  /** Subscribe to visual beats. cb({beat, sub, bar, audible, countIn}). Returns unsubscribe fn. */
  onVisual(cb) { this._visualListeners.add(cb); return () => this._visualListeners.delete(cb); }

  /** Seconds per click (one subdivision). */
  get tickSeconds() { return 60 / this.bpm / this.subdivision; }

  /** Pre-load the spoken count samples (small WAVs in /sounds). */
  loadVoice() {
    if (this._voiceLoading) return this._voiceLoading;
    const ctx = getCtx();
    this._voiceLoading = Promise.all(VOICE_WORDS.map(async (w, i) => {
      try {
        const res = await fetch(`sounds/${w}.wav`);
        const buf = await ctx.decodeAudioData(await res.arrayBuffer());
        this._voice[i + 1] = trimLeadingSilence(ctx, buf);
      } catch (e) { console.warn('voice sample failed', w, e); }
    }));
    return this._voiceLoading;
  }

  /* ---------------- scheduler internals ---------------- */

  _scheduler() {
    const ctx = getCtx();
    while (this._nextTime < ctx.currentTime + LOOKAHEAD_S) {
      this._scheduleTick(this._tick, this._nextTime);
      this._nextTime += this.tickSeconds;   // read each time, so BPM changes apply live
      this._tick++;
    }
  }

  _scheduleTick(tick, time) {
    const perBar = this.beatsPerBar * this.subdivision;
    const sub = tick % this.subdivision;
    const beat = Math.floor(tick / this.subdivision) % this.beatsPerBar;
    const rawBar = Math.floor(tick / perBar);
    const countIn = rawBar < this.countInBars;
    const bar = rawBar - this.countInBars;         // bar 0 = first real bar
    let audible = true;
    if (!countIn && this.gap.enabled) {
      const cycle = this.gap.playBars + this.gap.muteBars;
      audible = (bar % cycle) < this.gap.playBars;
    }
    const info = { time, beat, sub, bar, audible, countIn };
    this.grid.push(info);
    if (this.grid.length > 5000) this.grid.splice(0, 1000);
    if (audible) this._playSound(time, beat === 0 && sub === 0 && this.accent ? 'accent' : sub === 0 ? 'beat' : 'sub', beat);
    this._visualQueue.push(info);
  }

  /** Synthesize one tick. level: 'accent' | 'beat' | 'sub'. */
  _playSound(time, level, beat) {
    const ctx = getCtx();
    const vol = this.volume * (level === 'accent' ? 1 : level === 'beat' ? 0.7 : 0.38);
    const out = ctx.createGain();
    out.gain.value = vol;
    out.connect(ctx.destination);

    switch (this.sound) {
      case 'woodblock': {
        const f = level === 'accent' ? 1250 : level === 'beat' ? 950 : 800;
        this._tone(time, f, 'sine', 0.07, out);
        this._tone(time, f * 2.6, 'sine', 0.02, out, 0.3);
        break;
      }
      case 'hihat': {
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer();
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
        const g = ctx.createGain();
        const len = level === 'accent' ? 0.12 : 0.05;
        g.gain.setValueAtTime(0, time);
        g.gain.linearRampToValueAtTime(1, time + 0.001);
        g.gain.exponentialRampToValueAtTime(0.001, time + len);
        src.connect(hp); hp.connect(g); g.connect(out);
        src.start(time); src.stop(time + len + 0.02);
        if (level === 'accent') this._tone(time, 180, 'sine', 0.06, out, 0.6); // soft "kick" marks beat 1
        break;
      }
      case 'voice': {
        const sample = level !== 'sub' ? this._voice[beat + 1] : null;
        if (sample) {
          const src = ctx.createBufferSource();
          src.buffer = sample; src.connect(out); src.start(time);
        } else {
          // subdivisions (or samples not loaded yet) use a soft click
          this._tone(time, level === 'sub' ? 1100 : 1500, 'sine', 0.03, out);
        }
        break;
      }
      default: { // 'click'
        const f = level === 'accent' ? 1760 : level === 'beat' ? 1320 : 990;
        this._tone(time, f, 'square', 0.035, out, 0.35);
      }
    }
  }

  _tone(time, freq, type, len, dest, gainMul = 1) {
    const ctx = getCtx();
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(gainMul, time + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, time + len);
    o.connect(g); g.connect(dest);
    o.start(time); o.stop(time + len + 0.02);
  }

  _noiseBuffer() {
    if (this._noise) return this._noise;
    const ctx = getCtx();
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.2), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return (this._noise = b);
  }

  /* Visual pulse: fires listeners when each tick's time arrives. */
  _startVisualLoop() {
    const ctx = getCtx();
    const loop = () => {
      if (!this.running) return;
      const now = ctx.currentTime;
      while (this._visualQueue.length && this._visualQueue[0].time <= now) {
        const info = this._visualQueue.shift();
        this._visualListeners.forEach(cb => { try { cb(info); } catch (e) { console.error(e); } });
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
}

/* ---------------- helpers ---------------- */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Cut the silence at the start of a voice sample so "one" lands ON the beat. */
function trimLeadingSilence(ctx, buf) {
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  const thr = peak * 0.08;
  let start = 0;
  while (start < d.length && Math.abs(d[start]) < thr) start++;
  start = Math.max(0, start - Math.floor(ctx.sampleRate * 0.003));
  const out = ctx.createBuffer(1, d.length - start, buf.sampleRate);
  out.getChannelData(0).set(d.subarray(start));
  return out;
}

/** Shared single metronome instance used across the app. */
export const metronome = new Metronome();
