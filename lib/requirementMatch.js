// Per-requirement fit, decided by code. The model only extracts the
// posting's requirements and says which of the user's material each maps
// to (lib/prompts/extractRequirements.js, matchRequirements.js); this
// module decides covered / partial / gap, and refuses any evidence that
// isn't actually in the user's material.
// Idea from Dossier's match-requirements (github.com/AienTech/dossier,
// AGPL-3.0); reimplemented, no code copied.

const norm = (s) => String(s || '').toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim();

// Evidence counts only if its text appears in the material it claims to
// come from (or, failing that, anywhere in the user's material). A model
// can paraphrase or invent; a substring check can't be talked round.
function backed(ev, material) {
  const t = norm(ev?.text);
  if (t.length < 4) return false;
  const own = material[ev.source];
  if (own && norm(own).includes(t)) return true;
  return Object.values(material).some((m) => norm(m).includes(t));
}

// requirements: [{ id, text, kind: 'must'|'nice', quote }]
// matches:      [{ requirementId, evidence: [{ source, text }], confidence }]
// material:     { resume, profile, knowledge } — the text the model was given
// → [{ id, text, kind, quote, state: 'covered'|'partial'|'gap', evidence }]
export function decideRequirements(requirements, matches, material = {}) {
  const byId = new Map((matches || []).map((m) => [String(m.requirementId), m]));
  return (requirements || []).map((r) => {
    const m = byId.get(String(r.id));
    const evidence = (m?.evidence || []).filter((ev) => backed(ev, material));
    const conf = m?.confidence;
    const state = !evidence.length || !conf || conf === 'none' ? 'gap'
      : conf === 'high' ? 'covered' : 'partial';
    return { id: r.id, text: r.text, kind: r.kind === 'must' ? 'must' : 'nice', quote: r.quote || null, state, evidence };
  });
}

// Counts, plus the must-have gaps (the ones that decide an application).
export function summarizeRequirements(result) {
  const out = { total: result.length, covered: 0, partial: 0, gap: 0, mustGaps: [] };
  for (const r of result) {
    out[r.state]++;
    if (r.state === 'gap' && r.kind === 'must') out.mustGaps.push(r);
  }
  return out;
}

// Display order: must-have gaps pinned first, then the rest of the musts,
// then nice-to-haves; within each, gap → partial → covered.
const STATE_ORDER = { gap: 0, partial: 1, covered: 2 };
export function orderRequirements(result) {
  return [...result].sort((a, b) =>
    (a.kind === 'must' ? 0 : 1) - (b.kind === 'must' ? 0 : 1)
    || STATE_ORDER[a.state] - STATE_ORDER[b.state]);
}
