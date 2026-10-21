import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepList, FLOW_STEPS } from '../lib/progressSteps.js';

const states = (l) => l.map((s) => `${s.id}:${s.state}`).join(' ');

test('steps before the current one are done, later ones to do', () => {
  assert.equal(states(stepList('analyze-fit', 'extract')), 'fit:done extract:active match:todo');
  assert.equal(states(stepList('analyze-fit', 'match')), 'fit:done extract:done match:active');
});

test('an unknown or missing step shows the first as active', () => {
  assert.equal(states(stepList('analyze-requirements', null)), 'extract:active match:todo');
});

test('the optional retry step shows only once reached', () => {
  assert.equal(states(stepList('generate-letter', 'check')), 'write:done check:active');
  assert.equal(states(stepList('generate-letter', 'retry')), 'write:done check:done retry:active');
});

test('flows without steps return null; step ids are unique within a flow', () => {
  assert.equal(stepList('ask-llm', 'x'), null);
  for (const steps of Object.values(FLOW_STEPS)) assert.equal(new Set(steps.map((s) => s.id)).size, steps.length);
});
