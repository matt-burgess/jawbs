import test from 'node:test';
import assert from 'node:assert/strict';
import { postingAgeDays, applicantCount } from '../lib/freshness.js';

test('postingAgeDays', () => {
  const now = Date.parse('2026-10-12T15:00:00Z');
  assert.equal(postingAgeDays('2 days ago', now), 2);
  assert.equal(postingAgeDays('Reposted 3 weeks ago', now), 21);
  assert.equal(postingAgeDays('5 hours ago', now), 0);
  assert.equal(postingAgeDays('1 month ago', now), 30);
  assert.equal(postingAgeDays('Just now', now), 0);
  assert.equal(postingAgeDays('2026-10-01', now), 11);
  assert.equal(postingAgeDays('2026-10-09T08:00:00.000Z', now), 3);
  assert.equal(postingAgeDays('', now), null);
  assert.equal(postingAgeDays('soon', now), null);
});

test('applicantCount', () => {
  assert.equal(applicantCount('1,204 applicants'), 1204);
  assert.equal(applicantCount('Over 200 people clicked apply'), 200);
  assert.equal(applicantCount(''), null);
});
