// Pure logic for the Jawb tab's four steps (Fit, Comp, Resume, Cover
// letter) and for what the flyout shows. No DOM, so it can be tested.
import { compVerdict, rangeBar } from './compVerdict.js';

export const STEPS = ['fit', 'comp', 'resume', 'letter'];

// 70+ strong, 40-69 fair, under 40 weak. The panel's gauges, the Fit
// row and the weak-fit note all read this one cut.
export function scoreBand(score) {
  const n = Number.isFinite(score) ? score : 0;
  return n >= 70 ? 'strong' : n >= 40 ? 'fair' : 'weak';
}

export function fmtMoneyK(n) {
  if (n == null || Number.isNaN(n)) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

// Fit v8+ answers fitScore 0 plus one "No job description was captured"
// gap when it was handed a search-results blob. That is not a score.
export function isFitSkeleton(r) {
  return r?.fitScore === 0 && Array.isArray(r.gaps) && r.gaps.length === 1
    && /^No job description was captured/i.test(r.gaps[0] || '');
}

// Which steps are done, which one is next, and whether a weak fit should
// dim everything after it. `analyses` is job.analyses.
export function stepStates(a = {}) {
  const fit = a.fit?.result;
  const done = { fit: !!fit && !isFitSkeleton(fit), comp: !!a.comp, resume: !!a.resume, letter: !!a.coverLetter };
  const weak = done.fit && scoreBand(fit.fitScore) === 'weak';
  return { done, weak, next: STEPS.find((s) => !done[s]) || null, applyPrimary: done.fit && done.comp && !weak };
}

// ---------- Fit ----------

const FIT_WORD = { strong: 'Strong', fair: 'Fair', weak: 'Weak' };
const REC_LINE = {
  'apply-now': 'Worth applying now.',
  'apply-if-nothing-better': 'Worth applying if nothing better turns up.',
  skip: 'Not worth your time.',
};

export function fitView(r = {}) {
  const band = scoreBand(r.fitScore);
  const gaps = r.gaps || [];
  const matches = r.alignments || [];
  const count = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return {
    score: r.fitScore ?? null, band, label: FIT_WORD[band],
    summary: [REC_LINE[r.verdict?.recommendation], `${count(matches.length, 'point')} line up, ${count(gaps.length, 'gap')} to read first.`]
      .filter(Boolean).join(' '),
    gaps, matches, topGap: gaps[0] || null,
  };
}

// ---------- Comp ----------

const SOURCES = {
  posting: { name: 'Job posting', short: 'Job posting', tone: 'pos' },
  'company-research': { name: 'Company data', short: 'Company est.', tone: 'caution' },
  'title-benchmark': { name: 'Industry', short: 'Industry est.', tone: 'neg' },
};
// Short names say "est." because #2 and #3 are the model's own estimate,
// not a pay database.

export function rangeText(low, high, sep = '-') {
  if (low != null && high != null) return `${fmtMoneyK(low)}${sep}${fmtMoneyK(high)}`;
  if (low != null) return `${fmtMoneyK(low)}+`;
  if (high != null) return `up to ${fmtMoneyK(high)}`;
  return null;
}

export function compBadge(s = {}) {
  const src = SOURCES[s.source];
  if (!src) return { label: 'No pay data', name: 'No pay data', tone: 'neg' };
  return { label: s.confidence ? `${src.short} · ${s.confidence}` : src.short, name: src.short, tone: src.tone };
}

// Everything the Comp row and flyout show, from a stored comp record.
export function compView(record, targets = {}) {
  const res = record?.result;
  const s = res?.salary;
  if (!s) return null;
  const base = s.base || {};
  const verdict = compVerdict(base, targets);
  const bonus = s.bonus || {};
  const bonusEquity = [
    bonus.percent != null ? `${bonus.percent}% bonus target` : bonus.note,
    s.equity?.note,
  ].filter(Boolean).join(' · ');
  const others = res.others || [];
  const ladder = Object.entries(SOURCES).map(([key, src], i) => {
    const used = s.source === key;
    const o = used ? base : others.find((x) => x.source === key);
    return { n: i + 1, key, name: src.name, tone: src.tone, used, range: rangeText(o?.low, o?.high), };
  });
  return {
    range: rangeText(base.low, base.high), estimate: s.source !== 'posting',
    badge: compBadge(s), verdict, bonusEquity, sourceLabel: s.sourceLabel || '',
    bar: rangeBar(base, targets),
    floor: Number(targets.floor) || null, target: Number(targets.target) || null,
    ladder,
    others: others.filter((o) => o.source !== s.source).map((o) => ({
      name: SOURCES[o.source]?.name || o.source, range: rangeText(o.low, o.high), sourceLabel: o.sourceLabel || '',
    })),
    answer: res.applicationAnswer?.number != null || res.applicationAnswer?.short ? {
      number: res.applicationAnswer.number ?? null,
      numberText: res.applicationAnswer.number != null ? `$${res.applicationAnswer.number.toLocaleString('en-US')}` : null,
      short: res.applicationAnswer.short || null,
    } : null,
  };
}

// Tidy what the model returned for `others` and `applicationAnswer`
// (lib/prompts/comp.js), so the rules do not depend on it obeying them:
// no posting entry in `others`, the pay-answer number is at or above the
// target, inside the found range when possible, and a multiple of $5K.
export function normalizeComp(result, { target } = {}) {
  if (!result || typeof result !== 'object') return result;
  const s = result.salary || {};
  const base = s.base || {};
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  result.others = (Array.isArray(result.others) ? result.others : [])
    .map((o) => ({ source: o?.source, low: num(o?.low), high: num(o?.high), sourceLabel: String(o?.sourceLabel || '') }))
    .filter((o) => (o.source === 'company-research' || o.source === 'title-benchmark')
      && o.source !== s.source && o.low != null && o.high != null && o.low <= o.high);

  const t = Number(target) || 0;
  const lo = Math.max(t, base.low || 0);
  const hi = base.high ?? Infinity;
  let n = num(result.applicationAnswer?.number) ?? (t || base.high || base.low || null);
  if (n != null) {
    n = lo <= hi ? Math.min(Math.max(n, lo), hi) : lo; // target above the range: the target wins
    n = Math.round(n / 5000) * 5000;
    if (n < t) n = Math.ceil(t / 5000) * 5000;
  }
  const short = String(result.applicationAnswer?.short || '').replace(/\s*[–—]\s*/g, ', ').trim() || null;
  result.applicationAnswer = n == null && !short ? null : { number: n, short: n == null ? null : short };
  return result;
}

// The one step whose button gets the accent fill: Fit, then Comp, then
// opening the corp site (until the job is Applied), then the resume.
// None while the fit is weak. The cover letter is never the accent.
export function accentStep(st, applied) {
  if (!st.done.fit) return 'fit';
  if (st.weak) return null;
  if (!st.done.comp) return 'comp';
  if (!applied) return 'apply';
  return st.done.resume ? null : 'resume';
}
