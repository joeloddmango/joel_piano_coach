/* =====================================================================
 * app.js — the user interface. Wires together:
 *   store.js (data) · coach.js (rules) · metronome.js · mic.js ·
 *   timing.js · recorder.js · planner.js
 *
 * Rendering is deliberately simple: each screen is a function returning
 * an HTML string, re-drawn after changes. Buttons carry data-act="…"
 * and are handled by ONE click listener (see ACTIONS at the bottom).
 * Settings inputs carry data-setting="key" and save automatically.
 *
 * Screens: today · pieces · piece (detail) · metronome · log · settings
 * Overlay: the coach (#coach) — the full-screen clean-rep focus view.
 * ===================================================================== */

import * as fx from './fx.js';
import { state, save, uid, dayStr, findSection, sectionLabel, replaceState, validateImport,
         requestPersistence, getDevice, setDevice, normalizeSection } from './store.js';
import { recordRep, setTempo, dailyGoal, isDoneToday, progress, addPracticeSeconds, currentStreak, ensureToday } from './coach.js';
import { metronome, SOUNDS, SUBDIVISIONS } from './metronome.js';
import { unlockAudio, getCtx, setAudioSessionType } from './audio.js';
import { mic } from './mic.js';
import { analyzeRep, computeLatency } from './timing.js';
import { startRepRecording, stopRepRecording, listRecordings, deleteRecording, recordingSupported } from './recorder.js';
import { buildSession } from './planner.js';

/* ---------------- small helpers ---------------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const beatsOf = ts => Math.max(1, Math.min(12, parseInt(String(ts).split('/')[0], 10) || 4));
const fmtTime = sec => { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec / 60), s = sec % 60; return `${m}:${String(s).padStart(2, '0')}`; };
const minsHtml = sec => sec < 60 ? `${Math.round(sec)}<small>s</small>` : `<span data-count="${Math.round(sec / 60)}">${Math.round(sec / 60)}</span> <small>min</small>`;
const fmtMin = sec => sec < 60 ? `${Math.round(sec)}s` : `${Math.round(sec / 60)} min`;
const TIME_SIGS = ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '9/8', '12/8'];
const GRIDS = [{ id: 1, label: 'Quarter notes' }, { id: 2, label: '8th notes' }, { id: 3, label: 'Triplets' }, { id: 4, label: '16th notes' }];
const needsMic = () => state.settings.micCheck || state.settings.spotCheck;

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------------- UI state (not saved) ---------------- */
const ui = { tab: 'today', pieceId: null, planDraft: null, planMinutes: null, calMonth: new Date() };
let coach = null;          // runtime state of the open focus view (null when closed)
let coachTimer = null;     // 1-second timer while the coach is open

/* =====================================================================
 * MODALS — showModal returns a Promise with the clicked button's value.
 * showForm builds a form from field specs and resolves with values (or null).
 * ===================================================================== */
function showModal({ title, html = '', buttons = [{ label: 'OK', value: true, cls: 'primary' }], onOpen }) {
  return new Promise(resolve => {
    const root = $('#modal-root');
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      ${title ? `<h3>${esc(title)}</h3>` : ''}<div class="modal-body">${html}</div>
      <div class="btns">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-mi="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    root.appendChild(back);
    const close = v => { back.remove(); resolve(v); };
    back.addEventListener('click', e => {
      const b = e.target.closest('[data-mi]');
      if (b) { e.stopPropagation(); const spec = buttons[+b.dataset.mi]; if (spec.validate && !spec.validate(back)) return; close(spec.value); }
      else if (e.target === back) close(null);
    });
    back.close = close;
    if (onOpen) onOpen(back, close);
  });
}

function confirmModal(title, text, yes = 'Yes', cls = 'primary') {
  return showModal({ title, html: `<p class="muted">${esc(text)}</p>`, buttons: [{ label: 'Cancel', value: false }, { label: yes, value: true, cls }] });
}

/** fields: [{key, label, type:'text'|'number'|'select', value, options:[{id,label}], min, max, hint}] */
async function showForm(title, fields, submit = 'Save') {
  const html = fields.map(f => {
    const id = `f_${f.key}`;
    let input;
    if (f.type === 'select') input = `<select id="${id}">${f.options.map(o => `<option value="${esc(o.id)}" ${String(o.id) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    else input = `<input id="${id}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" ${f.min != null ? `min="${f.min}"` : ''} ${f.max != null ? `max="${f.max}"` : ''} ${f.type === 'number' ? 'inputmode="numeric"' : ''}>`;
    return `<label class="field"><span>${esc(f.label)}</span>${input}${f.hint ? `<div class="small muted" style="margin-top:4px">${esc(f.hint)}</div>` : ''}</label>`;
  }).join('');
  let values = null;
  const ok = await showModal({
    title, html,
    buttons: [{ label: 'Cancel', value: false }, {
      label: submit, value: true, cls: 'primary',
      validate: root => {
        values = {};
        for (const f of fields) {
          const el = root.querySelector(`#f_${f.key}`);
          let v = el.value.trim();
          if (f.type === 'number' || f.num) {
            v = Number(v);
            if (!Number.isFinite(v) || (f.min != null && v < f.min) || (f.max != null && v > f.max)) { toast(`Check “${f.label}”`); el.focus(); return false; }
          } else if (f.required && !v) { toast(`“${f.label}” is needed`); el.focus(); return false; }
          values[f.key] = v;
        }
        return true;
      },
    }],
    onOpen: root => { const first = root.querySelector('input'); if (first && !fields[0].value) setTimeout(() => first.focus(), 50); },
  });
  return ok ? values : null;
}

/* =====================================================================
 * MAIN SCREENS
 * ===================================================================== */
let lastScreen = null;   // play the enter animation only when the screen changes
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
  const v = $('#view');
  const screens = { today: viewToday, pieces: viewPieces, piece: viewPiece, metronome: viewMetronome, log: viewLog, settings: viewSettings };
  v.innerHTML = (screens[ui.tab] || viewToday)() + footerHtml();
  const screenKey = ui.tab + (ui.tab === 'piece' ? ui.pieceId : '');
  if (screenKey !== lastScreen) { fx.enter(v); fx.countUps(v); lastScreen = screenKey; }
  if (ui.tab === 'log') fillRecordings();
  if (ui.tab === 'metronome') syncMetroDots();
}

function footerHtml() {
  return `<footer class="brand"><img src="icons/kora-white.png" alt="" width="22" height="25"><span>Piano Coach · Kora Co</span></footer>`;
}

