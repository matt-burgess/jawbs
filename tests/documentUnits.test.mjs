import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitResume, splitLetter, joinUnits, diffUnits, unitsFromResume, resumeFromUnits, applyRefine, keptUnits } from '../lib/documentUnits.js';

const ws = (s) => s.replace(/\s+/g, ' ').trim();

const RESUMES = {
  allCaps: `Jordan Lee
SUMMARY
Engineering director who builds platform teams.
EXPERIENCE
Director of Engineering, Acme Pay, Jan 2020 - Present
- Led 45 engineers across four teams.
- Cut deploy time from 2 hours to 9 minutes.
Engineering Manager, Initech, 2016 - 2019
- Grew the team from 6 to 18.
SKILLS
- Kubernetes
- Go
EDUCATION
B.S. Computer Science, State University`,
  markdown: `Jordan Lee
## Summary
Engineering leader.
## Experience
Acme Pay | Director | 2020 - present
Seattle, WA
* Ran the Kubernetes migration.
* Hired 20 engineers.
## Certifications
* AWS Certified Solutions Architect`,
  colons: `Jordan Lee, Director of Engineering
Profile:
Builds teams that ship.
Work history:
Initech 2012 - 2016
• Built the billing service.
• Ran on-call for 30 services.
Skills:
Go, Python, Postgres`,
};

for (const [name, text] of Object.entries(RESUMES)) {
  test(`splitResume round-trips (${name})`, () => {
    assert.equal(ws(joinUnits(splitResume(text))), ws(text));
  });
}

test('splitResume kinds: header, headings, roles, bullets tied to their role', () => {
  const u = splitResume(RESUMES.allCaps);
  assert.equal(u[0].kind, 'header');
  assert.deepEqual(u.filter((x) => x.kind === 'sectionHeading').map((x) => x.text), ['SUMMARY', 'EXPERIENCE', 'SKILLS', 'EDUCATION']);
  const roles = u.filter((x) => x.kind === 'role');
  assert.equal(roles.length, 2);
  const bullets = u.filter((x) => x.kind === 'bullet');
  assert.deepEqual(bullets.map((b) => b.roleId), [roles[0].id, roles[0].id, roles[1].id]);
  assert.deepEqual(u.filter((x) => x.kind === 'skill').map((x) => x.text), ['Kubernetes', 'Go']);
  assert.equal(u.find((x) => x.kind === 'summary').text, 'Engineering director who builds platform teams.');
});

test('splitResume: undated line under Experience stays with its role', () => {
  const u = splitResume(RESUMES.markdown);
  const role = u.find((x) => x.kind === 'role');
  assert.equal(u.find((x) => x.text === 'Seattle, WA').roleId, role.id);
});

const LETTERS = {
  withGreeting: `Dear Hiring Team,

Your payments platform is solving the problem I have worked on for five years.

At Acme Pay I led the migration of 300 services.

In my first 90 days I would map the on-call load.

Best,
Jordan`,
  bare: `Your team caught my eye because of the billing rewrite.

I would welcome a conversation.`,
};

for (const [name, text] of Object.entries(LETTERS)) {
  test(`splitLetter round-trips (${name})`, () => {
    assert.equal(ws(joinUnits(splitLetter(text))), ws(text));
  });
}

test('splitLetter kinds', () => {
  assert.deepEqual(splitLetter(LETTERS.withGreeting).map((u) => u.kind), ['greeting', 'opening', 'body', 'closing', 'signoff']);
  assert.deepEqual(splitLetter(LETTERS.bare).map((u) => u.kind), ['opening', 'closing']);
  assert.deepEqual(splitLetter('One paragraph.').map((u) => u.kind), ['opening']);
});

test('joinUnits leaves removed units out; letters join with blank lines', () => {
  const u = splitLetter(LETTERS.bare);
  assert.equal(joinUnits(u), `${u[0].text}\n\n${u[1].text}`);
  assert.equal(joinUnits([{ ...u[0], removed: true }, u[1]]), u[1].text);
});

test('diffUnits', () => {
  const a = [{ id: 'u1', text: 'a' }, { id: 'u2', text: 'b' }, { id: 'u3', text: 'c' }];
  const b = [{ id: 'u1', text: 'a' }, { id: 'u2', text: 'B' }, { id: 'u3', text: 'c', removed: true }, { id: 'n1', text: 'd' }];
  assert.deepEqual(diffUnits(a, b), { added: ['n1'], removed: [], changed: ['u2', 'u3'] });
  assert.deepEqual(diffUnits(b, a).removed, ['n1']);
});

