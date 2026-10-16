import test from 'node:test';
import assert from 'node:assert/strict';
import { compVerdict, rangeBar } from '../lib/compVerdict.js';
import { trackRecordLine } from '../lib/calibration.js';

const T = { floor: 140000, target: 155000 };

test('compVerdict answers "is this enough?" from floor and target', () => {
  assert.equal(compVerdict({ low: 160000, high: 288500 }, T).label, 'Clears your target');
  assert.equal(compVerdict({ low: 145000, high: 180000 }, T).label, 'Top end reaches your target');
  assert.equal(compVerdict({ low: 120000, high: 180000 }, T).label, 'Low end under your floor');
  assert.match(compVerdict({ low: 120000, high: 180000 }, T).detail, /top \$180K clears your target/);
  assert.equal(compVerdict({ low: 100000, high: 130000 }, T).tone, 'neg');
  assert.equal(compVerdict({ low: 142000, high: 150000 }, T).label, 'Above floor, under target');
  assert.equal(compVerdict({ low: 150000, high: 150000 }, { floor: 140000 }).label, 'Clears your floor');
  assert.equal(compVerdict({ low: 150000, high: 150000 }, {}), null);           // nothing set → no verdict
  assert.equal(compVerdict({ low: null, high: null }, T), null);
  assert.equal(compVerdict({ low: null, high: 150000 }, T).label, 'Above floor, under target'); // "up to" ranges
});

test('rangeBar places band and ticks on one scale', () => {
  const b = rangeBar({ low: 160000, high: 288500 }, T);
  assert.ok(b.floor < b.target && b.target < b.band.left);
  assert.ok(b.band.left + b.band.width <= 100);
  assert.equal(rangeBar({ low: 1, high: 2 }, {}), null);
});

const job = (fitScore, status, extra = {}) => ({
  status, analyses: { fit: { result: { fitScore } } }, application: { appliedAt: '2026-09-01' }, ...extra,
});

test('trackRecordLine gives exact counts for the score band, or nothing', () => {
  const jobs = [job(82, 'interviewing'), job(78, 'notMovingForward'), job(60, 'archived'), job(62, 'applied', { interviewRounds: [{}] }), job(40, 'notMovingForward')];
  assert.equal(trackRecordLine(jobs, 58), 'Your past 55–74 fits: 1 of 2 got an interview.');
  assert.equal(trackRecordLine(jobs, 90), 'Your past 75+ fits: 1 of 2 got an interview.');
  assert.equal(trackRecordLine(jobs.slice(0, 2), 58), null);                 // under 3 answered
  assert.equal(trackRecordLine([job(82, 'interviewing'), job(78, 'archived'), job(76, 'archived')], 58), null); // none in band
});