/* ---------------- Today ---------------- */
function viewToday() {
  const today = state.log[dayStr()];
  const streak = currentStreak();
  const sess = activeSessionForToday();
  const hasWork = state.pieces.some(p => p.sections.length);
  const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  let planHtml;
  if (sess) {
    planHtml = `<div class="card">
      <div class="row"><h3 class="grow">Session in progress</h3><span class="chip">${sess.index + 1} / ${sess.blocks.length}</span></div>
      ${blockListHtml(sess.blocks, sess.index)}
      <div class="row" style="margin-top:12px"><button class="btn primary grow" data-act="resume-session">Resume</button><button class="btn" data-act="end-session">End</button></div></div>`;
  } else if (!hasWork) {
    planHtml = `<div class="card"><h3>Welcome 👋</h3><p class="muted">Start by adding a piece (split into sections by bars) or a routine item like scales or Hanon.</p>
      <button class="btn primary block" data-act="tab" data-tab="pieces">Add your first piece</button></div>`;
  } else {
    const mins = ui.planMinutes ?? state.settings.sessionMinutes;
    planHtml = `<div class="card">
      <h3>Plan today’s session</h3>
      <div class="row" style="margin:12px 0">
        <button class="icon-btn" data-act="plan-min" data-d="-15">−</button>
        <div class="grow" style="text-align:center"><span style="font-size:34px;font-weight:600">${mins}</span> <span class="muted">min</span></div>
        <button class="icon-btn" data-act="plan-min" data-d="15">+</button>
      </div>
      ${ui.planDraft ? (ui.planDraft.length ? blockListHtml(ui.planDraft, -1) : '<p class="muted">Nothing left to plan — everything is mastered or done for today. 🎉</p>') : ''}
      ${ui.planDraft && ui.planDraft.length
        ? `<div class="row" style="margin-top:12px"><button class="btn primary grow" data-act="start-session">Start session</button><button class="btn" data-act="build-plan">Rebuild</button></div>`
        : `<button class="btn primary block" data-act="build-plan">Build session</button>`}
    </div>`;
  }

  return `<h1>Today</h1>
    <p class="muted" style="margin-top:-10px">${esc(date)}</p>
    <div class="row" style="margin:16px 0">
      <div class="card grow" style="margin:0"><div class="cap">Streak</div><div class="stat"><span data-count="${streak}">${streak}</span> <small>day${streak === 1 ? '' : 's'}</small></div></div>
      <div class="card grow" style="margin:0"><div class="cap">Practiced today</div><div class="stat">${minsHtml(today ? today.seconds : 0)}</div></div>
    </div>
    ${planHtml}
    ${quickListHtml()}`;
}

function blockListHtml(blocks, current) {
  return `<div class="stack" style="margin-top:8px">${blocks.map((b, i) => {
    const f = findSection(b.sectionId);
    const done = b.done || (f && isDoneToday(f.section));
    return `<div class="row small"><span style="width:20px">${b.done ? '✓' : i === current ? '▶' : '·'}</span>
      <span class="grow ${b.done ? 'muted' : ''}">${esc(b.label)}${b.kind === 'warmup' ? ' <span class="chip">warm-up</span>' : ''}${done && !b.done ? ' <span class="chip good">done today</span>' : ''}</span>
      <span class="muted">${b.minutes} min</span></div>`;
  }).join('')}</div>`;
}

function quickListHtml() {
  const items = state.pieces.flatMap(p => p.sections.map(s => ({ p, s }))).filter(x => !x.s.mastered);
  if (!items.length) return '';
  return `<h2>Quick practice</h2>${items.slice(0, 8).map(({ p, s }) => `
    <div class="card row">
      <div class="grow"><div style="font-weight:600">${esc(sectionLabel(p, s))}</div>
      <div class="muted small">${s.currentBpm} → ${s.targetBpm} BPM ${isDoneToday(s) ? '· <span style="color:var(--accent)">done today ✓</span>' : ''}</div></div>
      <button class="btn sm primary" data-act="practice" data-sec="${s.id}">Practice</button>
    </div>`).join('')}`;
}

/* ---------------- Pieces list ---------------- */
function viewPieces() {
  const pieces = state.pieces.filter(p => p.kind !== 'routine');
  const routines = state.pieces.filter(p => p.kind === 'routine');
  return `<h1>Pieces</h1>
    ${pieces.map(p => {
      const m = p.sections.filter(s => s.mastered).length;
      const avg = p.sections.length ? p.sections.reduce((a, s) => a + progress(s), 0) / p.sections.length : 0;
      return `<div class="card tap" data-act="open-piece" data-id="${p.id}">
        <div class="row"><h3 class="grow">${esc(p.title)}</h3><span class="muted">›</span></div>
        <div class="muted small">${p.sections.length} section${p.sections.length === 1 ? '' : 's'} · ${m} mastered · target ${p.targetBpm} BPM · ${esc(p.timeSig)}</div>
        <div class="bar"><i style="width:${Math.round(avg * 100)}%"></i></div></div>`;
    }).join('') || '<p class="muted">No pieces yet.</p>'}
    <button class="btn primary block" data-act="add-piece">+ Add piece</button>

    <h2>Routine (scales, Hanon, Czerny…)</h2>
    ${routines.map(p => { const s = p.sections[0]; return `<div class="card">
      <div class="row"><div class="grow"><h3>${esc(p.title)}</h3>
        <div class="muted small">${s.currentBpm} → ${s.targetBpm} BPM · ${esc(p.timeSig)} ${s.mastered ? '· <span style="color:var(--accent)">mastered</span>' : ''}</div></div>
        <button class="btn sm" data-act="edit-routine" data-id="${p.id}">Edit</button>
        <button class="btn sm primary" data-act="practice" data-sec="${s.id}">Practice</button></div>
      <div class="bar"><i style="width:${Math.round(progress(s) * 100)}%"></i></div></div>`; }).join('') || '<p class="muted">No routine items yet.</p>'}
    <button class="btn block" data-act="add-routine">+ Add routine item</button>`;
}

/* ---------------- Piece detail ---------------- */
function viewPiece() {
  const p = state.pieces.find(x => x.id === ui.pieceId);
  if (!p) { ui.tab = 'pieces'; return viewPieces(); }
  const s = state.settings;
  return `<div class="row"><button class="btn ghost sm" data-act="tab" data-tab="pieces">‹ Pieces</button><span class="grow"></span>
      <button class="btn sm" data-act="edit-piece" data-id="${p.id}">Edit</button></div>
    <h1>${esc(p.title)}</h1>
    <p class="muted" style="margin-top:-10px">Target ${p.targetBpm} BPM · ${esc(p.timeSig)}</p>
    <h2>Sections</h2>
    ${p.sections.map(sec => {
      ensureToday(sec);
      const chip = sec.mastered ? '<span class="chip good">mastered</span>'
        : isDoneToday(sec) ? '<span class="chip good">done today</span>'
        : `<span class="chip">${'●'.repeat(sec.streak)}${'○'.repeat(Math.max(0, s.cleanTarget - sec.streak))}</span>`;
      return `<div class="card">
        <div class="row"><div class="grow tap" data-act="edit-section" data-sec="${sec.id}">
          <h3>${esc(sec.name)} <span class="muted small">✎</span></h3>
          <div class="muted small">Bars ${sec.barStart}–${sec.barEnd} · ${sec.currentBpm} → ${sec.targetBpm} BPM · today’s goal ${dailyGoal(sec)}</div></div>
          ${chip}</div>
        <div class="bar"><i style="width:${Math.round(progress(sec) * 100)}%"></i></div>
        <button class="btn primary block" style="margin-top:12px" data-act="practice" data-sec="${sec.id}">Practice</button>
      </div>`;
    }).join('') || '<p class="muted">No sections yet. Split the piece by bar ranges.</p>'}
    <div class="row"><button class="btn primary grow" data-act="add-section" data-id="${p.id}">+ Add section</button>
      <button class="btn grow" data-act="split-piece" data-id="${p.id}">Auto-split…</button></div>
    <button class="btn danger block ghost" style="margin-top:24px" data-act="delete-piece" data-id="${p.id}">Delete piece</button>`;
}

