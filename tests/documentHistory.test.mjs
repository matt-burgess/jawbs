import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDoc, commit, undo, undoTarget, restore, docFromJob, MAX_VERSIONS } from '../lib/documentHistory.js';

const U = (t) => [{ id: 'u1', kind: 'opening', text: t }];

test('commit adds a version and makes it current, without mutating', () => {
  const d1 = newDoc(U('a'));
  const d2 = commit(d1, U('b'), 'edited', 'typo');
  assert.equal(d1.versions.length, 1);
  assert.equal(d1.units[0].text, 'a');
  assert.equal(d2.versions.length, 2);
  assert.equal(d2.current, 'v2');
  assert.deepEqual(d2.versions.map((v) => v.cause), ['written', 'edited']);
  assert.equal(d2.versions[1].note, 'typo');
  assert.equal(d2.units[0].text, 'b');
});

test('undo walks back one version per call and stops at the first', () => {
  let d = newDoc(U('a'));
  d = commit(d, U('b'), 'refined', 'make it shorter');
  d = commit(d, U('c'), 'regenerated');
  d = undo(d);
  assert.equal(d.units[0].text, 'b');
  assert.equal(d.versions.at(-1).cause, 'undone');
  d = undo(d);
  assert.equal(d.units[0].text, 'a');
  assert.equal(undoTarget(d), null);
  assert.equal(undo(d), d);
});

test('restore snapshots what was showing, then brings the version back', () => {
  let d = newDoc(U('a'));
  d = commit(d, U('b'), 'edited');
  d = restore(d, 'v1');
  assert.deepEqual(d.versions.slice(-2).map((v) => v.cause), ['beforeRestore', 'restored']);
  assert.equal(d.versions.at(-2).units[0].text, 'b');
  assert.equal(d.units[0].text, 'a');
  // Undoing the restore lands on the snapshot.
  assert.equal(undo(d).units[0].text, 'b');
  assert.equal(restore(d, 'nope'), d);
});

test('keeps at most 25 versions, dropping the oldest', () => {
  let d = newDoc(U('0'));
  for (let i = 1; i <= 30; i++) d = commit(d, U(String(i)), 'edited');
  assert.equal(d.versions.length, MAX_VERSIONS);
  assert.equal(d.versions[0].units[0].text, '6');
  assert.equal(d.current, d.versions.at(-1).id);
  assert.equal(d.units[0].text, '30');
});

test('docFromJob: stored doc wins; old string letter becomes version 1, written', () => {
  const stored = newDoc(U('x'));
  assert.equal(docFromJob({ documents: { letter: stored } }, 'letter'), stored);
  const job = { analyses: { coverLetter: { generatedAt: '2026-01-01T00:00:00.000Z', result: { letter: 'Your team caught my eye.\n\nWe grew 40% in a year.' },
    factGuard: { flags: [{ value: '40%', text: 'We grew 40% in a year.' }] } } } };
  const d = docFromJob(job, 'letter');
  assert.equal(d.versions.length, 1);
  assert.equal(d.versions[0].cause, 'written');
  assert.equal(d.versions[0].at, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(d.units.map((u) => u.kind), ['opening', 'closing']);
  assert.equal(d.units[1].flags[0].value, '40%');
  assert.equal(docFromJob({}, 'resume'), null);
});
