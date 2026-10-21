import test from 'node:test';
import assert from 'node:assert/strict';
import { refineSuggestions, shortLabel } from '../lib/refineSuggestions.js';

test('shortLabel strips the boilerplate lead and caps length', () => {
  assert.equal(shortLabel('5+ years of experience with Kubernetes at scale.'), 'Kubernetes at scale');
  assert.equal(shortLabel('Proven track record of building high-performing distributed engineering organizations globally'), 'building high-performing distributed engineering organizations globally');
  assert.equal(shortLabel('Strong knowledge of Java, Spring Boot, Kafka, Postgres, Redis and Terraform'), 'Java, Spring Boot, Kafka, Postgres, Redis…');
});

test('chips come from gaps and partials, must-haves first, no covered ones', () => {
  const chips = refineSuggestions([
    { id: 'a', text: 'Fintech domain', kind: 'nice', state: 'gap' },
    { id: 'b', text: 'Experience with Kubernetes', kind: 'must', state: 'gap' },
    { id: 'c', text: 'Led teams of 20+', kind: 'must', state: 'partial' },
    { id: 'd', text: 'Go', kind: 'must', state: 'covered' },
  ]);
  assert.deepEqual(chips.map((c) => c.label), [
    'Address the Kubernetes gap in the letter',
    'Prep for a question on Kubernetes',
    'Add a bullet showing Led teams of 20+',
    'Address the Fintech domain gap in the letter',
    'Prep for a question on Fintech domain',
  ]);
  assert.ok(chips.every((c) => !c.label.includes('Go')));
  assert.match(chips[0].message, /using only my real experience/);
});

test('nothing to suggest when everything is covered; cap respected', () => {
  assert.deepEqual(refineSuggestions([{ id: 'x', text: 'Go', kind: 'must', state: 'covered' }]), []);
  const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: `Skill ${i}`, kind: 'must', state: 'gap' }));
  assert.equal(refineSuggestions(many).length, 6);
});