/* ---------------- Metronome ---------------- */
function viewMetronome() {
  const s = state.settings;
  return `<h1>Metronome</h1>
    <div class="bpm-big"><span id="m-bpm">${s.metroBpm}</span> <small>BPM</small></div>
    <div class="beat-dots" id="m-dots">${'<i></i>'.repeat(beatsOf(s.metroTimeSig))}</div>
    <input type="range" min="20" max="240" value="${s.metroBpm}" id="m-slider" aria-label="Tempo">
    <div class="bpm-buttons" style="margin:10px 0">
      <button class="btn" data-act="m-bpm" data-d="-5">−5</button><button class="btn" data-act="m-bpm" data-d="-1">−1</button>
      <button class="btn" data-act="m-bpm" data-d="1">+1</button><button class="btn" data-act="m-bpm" data-d="5">+5</button>
    </div>
    <div class="row"><button class="btn primary grow start-rep" data-act="m-toggle" id="m-toggle">${metronome.running && !coach ? 'Stop' : 'Start'}</button>
      <button class="btn start-rep" style="width:110px" data-act="m-tap">Tap</button></div>
    <div class="card" style="margin-top:16px">
      <div class="setting"><span class="lbl">Time signature</span>
        <select data-setting="metroTimeSig">${TIME_SIGS.map(t => `<option ${t === s.metroTimeSig ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      ${clickSettingsHtml()}
    </div>
    <p class="muted small">Use <b>wired</b> earphones. Bluetooth makes the click late.</p>`;
}

/** Sound / subdivision / accent / gap / volume — shared by Metronome screen and the coach’s “Click” sheet. */
function clickSettingsHtml() {
  const s = state.settings;
  return `
    <div class="setting"><span class="lbl">Sound</span><select data-setting="sound">${SOUNDS.map(o => `<option value="${o.id}" ${o.id === s.sound ? 'selected' : ''}>${o.label}</option>`).join('')}</select></div>
    <div class="setting"><span class="lbl">Subdivision</span><select data-setting="subdivision" data-num>${SUBDIVISIONS.map(o => `<option value="${o.id}" ${o.id === s.subdivision ? 'selected' : ''}>${o.label}</option>`).join('')}</select></div>
    ${toggleRow('accent', 'Accent beat 1')}
    ${toggleRow('gapEnabled', 'Gap mode (click drops out)')}
    <div class="setting" ${s.gapEnabled ? '' : 'hidden'} data-gap-row><span class="lbl">Click plays (bars)</span><input type="number" min="1" max="16" data-setting="gapPlay" value="${s.gapPlay}" inputmode="numeric"></div>
    <div class="setting" ${s.gapEnabled ? '' : 'hidden'} data-gap-row><span class="lbl">Then silent (bars)</span><input type="number" min="1" max="16" data-setting="gapMute" value="${s.gapMute}" inputmode="numeric"></div>
    <div class="setting"><span class="lbl">Volume</span><input type="range" min="0" max="1" step="0.05" data-setting="volume" value="${s.volume}" style="width:150px"></div>`;
}

function toggleRow(key, label, hint = '') {
  return `<div class="setting"><span class="lbl">${esc(label)}${hint ? `<div class="small muted">${esc(hint)}</div>` : ''}</span>
    <label class="switch"><input type="checkbox" data-setting="${key}" ${state.settings[key] ? 'checked' : ''}><span></span></label></div>`;
}

function numberRow(key, label, min, max, hint = '') {
  return `<div class="setting"><span class="lbl">${esc(label)}${hint ? `<div class="small muted">${esc(hint)}</div>` : ''}</span>
    <input type="number" min="${min}" max="${max}" data-setting="${key}" value="${state.settings[key]}" inputmode="numeric"></div>`;
}

/** Push current settings into the metronome engine. */
function applyClickSettings(bpm, timeSig) {
  const s = state.settings;
  if (bpm != null) metronome.setBpm(bpm);
  if (timeSig != null) metronome.beatsPerBar = beatsOf(timeSig);
  metronome.subdivision = Number(s.subdivision) || 1;
  metronome.sound = s.sound;
  metronome.accent = !!s.accent;
  metronome.volume = Number(s.volume);
  metronome.gap = { enabled: !!s.gapEnabled, playBars: Math.max(1, +s.gapPlay), muteBars: Math.max(1, +s.gapMute) };
  if (s.sound === 'voice') metronome.loadVoice();
}

function syncMetroDots() {
  const dots = $('#m-dots');
  if (dots) dots.innerHTML = '<i></i>'.repeat(beatsOf(state.settings.metroTimeSig));
}

/* Visual pulse for both the Metronome screen and the coach. */
metronome.onVisual(info => {
  if (info.sub !== 0) return;
  const isAccent = info.beat === 0;
  const dots = document.querySelectorAll('#m-dots i');
  dots.forEach((d, i) => { d.classList.toggle('on', i === info.beat); d.classList.toggle('accent', i === info.beat && isAccent); d.classList.toggle('silent', !info.audible); });
  const p = $('#c-pulse');
  if (p) {
    p.classList.add('on'); p.classList.toggle('accent', isAccent); p.classList.toggle('silent', !info.audible);
    clearTimeout(p._t); p._t = setTimeout(() => p.classList.remove('on'), 110);
  }
  const lbl = $('#c-countin');
  if (lbl) lbl.textContent = info.countIn ? `Count-in… ${info.beat + 1}` : info.audible ? '' : 'Click silent — keep the beat';
});

/* ---------------- Log ---------------- */
function viewLog() {
  const days = Object.keys(state.log).filter(d => state.log[d].seconds > 0 || Object.keys(state.log[d].items).length).sort().reverse();
  const m = ui.calMonth;
  const monthName = m.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const first = new Date(m.getFullYear(), m.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;   // Monday first
  const nDays = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
  const todayS = dayStr();
  let cells = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<div class="dow">${d}</div>`).join('');
  cells += '<div></div>'.repeat(lead);
  let monthSec = 0;
  for (let i = 1; i <= nDays; i++) {
    const ds = dayStr(new Date(m.getFullYear(), m.getMonth(), i));
    const l = state.log[ds];
    const practiced = l && (l.seconds >= 60 || Object.keys(l.items).length);
    if (l) monthSec += l.seconds;
    cells += `<div class="d ${practiced ? 'p' : ''} ${ds === todayS ? 'today' : ''}">${i}</div>`;
  }
  const streak = currentStreak();
  return `<h1>Practice log</h1>
    <div class="row" style="margin-bottom:12px">
      <div class="card grow" style="margin:0"><div class="cap">Streak</div><div class="stat"><span data-count="${streak}">${streak}</span> <small>day${streak === 1 ? '' : 's'}</small></div></div>
      <div class="card grow" style="margin:0"><div class="cap">This month</div><div class="stat">${minsHtml(monthSec)}</div></div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:10px"><button class="btn sm ghost" data-act="cal" data-d="-1">‹</button>
        <div class="grow" style="text-align:center;font-weight:600">${esc(monthName)}</div><button class="btn sm ghost" data-act="cal" data-d="1">›</button></div>
      <div class="cal">${cells}</div>
    </div>
    <h2>Recent days</h2>
    ${days.slice(0, 30).map(d => {
      const l = state.log[d];
      const items = Object.values(l.items);
      return `<div class="card"><div class="row"><h3 class="grow">${new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</h3><span class="muted">${fmtMin(l.seconds)}</span></div>
        ${items.map(it => { const gain = it.toBpm - it.fromBpm; return `<div class="row small"><span class="grow">${esc(it.label)}</span>
          <span class="muted">${it.clean}/${it.reps} clean</span>
          <span style="width:70px;text-align:right;color:${gain > 0 ? 'var(--accent)' : gain < 0 ? 'var(--warn)' : 'var(--muted)'}">${gain > 0 ? '+' : ''}${gain} BPM</span></div>`; }).join('') || '<div class="muted small">Time only</div>'}
      </div>`;
    }).join('') || '<p class="muted">No practice logged yet.</p>'}
    <h2>Spot-check recordings</h2>
    <div id="recs"><p class="muted small">Loading…</p></div>`;
}

let recUrls = [];
async function fillRecordings() {
  const box = $('#recs'); if (!box) return;
  recUrls.forEach(u => URL.revokeObjectURL(u)); recUrls = [];
  let recs = [];
  try { recs = await listRecordings(); } catch (e) { box.innerHTML = '<p class="muted small">Recordings unavailable in this browser.</p>'; return; }
  if (!$('#recs')) return;
  box.innerHTML = recs.length ? recs.map(r => {
    const url = URL.createObjectURL(r.blob); recUrls.push(url);
    return `<div class="card"><div class="row"><div class="grow"><div style="font-weight:600">${esc(r.label)}</div>
      <div class="muted small">${new Date(r.date).toLocaleString()} · ${r.bpm} BPM · you said: clean</div></div>
      <button class="btn sm danger" data-act="del-rec" data-id="${r.id}">Delete</button></div>
      <audio controls preload="none" src="${url}"></audio></div>`;
  }).join('') : `<p class="muted small">${state.settings.spotCheck ? 'None yet. About 1 in ' + state.settings.spotEvery + ' clean reps gets saved here so you can check your own honesty.' : 'Turn on spot-check recordings in Settings.'}</p>`;
}

/* ---------------- Settings ---------------- */
function viewSettings() {
  const dev = getDevice();
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['{}'], 'x.json', { type: 'application/json' })] }));
  return `<h1>Settings</h1>
    <h2>Clean-rep rules</h2><div class="card">
      ${numberRow('cleanTarget', 'Clean reps in a row to move up', 1, 10)}
      ${numberRow('tempoStep', 'Tempo step (BPM)', 1, 20)}
      ${numberRow('failLimit', 'Misses in a row before suggesting slower', 2, 20)}
      ${numberRow('dropPercent', 'Suggested slow-down (%)', 3, 30)}
      ${numberRow('dailySteps', 'Daily goal (tempo steps per day)', 1, 10, 'Done for today = clean streak at today’s start tempo + this many steps')}
      ${numberRow('countInBars', 'Count-in bars before each rep', 0, 4)}
    </div>
    <h2>Session planner</h2><div class="card">
      ${numberRow('sessionMinutes', 'Default session length (min)', 10, 240)}
      ${numberRow('blockMinutes', 'Minutes per section block', 3, 30)}
      ${numberRow('warmupPercent', 'Warm-up share (%)', 0, 50)}
    </div>
    <h2>Mic timing check</h2><div class="card">
      ${toggleRow('micCheck', 'Listen while I play', 'A rep only counts as Clean if timing passes too')}
      ${numberRow('tolMs', 'Tolerance (± ms per note)', 10, 150)}
      ${numberRow('passPct', 'Notes that must be on time (%)', 50, 100)}
      <div class="setting"><span class="lbl">Note detection sensitivity<div class="small muted">Higher = hears softer notes, but more false notes</div></span>
        <input type="range" min="1" max="10" step="1" data-setting="sensitivity" value="${state.settings.sensitivity}" style="width:130px"></div>
      <div class="setting"><span class="lbl">Latency calibration<div class="small muted">${dev.latencyMs != null ? `This device: ${dev.latencyMs} ms (saved ${new Date(dev.calibratedAt).toLocaleDateString()})` : 'Not calibrated on this device yet'}</div></span>
        <button class="btn sm primary" data-act="calibrate">Calibrate</button></div>
      <p class="small muted" style="margin-top:8px">Use <b>wired</b> earphones for the click so the mic hears only the piano. Bluetooth adds delay and changes from day to day.</p>
    </div>
    <h2>Spot-check recordings</h2><div class="card">
      ${toggleRow('spotCheck', 'Record some clean reps', recordingSupported() ? 'Kept on this device only' : 'Not supported in this browser')}
      ${numberRow('spotEvery', 'Keep about 1 in every … clean reps', 1, 20)}
      ${numberRow('keepRecordings', 'Recordings to keep', 1, 20)}
    </div>
    <h2>Screen</h2><div class="card">${toggleRow('wakeLock', 'Keep screen awake while practicing')}
      <div class="setting"><span class="lbl">Motion<div class="small muted">Calm = no sparkles. Your phone’s Reduce Motion turns it off.</div></span><select data-setting="motion">${[['lively', 'Lively'], ['calm', 'Calm'], ['off', 'Off']].map(([v, l]) => `<option value="${v}" ${state.settings.motion === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <h2>Your data</h2><div class="card stack">
      <p class="small muted">Everything is saved on this device only. Use Export on one device and Import on the other to move your data (recordings and mic calibration stay on each device).</p>
      <button class="btn block" data-act="export">Export backup (.json file)</button>
      ${canShare ? '<button class="btn block" data-act="share-export">Share backup (AirDrop, Files…)</button>' : ''}
      <button class="btn block" data-act="import">Import backup…</button>
      <button class="btn block danger ghost" data-act="reset">Erase all data</button>
    </div>
    <p class="small muted" style="text-align:center;margin-top:20px">Version 2</p>`;
}

/* =====================================================================
 * COACH — full-screen clean-rep focus view
 * ===================================================================== */
async function openCoach(sectionId) {
  const f = findSection(sectionId);
  if (!f) return;
  if (metronome.running) metronome.stop();
  stopRecordingIfAny();
  if (coach && coach.unLevel) { coach.unLevel(); coach.unOnset(); }
  coach = {
    sectionId, pieceId: f.piece.id, repActive: false, repStart: 0, result: null,
    message: '', msgCls: '', banner: null, blockPrompted: false,
    lastTick: Date.now(), unsaved: 0,
  };
  ensureToday(f.section);
  $('#coach').hidden = false;
  document.body.style.overflow = 'hidden';
  if (!coachTimer) {
    coachTimer = setInterval(coachTick, 1000);
    keepAwake(true);
  }
  renderCoach();
}

function closeCoach() {
  if (!coach) return;
  metronome.stop();
  stopRecordingIfAny();
  clearInterval(coachTimer); coachTimer = null;
  if (coach.unLevel) { coach.unLevel(); coach.unOnset(); }
  coach = null;
  mic.stop();
  keepAwake(false);
  save();
  $('#coach').hidden = true;
  $('#coach').innerHTML = '';
  document.body.style.overflow = '';
  render();
}

function renderCoach() {
  if (!coach) return;
  const f = findSection(coach.sectionId);
  if (!f) return closeCoach();
  const { piece, section: sec } = f;
  const s = state.settings;
  const sess = activeSessionForToday();
  const micOn = s.micCheck;
  const goal = dailyGoal(sec);
  const dots = Array.from({ length: s.cleanTarget }, (_, i) => `<i class="${i < sec.streak ? 'on' : ''}"></i>`).join('');
  let status;
  if (sec.mastered) status = 'Mastered ✓ — keep it fresh, or move on.';
  else if (isDoneToday(sec)) status = 'Done for today ✓ — tomorrow starts here.';
  else status = `${s.cleanTarget - sec.streak} more clean at ${sec.currentBpm} to move up`;

  const titleTop = piece.kind === 'routine' ? 'Routine' : piece.title;
  const name = piece.kind === 'routine' ? piece.title : sec.name;
  const bars = piece.kind === 'routine' ? '' : `Bars ${sec.barStart}–${sec.barEnd}`;

  $('#coach').innerHTML = `
    <div class="coach-top">
      <button class="icon-btn" data-act="close-coach" aria-label="Close">✕</button>
      <div class="timers" id="c-timers">${timersHtml()}</div>
      <button class="icon-btn" data-act="click-settings" aria-label="Click settings">♩</button>
    </div>
    <div class="coach-main">
      ${coach.banner ? `<div class="banner"><span class="grow">${esc(coach.banner)}</span>${sess ? '<button class="btn sm primary" data-act="next-block">Next →</button>' : ''}<button class="btn sm" data-act="banner-dismiss">${sess ? '+3 min' : 'OK'}</button></div>` : ''}
      <div class="coach-piece">${esc(titleTop)}</div>
      <div class="coach-section">${esc(name)}</div>
      <div class="muted">${bars}</div>
      <div class="coach-tempo">
        <button class="icon-btn" data-act="c-tempo" data-d="-1" aria-label="Slower">−</button>
        <button class="bpm" data-act="c-tempo-set">${sec.currentBpm}<small> BPM</small></button>
        <button class="icon-btn" data-act="c-tempo" data-d="1" aria-label="Faster">+</button>
      </div>
      <div class="muted small">Target ${sec.targetBpm} · today’s goal ${goal}</div>
      <div class="pulse" id="c-pulse"></div>
      <div class="muted small" id="c-countin" style="min-height:20px"></div>
      <div class="streak" id="c-streak" aria-label="Clean streak ${sec.streak} of ${s.cleanTarget}">${dots}</div>
      <div class="status">${esc(status)}</div>
      <div class="message ${coach.msgCls}" id="c-msg">${esc(coach.message)}</div>
      ${coach.result ? timingHtml(coach.result) : ''}
      ${mic.active && coach.repActive ? '<div class="level" id="c-level"><i></i></div><div class="small muted">mic level</div>' : ''}
      <div class="rule">Clean = no stopping, no wrong notes, steady with the click. <b>If in doubt, it’s not clean.</b></div>
    </div>
    <div class="coach-actions">
      ${coach.repActive
        ? `<button class="btn start-rep" data-act="stop-rep">■ Stop (don’t count)</button>`
        : `<button class="btn start-rep primary" data-act="start-rep">▶ Start rep${s.countInBars ? ` <span class="small">(${s.countInBars} bar count-in)</span>` : ''}</button>`}
      <div class="judge">
        <button class="no" data-act="judge" data-clean="0">Not clean</button>
        <button class="yes" data-act="judge" data-clean="1">Clean</button>
      </div>
      ${sess ? `<button class="btn ghost sm" data-act="next-block">Skip to next block →</button>` : ''}
    </div>`;
  if (mic.active && coach.repActive) attachLevelMeter();
}

function timersHtml() {
  const sess = activeSessionForToday();
  if (!sess) {
    const l = state.log[dayStr()];
    return `Today <b>${fmtTime(l ? l.seconds : 0)}</b>`;
  }
  const b = sess.blocks[sess.index];
  const blockLeft = b.minutes * 60 + (sess.blockExtraMs || 0) / 1000 - (Date.now() - sess.blockStartedAt) / 1000;
  const total = sess.blocks.reduce((a, x) => a + x.minutes, 0) * 60;
  const sessLeft = total - (Date.now() - sess.startedAt) / 1000;
  return `Block ${sess.index + 1}/${sess.blocks.length} <b>${blockLeft >= 0 ? fmtTime(blockLeft) : '+' + fmtTime(-blockLeft)}</b> · Session <b>${fmtTime(sessLeft)}</b>`;
}

function timingHtml(r) {
  if (r.n < 4) return `<div class="timing"><b>Couldn’t hear enough notes.</b><div class="small muted">Rep not counted. Check the mic isn’t covered, or raise sensitivity in Settings.</div></div>`;
  const s = state.settings;
  const tend = Math.abs(r.meanMs) < 8 ? 'centered on the beat' : r.meanMs < 0 ? `rushing ~${-r.meanMs} ms` : `dragging ~${r.meanMs} ms`;
  const gap = r.gap ? `<div class="small" style="margin-top:8px">Silent bars: <b>${r.gap.verdict === 'steady' ? 'held steady ✓' : r.gap.verdict === 'rushed' ? 'rushed' : 'dragged'}</b> — you played about ${r.gap.estBpm} BPM, ${Math.abs(r.gap.meanMs)} ms ${r.gap.meanMs < 0 ? 'early' : 'late'} on average.</div>` : '';
  const counts = { early: 0, on: 0, late: 0 };
  r.notes.forEach(n => counts[n.cls]++);
  return `<div class="timing">
    <div class="head"><span class="score">${r.onTimePct}%</span><span class="grow muted small">on time (±${s.tolMs} ms) · ${r.n} notes · ${tend}</span>
      <span class="chip ${r.pass ? 'good' : 'warn'}">${r.pass ? 'timing pass' : 'timing fail'}</span></div>
    <div class="note-strip">${r.notes.map(n => `<i class="${n.cls} ${n.audible ? '' : 'silent'}" title="${Math.round(n.dev * 1000)} ms"></i>`).join('')}</div>
    <div class="legend"><b class="e">■</b> early ${counts.early} · <b class="o">■</b> on time ${counts.on} · <b class="l">■</b> late ${counts.late}${r.gap ? ' · dashed = click silent' : ''}</div>
    ${gap}</div>`;
}

function attachLevelMeter() {
  if (coach.unLevel) coach.unLevel();
  if (coach.unOnset) coach.unOnset();
  coach.unLevel = mic.onLevel(db => {
    const el = $('#c-level i'); if (el) el.style.width = `${Math.max(0, Math.min(100, (db + 70) * 1.6))}%`;
  });
  coach.unOnset = mic.onOnset(() => {
    const el = $('#c-level'); if (!el) return;
    el.classList.add('hit'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('hit'), 120);
  });
}

/** Called every second while the coach is open: practice time + timers. */
function coachTick() {
  if (!coach) return;
  if (document.visibilityState === 'visible') {
    addPracticeSeconds(1);
    if (++coach.unsaved >= 15) { save(); coach.unsaved = 0; }
  }
  const t = $('#c-timers'); if (t) t.innerHTML = timersHtml();
  const sess = activeSessionForToday();
  if (sess && !coach.blockPrompted) {
    const b = sess.blocks[sess.index];
    if (Date.now() - sess.blockStartedAt >= b.minutes * 60000 + (sess.blockExtraMs || 0)) {
      coach.blockPrompted = true;
      coach.banner = 'Time’s up for this block. Finish your rep, then move on.';
      if (!coach.repActive) renderCoach(); else coach.pendingRender = true;
    }
  }
}

/* ---------- a rep: Start → count-in → play → Clean / Not clean ---------- */
async function startRep() {
  const f = findSection(coach.sectionId);
  await unlockAudio();
  const s = state.settings;
  if (needsMic() && !mic.active) {
    try {
      mic.sensitivity = s.sensitivity;
      await mic.start();
    } catch (e) {
      console.error(e);
      await showModal({ title: 'Microphone not available', html: `<p class="muted">${esc(e.message || e.name)}</p><p class="small muted">On iPhone: Settings › Safari › Microphone → Ask or Allow. The page must be opened over https://. You can turn off the mic timing check in Settings to practice without it.</p>` });
      return;
    }
  } else if (!needsMic()) {
    setAudioSessionType('playback');
  }
  applyClickSettings(f.section.currentBpm, f.piece.timeSig);
  metronome.start({ countInBars: s.countInBars });
  coach.repActive = true;
  coach.repStart = metronome.musicStartTime;
  coach.result = null; coach.message = ''; coach.msgCls = '';
  if (s.spotCheck && mic.active) startRepRecording();
  renderCoach();
}

