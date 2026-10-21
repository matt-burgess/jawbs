import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileStrength } from '../lib/profileStrength.js';

const full = { profile: 'x'.repeat(1500), masterResume: 'x'.repeat(3000), knowledgeBase: 'x'.repeat(2000), writingSamples: 'x'.repeat(1000), prepQuestions: Array(8).fill('Why?') };

test('empty is 0 and points at the biggest gap', () => {
  const r = profileStrength({});
  assert.equal(r.percent, 0);
  assert.equal(r.weakest, 'profile');
});

test('complete is 100 with no hint', () => {
  assert.deepEqual(profileStrength(full), { percent: 100, hint: null, weakest: null });
});

test('weights by presence and length; longer than full counts as full', () => {
  assert.equal(profileStrength({ ...full, knowledgeBase: '' }).percent, 85);
  assert.equal(profileStrength({ ...full, profile: 'x'.repeat(750) }).percent, 85);
  assert.equal(profileStrength({ ...full, masterResume: 'x'.repeat(9000) }).percent, 100);
  assert.equal(profileStrength({ ...full, prepQuestions: ['a', ' ', 'b', 'c'] }).percent, 94);
});

test('the hint names the single emptiest section', () => {
  const r = profileStrength({ ...full, writingSamples: 'x'.repeat(100), knowledgeBase: 'x'.repeat(1800) });
  assert.equal(r.weakest, 'writingSamples');
  assert.match(r.hint, /sound like you/);
  assert.equal(profileStrength({ ...full, knowledgeBase: '', writingSamples: '' }).weakest, 'knowledgeBase');
});
