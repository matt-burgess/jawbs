import test from 'node:test';
import assert from 'node:assert/strict';
import { decideRequirements, summarizeRequirements, orderRequirements } from '../lib/requirementMatch.js';

const material = {
  resume: 'Led 45 engineers across platform and payments. Ran Kubernetes migration for 300 services.',
  profile: 'Director-level engineering leader, fintech.',
  knowledge: 'Shipped PCI-DSS Level 1 certification in 2021.',
};
const reqs = [
  { id: 'r1', text: 'Kubernetes at scale', kind: 'must' },
  { id: 'r2', text: 'Led large teams', kind: 'must' },
  { id: 'r3', text: 'Java and Spring Boot', kind: 'must' },
  { id: 'r4', text: 'Fintech domain', kind: 'nice' },
  { id: 'r5', text: 'PCI compliance', kind: 'nice' },
];
const ev = (source, text) => ({ source, text });

test('code decides each state from confidence plus backed evidence', () => {
  const out = decideRequirements(reqs, [
    { requirementId: 'r1', confidence: 'high', evidence: [ev('resume', 'Ran Kubernetes migration for 300 services')] },
    { requirementId: 'r2', confidence: 'medium', evidence: [ev('resume', 'Led 45 engineers')] },
    { requirementId: 'r3', confidence: 'none', evidence: [] },
    { requirementId: 'r4', confidence: 'low', evidence: [ev('profile', 'engineering leader, fintech')] },
    // r5: no match entry at all
  ], material);
  assert.deepEqual(out.map((r) => r.state), ['covered', 'partial', 'gap', 'partial', 'gap']);
});

test('invented evidence fails the substring guard and becomes a gap', () => {
  const out = decideRequirements([reqs[0]], [
    { requirementId: 'r1', confidence: 'high', evidence: [ev('resume', 'Ran Kubernetes for 3,000 services at Google')] },
  ], material);
  assert.equal(out[0].state, 'gap');
  assert.deepEqual(out[0].evidence, []);
});

test('evidence attributed to the wrong source still counts if it is in the material', () => {
  const out = decideRequirements([reqs[4]], [
    { requirementId: 'r5', confidence: 'high', evidence: [ev('resume', 'PCI-DSS Level 1 certification')] },
  ], material);
  assert.equal(out[0].state, 'covered');
});

test('high confidence with no evidence is a gap; matching is case and space insensitive', () => {
  const out = decideRequirements(reqs.slice(0, 2), [
    { requirementId: 'r1', confidence: 'high', evidence: [] },
    { requirementId: 'r2', confidence: 'high', evidence: [ev('resume', '  led 45   ENGINEERS ')] },
  ], material);
  assert.deepEqual(out.map((r) => r.state), ['gap', 'covered']);
});

test('summarize counts and lists must-have gaps; order pins them first', () => {
  const out = decideRequirements(reqs, [
    { requirementId: 'r1', confidence: 'high', evidence: [ev('resume', 'Kubernetes migration')] },
    { requirementId: 'r4', confidence: 'low', evidence: [ev('profile', 'fintech')] },
  ], material);
  const s = summarizeRequirements(out);
  assert.deepEqual({ ...s, mustGaps: s.mustGaps.map((r) => r.id) }, { total: 5, covered: 1, partial: 1, gap: 3, mustGaps: ['r2', 'r3'] });
  assert.deepEqual(orderRequirements(out).map((r) => r.id), ['r2', 'r3', 'r1', 'r5', 'r4']);
});