function stopRep() {
  metronome.stop();
  stopRecordingIfAny();
  coach.repActive = false;
  coach.message = 'Rep stopped — not counted.'; coach.msgCls = '';
  renderCoach();
}

function stopRecordingIfAny() { stopRepRecording(false); }

async function judge(clean) {
  const f = findSection(coach.sectionId);
  const { piece, section } = f;
  const s = state.settings;
  const dev = getDevice();
  let result = null;
  let counted = clean;
  let note = '';

  if (s.micCheck) {
    if (!coach.repActive) {
      coach.message = 'Tap “Start rep” first so I can listen.'; coach.msgCls = 'warn';
      return renderCoach();
    }
    const ctx = getCtx();
    const tEnd = ctx.currentTime - 0.35;   // ignore the thud of your finger tapping the screen
    result = analyzeRep({
      onsets: mic.onsetsBetween(coach.repStart - 0.5, tEnd),
      grid: metronome.grid, bpm: metronome.bpm, gridDiv: section.gridDiv,
      latency: (dev.latencyMs || 0) / 1000, tolMs: s.tolMs, passPct: s.passPct, tEnd,
      gapCycle: s.gapEnabled ? s.gapPlay + s.gapMute : 0,
    });
    if (result.n < 4) {
      metronome.stop(); stopRecordingIfAny();
      coach.repActive = false; coach.result = result; coach.message = '';
      return renderCoach();
    }
    if (clean && !result.pass) { counted = false; note = 'You felt it was clean, but the timing check didn’t pass — counts as not clean.'; }
  }

  metronome.stop();
  const wasActive = coach.repActive;
  coach.repActive = false;
  coach.result = result;

  // spot-check: keep ~1 in N clean reps
  const keep = counted && s.spotCheck && wasActive && Math.random() < 1 / Math.max(1, s.spotEvery);
  stopRepRecording(keep, { label: sectionLabel(piece, section), bpm: section.currentBpm }, s.keepRecordings)
    .then(saved => { if (saved) toast('🎙 This rep was saved for a spot-check (see Log).'); });

  const ev = recordRep(piece, section, counted);
  save();

  const msgs = {
    streak: ['Clean ✓', 'good'], miss: ['Not clean — streak reset.', 'bad'],
    raised: [`${s.cleanTarget} clean in a row! Tempo up: ${ev.from} → ${ev.to} BPM`, 'good'],
    doneToday: [`Today’s goal reached ✓ Section done for today. Next time: ${ev.to} BPM`, 'good'],
    mastered: ['Mastered at target tempo! 🎉', 'good'],
    suggestDrop: [`${s.failLimit} misses in a row.`, 'warn'],
  };
  [coach.message, coach.msgCls] = msgs[ev.type];
  if (note) { coach.message = note; coach.msgCls = 'warn'; }
  if (coach.pendingRender) coach.pendingRender = false;
  if ((ev.type === 'doneToday' || ev.type === 'mastered') && activeSessionForToday()) coach.banner = ev.type === 'mastered' ? 'Mastered! Move to the next block?' : 'Done for today! Move to the next block?';
  renderCoach();
  celebrate(ev.type);

  if (ev.type === 'suggestDrop') {
    const ok = await confirmModal('Slow down a little?', `That’s ${s.failLimit} not-clean reps in a row at ${section.currentBpm} BPM. Dropping about ${s.dropPercent}% to ${ev.to} BPM usually gets you clean again quickly.`, `Drop to ${ev.to}`);
    if (ok) { setTempo(section, ev.to); coach.message = `Tempo set to ${ev.to} BPM. Fresh start.`; coach.msgCls = ''; }
    else section.failStreak = 0;
    save(); renderCoach();
  }
}

