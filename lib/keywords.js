// Plain-text keyword matching between a posting, the master resume, and a
// tailored resume. No model involved — this is how an ATS search behaves
// (exact strings, no synonyms), so it is the right tool for checking
// whether a resume will actually be found.
//
// ponytail: n-gram intersection with a stoplist is a blunt instrument. It
// can't tell a required skill from boilerplate both documents happen to
// share, and it only sees verbatim matches. Upgrade path if it proves too
// noisy: have the model label the posting's terms once and cache them.

const STOP = new Set(`a an and are as at be by for from has have in is it its of on or that the their this to was were will with
you your our we us who what which into across over under per via about within while than then so such not no can may must should
would able also any all each more most other some they them these those if when where how up out off both either`.split(/\s+/));

// Words too generic to be worth a recruiter's search on their own.
const GENERIC = new Set(`experience experienced years year work working team teams ability strong skills skill role roles
company companies business including include includes required requirements preferred plus level high highly new well good great best
looking opportunity position candidate candidates responsibilities qualifications join help need needs make using use used based
environment time full part day world people job jobs ensure provide support supporting related relevant across various multiple
key deep proven track record excellent successful success understanding knowledge degree equivalent minimum least`.split(/\s+/));

import { guard, buildCorpus } from './factGuard.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Case-insensitive whole-term match, whitespace-tolerant. "Go" doesn't
// match "Google"; "C++" and "CI/CD" match as written.
export function containsTerm(text, term) {
  const t = String(term || '').trim();
  if (!t) return false;
  const body = t.split(/\s+/).map(escapeRe).join('\\s+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i').test(String(text || ''));
}

