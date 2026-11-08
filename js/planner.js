/* =====================================================================
 * planner.js — builds today's practice session.
 *
 *  1. Warm-up (~15% of the budget, 5–15 min) from routine items
 *     (scales, Hanon, Czerny…), least recently practiced first.
 *  2. The rest goes to piece sections that are NOT mastered and NOT
 *     done for today, ranked by:
 *        priority = 0.6 × (how far below target tempo, 0..1)
 *                 + 0.4 × (days since last practiced, capped at 7, /7)
 *     Never-practiced sections count as 7 days.
 *  3. Each section gets a block of `blockMinutes` (default 8). If there
 *     are fewer sections than slots, blocks are lengthened (max 15 min).
 * ===================================================================== */

import { state, sectionLabel } from './store.js';
import { isDoneToday, progress } from './coach.js';

function daysSince(iso) {
  if (!iso) return 7;
  return Math.min(7, (Date.now() - new Date(iso).getTime()) / 86400000);
}

function priority(section) {
  return 0.6 * (1 - progress(section)) + 0.4 * (daysSince(section.lastPracticed) / 7);
}

export function buildSession(minutes) {
  const s = state.settings;
  const blocks = [];

  // --- warm-up ---
  const routines = state.pieces.filter(p => p.kind === 'routine' && p.sections.length)
    .map(p => ({ piece: p, section: p.sections[0] }))
    .sort((a, b) => daysSince(b.section.lastPracticed) - daysSince(a.section.lastPracticed));
  let warm = routines.length ? Math.max(5, Math.min(15, Math.round(minutes * s.warmupPercent / 100))) : 0;
  warm = Math.min(warm, minutes);
  if (routines.length) {
    const items = routines.slice(0, Math.max(1, Math.min(3, Math.floor(warm / 3))));
    const each = Math.max(2, Math.round(warm / items.length));
    items.forEach(r => blocks.push(block(r, each, 'warmup')));
  }

  // --- sections ---
  let remaining = minutes - blocks.reduce((a, b) => a + b.minutes, 0);
  const work = state.pieces.filter(p => p.kind !== 'routine')
    .flatMap(p => p.sections.map(section => ({ piece: p, section })))
    .filter(x => !isDoneToday(x.section))
    .sort((a, b) => priority(b.section) - priority(a.section));

  if (work.length && remaining > 0) {
    const slots = Math.max(1, Math.floor(remaining / s.blockMinutes));
    const chosen = work.slice(0, slots);
    const each = Math.min(15, Math.max(s.blockMinutes, Math.floor(remaining / chosen.length)));
    chosen.forEach(x => blocks.push(block(x, each, 'work')));
  }
  return blocks;
}

function block({ piece, section }, minutes, kind) {
  return { pieceId: piece.id, sectionId: section.id, label: sectionLabel(piece, section), minutes, kind };
}