/* Small, earned moments: only right after a Clean / Not clean tap, never while playing. */
function celebrate(type) {
  const streakEl = $('#c-streak'), msg = $('#c-msg'), bpm = $('#coach .bpm');
  if (type === 'streak') {
    const lit = streakEl && streakEl.querySelectorAll('i.on');
    if (lit && lit.length) fx.replay(lit[lit.length - 1], 'pop');
    fx.replay(msg, 'pop-soft');
  } else if (type === 'miss') {
    fx.replay(streakEl, 'shake');
  } else if (type === 'raised' || type === 'doneToday') {
    fx.replay(bpm, 'flash');
    fx.burst(streakEl, type === 'raised' ? 18 : 26);
    fx.replay(msg, 'pop-soft');
  } else if (type === 'mastered') {
    fx.replay(bpm, 'flash');
    fx.burst(bpm, 30, 'var(--gold)');
    setTimeout(() => fx.burst(streakEl, 22), 180);
    fx.replay(msg, 'pop-soft');
  }
}

/* ---------- sessions ---------- */
function activeSessionForToday() {
  const a = state.activeSession;
  if (a && a.date !== dayStr()) { state.activeSession = null; save(); return null; }
  return a;
}

function startSession(blocks) {
  state.activeSession = {
    date: dayStr(), blocks: blocks.map(b => ({ ...b, done: false })), index: 0,
    startedAt: Date.now(), blockStartedAt: Date.now(), blockExtraMs: 0,
  };
  ui.planDraft = null;
  save();
  openCoach(blocks[0].sectionId);
}

