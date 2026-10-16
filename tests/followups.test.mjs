import test from 'node:test';
import assert from 'node:assert/strict';
import { quietness, followUpDue, isStale } from '../lib/followups.js';

const now = Date.parse('2026-10-16T12:00:00Z');
const daysAgo = (n) => new Date(now - n * 86_400_000).toISOString();

test('only applications waiting to hear back are quiet', () => {
  assert.equal(quietness({ status: 'saved', statusUpdatedAt: daysAgo(30) }, now), null);
  assert.equal(quietness({ status: 'interviewing', statusUpdatedAt: daysAgo(30) }, now), null);
});

test('any dated contact resets the clock; follow-ups are counted', () => {
  const job = {
    status: 'applied', application: { appliedAt: daysAgo(30) },
    timeline: [{ at: daysAgo(30), type: 'status-change' }, { at: daysAgo(12), type: 'followup' }],
  };
  assert.deepEqual({ ...quietness(job, now), lastAt: undefined }, { daysQuiet: 12, followUps: 1, lastAt: undefined });
  assert.equal(followUpDue(quietness(job, now)), true);
});

test('at most two follow-ups; stale after 60 days', () => {
  const two = { status: 'applied', timeline: [{ at: daysAgo(70), type: 'followup' }, { at: daysAgo(65), type: 'followup' }] };
  assert.equal(followUpDue(quietness(two, now)), false);
  assert.equal(isStale(quietness(two, now)), true);
  const fresh = { status: 'applied', statusUpdatedAt: daysAgo(3) };
  assert.equal(followUpDue(quietness(fresh, now)), false);
  assert.equal(isStale(quietness(fresh, now)), false);
});
