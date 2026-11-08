/* =====================================================================
 * mic.js — microphone input + onset detection (via onset-worklet.js).
 *
 * The mic is opened with echoCancellation / noiseSuppression /
 * autoGainControl all OFF. Those "phone call" filters smear and delay
 * note attacks, which would wreck timing measurements.
 *
 * Usage:
 *   await mic.start()              // asks permission the first time
 *   mic.onsets                     // [{time, db}] in AudioContext seconds
 *   mic.onsetsBetween(t0, t1)
 *   mic.onLevel(cb), mic.onOnset(cb)
 *   mic.stream                     // for MediaRecorder (recorder.js)
 *   mic.stop()
 * ===================================================================== */

import { getCtx, setAudioSessionType } from './audio.js';

class Mic {
  constructor() {
    this.stream = null;
    this.node = null;
    this.source = null;
    this.onsets = [];
    this._levelCbs = new Set();
    this._onsetCbs = new Set();
    this._moduleLoaded = false;
    this.sensitivity = 5;
  }

  get active() { return !!this.stream; }

  async start() {
    if (this.stream) return;
    const ctx = getCtx();
    setAudioSessionType('play-and-record');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser can’t use the microphone here. The page must be opened over https://');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    if (!this._moduleLoaded) {
      await ctx.audioWorklet.addModule('js/onset-worklet.js');
      this._moduleLoaded = true;
    }
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'onset-detector', { numberOfOutputs: 1 });
    // Worklet must be connected to the output to keep running; a 0-gain node keeps it silent.
    const mute = ctx.createGain(); mute.gain.value = 0;
    this.source.connect(this.node);
    this.node.connect(mute); mute.connect(ctx.destination);
    this._mute = mute;
    this.setSensitivity(this.sensitivity);
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'onset') {
        this.onsets.push(m);
        if (this.onsets.length > 4000) this.onsets.splice(0, 1000);
        this._onsetCbs.forEach(cb => cb(m));
      } else if (m.type === 'level') {
        this._levelCbs.forEach(cb => cb(m.db));
      }
    };
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    try { this.source && this.source.disconnect(); this.node && this.node.disconnect(); this._mute && this._mute.disconnect(); } catch (e) {}
    this.stream = null; this.node = null; this.source = null;
    setAudioSessionType('playback');
  }

  setSensitivity(v) {
    this.sensitivity = v;
    if (this.node) this.node.port.postMessage({ type: 'sensitivity', value: v });
  }

  onsetsBetween(t0, t1) { return this.onsets.filter(o => o.time >= t0 && o.time <= t1); }
  onLevel(cb) { this._levelCbs.add(cb); return () => this._levelCbs.delete(cb); }
  onOnset(cb) { this._onsetCbs.add(cb); return () => this._onsetCbs.delete(cb); }
}

export const mic = new Mic();
