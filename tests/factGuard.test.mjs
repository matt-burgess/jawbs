import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFacts, buildCorpus, guard, splitUnits, CREDENTIALS } from '../lib/factGuard.js';

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const profile = fx('profile-director.json');
const posting = fx('posting-director.json').posting;
const corpus = buildCorpus({ ...profile, posting: `${posting.title}\n${posting.company}\n${posting.descriptionText}` });
const kinds = (text) => extractFacts(text).map((f) => `${f.kind}:${f.value}`);

test('splitUnits: bullets are units, prose splits into sentences', () => {
  assert.deepEqual(splitUnits('I led teams. They shipped.\n- Cut spend 30%.\n- Hired 6 managers.'),
    ['I led teams.', 'They shipped.', '- Cut spend 30%.', '- Hired 6 managers.']);
});

test('numbers in every format normalise to a value', () => {
  const norm = (t) => extractFacts(t).filter((f) => f.kind === 'number').map((f) => f.normalized);
  assert.deepEqual(norm('Grew to 4,000+ users.'), ['4000']);
  assert.deepEqual(norm('Saved 120k a year.'), ['120000']);
  assert.deepEqual(norm('Budget of $1.2M.'), ['$1200000']);
  assert.deepEqual(norm('Cut cost 30%.'), ['%30']);
  assert.deepEqual(norm('Ran 3-5 teams.'), ['3', '5']);
  assert.deepEqual(norm('A 3x speedup.'), ['x3']);
  assert.deepEqual(norm('SOC 2 and a team of 5.'), []);       // bare single digits are not claims
});

test('years, acronyms, names and credentials', () => {
  assert.deepEqual(kinds('From 2019 to 2021 I ran PCI work.').filter((k) => !k.startsWith('number')), ['year:2019', 'year:2021', 'acronym:PCI']);
  assert.deepEqual(kinds('I worked with Acme Pay and Initech Labs.'), ['name:Acme Pay', 'name:Initech Labs']);
  assert.deepEqual(kinds('At Procter & Gamble I led it.'), ['name:Procter & Gamble']);
  assert.ok(!kinds('Dear Hiring Manager, hello.').some((k) => k.startsWith('name')));   // sentence start + skip list
  assert.ok(kinds('I hold an MBA and the AWS Certified badge.').includes('credential:MBA'));
  assert.ok(kinds('I hold an MBA and the AWS Certified badge.').includes('credential:AWS Certified'));
  assert.ok(!kinds('I hold an MBA.').includes('acronym:MBA'));                          // credential, not acronym
  assert.ok(CREDENTIALS.includes('CISSP'));
});

test('a document built only from the material is clean', () => {
  const letter = `I led 45 engineers across platform and payments at Acme Pay.
I ran the Kubernetes migration for 300 services on AWS, cutting cloud spend 30% ($2.1M a year).
We shipped PCI-DSS Level 1 certification in 2021, and your $2B payments platform is the next step.`;
  assert.deepEqual(guard(letter, corpus), { flags: [], clean: true });
});

test('120k in the letter is backed by 120,000 in the material, within 2%', () => {
  const c = buildCorpus({ masterResume: 'Saved $120,000 a year.' });
  assert.equal(guard('I saved $120k annually.', c).clean, true);
  assert.equal(guard('I saved $121k annually.', c).clean, true);   // within 2%
  assert.equal(guard('I saved $130k annually.', c).clean, false);
});

test('three planted inventions are each flagged on the right unit', () => {
  const letter = `I led 45 engineers at Acme Pay.
I ran the Kubernetes migration for 300 services and grew revenue 40%.
- Earned my CISSP in 2018.
- Partnered with Goldman Sachs on settlement.`;
  const r = guard(letter, corpus);
  assert.equal(r.clean, false);
  const got = r.flags.map((f) => `${f.unit}:${f.kind}:${f.value}`);
  assert.ok(got.includes('1:number:40%'), got.join(' | '));
  assert.ok(got.includes('2:credential:CISSP'), got.join(' | '));
  assert.ok(got.includes('2:year:2018'), got.join(' | '));
  assert.ok(got.includes('3:name:Goldman Sachs'), got.join(' | '));
  assert.ok(!got.some((g) => g.startsWith('0:')), 'first sentence is backed');
  assert.equal(r.flags.find((f) => f.value === 'Goldman Sachs').text, '- Partnered with Goldman Sachs on settlement.');
});
