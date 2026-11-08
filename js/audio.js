/* =====================================================================
 * audio.js — one shared AudioContext for the whole app.
 *
 * WHY ONE CONTEXT: the metronome schedules clicks on the AudioContext
 * clock, and the mic onset detector timestamps notes on the SAME clock.
 * Using one context means "note time minus beat time" is meaningful
 * without any clock conversion.
 * ===================================================================== */

let ctx = null;

/** Get (or lazily create) the shared AudioContext. */
export function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
  }
  return ctx;
}

/**
 * iPhone Safari only lets audio start inside a user tap. Call this from
 * every "Start" button handler. Also plays a 1-sample silent buffer,
 * which older iOS versions needed to fully unlock audio.
 */
export async function unlockAudio() {
  const c = getCtx();
  if (c.state !== 'running') {
    try { await c.resume(); } catch (e) { console.warn('resume failed', e); }
  }
  try {
    const b = c.createBuffer(1, 1, c.sampleRate);
    const s = c.createBufferSource();
    s.buffer = b; s.connect(c.destination); s.start();
  } catch (e) { /* ignore */ }
  return c;
}

/**
 * iOS 16.4+ exposes navigator.audioSession. Setting type to 'playback'
 * makes Web Audio play even when the ringer/silent switch is ON (otherwise
 * iPhone mutes web audio in silent mode — a classic gotcha).
 * When the mic is in use we need 'play-and-record'.
 */
export function setAudioSessionType(type) {
  try {
    if (navigator.audioSession && navigator.audioSession.type !== type) {
      navigator.audioSession.type = type;
    }
  } catch (e) { /* not supported: fine */ }
}