async function nextBlock() {
  const sess = activeSessionForToday(); if (!sess) return;
  if (coach && coach.repActive) { metronome.stop(); stopRecordingIfAny(); }
  sess.blocks[sess.index].done = true;
  sess.index++;
  sess.blockStartedAt = Date.now(); sess.blockExtraMs = 0;
  if (sess.index >= sess.blocks.length) {
    state.activeSession = null; save();
    closeCoach();
    const l = state.log[dayStr()];
    await showModal({ title: 'Session complete 🎹', html: `<p class="muted">You practiced ${fmtMin(l ? l.seconds : 0)} today. Nice work.</p>` });
    return;
  }
  save();
  openCoach(sess.blocks[sess.index].sectionId);
}

/* ---------- wake lock (keep screen on) ---------- */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && state.settings.wakeLock && 'wakeLock' in navigator) {
      if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    } else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { console.warn('wake lock unavailable', e); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (coach || metronome.running)) keepAwake(true);
  if (document.visibilityState === 'hidden') save();
});

/* ---------- calibration ---------- */
async function calibrate() {
  const html = `<p>This measures your device’s built-in audio delay so it isn’t counted as you being late.</p>
    <ol class="muted small" style="padding-left:20px">
      <li>Put on <b>wired</b> earphones (so the mic doesn’t hear the click).</li>
      <li>Place the phone on the music stand.</li>
      <li>Tap Start, then play <b>one key</b> (short, firm, mezzo-forte) exactly with every click for about 12 seconds.</li>
    </ol>
    <div id="cal-status" style="font-size:20px;font-weight:600;text-align:center;margin:12px 0"></div>`;
  let done = false, cancelled = false;
  await showModal({
    title: 'Latency calibration', html,
    buttons: [{ label: 'Close', value: false }, { label: 'Start', value: 'start', cls: 'primary', validate: root => { runCal(root); return false; } }],
  });
  cancelled = true;               // modal closed: abort a run in progress
  if (done === 'running') { metronome.stop(); if (!coach) mic.stop(); applyClickSettings(null, null); }
  async function runCal(root) {
    if (done === 'running') return;
    done = 'running';
    const st = root.querySelector('#cal-status');
    try {
      await unlockAudio();
      mic.sensitivity = state.settings.sensitivity;
      await mic.start();
    } catch (e) { st.textContent = 'Microphone not available: ' + (e.message || e.name); done = false; return; }
    metronome.setBpm(80); metronome.beatsPerBar = 4; metronome.subdivision = 1; metronome.sound = 'click';
    metronome.accent = true; metronome.gap = { enabled: false, playBars: 1, muteBars: 1 }; metronome.volume = Number(state.settings.volume);
    metronome.start({ countInBars: 0 });
    const t0 = metronome.startTime;
    const secs = 12;
    for (let i = secs; i > 0; i--) {
      if (cancelled) return;
      st.textContent = `Play with the click… ${i}`;
      await new Promise(r => setTimeout(r, 1000));
    }
    metronome.stop();
    const res = computeLatency(mic.onsetsBetween(t0 - 0.2, getCtx().currentTime), metronome.grid);
    if (!coach) mic.stop();
    applyClickSettings(null, null);
    if (!res) { st.innerHTML = 'Didn’t hear enough notes.<div class="small muted">Play a little louder, or raise sensitivity, and try again.</div>'; done = false; return; }
    setDevice({ latencyMs: res.latencyMs, calibratedAt: new Date().toISOString(), spreadMs: res.spreadMs });
    st.innerHTML = `Saved: ${res.latencyMs} ms<div class="small muted">${res.count} notes heard · consistency ±${res.spreadMs} ms ${res.spreadMs > 30 ? '— a bit uneven; consider running it again' : '— good'}</div>`;
    done = true;
    if (ui.tab === 'settings') render();
  }
}

