/* =====================================================================
 * recorder.js — spot-check recordings.
 *
 * Every rep is recorded while the mic is on, but only kept if the rep
 * was marked Clean AND it wins a 1-in-N draw. Kept recordings are stored
 * in IndexedDB (localStorage can't hold audio). Only the newest few are
 * kept. Recordings are NOT included in JSON export (too large).
 * ===================================================================== */

import { mic } from './mic.js';

const DB_NAME = 'pianoCoachMedia';
const STORE = 'recordings';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

let rec = null;
let chunks = [];

export function recordingSupported() {
  return typeof MediaRecorder !== 'undefined';
}

/** Start recording the current rep (mic must be running). */
export function startRepRecording() {
  if (!recordingSupported() || !mic.stream) return;
  chunks = [];
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(t => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  try {
    rec = new MediaRecorder(mic.stream, type ? { mimeType: type } : undefined);
    rec.ondataavailable = e => e.data && e.data.size && chunks.push(e.data);
    rec.start();
  } catch (e) { console.warn('MediaRecorder failed', e); rec = null; }
}

/** Stop recording. If keep, save it with meta {label, bpm}. Resolves true if saved. */
export function stopRepRecording(keep, meta, maxKeep = 5) {
  return new Promise(resolve => {
    if (!rec) return resolve(false);
    const r = rec; rec = null;
    r.onstop = async () => {
      if (!keep || !chunks.length) return resolve(false);
      const blob = new Blob(chunks, { type: r.mimeType || 'audio/mp4' });
      try {
        await tx('readwrite', s => s.put({ id: Date.now(), date: new Date().toISOString(), blob, ...meta }));
        await prune(maxKeep);
        resolve(true);
      } catch (e) { console.error(e); resolve(false); }
    };
    try { r.stop(); } catch (e) { resolve(false); }
  });
}

export function listRecordings() {
  return tx('readonly', s => s.getAll()).then(a => (a || []).sort((x, y) => y.id - x.id));
}

export function deleteRecording(id) {
  return tx('readwrite', s => s.delete(id));
}

async function prune(maxKeep) {
  const all = await listRecordings();
  for (const r of all.slice(maxKeep)) await deleteRecording(r.id);
}
