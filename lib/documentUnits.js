// Documents as units: a tailored resume or cover letter stored as small
// editable parts (a bullet, a paragraph) so one part can be rewritten,
// removed or put back without touching the rest. Pure, no I/O.
//
// A unit: { id, kind, text, flags?, removed?, roleId?, meta?, marker? }
//   resume kinds  header, summary, sectionHeading, role, bullet, skill, certification, education
//   letter kinds  greeting, opening, body, closing, signoff
// `removed: true` units stay in place (page-limit trimming puts them back).

export const LETTER_KINDS = new Set(['greeting', 'opening', 'body', 'closing', 'signoff']);
// Role and education units carry structured fields (meta) the PDF lays
// out; they can be removed but not reworded in place.
export const EDITABLE_KINDS = new Set(['header', 'summary', 'bullet', 'skill', 'certification', ...LETTER_KINDS]);

const isLetter = (units) => units.some((u) => LETTER_KINDS.has(u.kind));
// The parts that would be sent: not removed, and not a bullet of a
// removed role.
export function keptUnits(units) {
  const gone = new Set((units || []).filter((u) => u.removed).map((u) => u.id));
  return (units || []).filter((u) => !u.removed && !(u.roleId && gone.has(u.roleId)));
}
const live = keptUnits;

// ---------- Plain text ----------

const BULLET = /^\s*([-*•▪◦]|\d+[.)])\s+/;
const DATE_RANGE = /\b(19|20)\d{2}\b.*?(\b(19|20)\d{2}\b|present|current|now)/i;
const SECTION_KIND = [
  [/summary|profile|about/i, 'summary'],
  [/skill|competenc|technolog|tools/i, 'skill'],
  [/certif|award|licen/i, 'certification'],
  [/educat/i, 'education'],
];

function isHeading(line) {
  const t = line.replace(/^#+\s*/, '').replace(/:$/, '').trim();
  if (!t || t.length > 40 || BULLET.test(line)) return false;
  return /^#+\s/.test(line) || /:$/.test(line.trim()) || (/[A-Z]/.test(t) && t === t.toUpperCase());
}

// Resume text: the first line is the header, headings start sections,
// dated lines are roles, marker lines are bullets of the last role.
// Stable and reversible rather than clever: joinUnits gives the text
// back, whitespace aside.
export function splitResume(text) {
  const units = [];
  let section = null;
  let roleId = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const id = `u${units.length + 1}`;
    if (!units.length) { units.push({ id, kind: 'header', text: line }); continue; }
    if (isHeading(line)) {
      section = (SECTION_KIND.find(([re]) => re.test(line)) || [])[1] || 'experience';
      units.push({ id, kind: 'sectionHeading', text: line });
      continue;
    }
    const m = line.match(BULLET);
    if (m) {
      const kind = section === 'skill' || section === 'certification' || section === 'education' ? section : 'bullet';
      units.push({ id, kind, text: line.slice(m[0].length), marker: m[0], ...(kind === 'bullet' && roleId ? { roleId } : {}) });
      continue;
    }
    // A dated line starts a role. Under Experience, an undated line
    // (company, location) belongs to the role above it.
    if (DATE_RANGE.test(line) && (!section || section === 'experience')) {
      roleId = id;
      units.push({ id, kind: 'role', text: line });
      continue;
    }
    if (section === 'experience') {
      units.push(roleId ? { id, kind: 'bullet', roleId, text: line } : { id, kind: 'role', text: line });
      if (!roleId) roleId = id;
      continue;
    }
    units.push({ id, kind: section && section !== 'experience' ? section : 'summary', text: line });
  }
  return units;
}

const GREETING = /^(dear|hi|hello|to whom|greetings)\b/i;
const SIGNOFF = /^(sincerely|best|regards|kind regards|warm regards|thank you|thanks|cheers|warmly|respectfully|yours)\b/i;

// Letter text: one unit per paragraph. A short opening "Dear ..." is the
// greeting, a short closing "Best, ..." the signoff; of the rest the
// first opens, the last closes and the middle is body.
export function splitLetter(text) {
  const paras = String(text || '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const kinds = paras.map(() => 'body');
  let lo = 0;
  let hi = paras.length - 1;
  if (paras.length > 1 && paras[0].length < 80 && GREETING.test(paras[0])) kinds[lo++] = 'greeting';
  if (hi > lo && paras[hi].length < 120 && SIGNOFF.test(paras[hi])) kinds[hi--] = 'signoff';
  if (hi >= lo) kinds[lo] = 'opening';
  if (hi > lo) kinds[hi] = 'closing';
  return paras.map((text, i) => ({ id: `u${i + 1}`, kind: kinds[i], text }));
}

// Text of the document as it would be sent: removed units left out.
export function joinUnits(units) {
  const kept = live(units);
  return kept.map((u) => `${u.marker || ''}${u.text}`).join(isLetter(kept) ? '\n\n' : '\n');
}

// What changed between two unit lists, by id. A unit whose text or
// removed state differs counts as changed.
export function diffUnits(a, b) {
  const before = new Map((a || []).map((u) => [u.id, u]));
  const after = new Map((b || []).map((u) => [u.id, u]));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed: [...after.keys()].filter((id) => before.has(id)
      && (before.get(id).text !== after.get(id).text || !!before.get(id).removed !== !!after.get(id).removed)),
  };
}