/* ---------- export / import ---------- */
function backupFile() {
  const json = JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
  return new File([json], `piano-coach-${dayStr()}.json`, { type: 'application/json' });
}
function downloadExport() {
  const f = backupFile();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
async function shareExport() {
  try { await navigator.share({ files: [backupFile()], title: 'Piano Coach backup' }); }
  catch (e) { if (e.name !== 'AbortError') downloadExport(); }
}
$('#import-file').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  try {
    const obj = JSON.parse(await file.text());
    if (!validateImport(obj)) throw new Error('Not a Piano Coach backup file.');
    const n = obj.pieces.length;
    const ok = await confirmModal('Replace all data?', `This backup has ${n} piece/routine item${n === 1 ? '' : 's'}. Importing replaces everything currently on this device.`, 'Replace', 'primary');
    if (!ok) return;
    delete obj.exportedAt;
    replaceState(obj);
    toast('Backup imported ✓');
    render();
  } catch (err) { showModal({ title: 'Import failed', html: `<p class="muted">${esc(err.message)}</p>` }); }
});

/* =====================================================================
 * FORMS for pieces / sections / routine
 * ===================================================================== */
async function addOrEditPiece(piece) {
  const v = await showForm(piece ? 'Edit piece' : 'Add piece', [
    { key: 'title', label: 'Title', value: piece?.title || '', required: true },
    { key: 'targetBpm', label: 'Target tempo (BPM)', type: 'number', value: piece?.targetBpm ?? 100, min: 20, max: 300 },
    { key: 'timeSig', label: 'Time signature', type: 'select', value: piece?.timeSig || '4/4', options: TIME_SIGS.map(t => ({ id: t, label: t })) },
  ]);
  if (!v) return;
  if (piece) Object.assign(piece, v);
  else { const p = { id: uid(), kind: 'piece', sections: [], ...v }; state.pieces.push(p); ui.pieceId = p.id; ui.tab = 'piece'; }
  save(); render();
}

async function addOrEditSection(piece, sec) {
  const last = piece.sections[piece.sections.length - 1];
  const v = await showForm(sec ? 'Edit section' : 'Add section', [
    { key: 'name', label: 'Name', value: sec?.name ?? `Section ${piece.sections.length + 1}`, required: true },
    { key: 'barStart', label: 'First bar', type: 'number', value: sec?.barStart ?? (last ? last.barEnd + 1 : 1), min: 1, max: 9999 },
    { key: 'barEnd', label: 'Last bar', type: 'number', value: sec?.barEnd ?? (last ? last.barEnd + 8 : 8), min: 1, max: 9999 },
    { key: 'currentBpm', label: sec ? 'Current tempo (BPM)' : 'Starting tempo (BPM)', type: 'number', value: sec?.currentBpm ?? Math.round(piece.targetBpm * 0.6), min: 20, max: 300, hint: 'A tempo where you can play it cleanly right now.' },
    { key: 'targetBpm', label: 'Target tempo (BPM)', type: 'number', value: sec?.targetBpm ?? piece.targetBpm, min: 20, max: 300 },
    { key: 'gridDiv', label: 'Fastest notes in this section (for the mic check)', type: 'select', num: true, value: sec?.gridDiv ?? 2, options: GRIDS },
  ], sec ? 'Save' : 'Add');
  if (!v) return;
  if (v.barEnd < v.barStart) { toast('Last bar must be after the first bar'); return; }
  if (sec) {
    const tempoChanged = v.currentBpm !== sec.currentBpm;
    Object.assign(sec, v);
    if (tempoChanged) setTempo(sec, v.currentBpm);
    if (sec.currentBpm < sec.targetBpm) sec.mastered = false;
  } else {
    piece.sections.push(normalizeSection({ id: uid(), ...v, startBpm: v.currentBpm }));
  }
  save(); render();
}

async function splitPiece(piece) {
  const v = await showForm('Auto-split into sections', [
    { key: 'firstBar', label: 'Start at bar', type: 'number', value: 1, min: 1, max: 9999 },
    { key: 'lastBar', label: 'Last bar of the piece', type: 'number', value: 32, min: 1, max: 9999 },
    { key: 'size', label: 'Bars per section', type: 'number', value: 8, min: 1, max: 64 },
    { key: 'startBpm', label: 'Starting tempo (BPM)', type: 'number', value: Math.round(piece.targetBpm * 0.6), min: 20, max: 300 },
  ], 'Create sections');
  if (!v) return;
  let n = piece.sections.length;
  for (let b = v.firstBar; b <= v.lastBar; b += v.size) {
    n++;
    piece.sections.push(normalizeSection({ id: uid(), name: `Section ${n}`, barStart: b, barEnd: Math.min(v.lastBar, b + v.size - 1), startBpm: v.startBpm, currentBpm: v.startBpm, targetBpm: piece.targetBpm }));
  }
  save(); render();
}

async function addOrEditRoutine(item) {
  const sec = item?.sections[0];
  const fields = [
    { key: 'title', label: 'Name (e.g. “C major scale, 4 octaves” or “Hanon 1”)', value: item?.title || '', required: true },
    { key: 'currentBpm', label: sec ? 'Current tempo (BPM)' : 'Starting tempo (BPM)', type: 'number', value: sec?.currentBpm ?? 60, min: 20, max: 300 },
    { key: 'targetBpm', label: 'Target tempo (BPM)', type: 'number', value: sec?.targetBpm ?? 100, min: 20, max: 300 },
    { key: 'timeSig', label: 'Time signature', type: 'select', value: item?.timeSig || '4/4', options: TIME_SIGS.map(t => ({ id: t, label: t })) },
    { key: 'gridDiv', label: 'Notes per beat (for the mic check)', type: 'select', num: true, value: sec?.gridDiv ?? 4, options: GRIDS },
  ];
  const v = await showForm(item ? 'Edit routine item' : 'Add routine item', fields, item ? 'Save' : 'Add');
  if (!v) return;
  if (item) {
    item.title = v.title; item.timeSig = v.timeSig; item.targetBpm = v.targetBpm;
    if (v.currentBpm !== sec.currentBpm) setTempo(sec, v.currentBpm);
    sec.targetBpm = v.targetBpm; sec.gridDiv = v.gridDiv;
    if (sec.currentBpm < sec.targetBpm) sec.mastered = false;
  } else {
    state.pieces.push({ id: uid(), kind: 'routine', title: v.title, targetBpm: v.targetBpm, timeSig: v.timeSig,
      sections: [normalizeSection({ id: uid(), name: 'Whole', barStart: 1, barEnd: 1, startBpm: v.currentBpm, currentBpm: v.currentBpm, targetBpm: v.targetBpm, gridDiv: v.gridDiv })] });
  }
  save(); render();
}

/* =====================================================================
 * ACTIONS — every button with data-act="name" calls ACTIONS.name(el)
 * ===================================================================== */
