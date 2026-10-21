import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchEmail, parseEmail } from '../lib/emailMatch.js';

const job = (jobId, company, title, extra = {}) => ({ jobId, posting: { company, title }, ...extra });
const JOBS = [
  job('1', 'Acme Pay', 'Director of Engineering', { applyLinks: ['https://careers.acmepay.io/jobs/123'] }),
  job('2', 'Stripe', 'Engineering Manager, Payments'),
  job('3', 'Initech', 'VP Engineering', { applyLinks: ['https://boards.greenhouse.io/initech/jobs/9'] }),
  job('4', 'Globex', 'Head of Platform'),
];
const ids = (r) => r.map((c) => c.job.jobId);

test('sender domain seen on a job wins', () => {
  const r = matchEmail({ from: 'Jane Roe <jane@acmepay.io>', subject: 'Next steps', body: 'Hi there' }, JOBS);
  assert.deepEqual(ids(r), ['1']);
  assert.equal(r[0].score, 100);
  assert.match(r[0].reason, /acmepay\.io/);
});

test('sender domain that is the company name', () => {
  const r = matchEmail({ from: 'sam@stripe.com', subject: 'Hello', body: '' }, JOBS);
  assert.deepEqual(ids(r), ['2']);
  assert.equal(r[0].score, 90);
});

test('freemail and shared ATS domains never match by domain', () => {
  assert.deepEqual(matchEmail({ from: 'recruiter@gmail.com', subject: 'Hi', body: '' }, JOBS), []);
  assert.deepEqual(matchEmail({ from: 'no-reply@greenhouse.io', subject: 'Update', body: '' }, JOBS), []);
  assert.deepEqual(matchEmail({ from: 'me@proton.me', subject: '', body: '' }, [job('9', 'Proton', 'Engineer')]), []);
});

test('company name in the sender name or subject', () => {
  const r = matchEmail({ from: 'Initech Talent <talent@gmail.com>', subject: 'Your application', body: '' }, JOBS);
  assert.deepEqual(ids(r), ['3']);
  assert.equal(r[0].score, 60);
  assert.deepEqual(ids(matchEmail({ from: 'x@gmail.com', subject: 'Update from Globex', body: '' }, JOBS)), ['4']);
});

test('title in the opening of the body; not past 300 characters', () => {
  const body = 'Thanks for applying to the Head of Platform role.';
  assert.deepEqual(ids(matchEmail({ from: 'x@gmail.com', subject: 'Thanks', body }, JOBS)), ['4']);
  const late = `${'x '.repeat(200)}Head of Platform`;
  assert.deepEqual(matchEmail({ from: 'x@gmail.com', subject: 'Thanks', body: late }, JOBS), []);
});

test('extra signals add 10; at most three candidates, best first', () => {
  const r = matchEmail({ from: 'jane@acmepay.io', subject: 'Acme Pay: Director of Engineering', body: '' }, JOBS);
  assert.equal(r[0].score, 120);
  const many = Array.from({ length: 6 }, (_, i) => job(String(i), `Co${i}`, 'Staff Engineer'));
  assert.equal(matchEmail({ from: 'x@gmail.com', subject: 'Staff Engineer role', body: '' }, many).length, 3);
});

test('parseEmail: headers when present, else the first address', () => {
  assert.deepEqual(parseEmail('From: Jane <jane@acme.io>\nSubject: Interview\n\nHi Jordan,\nCan we talk?'),
    { from: 'Jane <jane@acme.io>', subject: 'Interview', body: 'Hi Jordan,\nCan we talk?' });
  const p = parseEmail('Jane Roe\njane@acme.io\nto me\n\nHi Jordan');
  assert.equal(p.from, 'jane@acme.io');
  assert.equal(p.subject, '');
  assert.match(p.body, /Hi Jordan/);
});
