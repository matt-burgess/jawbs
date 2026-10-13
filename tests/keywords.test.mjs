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
