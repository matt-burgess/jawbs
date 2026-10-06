// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTransition, normalizeTrackerStage } from '../lib/statuses.js';

const run = (record, kind, extra = {}) =>
  resolveTransition(record, { kind, explicit: true, ...extra }).status;
const rec = (status, more = {}) => ({ status, ...more });

test('save / unsave', () => {
  assert.equal(run(null, 'save'), 'saved');
  assert.equal(run(rec('analyzed'), 'save'), 'saved');
  assert.equal(run(rec('applied'), 'save'), 'applied');
  assert.equal(run(rec('archived'), 'save'), 'saved');
  assert.equal(run(rec('archived'), 'save', { explicit: false }), 'archived');
  assert.equal(run(rec('saved'), 'unsave'), 'analyzed');
  assert.equal(run(rec('applied'), 'unsave'), 'applied');
});

test('apply click is in-progress, not applied', () => {
  assert.equal(run(rec('saved'), 'apply-clicked'), 'inProgressClickedApply');
  assert.equal(run(rec('inProgressDraft'), 'apply-clicked'), 'inProgressClickedApply');
  assert.equal(run(rec('applied'), 'apply-clicked'), 'applied');
  assert.equal(run(rec('interviewing'), 'apply-clicked'), 'interviewing');
});

test('apply confirmed', () => {
  assert.equal(run(rec('inProgressClickedApply'), 'apply-confirmed'), 'applied');
  assert.equal(run(rec('interviewing'), 'apply-confirmed'), 'interviewing');
  assert.equal(run(rec('archived'), 'apply-confirmed'), 'applied');
  assert.equal(run(rec('archived'), 'apply-confirmed', { explicit: false }), 'archived');
  assert.equal(run(rec('saved'), 'apply-confirmed', { explicit: false }), 'applied');
});

test('explicit tracker move sets exactly, either direction', () => {
  assert.equal(run(rec('applied'), 'tracker', { status: 'saved' }), 'saved');
  assert.equal(run(rec('archived'), 'tracker', { status: 'applied' }), 'applied');
  assert.equal(run(rec('saved'), 'tracker', { status: 'notMovingForward' }), 'notMovingForward');
});

test('observed tracker: first sighting never demotes', () => {
  const seen = (r, status) => resolveTransition(r, { kind: 'tracker', explicit: false, status });
  assert.equal(seen(rec('interviewing'), 'applied').status, 'interviewing');
  assert.equal(seen(rec('interviewing'), 'applied').linkedInStage, 'applied');
  assert.equal(seen(rec('archived'), 'saved').status, 'archived');
  assert.equal(seen(rec('saved'), 'applied').status, 'applied');
  assert.equal(seen(rec('saved'), 'archived').status, 'archived');
});

test('observed tracker: after baseline LinkedIn wins both ways', () => {
  const seen = (r, status) => resolveTransition(r, { kind: 'tracker', explicit: false, status });
  assert.equal(seen(rec('applied', { linkedInStage: 'applied' }), 'saved').status, 'saved');
  assert.equal(seen(rec('archived', { linkedInStage: 'archived' }), 'applied').status, 'applied');
  // a falsely detected "applied" is corrected by seeing the job still in Saved
  assert.equal(seen(rec('applied', { linkedInStage: 'saved' }), 'saved').status, 'saved');
  // the In Progress tab doesn't flatten Draft into Clicked Apply
  assert.equal(seen(rec('inProgressDraft', { linkedInStage: 'saved' }), 'inProgressClickedApply').status, 'inProgressDraft');
});

test('status set in Jawbs sticks until the job changes tab on LinkedIn', () => {
  const seen = (r, status) => resolveTransition(r, { kind: 'tracker', explicit: false, status });
  const manual = rec('interviewing', { linkedInStage: 'applied', manualLock: true });
  assert.equal(seen(manual, 'applied').status, 'interviewing');
  const moved = seen(manual, 'archived');
  assert.equal(moved.status, 'archived');
  assert.equal(moved.manualLock, false);
  // manual, never seen on the tracker: baseline only, even for an upgrade
  assert.equal(seen(rec('saved', { manualLock: true }), 'applied').status, 'saved');
});

test('normalizeTrackerStage', () => {
  assert.equal(normalizeTrackerStage('clicked_apply'), 'inProgressClickedApply');
  assert.equal(normalizeTrackerStage('IN_PROGRESS'), 'inProgressClickedApply');
  assert.equal(normalizeTrackerStage('not-moving-forward'), 'notMovingForward');
  assert.equal(normalizeTrackerStage('interview'), 'interviewing');
  assert.equal(normalizeTrackerStage('unknown'), null);
  assert.equal(normalizeTrackerStage(''), null);
});