const ACTIONS = {
  tab: el => { ui.tab = el.dataset.tab; ui.planDraft = ui.tab === 'today' ? ui.planDraft : null; render(); window.scrollTo(0, 0); },
  'open-piece': el => { ui.pieceId = el.dataset.id; ui.tab = 'piece'; render(); window.scrollTo(0, 0); },
  'add-piece': () => addOrEditPiece(null),
  'edit-piece': el => addOrEditPiece(state.pieces.find(p => p.id === el.dataset.id)),
  'delete-piece': async el => {
    const p = state.pieces.find(x => x.id === el.dataset.id);
    if (await confirmModal('Delete piece?', `“${p.title}” and all its sections will be removed. Your practice log stays.`, 'Delete', 'danger')) {
      state.pieces = state.pieces.filter(x => x !== p); save(); ui.tab = 'pieces'; render();
    }
  },
  'add-section': el => addOrEditSection(state.pieces.find(p => p.id === el.dataset.id), null),
  'edit-section': async el => {
    const f = findSection(el.dataset.sec);
    const choice = await showModal({ title: f.section.name, html: `<p class="muted small">Bars ${f.section.barStart}–${f.section.barEnd} · ${f.section.reps} reps so far, ${f.section.cleanReps} clean</p>`,
      buttons: [{ label: 'Delete', value: 'del', cls: 'danger' }, { label: 'Edit', value: 'edit', cls: 'primary' }] });
    if (choice === 'edit') addOrEditSection(f.piece, f.section);
    if (choice === 'del' && await confirmModal('Delete section?', `Remove “${f.section.name}”?`, 'Delete', 'danger')) {
      f.piece.sections = f.piece.sections.filter(s => s !== f.section); save(); render();
    }
  },
  'split-piece': el => splitPiece(state.pieces.find(p => p.id === el.dataset.id)),
  'add-routine': () => addOrEditRoutine(null),
  'edit-routine': async el => {
    const item = state.pieces.find(p => p.id === el.dataset.id);
    const choice = await showModal({ title: item.title, buttons: [{ label: 'Delete', value: 'del', cls: 'danger' }, { label: 'Edit', value: 'edit', cls: 'primary' }] });
    if (choice === 'edit') addOrEditRoutine(item);
    if (choice === 'del' && await confirmModal('Delete routine item?', `Remove “${item.title}”?`, 'Delete', 'danger')) {
      state.pieces = state.pieces.filter(p => p !== item); save(); render();
    }
  },
  practice: el => openCoach(el.dataset.sec),

  // today / planner
  'plan-min': el => { ui.planMinutes = Math.max(15, Math.min(240, (ui.planMinutes ?? state.settings.sessionMinutes) + +el.dataset.d)); ui.planDraft = null; render(); },
  'build-plan': () => { ui.planDraft = buildSession(ui.planMinutes ?? state.settings.sessionMinutes); render(); },
  'start-session': () => ui.planDraft && ui.planDraft.length && startSession(ui.planDraft),
  'resume-session': () => { const s = activeSessionForToday(); if (s) openCoach(s.blocks[s.index].sectionId); },
  'end-session': async () => { if (await confirmModal('End session?', 'Your practice so far is already saved in the log.', 'End session')) { state.activeSession = null; save(); render(); } },

  // metronome screen
  'm-bpm': el => setMetroBpm(state.settings.metroBpm + +el.dataset.d),
  'm-tap': () => { const b = metronome.tap(); if (b) setMetroBpm(b); },
  'm-toggle': async () => {
    if (metronome.running) {
      metronome.stop(); keepAwake(false);
      document.querySelectorAll('#m-dots i').forEach(d => d.className = '');
    }
    else {
      await unlockAudio(); setAudioSessionType('playback');
      applyClickSettings(state.settings.metroBpm, state.settings.metroTimeSig);
      metronome.start({ countInBars: 0 }); keepAwake(true);
    }
    const b = $('#m-toggle'); if (b) b.textContent = metronome.running ? 'Stop' : 'Start';
  },

  // log
  cal: el => { const m = ui.calMonth; ui.calMonth = new Date(m.getFullYear(), m.getMonth() + +el.dataset.d, 1); render(); },
  'del-rec': async el => { await deleteRecording(+el.dataset.id); fillRecordings(); },

  // settings
  calibrate: () => calibrate(),
  export: () => downloadExport(),
  'share-export': () => shareExport(),
  import: () => $('#import-file').click(),
  reset: async () => {
    if (await confirmModal('Erase everything?', 'All pieces, sections, settings and the practice log on this device will be deleted. Export a backup first if unsure.', 'Erase', 'danger')) {
      replaceState({ version: 1, pieces: [] }); render(); toast('All data erased');
    }
  },

  // coach
  'close-coach': () => closeCoach(),
  'start-rep': () => startRep(),
  'stop-rep': () => stopRep(),
  judge: el => judge(el.dataset.clean === '1'),
  'c-tempo': el => {
    const f = findSection(coach.sectionId);
    setTempo(f.section, f.section.currentBpm + +el.dataset.d);
    if (metronome.running) metronome.setBpm(f.section.currentBpm);
    save(); renderCoach();
  },
  'c-tempo-set': async () => {
    const f = findSection(coach.sectionId);
    const v = await showForm('Set tempo', [{ key: 'bpm', label: 'Current tempo (BPM)', type: 'number', value: f.section.currentBpm, min: 20, max: 300, hint: 'Changing tempo resets the clean streak.' }]);
    if (v) { setTempo(f.section, v.bpm); save(); renderCoach(); }
  },
  'click-settings': () => showModal({ title: 'Click settings', html: `<div>${clickSettingsHtml()}</div><p class="small muted" style="margin-top:10px">Changes apply from the next rep.</p>`, buttons: [{ label: 'Done', value: true, cls: 'primary' }] }),
  'next-block': () => nextBlock(),
  'banner-dismiss': () => {
    const sess = activeSessionForToday();
    if (sess) { sess.blockExtraMs = (sess.blockExtraMs || 0) + 3 * 60000; coach.blockPrompted = false; save(); }
    coach.banner = null; renderCoach();
  },
};

function setMetroBpm(b) {
  b = Math.max(20, Math.min(300, Math.round(b)));
  state.settings.metroBpm = b; save();
  if (!coach) metronome.setBpm(b);
  const n = $('#m-bpm'); if (n) n.textContent = b;
  const sl = $('#m-slider'); if (sl) sl.value = b;
}

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('.modal-back') && !el.closest('.modal-body')) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});

/* Settings inputs: save on change; ranges update live. */
function onSettingInput(e) {
  const el = e.target;
  if (el.id === 'm-slider') { setMetroBpm(+el.value); return; }
  const key = el.dataset.setting; if (!key) return;
  if (e.type === 'input' && el.type !== 'range') return;
  let v;
  if (el.type === 'checkbox') v = el.checked;
  else if (el.type === 'number' || el.type === 'range' || 'num' in el.dataset) {
    v = Number(el.value);
    if (!Number.isFinite(v)) return;
    if (el.min !== '' && v < +el.min) v = +el.min;
    if (el.max !== '' && v > +el.max) v = +el.max;
  } else v = el.value;
  state.settings[key] = v;
  save();
  // side effects
  if (key === 'sensitivity') mic.setSensitivity(v);
  if (key === 'motion') fx.setMotion(v);
  if (key === 'gapEnabled') document.querySelectorAll('[data-gap-row]').forEach(r => r.hidden = !v);
  if (key === 'metroTimeSig') syncMetroDots();
  if (key === 'wakeLock' && !v) keepAwake(false);
  if (key === 'micCheck' && v && !getDevice().latencyMs) toast('Tip: run “Calibrate” once on this device for accurate timing.', 3500);
  if (['sound', 'subdivision', 'accent', 'volume', 'gapEnabled', 'gapPlay', 'gapMute', 'metroTimeSig'].includes(key) && !coach) {
    // live-update the standalone metronome; restart if the bar structure changed
    const wasRunning = metronome.running;
    applyClickSettings(state.settings.metroBpm, state.settings.metroTimeSig);
    if (wasRunning && ['subdivision', 'gapEnabled', 'gapPlay', 'gapMute', 'metroTimeSig'].includes(key)) metronome.start({ countInBars: 0 });
  }
}
document.addEventListener('change', onSettingInput);
document.addEventListener('input', e => { if (e.target.type === 'range') onSettingInput(e); });

/* =====================================================================
 * START-UP
 * ===================================================================== */
requestPersistence();
fx.setMotion(state.settings.motion);
render();

// Offline support (only works over https:// or localhost).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registration failed', e));
}

// Handy for debugging from the browser console in a future session.
window.pianoCoach = { state: () => state, metronome, mic };
