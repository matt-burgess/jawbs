import test from 'node:test';
import assert from 'node:assert/strict';
import { containsTerm, sharedTerms, verifyResume } from '../lib/keywords.js';

const POSTING = `Director of Engineering, Platform
We need a leader with experience in Kubernetes and AWS. You will own stakeholder communication
across product and design; run CI/CD for 40 engineers. Experience with Terraform is a plus.
Strong stakeholder communication, and a record of cross-functional collaboration.`;
const RESUME = `Led platform teams running Kubernetes on AWS. Built CI/CD pipelines.
Known for stakeholder communication with executives. Wrote Go services.`;

test('containsTerm matches whole terms only', () => {
  assert.ok(containsTerm('Wrote Go services', 'go'));
  assert.ok(!containsTerm('Worked at Google', 'Go'));
  assert.ok(containsTerm('C++ and CI/CD', 'c++'));
  assert.ok(containsTerm('stakeholder\n  communication', 'stakeholder communication'));
  assert.ok(!containsTerm('anything', ''));
});

test('sharedTerms finds what both documents say verbatim', () => {
  const shared = sharedTerms(POSTING, RESUME).map((s) => s.toLowerCase());
  for (const t of ['stakeholder communication', 'kubernetes', 'aws', 'ci/cd']) assert.ok(shared.includes(t), t);
  assert.ok(!shared.includes('terraform'));                  // posting only
  assert.ok(!shared.includes('cross-functional collaboration'));
  assert.ok(!shared.includes('experience'));                 // generic
  assert.ok(!shared.includes('communication'));              // swallowed by the longer phrase
  assert.equal(shared[0], 'stakeholder communication');      // repeated multi-word phrase ranks first
});

test('verifyResume checks the output instead of trusting the model', () => {
  const shared = sharedTerms(POSTING, RESUME);
  const v = verifyResume({
    posting: POSTING, masterResume: RESUME, profile: '', shared,
    result: {
      headline: 'Director of Engineering, Platform',
      summary: 'Platform leader. Kubernetes, AWS.',
      skills: ['Kubernetes', 'AWS', 'Terraform'],
      experience: [{ title: 'Director', bullets: ['Ran stakeholder communication for the platform org.'] }],
      vocabularyMirrored: ['stakeholder communication', 'cross-functional collaboration', 'thought leadership'],
      missingKeywords: ['Terraform', 'CI/CD'],
    },
  });
  assert.ok(v.covered.map((s) => s.toLowerCase()).includes('kubernetes'));
  assert.ok(v.missed.includes('CI/CD'));                     // supported, shared, but left off
  assert.equal(v.phrasesVerified, 1);                        // only one is in both posting and resume
  assert.deepEqual(v.unverifiedSkills, ['Terraform']);       // not in the master resume
  assert.deepEqual(v.missing, ['Terraform']);                // CI/CD was wrongly called missing
});

import { factTokens, unsupportedFacts } from '../lib/keywords.js';

test('factTokens normalises the ways a number gets written', () => {
  const keys = (t) => factTokens(t).map((x) => x.key);
  assert.deepEqual(keys('Cut costs 40% and $12M'), ['$12000000', '40%']);
  assert.deepEqual(keys('$12 million budget'), ['$12000000']);
  assert.deepEqual(keys('a 3x improvement'), ['3x']);
  assert.deepEqual(keys('since 2019, 45 engineers, 15+ years'), ['y2019', 'n45', 'n15']);
  assert.deepEqual(keys('SOC 2, Python 3, team of 5'), []);
  assert.deepEqual(keys('2M users'), ['n2000000']);
});

test('unsupportedFacts flags invented and inflated numbers only', () => {
  const source = 'Led 45 engineers at Acme from 2019. Cut cloud spend 30% ($2.1M). 15 years in platform roles.';
  assert.deepEqual(unsupportedFacts('Led 45 engineers since 2019, cutting spend 30%, saving $2.1 million.', source), []);
  assert.deepEqual(unsupportedFacts('Led 60 engineers, cut spend 40% over 15+ years since 2018.', source).sort(), ['2018', '40%', '60']);  // now via factGuard.guard
});
