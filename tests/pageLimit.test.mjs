import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTrim, speaksTo, trimNote } from '../lib/pageLimit.js';
import { unitsFromResume } from '../lib/documentUnits.js';

const RESUME = {
  headline: 'Director of Engineering',
  summary: 'Builds platform teams. Ships payments systems. Mentors managers.',
  skills: ['Kubernetes', 'Go', 'Cobol'],
  experience: [
    { title: 'Director', company: 'Acme Pay', dates: '2020 - Present', bullets: ['Led 45 engineers.', 'Ran the migration.'] },
    { title: 'Manager', company: 'Initech', dates: '2016 - 2019', bullets: ['Grew the team.', 'Built the billing system.', 'Ran on-call.'] },
  ],
  earlierExperience: [{ title: 'Engineer', company: 'Globex', dates: '2010 - 2016' }],
};
const POSTING = 'We run Kubernetes and Go at scale.';

// Apply trims until nothing more can go; returns the trims in order.
function exhaust(units, opts) {
  const out = [];
  let u = units.map((x) => ({ ...x }));
  for (let t = nextTrim(u, opts); t; t = nextTrim(u, opts)) {
    out.push(t);
    u = u.map((x) => (x.id !== t.id ? x : t.text != null ? { ...x, text: t.text } : { ...x, removed: true }));
    assert.ok(out.length < 50, 'runaway');
  }
  return { trims: out, units: u };
}

const label = (units, t) => {
  const u = units.find((x) => x.id === t.id);
  return t.text != null ? `summary:${t.text}` : `${u.kind}:${u.meta?.company || u.text}`;
};

test('trim order: oldest role first (bullets, then the role), then unmentioned skills, then summary sentences', () => {
  const units = unitsFromResume(RESUME);
  const { trims } = exhaust(units, { posting: POSTING });
  assert.deepEqual(trims.map((t) => label(units, t)), [
    'role:Globex',
    'bullet:Ran on-call.', 'bullet:Built the billing system.', 'role:Initech',
    'skill:Cobol',
    'summary:Builds platform teams. Ships payments systems.', 'summary:Builds platform teams.',
  ]);
});

test('never removes the header, the most recent role, or skills the posting names', () => {
  const units = unitsFromResume(RESUME);
  const { units: after } = exhaust(units, { posting: POSTING });
  const kept = after.filter((u) => !u.removed).map((u) => u.meta?.company || u.text);
  for (const t of ['Director of Engineering', 'Acme Pay', 'Led 45 engineers.', 'Ran the migration.', 'Kubernetes', 'Go']) assert.ok(kept.includes(t), t);
});

test('a part that speaks to a must-have requirement is kept, and so is its role', () => {
  const units = unitsFromResume(RESUME);
  const { trims } = exhaust(units, { posting: POSTING, mustHaves: ['Ownership of billing systems'] });
  const gone = trims.map((t) => label(units, t));
  assert.ok(!gone.includes('bullet:Built the billing system.'));
  assert.ok(!gone.includes('role:Initech'));
  assert.ok(gone.includes('bullet:Ran on-call.'));
});

test('returns null when nothing can go', () => {
  assert.equal(nextTrim(unitsFromResume({ headline: 'X', experience: [{ title: 'A', bullets: ['One.'] }] })), null);
  assert.equal(nextTrim([]), null);
});

test('speaksTo', () => {
  assert.ok(speaksTo('Led 45 engineers across four teams', '8+ years leading engineering teams'));
  assert.ok(!speaksTo('Ran the billing migration', '8+ years leading engineering teams'));
  assert.ok(speaksTo('Kubernetes at scale', 'Kubernetes'));
});

test('trimNote', () => {
  const units = unitsFromResume(RESUME);
  const { trims } = exhaust(units, { posting: POSTING });
  assert.equal(trimNote(units, trims.slice(0, 4), 1), 'Trimmed 2 roles and 2 bullets to fit one page.');
  assert.equal(trimNote(units, trims.slice(5, 6), 2), 'Trimmed 1 summary sentence to fit 2 pages.');
});

test('a role whose title speaks to a must-have still loses extra bullets, but stays', () => {
  const units = unitsFromResume(RESUME);
  const { trims, units: after } = exhaust(units, { posting: POSTING, mustHaves: ['Managing managers, 5+ years'] });
  const gone = trims.map((t) => label(units, t));
  assert.ok(gone.includes('bullet:Ran on-call.'));
  assert.ok(!gone.includes('role:Initech'));
  assert.equal(after.filter((u) => !u.removed && u.roleId === units.find((x) => x.meta?.company === 'Initech').id).length, 1);
});

test('a one-word skill named in a must-have is kept', () => {
  const units = unitsFromResume(RESUME);
  const { trims } = exhaust(units, { posting: '', mustHaves: ['Kubernetes and AWS at scale'] });
  const gone = trims.map((t) => label(units, t));
  assert.ok(!gone.includes('skill:Kubernetes'));
  assert.ok(gone.includes('skill:Cobol'));
});
