// Page-limit trimming: which part of a resume goes next when it runs
// over the page limit. Pure; the measuring is lib/pageMeasure.js.
// Order from Dossier's page-limit (github.com/AienTech/dossier, AGPL-3.0);
// reimplemented, no code copied.

import { keptUnits } from './documentUnits.js';

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const STOP = new Set(['with', 'have', 'experience', 'years', 'year', 'ability', 'strong', 'using', 'work', 'working', 'including',
  'knowledge', 'skills', 'that', 'this', 'from', 'will', 'your', 'their', 'more', 'plus', 'least', 'other', 'such', 'well', 'and/or', 'proven']);
// ponytail: 5-letter stems stand in for real stemming ("engineering" ~ "engineers"); swap in a stemmer if protection misses obvious matches.
const stems = (s) => [...new Set(norm(s).split(/[^a-z0-9+#]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 5)))];

// A part speaks to a must-have requirement when it shares at least two of
// the requirement's key words, or all of its own when it is one word (a
// skill like "Kubernetes").
export function speaksTo(text, requirement) {
  const want = stems(requirement);
  const have = new Set(stems(text));
  if (!want.length || !have.size) return false;
  return want.filter((w) => have.has(w)).length >= Math.min(2, want.length, have.size);
}

// → { id } to remove, { id, text } to shorten, or null when nothing more
// can go. Order: the last bullet of the oldest role; that role once it is
// down to one bullet; skills the posting doesn't mention; the summary's
// last sentence. Never the header, the most recent role, or a part that
// speaks to a must-have requirement.
export function nextTrim(units, { posting = '', mustHaves = [] } = {}) {
  const kept = keptUnits(units);
  const guarded = (u) => u.kind === 'header' || mustHaves.some((m) => speaksTo(u.text, m));
  const roles = kept.filter((u) => u.kind === 'role');
  for (const role of roles.slice(1).reverse()) {
    const bullets = kept.filter((u) => u.roleId === role.id);
    const free = bullets.filter((b) => !guarded(b));
    if (bullets.length > 1 && free.length) return { id: free[free.length - 1].id };
    // A role that speaks to a must-have keeps its title and last bullet.
    if (!guarded(role) && bullets.length <= 1 && free.length === bullets.length) return { id: role.id };
  }
  const p = norm(posting);
  const skill = kept.filter((u) => u.kind === 'skill' && !guarded(u) && !p.includes(norm(u.text))).pop();
  if (skill) return { id: skill.id };
  const summary = kept.find((u) => u.kind === 'summary' && !guarded(u));
  const sentences = summary?.text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) || [];
  if (sentences.length > 1) return { id: summary.id, text: sentences.slice(0, -1).join(' ') };
  return null;
}

// "Trimmed 3 bullets and 1 role to fit one page."
export function trimNote(units, trims, limit) {
  const byId = new Map(units.map((u) => [u.id, u]));
  const n = {};
  for (const t of trims) {
    const kind = t.text != null ? 'summary sentence' : byId.get(t.id)?.kind || 'part';
    n[kind] = (n[kind] || 0) + 1;
  }
  const parts = Object.entries(n).map(([k, c]) => `${c} ${k}${c === 1 ? '' : 's'}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `Trimmed ${list} to fit ${limit === 1 ? 'one page' : `${limit} pages`}.`;
}
