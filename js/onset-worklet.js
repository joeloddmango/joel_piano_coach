/* =====================================================================
 * onset-worklet.js — runs on the audio thread (AudioWorklet).
 *
 * Detects NOTE ONSETS (the moment a note starts), not pitches.
 * Method (simple + robust for acoustic piano):
 *   1. Pre-emphasis high-pass (x[n] - 0.97·x[n-1]) — hammer attacks are
 *      rich in high frequencies, sustained notes much less so.
 *   2. Energy in dB over hops of 256 samples (~5.8 ms at 44.1 kHz).
 *   3. Onset when energy jumps by ≥ threshold dB above the quietest of
 *      the previous few hops, AND is well above the background noise
 *      floor, AND at least 70 ms after the previous onset.
 *   4. Refine the time inside the hop to the first sample above 50% of
 *      the hop's peak.
 *
 * Each onset is posted to the main thread as
 *   {type:'onset', time (AudioContext seconds), db (loudness)}
 * `db` is not used for timing — it's saved for a future
 * "touch evenness" meter (loudness of each note).
 * ===================================================================== */

class OnsetDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hop = 256;
    this.buf = new Float32Array(this.hop);
    this.rawBuf = new Float32Array(this.hop);
    this.n = 0;
    this.prevX = 0;
    this.history = [-100, -100, -100, -100];
    this.floor = -70;            // adaptive background noise level (dB)
    this.lastOnsetFrame = -1e9;
    this.minGapFrames = Math.floor(0.07 * sampleRate);
    this.riseDb = 9;             // set from "sensitivity"
    this.gateDb = 14;            // must be this far above noise floor
    this.levelHops = 0;
    this.levelPeak = -100;
    this.port.onmessage = (e) => {
      if (e.data.type === 'sensitivity') {
        // sensitivity 1 (strict) .. 10 (very sensitive)
        const s = Math.max(1, Math.min(10, e.data.value));
        this.riseDb = 15 - s;          // 14 dB .. 5 dB
        this.gateDb = 20 - s;          // 19 dB .. 10 dB
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      this.buf[this.n] = x - 0.97 * this.prevX;
      this.rawBuf[this.n] = x;
      this.prevX = x;
      this.n++;
      if (this.n === this.hop) {
        // frame index of the first sample in this hop
        this.analyze(currentFrame + i - this.hop + 1);
        this.n = 0;
      }
    }
    return true;
  }

  analyze(startFrame) {
    let e = 0, peak = 0, rawE = 0;
    for (let i = 0; i < this.hop; i++) {
      const v = this.buf[i];
      e += v * v;
      rawE += this.rawBuf[i] * this.rawBuf[i];
      const a = Math.abs(v); if (a > peak) peak = a;
    }
    const db = 10 * Math.log10(e / this.hop + 1e-12);
    const rawDb = 10 * Math.log10(rawE / this.hop + 1e-12);
    const ref = Math.min(...this.history);
    const rise = db - ref;

    // ignore the first 0.3 s after the mic opens (the jump from silence looks like a note)
    if (this.firstFrame == null) this.firstFrame = startFrame;
    const warmedUp = startFrame - this.firstFrame > 0.3 * sampleRate;

    if (warmedUp && rise >= this.riseDb && db > this.floor + this.gateDb && db > -75 &&
        startFrame - this.lastOnsetFrame > this.minGapFrames) {
      let k = 0;
      const thr = peak * 0.5;
      while (k < this.hop && Math.abs(this.buf[k]) < thr) k++;
      const frame = startFrame + k;
      this.lastOnsetFrame = frame;
      this.port.postMessage({ type: 'onset', time: frame / sampleRate, db: rawDb });
    }

    // track the noise floor: fall quickly, rise slowly
    if (db < this.floor) this.floor = 0.5 * this.floor + 0.5 * db;
    else this.floor += 0.02;

    this.history.shift(); this.history.push(db);

    // level meter for the UI, ~every 50 ms
    if (rawDb > this.levelPeak) this.levelPeak = rawDb;
    if (++this.levelHops >= 9) {
      this.port.postMessage({ type: 'level', db: this.levelPeak });
      this.levelHops = 0; this.levelPeak = -100;
    }
  }
}

registerProcessor('onset-detector', OnsetDetector);