const STRUCTURED = {
  headline: 'Director of Engineering',
  summary: 'Builds platform teams.',
  skills: ['Kubernetes', 'Go'],
  experience: [
    { title: 'Director', company: 'Acme Pay', location: 'Seattle, WA', dates: '2020 - Present', bullets: ['Led 45 engineers.', 'Ran the migration.'] },
    { title: 'Manager', company: 'Initech', location: 'Austin, TX', dates: '2016 - 2019', bullets: ['Grew the team.'] },
  ],
  earlierExperience: [{ title: 'Engineer', company: 'Globex', detail: null, location: 'Remote', dates: '2010 - 2016' }],
  certifications: ['CKA'],
  education: [{ degree: 'B.S. Computer Science', school: 'State University' }],
};

test('structured resume: units and back give the same resume', () => {
  const back = resumeFromUnits(unitsFromResume(STRUCTURED));
  assert.deepEqual(back.experience, STRUCTURED.experience);
  assert.deepEqual(back.earlierExperience, [{ title: 'Engineer', company: 'Globex', location: 'Remote', dates: '2010 - 2016' }]);
  for (const k of ['headline', 'summary', 'skills', 'certifications', 'education']) assert.deepEqual(back[k], STRUCTURED[k]);
});

test('resumeFromUnits drops removed units and the bullets of a removed role', () => {
  const u = unitsFromResume(STRUCTURED);
  const initech = u.find((x) => x.kind === 'role' && x.meta.company === 'Initech');
  initech.removed = true;
  u.find((x) => x.text === 'Ran the migration.').removed = true;
  const back = resumeFromUnits(u);
  assert.equal(back.experience.length, 1);
  assert.deepEqual(back.experience[0].bullets, ['Led 45 engineers.']);
});

test('unitsFromResume reads the old v1 shape', () => {
  const u = unitsFromResume({ summaryParagraph: 'Old summary.', sections: [{ heading: 'Experience', entries: [{ role: 'Director, Acme', bullets: [{ text: 'Did a thing.' }] }] }] });
  assert.deepEqual(u.map((x) => x.kind), ['summary', 'role', 'bullet']);
  assert.equal(resumeFromUnits(u).experience[0].bullets[0], 'Did a thing.');
});

test('applyRefine: edits, adds a bullet under the right role, removes; ignores bad ids and fixed kinds', () => {
  const u = unitsFromResume(STRUCTURED);
  const bullet = u.find((x) => x.text === 'Led 45 engineers.');
  const role = u.find((x) => x.kind === 'role');
  bullet.flags = [{ value: '45' }];
  const { units, touched } = applyRefine(u, {
    edits: [{ id: bullet.id, text: 'Led 40 engineers.' }, { id: role.id, text: 'CTO' }, { id: 'zz', text: 'x' }],
    add: [{ after: bullet.id, kind: 'bullet', text: 'Hired 12 engineers.' }, { after: bullet.id, kind: 'body', text: 'nope' }],
    remove: [u.find((x) => x.text === 'CKA').id],
  });
  const added = units.find((x) => x.text === 'Hired 12 engineers.');
  assert.equal(added.roleId, role.id);
  assert.equal(units[units.indexOf(added) - 1].id, bullet.id);
  assert.equal(units.find((x) => x.id === bullet.id).flags, undefined);
  assert.equal(units.find((x) => x.id === role.id).text, role.text);
  assert.ok(units.find((x) => x.text === 'CKA').removed);
  assert.equal(touched.length, 3);
  assert.equal(new Set(units.map((x) => x.id)).size, units.length);
  assert.equal(u.find((x) => x.id === bullet.id).text, 'Led 45 engineers.');
});

test('keptUnits and joinUnits drop bullets of a removed role', () => {
  const u = splitResume(RESUMES.allCaps);
  const role = u.find((x) => x.kind === 'role');
  role.removed = true;
  const text = joinUnits(u);
  assert.ok(!text.includes('Led 45 engineers'));
  assert.ok(text.includes('Grew the team from 6 to 18.'));
  assert.equal(keptUnits(u).filter((x) => x.roleId === role.id).length, 0);
});
