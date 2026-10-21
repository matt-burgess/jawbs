// Version history for a unit document (lib/documentUnits.js). Pure: every
// function returns a new doc and never mutates the one passed in.
//
// doc = { units, versions: [{ id, at, cause, units, note, base? }], current }
// causes: written, edited, regenerated, refined, trimmed, restored,
//         beforeRestore, undone

import { splitLetter, unitsFromResume } from './documentUnits.js';

export const MAX_VERSIONS = 25;

const now = () => new Date().toISOString();
const copy = (units) => (units || []).map((u) => ({ ...u }));

export function newDoc(units, cause = 'written', note = '', at = now()) {
  return commit({ units: [], versions: [], current: null }, units, cause, note, at);
}

export function commit(doc, units, cause, note = '', at = now(), extra = {}) {
  const n = Math.max(0, ...(doc.versions || []).map((v) => Number(String(v.id).slice(1)) || 0)) + 1;
  const v = { id: `v${n}`, at, cause, note, units: copy(units), ...extra };
  let versions = [...(doc.versions || []), v];
  // Oldest go first, but never the version being shown.
  while (versions.length > MAX_VERSIONS) {
    const i = versions.findIndex((x) => x.id !== v.id);
    versions = versions.filter((_, j) => j !== i);
  }
  return { ...doc, units: copy(units), versions, current: v.id };
}

// The version undo would go back to, or null. An undone version points
// at the version it brought back (base), so undo again keeps walking back.
export function undoTarget(doc) {
  const vs = doc?.versions || [];
  const cur = vs.find((v) => v.id === doc.current);
  if (!cur) return null;
  const from = cur.cause === 'undone' ? vs.find((v) => v.id === cur.base) : cur;
  const i = vs.indexOf(from);
  return i > 0 ? vs[i - 1] : null;
}

export function undo(doc, at = now()) {
  const t = undoTarget(doc);
  if (!t) return doc;
  return commit(doc, t.units, 'undone', `Back to the ${t.cause} version`, at, { base: t.id });
}

// Snapshot what is showing, then bring the chosen version back. Both are
// versions, so a restore can itself be undone or restored over.
export function restore(doc, versionId, at = now()) {
  const t = (doc.versions || []).find((v) => v.id === versionId);
  if (!t) return doc;
  const snap = commit(doc, doc.units, 'beforeRestore', 'Before restoring an earlier version', at);
  return commit(snap, t.units, 'restored', `Restored the ${t.cause} version`, at, { base: t.id });
}

// The job's document of one kind ('resume' | 'letter'), building it from
// the analysis for jobs generated before documents had units. Nothing is
// written here; the first change saves it.
export function docFromJob(job, kind) {
  if (job?.documents?.[kind]) return job.documents[kind];
  const rec = job?.analyses?.[kind === 'letter' ? 'coverLetter' : 'resume'];
  if (!rec?.result) return null;
  const units = kind === 'letter'
    ? (Array.isArray(rec.result.units) ? rec.result.units.map((u, i) => ({ id: `u${i + 1}`, kind: u.kind, text: u.text })) : splitLetter(rec.result.letter))
    : unitsFromResume(rec.result);
  // Older records flagged sentences of the whole text; hang each flag on
  // the unit that contains its sentence.
  for (const u of units) {
    const hit = (rec.factGuard?.flags || []).filter((f) => f.text && u.text.includes(f.text));
    if (hit.length) u.flags = hit;
  }
  return units.length ? newDoc(units, 'written', '', rec.generatedAt || now()) : null;
}
