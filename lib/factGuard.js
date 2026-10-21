// Fact guard: every checkable claim in a generated letter, resume, email
// or answer must be backed by the user's own material or the posting.
// Typed extraction (numbers, years, acronyms, names, credentials), each
// looked up in a normalised corpus; anything not found is flagged on the
// sentence or bullet it came from. No model involved.
// Idea from Dossier's fact-guard (github.com/AienTech/dossier, AGPL-3.0);
// reimplemented, no code copied.
//
// ponytail: matching is by presence, not context. "45 engineers" in the
// resume backs "45 customers" in the letter. It catches invented and
// inflated facts, not a real fact reattached to the wrong claim.

// Degrees and certifications. One list; extend here.
export const CREDENTIALS = [
  'BS', 'BA', 'BSc', 'BEng', 'MS', 'MSc', 'MA', 'MEng', 'MBA', 'EMBA', 'PhD', 'JD', 'MD', 'CPA', 'CFA',
  'PMP', 'PgMP', 'CSM', 'CSPO', 'PSM', 'SAFe', 'ITIL', 'CISSP', 'CISM', 'CISA', 'CEH', 'OSCP', 'CCNA', 'CCNP', 'CCIE',
  'CKA', 'CKAD', 'CKS', 'TOGAF', 'Six Sigma', 'Lean Six Sigma', 'Scrum Master', 'Product Owner',
  'AWS Certified', 'Google Cloud Certified', 'Azure Certified', 'Microsoft Certified', 'Salesforce Certified',
  "Bachelor's", 'Bachelor of Science', 'Bachelor of Arts', "Master's", 'Master of Science', 'Doctorate',
];
const CREDENTIAL_PHRASES = CREDENTIALS.filter((c) => /\s|'/.test(c));
const CREDENTIAL_WORDS = new Set(CREDENTIALS.filter((c) => !/\s|'/.test(c)));

// All-caps words that are ordinary English or too common to be a claim.
const ACRONYM_SKIP = new Set(['I', 'A', 'OK', 'AM', 'PM', 'US', 'USA', 'UK', 'EU', 'AI', 'IT', 'HR', 'ASAP', 'FYI', 'TBD', 'PS', 'RE', 'CC', 'Q1', 'Q2', 'Q3', 'Q4']);
// Capitalised phrases letters use that aren't claims.
const NAME_SKIP = /^(hiring (manager|team)|dear|best regards|kind regards|thank you|sincerely|cover letter|human resources)$/i;

const norm = (s) => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

// Sentences and bullets, in order. A bullet line is one unit; a prose
// line splits into sentences. Indexes are what flags point at.
export function splitUnits(text) {
  const units = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^([-•*▪◦]|\d+[.)])\s/.test(t)) { units.push(t); continue; }
    units.push(...t.split(/(?<=[.!?])\s+(?=["“(]?[A-Z0-9$])/).map((x) => x.trim()).filter(Boolean));
  }
  return units;
}

// Numbers in a unit: [{ value, display, measure }] where measure is
// '$', '%', 'x' or ''. Single bare digits ("SOC 2", "team of 5") are not
// claims and are skipped; ranges give one number per end.
function numbersIn(text) {
  const out = [];
  let rest = String(text || '');
  const take = (re, fn) => { rest = rest.replace(re, (...m) => { fn(m); return ' '; }); };
  const num = (s, unit) => Number(String(s).replace(/,/g, '')) * (SCALE[String(unit || '').toLowerCase()] || 1);
  // $1.2M, $120k, $4,000, $160,000 - $288,500
  take(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k|mm|m|bn|b|thousand|million|billion)?\b(?:\s?[-–]\s?\$?\s?(\d[\d,]*(?:\.\d+)?)\s?(k|mm|m|bn|b|thousand|million|billion)?\b)?/gi, (m) => {
    out.push({ value: num(m[1], m[2] || m[4]), display: m[0].trim(), measure: '$' });
    if (m[3]) out.push({ value: num(m[3], m[4]), display: m[0].trim(), measure: '$' });
  });
  // 30%, 30-40%, 30 percent
  take(/(\d[\d,]*(?:\.\d+)?)(?:\s?[-–]\s?(\d[\d,]*(?:\.\d+)?))?\s?(%|percent\b)/gi, (m) => {
    out.push({ value: num(m[1]), display: m[0].trim(), measure: '%' });
    if (m[2]) out.push({ value: num(m[2]), display: m[0].trim(), measure: '%' });
  });
  take(/\b(\d+(?:\.\d+)?)\s?x\b/gi, (m) => out.push({ value: num(m[1]), display: m[0].trim(), measure: 'x' }));
  // Years are their own kind; keep them out of the plain-number pass.
  take(/\b(?:19|20)\d{2}\b(?:\s?[-–]\s?(?:(?:19|20)\d{2}|present|now))?/gi, () => {});
  // 4,000+, 120k, 3-5, 45
  take(/\b(\d[\d,]*(?:\.\d+)?)(\+)?\s?(k|mm|m|bn|b|thousand|million|billion)?\b(?:\s?[-–]\s?(\d[\d,]*(?:\.\d+)?)\s?(k|mm|m|bn|b|thousand|million|billion)?\b)?(\+)?/gi, (m) => {
    const a = num(m[1], m[3] || m[5]);
    const claim = a >= 10 || m[2] || m[3] || m[4] || m[6];
    if (claim) out.push({ value: a, display: m[0].trim(), measure: '' });
    if (m[4]) out.push({ value: num(m[4], m[5]), display: m[0].trim(), measure: '' });
  });
  return out;
}

// Every checkable fact in a text: [{ kind, value, normalized, unit, number? }]
export function extractFacts(text) {
  const facts = [];
  splitUnits(text).forEach((u, unit) => {
    for (const n of numbersIn(u)) facts.push({ kind: 'number', value: n.display, normalized: `${n.measure}${n.value}`, unit, number: n });
    for (const y of u.match(/\b(?:19|20)\d{2}\b/g) || []) facts.push({ kind: 'year', value: y, normalized: y, unit });
    const lower = norm(u);
    const creds = new Set();
    for (const c of CREDENTIAL_PHRASES) if (lower.includes(norm(c))) { creds.add(c); facts.push({ kind: 'credential', value: c, normalized: norm(c), unit }); }
    for (const w of u.match(/\b[A-Z][A-Za-z]{1,5}\b/g) || []) {
      if (CREDENTIAL_WORDS.has(w) && !creds.has(w)) { creds.add(w); facts.push({ kind: 'credential', value: w, normalized: norm(w), unit }); }
    }
    for (const w of u.match(/\b[A-Z][A-Z0-9&]{1,5}\b/g) || []) {
      if (/^\d/.test(w) || ACRONYM_SKIP.has(w) || CREDENTIAL_WORDS.has(w)) continue;
      if ([...creds].some((c) => c.includes(' ') && c.split(' ').includes(w))) continue; // part of "AWS Certified
      facts.push({ kind: 'acronym', value: w, normalized: norm(w), unit });
    }
    // Capitalised runs of 2+ words, not counting the sentence's first word.
    const words = u.replace(/^([-•*▪◦]|\d+[.)])\s+/, '').split(/\s+/);
    let run = [];
    const flush = () => {
      const name = run.join(' ').replace(/[,.;:)]+$/, '');
      if (run.length >= 2 && !NAME_SKIP.test(name)) facts.push({ kind: 'name', value: name, normalized: norm(name), unit });
      run = [];
    };
    words.forEach((w, i) => {
      const bare = w.replace(/^["“(]+|["”),.;:]+$/g, '');
      const cap = /^[A-Z][a-zA-Z0-9&.'-]*$/.test(bare) && !/^[A-Z]{2,}$/.test(bare) && !/^I('|$)/.test(bare);
      // "and" is not a joiner: "Acme Pay and Initech Labs" is two names.
      const joiner = run.length && /^(of|&|for|the|de|la)$/.test(bare);
      if (i > 0 && (cap || joiner)) { run.push(bare); if (/[,.;:)]$/.test(w)) flush(); } else flush();
    });
    while (run.length && /^(of|&|for|the|de|la)$/.test(run[run.length - 1])) run.pop();
    flush();
  });
  return facts;
}

