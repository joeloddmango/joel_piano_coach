/* =====================================================================
 * coach.js — the clean-rep RULES (no UI code here).
 *
 *  • N clean in a row at current tempo (default 3) → tempo goes up a step.
 *  • N clean in a row AT the target tempo        → section "mastered".
 *  • N clean in a row at/above today's goal       → "done for today".
 *    Today's goal = tempo you started today at + dailySteps × tempoStep,
 *    capped at the target tempo.
 *  • failLimit not-clean in a row (default 5)     → suggest ~10% slower.
 *
 * Also records each rep in the practice log.
 * ===================================================================== */

import { state, dayStr, sectionLabel } from './store.js';

/** Make sure the section's per-day fields are for today (call before using it). */
export function ensureToday(section) {
  const today = dayStr();
  if (section.dayDate !== today) {
    section.dayDate = today;
    section.dayStartBpm = section.currentBpm;
  }
}

export function dailyGoal(section) {
  ensureToday(section);
  const s = state.settings;
  return Math.min(section.targetBpm, section.dayStartBpm + s.dailySteps * s.tempoStep);
}

export function isDoneToday(section) {
  return section.mastered || section.doneDate === dayStr();
}

/** 0 = at start tempo, 1 = at target tempo. */
export function progress(section) {
  const span = section.targetBpm - section.startBpm;
  if (span <= 0) return section.mastered ? 1 : 0;
  return Math.max(0, Math.min(1, (section.currentBpm - section.startBpm) / span));
}

/**
 * Record one rep. `clean` must already include the mic timing verdict.
 * Returns an event describing what happened, for the UI to announce:
 *   {type:'raised', from, to} | {type:'mastered'} | {type:'doneToday', to}
 *   | {type:'suggestDrop', to} | {type:'streak'} | {type:'miss'}
 */
export function recordRep(piece, section, clean) {
  const s = state.settings;
  ensureToday(section);
  const before = section.currentBpm;
  section.reps++;
  section.lastPracticed = new Date().toISOString();
  let ev;

  if (clean) {
    section.cleanReps++;
    section.failStreak = 0;
    section.streak++;
    if (section.streak >= s.cleanTarget) {
      section.streak = 0;
      const goal = dailyGoal(section);
      if (before >= section.targetBpm) {
        section.mastered = true;
        ev = { type: 'mastered' };
      } else {
        section.currentBpm = Math.min(section.targetBpm, before + s.tempoStep);
        if (before >= goal) {
          section.doneDate = dayStr();
          ev = { type: 'doneToday', from: before, to: section.currentBpm };
        } else {
          ev = { type: 'raised', from: before, to: section.currentBpm };
        }
      }
    } else {
      ev = { type: 'streak' };
    }
  } else {
    section.streak = 0;
    section.failStreak++;
    ev = { type: 'miss' };
    if (section.failStreak >= s.failLimit) {
      ev = { type: 'suggestDrop', to: Math.max(20, Math.round(before * (1 - s.dropPercent / 100))) };
    }
  }

  logRep(piece, section, clean, before, section.currentBpm);
  return ev;
}

/** Apply a tempo change chosen by the user (drop suggestion or manual +/-). */
export function setTempo(section, bpm) {
  section.currentBpm = Math.max(20, Math.min(300, Math.round(bpm)));
  section.streak = 0;
  section.failStreak = 0;
  if (section.currentBpm < section.targetBpm) section.mastered = false;
}

/* ---------------- practice log ---------------- */

function todayLog() {
  const d = dayStr();
  if (!state.log[d]) state.log[d] = { seconds: 0, items: {} };
  return state.log[d];
}

function logRep(piece, section, clean, fromBpm, toBpm) {
  const l = todayLog();
  const it = l.items[section.id] || (l.items[section.id] = {
    label: sectionLabel(piece, section), reps: 0, clean: 0, fromBpm, toBpm,
  });
  it.reps++;
  if (clean) it.clean++;
  it.toBpm = toBpm;
}

export function addPracticeSeconds(sec) {
  todayLog().seconds += sec;
}

/** Consecutive practiced days, ending today (or yesterday if not yet practiced today). */
export function currentStreak() {
  const practiced = d => { const l = state.log[dayStr(d)]; return l && (l.seconds >= 60 || Object.keys(l.items).length); };
  const d = new Date();
  if (!practiced(d)) d.setDate(d.getDate() - 1);
  let n = 0;
  while (practiced(d)) { n++; d.setDate(d.getDate() - 1); }
  return n;
}
