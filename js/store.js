/* =====================================================================
 * store.js — all saved data lives here, in localStorage, as ONE JSON
 * object under the key below. Export/Import moves that object between
 * devices as a .json file.
 *
 * DATA SHAPE (version 1)
 * state = {
 *   version: 1,
 *   settings: {...see DEFAULT_SETTINGS},
 *   pieces: [{
 *     id, kind: 'piece' | 'routine', title, targetBpm, timeSig: '4/4',
 *     sections: [{
 *       id, name, barStart, barEnd,
 *       startBpm, currentBpm, targetBpm,
 *       gridDiv,              // smallest note value played: 1=quarter 2=8ths 3=triplets 4=16ths
 *       streak, failStreak,   // clean-in-a-row / not-clean-in-a-row at currentBpm
 *       mastered, doneDate,   // doneDate = 'YYYY-MM-DD' when "done for today"
 *       dayDate, dayStartBpm, // tempo when today's practice began (for the daily goal)
 *       lastPracticed,        // ISO timestamp
 *       reps, cleanReps,      // lifetime counters
 *     }]
 *   }],
 *   log: { 'YYYY-MM-DD': { seconds, items: { [sectionId]: {label, reps, clean, fromBpm, toBpm} } } },
 *   activeSession: null | { date, minutes, blocks:[...], index, startedAt, blockStartedAt, blockExtraMs }
 * }
 *
 * Device-specific things (mic latency calibration) are stored separately
 * under DEVICE_KEY and are NOT exported, because each phone/Mac differs.
 * Spot-check recordings live in IndexedDB (see recorder.js).
 * ===================================================================== */

const KEY = 'pianoCoach.v1';
const DEVICE_KEY = 'pianoCoach.device';

export const DEFAULT_SETTINGS = {
  // clean-rep rules
  tempoStep: 4,          // BPM added after the clean streak
  cleanTarget: 3,        // clean reps in a row needed
  failLimit: 5,          // not-clean in a row before suggesting a slower tempo
  dropPercent: 10,       // suggested tempo drop
  dailySteps: 2,         // daily goal = today's starting tempo + this many steps
  countInBars: 1,
  // session planner
  sessionMinutes: 60,
  blockMinutes: 8,
  warmupPercent: 15,
  // metronome
  sound: 'click',
  subdivision: 1,
  accent: true,
  volume: 0.8,
  gapEnabled: false,
  gapPlay: 2,
  gapMute: 2,
  metroBpm: 80,
  metroTimeSig: '4/4',
  // mic timing
  micCheck: false,
  sensitivity: 5,        // 1..10
  tolMs: 40,             // ± timing tolerance per note
  passPct: 80,           // % of notes that must be within tolerance
  // spot-check recording
  spotCheck: false,
  spotEvery: 5,
  keepRecordings: 5,
  // misc
  wakeLock: true,
  motion: 'lively',      // lively | calm | off (see fx.js)
};

export function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}

/** Local date as 'YYYY-MM-DD' (not UTC — practice days follow your clock). */
export function dayStr(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function emptyState() {
  return { version: 1, settings: { ...DEFAULT_SETTINGS }, pieces: [], log: {}, activeSession: null };
}

/** Fill in any missing fields (so older saved data keeps working after updates). */
function normalize(s) {
  const st = { ...emptyState(), ...s };
  st.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
  st.pieces = (st.pieces || []).map(p => ({
    kind: 'piece', timeSig: '4/4', targetBpm: 100, sections: [], ...p,
    sections: (p.sections || []).map(normalizeSection),
  }));
  st.log = st.log || {};
  return st;
}

export function normalizeSection(sec) {
  return {
    name: 'Section', barStart: 1, barEnd: 8, startBpm: 60, currentBpm: 60, targetBpm: 100,
    gridDiv: 2, streak: 0, failStreak: 0, mastered: false, doneDate: null,
    dayDate: null, dayStartBpm: null, lastPracticed: null, reps: 0, cleanReps: 0,
    ...sec,
  };
}

export let state = load();

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? normalize(JSON.parse(raw)) : emptyState();
  } catch (e) {
    console.error('load failed', e);
    return emptyState();
  }
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { console.error('save failed', e); alert('Could not save data on this device (storage full?). Export a backup.'); }
}

/** Replace everything with imported data. */
export function replaceState(newState) {
  state = normalize(newState);
  save();
}

export function validateImport(obj) {
  return obj && typeof obj === 'object' && obj.version === 1 && Array.isArray(obj.pieces);
}

/** Ask the browser not to auto-delete our data (helps on iPhone). */
export async function requestPersistence() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
}

/* ---------- lookups ---------- */

export function findSection(sectionId) {
  for (const p of state.pieces) {
    const s = p.sections.find(x => x.id === sectionId);
    if (s) return { piece: p, section: s };
  }
  return null;
}

export function sectionLabel(piece, section) {
  if (piece.kind === 'routine') return piece.title;
  return `${piece.title} · ${section.name}`;
}

/* ---------- device settings (not exported) ---------- */

export function getDevice() {
  try { return JSON.parse(localStorage.getItem(DEVICE_KEY)) || {}; } catch (e) { return {}; }
}
export function setDevice(patch) {
  const d = { ...getDevice(), ...patch };
  localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
  return d;
}