// Phrases (1–4 words) that appear verbatim in BOTH the posting and the
// resume, longest first, sub-phrases of a kept phrase dropped. Because
// each one is in the resume already, each is something the candidate can
// honestly claim — and each is something a recruiter might search for.
export function sharedTerms(posting, resume, max = 40) {
  const found = new Map(); // normalized phrase → { phrase, n, count }
  for (const segment of String(posting || '').split(/[\n;:,()|•·!?"“”]+|\.(?=\s|$)|\s[-–—]\s/)) {
    const words = segment.match(/[A-Za-z0-9][A-Za-z0-9+#./&'-]*[A-Za-z0-9+#]|[A-Za-z0-9]/g) || [];
    for (let n = Math.min(4, words.length); n >= 1; n--) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n);
        const lower = gram.map((w) => w.toLowerCase());
        if (STOP.has(lower[0]) || STOP.has(lower[n - 1])) continue;
        // "AWS and Kubernetes" is two terms, not one phrase to match verbatim.
        if (lower.includes('and') || lower.includes('or')) continue;
        if (lower.every((w) => STOP.has(w) || GENERIC.has(w))) continue;
        // A single word only counts when it looks like a name: an acronym,
        // CamelCase, has a digit or symbol (C++, CI/CD, SOC2), or is
        // capitalised mid-sentence (Kubernetes). Lowercase single words
        // ("product", "delivery") are too common to be worth flagging.
        if (n === 1 && !(/[A-Z]/.test(gram[0].slice(1)) || /[\d+#/.&]/.test(gram[0]) || (i > 0 && /^[A-Z]/.test(gram[0]) && gram[0].length > 2))) continue;
        const key = lower.join(' ');
        const hit = found.get(key);
        if (hit) hit.count++;
        else found.set(key, { phrase: gram.join(' '), n, count: 1 });
      }
    }
  }
  const kept = [];
  const candidates = [...found.values()]
    .filter((c) => containsTerm(resume, c.phrase))
    .sort((a, b) => b.n - a.n || b.count - a.count);
  for (const c of candidates) {
    if (kept.some((k) => containsTerm(k.phrase, c.phrase))) continue;
    kept.push(c);
  }
  // Multi-word phrases and repeated terms first — those carry the most signal.
  return kept
    .sort((a, b) => (b.count * (b.n > 1 ? 2 : 1)) - (a.count * (a.n > 1 ? 2 : 1)))
    .slice(0, max)
    .map((c) => c.phrase);
}

// The tailored resume as checkable text, one bullet per line.
export function resumeText(r) {
  return [
    r.headline, r.summary, ...(r.skills || []),
    ...(r.experience || []).flatMap((role) => [role.title, ...(role.bullets || []).map((b) => (typeof b === 'string' ? b : b?.text))]),
  ].filter(Boolean).join('\n');
}

// Checks the model's tailored resume against the text instead of taking
// its word for it.
//   covered / missed   shared terms that did / didn't make it into the resume
//   phrasesVerified    vocabularyMirrored entries really in the posting AND the resume
//   unverifiedSkills   skills not found verbatim in the master resume or profile
//                      (may be a fair paraphrase — flagged for a human look, not removed)
//   missing            posting keywords the master resume truly lacks
export function verifyResume({ result, posting, masterResume, profile, shared }) {
  const out = resumeText(result || {});
  const source = `${masterResume || ''}\n${profile || ''}`;
  const claimedMissing = result?.missingKeywords || [];
  // A term the model called "missing" that is in the master resume isn't
  // missing — it was left off.
  const wronglyMissing = claimedMissing.filter((k) => containsTerm(source, k));
  const terms = [...new Set([...(shared || []), ...wronglyMissing])];
  return {
    covered: terms.filter((t) => containsTerm(out, t)),
    missed: terms.filter((t) => !containsTerm(out, t)),
    phrasesVerified: (result?.vocabularyMirrored || []).filter((p) => containsTerm(posting, p) && containsTerm(out, p)).length,
    unverifiedSkills: (result?.skills || []).filter((s) => !containsTerm(source, s)),
    missing: claimedMissing.filter((k) => !wronglyMissing.includes(k)),
    // Numbers and dates the master resume doesn't contain, and roles
    // (title or employer) it doesn't name — the facts most likely to be
    // asked about in an interview.
    unsupportedFacts: unsupportedFacts(out, source),
    unknownRoles: [...(result?.experience || []), ...(result?.earlierExperience || [])]
      .flatMap((r) => [r.title, r.company])
      .filter((t) => t && !containsTerm(source, t)),
  };
}

// ---------- Fact check: numbers and dates ----------
//
// Every number in a generated document that makes a claim — 40%, $12M,
// 3x, 45 engineers, 15+ years, 2019 — must appear in the source material
// (master resume + profile, plus the posting for a cover letter). An
// invented or inflated metric is the claim most likely to be checked in
// an interview, and it's the easiest to catch without a model.
// Adapted from the "factual grounding audit" in MadsLorentzen/ai-job-search (MIT).
//
// ponytail: compares values, not context — "45 engineers" in the source
// will vouch for "45 customers" in the output. It catches invented and
// inflated numbers, not a real number reattached to the wrong claim.

const SCALE = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const toNum = (digits, unit) => Number(digits.replace(/,/g, '')) * (SCALE[(unit || '').toLowerCase()] || 1);

// Normalised claim-bearing numbers in a text: [{ raw, key }].
// Single bare digits ("SOC 2", "Python 3", "a team of 5") are skipped —
// too common to be claims and too noisy to flag.
export function factTokens(text) {
  const out = [];
  let rest = String(text || '');
  const take = (re, keyOf) => {
    rest = rest.replace(re, (...m) => {
      const key = keyOf(m);
      if (key) out.push({ raw: m[0].trim(), key });
      return ' ';
    });
  };
  take(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k|mm|m|bn|b|thousand|million|billion)?\b/gi, (m) => `$${toNum(m[1], m[2])}`);
  take(/(\d[\d,]*(?:\.\d+)?)\s?(%|percent\b)/gi, (m) => `${toNum(m[1])}%`);
  take(/\b(\d+(?:\.\d+)?)\s?x\b/gi, (m) => `${m[1]}x`);
  take(/\b((?:19|20)\d{2})\b/g, (m) => `y${m[1]}`);
  take(/\b(\d[\d,]*(?:\.\d+)?)(\+)?\s?(k|mm|m|bn|b|thousand|million|billion)?\b(\+)?/gi, (m) => {
    const n = toNum(m[1], m[3]);
    return n >= 10 || m[2] || m[3] || m[4] ? `n${n}` : null;
  });
  return out;
}

// Claim-bearing facts in `output` that the `source` never mentions.
// ponytail: thin wrapper kept for one release; callers use
// lib/factGuard.js#guard directly. Remove in v0.12.
export function unsupportedFacts(output, source) {
  return guard(output, buildCorpus({ masterResume: source })).flags.map((f) => f.value);
}
