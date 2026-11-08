/* =====================================================================
 * fx.js — Kora Co feel: tap ripples, screen enter, count-ups, celebrations.
 *
 * Motion levels (Settings › Screen › Motion):
 *   lively = everything below
 *   calm   = tap feedback, count-ups, toasts — no particle bursts or sweeps
 *   off    = nothing moves
 * The phone's "Reduce Motion" setting always forces off.
 *
 * Rule: nothing here moves on the practice screen while you play.
 * Celebrations only fire right after you tap Clean.
 * ===================================================================== */

let level = 'lively';
const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function setMotion(m) {
  level = reduced() ? 'off' : (m || 'lively');
  document.documentElement.dataset.motion = level;
}
export const motion = () => level;

/* ---------- tap ripple from the finger ---------- */
const TAPPABLE = 'button, .btn, .card.tap, [data-act]';
document.addEventListener('pointerdown', e => {
  if (level === 'off') return;
  const el = e.target.closest(TAPPABLE);
  if (!el || el.disabled || el.closest('#tabs')) return;
  const r = document.createElement('span');
  r.className = 'ripple';
  const light = !el.matches('.primary, .yes');
  if (!light) r.classList.add('dark');
  r.style.left = e.clientX + 'px';
  r.style.top = e.clientY + 'px';
  document.body.appendChild(r);
  setTimeout(() => r.remove(), 650);
}, { passive: true });

/* ---------- screen enter (children rise in, staggered) ---------- */
export function enter(el) {
  if (!el || level === 'off') return;
  el.classList.remove('enter');
  void el.offsetWidth;
  [...el.children].forEach((c, i) => c.style.setProperty('--i', Math.min(i, 10)));
  el.classList.add('enter');
}

/* ---------- count-up numbers: <span data-count="40">40</span> ---------- */
export function countUps(root = document) {
  if (level === 'off') return;
  root.querySelectorAll('[data-count]').forEach(el => {
    const end = Number(el.dataset.count);
    if (!Number.isFinite(end) || end < 3) return;
    const final = el.textContent;
    const dur = 900 + 90 * String(end).length;
    const t0 = performance.now();
    el.style.fontVariantNumeric = 'tabular-nums';
    const step = now => {
      const k = Math.min(1, (now - t0) / dur);
      const v = Math.round(end * (1 - Math.pow(1 - k, 4)));
      if (k < 1) { el.textContent = String(v); requestAnimationFrame(step); }
      else el.textContent = final;
    };
    requestAnimationFrame(step);
  });
}

/* ---------- restart a one-shot animation class ---------- */
export function replay(el, cls) {
  if (!el || level === 'off') return;
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
}

/* ---------- particle burst from an element ---------- */
export function burst(el, n = 20, color = 'var(--accent)') {
  if (!el || level !== 'lively') return;
  const b = el.getBoundingClientRect();
  const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'spark';
    const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 90;
    p.style.left = cx + 'px'; p.style.top = cy + 'px';
    p.style.setProperty('--dx', Math.cos(a) * d + 'px');
    p.style.setProperty('--dy', Math.sin(a) * d + 'px');
    p.style.setProperty('--s', (0.5 + Math.random()).toFixed(2));
    p.style.background = Math.random() < 0.3 ? 'var(--text)' : color;
    p.style.animationDelay = Math.random() * 60 + 'ms';
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1000);
  }
}