// The user's material plus the posting, normalised for lookup, with every
// number it states (so 120k finds 120,000).
export function buildCorpus({ profile = '', masterResume = '', knowledgeBase = '', writingSamples = '', posting = '' } = {}) {
  const text = [profile, masterResume, knowledgeBase, writingSamples, posting].join('\n');
  return { text: norm(text), numbers: numbersIn(text) };
}

const REASON = 'Not found in your resume, profile, knowledge base or the posting';

function backed(fact, corpus) {
  if (fact.kind === 'number') {
    const n = fact.number;
    if (corpus.text.includes(norm(n.display))) return true;
    return corpus.numbers.some((c) => c.measure === n.measure && (n.value === 0 ? c.value === 0 : Math.abs(c.value - n.value) / n.value <= 0.02));
  }
  return new RegExp(`(?<![a-z0-9])${fact.normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(corpus.text);
}

// { flags: [{ unit, kind, value, text, reason }], clean }. `text` is the
// sentence or bullet, so a renderer can mark it without re-splitting.
export function guard(text, corpus) {
  const units = splitUnits(text);
  const seen = new Set();
  const flags = [];
  for (const f of extractFacts(text)) {
    const key = `${f.unit}|${f.kind}|${f.normalized}`;
    if (seen.has(key) || backed(f, corpus)) continue;
    seen.add(key);
    flags.push({ unit: f.unit, kind: f.kind, value: f.value, text: units[f.unit], reason: REASON });
  }
  return { flags, clean: !flags.length };
}
