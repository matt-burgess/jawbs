import test from 'node:test';
import assert from 'node:assert/strict';
import { accentStep, stepStates, scoreBand, compView, compBadge, normalizeComp, fitView } from '../lib/jawbSteps.js';

const fit = (fitScore, extra = {}) => ({ fit: { result: { fitScore, gaps: ['No Kubernetes'], alignments: ['a', 'b'], ...extra } } });

test('next step follows the sequence; weak fit is flagged, never blocks', () => {
  assert.deepEqual(stepStates({}).next, 'fit');
  assert.equal(stepStates(fit(80)).next, 'comp');
  assert.equal(stepStates({ ...fit(80), comp: {} }).next, 'resume');
  const weak = stepStates(fit(30));
  assert.equal(weak.weak, true);
  assert.equal(weak.next, 'comp');
  assert.equal(stepStates({ ...fit(30), comp: {} }).applyPrimary, false);
  assert.equal(stepStates({ ...fit(80), comp: {} }).applyPrimary, true);
  assert.equal(scoreBand(39), 'weak'); assert.equal(scoreBand(40), 'fair'); assert.equal(scoreBand(70), 'strong');
});

test('a recovery-skeleton fit does not count as done', () => {
  const s = stepStates({ fit: { result: { fitScore: 0, gaps: ['No job description was captured here'] } } });
  assert.equal(s.done.fit, false); assert.equal(s.weak, false);
});

test('fitView puts the top gap first and says how many of each', () => {
  const v = fitView({ fitScore: 82, verdict: { recommendation: 'apply-now' }, gaps: ['g1', 'g2'], alignments: ['m'] });
  assert.equal(v.topGap, 'g1'); assert.equal(v.label, 'Strong');
  assert.match(v.summary, /1 point line up, 2 gaps/);
});

const salary = (source, low, high, confidence = 'medium') => ({ source, confidence, sourceLabel: 'Model estimate: x', base: { low, high } });

test('compBadge: estimates say so; only a posting is plain', () => {
  assert.deepEqual(compBadge(salary('posting', 1, 2, 'high')), { label: 'Job posting · high', name: 'Job posting', tone: 'pos' });
  assert.equal(compBadge(salary('company-research', 1, 2)).label, 'Company est. · medium');
  assert.equal(compBadge(salary('title-benchmark', 1, 2, 'low')).tone, 'neg');
});

test('compView lights the used source and lists the others', () => {
  const rec = { result: { salary: salary('company-research', 240000, 290000), others: [{ source: 'title-benchmark', low: 200000, high: 260000, sourceLabel: 'Model estimate: title' }], applicationAnswer: { number: 270000, short: 'I am looking for X.' } } };
  const v = compView(rec, { floor: 200000, target: 260000 });
  assert.equal(v.range, '$240K-$290K');
  assert.deepEqual(v.ladder.map((l) => [l.key, l.used, l.range]), [['posting', false, null], ['company-research', true, '$240K-$290K'], ['title-benchmark', false, '$200K-$260K']]);
  assert.equal(v.others.length, 1);
  assert.equal(v.answer.numberText, '$270,000');
  assert.equal(compView({}, {}), null);
});

test('normalizeComp: no posting in others, pay answer at/above target, $5K steps', () => {
  const base = () => ({ salary: salary('company-research', 240000, 290000), others: [{ source: 'posting', low: 1, high: 2 }, { source: 'company-research', low: 1, high: 2 }, { source: 'title-benchmark', low: 200000, high: 250000, sourceLabel: 's' }], applicationAnswer: { number: 262300, short: 'Looking at 260 – 280K.' } });
  const r = normalizeComp(base(), { target: 265000 });
  assert.deepEqual(r.others.map((o) => o.source), ['title-benchmark']);
  assert.equal(r.applicationAnswer.number, 265000);
  assert.ok(!/[–—]/.test(r.applicationAnswer.short));
  assert.equal(normalizeComp(base(), { target: 300000 }).applicationAnswer.number, 300000); // target above range wins
  assert.equal(normalizeComp(base(), {}).applicationAnswer.number, 260000);              // no target: model's figure, rounded
  const none = normalizeComp({ salary: { source: 'unknown', base: {} } }, {});
  assert.equal(none.applicationAnswer, null);
});

test('exactly one accent step; none when the fit is weak', () => {
  assert.equal(accentStep(stepStates({}), false), 'fit');
  assert.equal(accentStep(stepStates(fit(80)), false), 'comp');
  assert.equal(accentStep(stepStates({ ...fit(80), comp: {} }), false), 'apply');
  assert.equal(accentStep(stepStates({ ...fit(80), comp: {} }), true), 'resume');
  assert.equal(accentStep(stepStates({ ...fit(80), comp: {}, resume: {} }), true), null);
  assert.equal(accentStep(stepStates(fit(30)), false), null);
});