// ---------- Structured resume (the resume prompt's JSON) ----------

const roleText = (r) => [r.title, r.company, r.detail, r.location, r.dates].filter(Boolean).join(', ');

// The resume prompt already returns its parts as JSON; each becomes a
// unit, in print order. Old v1 resumes (summaryParagraph + sections)
// are read too, so they render after migration.
export function unitsFromResume(r) {
  const units = [];
  const add = (u) => { const id = `u${units.length + 1}`; units.push({ id, ...u }); return id; };
  const str = (x) => (typeof x === 'string' ? x : x?.text || '');
  if (!r || typeof r !== 'object') return units;
  if (r.headline) add({ kind: 'header', text: r.headline });
  const summary = r.summary || r.summaryParagraph;
  if (summary) add({ kind: 'summary', text: summary });
  for (const s of r.skills || []) if (str(s)) add({ kind: 'skill', text: str(s) });
  for (const role of r.experience || []) {
    const roleId = add({ kind: 'role', text: roleText(role), meta: pick(role, ['title', 'company', 'location', 'dates']) });
    for (const b of role.bullets || []) if (str(b)) add({ kind: 'bullet', roleId, text: str(b) });
  }
  for (const s of r.sections || []) {
    for (const e of s.entries || []) {
      const roleId = add({ kind: 'role', text: e.role || '', meta: { title: e.role || '' } });
      for (const b of e.bullets || []) if (str(b)) add({ kind: 'bullet', roleId, text: str(b) });
    }
  }
  for (const role of r.earlierExperience || []) {
    add({ kind: 'role', text: roleText(role), meta: { ...pick(role, ['title', 'company', 'detail', 'location', 'dates']), earlier: true } });
  }
  for (const c of r.certifications || []) if (str(c)) add({ kind: 'certification', text: str(c) });
  for (const e of r.education || []) {
    add({ kind: 'education', text: [e.degree, e.school].filter(Boolean).join(', '), meta: pick(e, ['degree', 'school']) });
  }
  return units;
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o?.[k] != null) out[k] = o[k];
  return out;
}

// Back to the structured shape print/ and the keyword check read.
// Removed units, and bullets of a removed role, are left out.
export function resumeFromUnits(units) {
  const kept = live(units);
  const out = { headline: '', summary: '', skills: [], experience: [], earlierExperience: [], certifications: [], education: [] };
  const roles = new Map();
  for (const u of kept) {
    if (u.kind === 'header') out.headline = u.text;
    else if (u.kind === 'summary') out.summary = out.summary ? `${out.summary} ${u.text}` : u.text;
    else if (u.kind === 'skill') out.skills.push(u.text);
    else if (u.kind === 'certification') out.certifications.push(u.text);
    else if (u.kind === 'education') out.education.push(u.meta?.degree != null || u.meta?.school != null ? { ...u.meta } : { degree: u.text, school: '' });
    else if (u.kind === 'role') {
      const meta = u.meta || { title: u.text };
      if (meta.earlier) { const { earlier, ...rest } = meta; out.earlierExperience.push(rest); }
      else { const role = { ...meta, bullets: [] }; roles.set(u.id, role); out.experience.push(role); }
    } else if (u.kind === 'bullet') {
      const role = roles.get(u.roleId) || out.experience[out.experience.length - 1];
      if (role) role.bullets.push(u.text);
    }
  }
  return out;
}

// ---------- Applying a model's edits ----------

const nextId = (units) => `u${Math.max(0, ...units.map((u) => Number(String(u.id).slice(1)) || 0)) + 1}`;
const ADDABLE = new Set(['bullet', 'skill', 'body']);

// A refine result ({ edits, add, remove }) applied to the units. Anything
// that names an unknown part, a fixed kind (role, education) or empty
// text is skipped, so a confused model can't damage the document.
// Returns the new units and the ids that changed (to fact-check).
export function applyRefine(units, result) {
  let out = units.map((u) => ({ ...u }));
  const byId = (id) => out.find((u) => u.id === id);
  const touched = [];
  for (const e of result?.edits || []) {
    const u = byId(e?.id);
    if (!u || !EDITABLE_KINDS.has(u.kind) || typeof e.text !== 'string' || !e.text.trim() || e.text.trim() === u.text) continue;
    u.text = e.text.trim();
    delete u.flags;
    touched.push(u.id);
  }
  for (const id of result?.remove || []) {
    const u = byId(id);
    if (u && !u.removed && u.kind !== 'header') { u.removed = true; touched.push(u.id); }
  }
  const letter = isLetter(out);
  for (const a of result?.add || []) {
    if (!ADDABLE.has(a?.kind) || (a.kind === 'body') !== letter || typeof a.text !== 'string' || !a.text.trim()) continue;
    const after = byId(a.after);
    const unit = { id: nextId(out), kind: a.kind, text: a.text.trim() };
    if (a.kind === 'bullet') {
      const roleId = after?.kind === 'role' ? after.id : after?.roleId;
      if (!roleId) continue;
      unit.roleId = roleId;
    }
    const at = after ? out.indexOf(after) + 1 : out.length;
    out = [...out.slice(0, at), unit, ...out.slice(at)];
    touched.push(unit.id);
  }
  return { units: out, touched };
}
