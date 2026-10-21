import test from 'node:test';
import assert from 'node:assert/strict';
import { pickMatch, pickCompany, summarize, usableSalary } from '../lib/freehire.js';

const job = (title, company, extra = {}) => ({ public_slug: `${title}-${company}`.toLowerCase().replace(/\W+/g, '-'), title, company, location: 'Remote', closed_at: null, source: 'greenhouse', ...extra });

test('exact title at the same company is a match', () => {
  const r = pickMatch([job('Director of Engineering', 'Acme, Inc.'), job('Director of Engineering', 'Acme Labs')], { title: 'Director of Engineering', company: 'Acme' });
  assert.equal(r.match.company, 'Acme, Inc.');
});

test('one role posted per city: the LinkedIn city wins', () => {
  const r = pickMatch([job('Staff Engineer', 'Globex', { location: 'Austin, TX' }), job('Staff Engineer', 'Globex', { location: 'Seattle, WA' })],
    { title: 'Staff Engineer', company: 'Globex', location: 'Seattle, WA' });
  assert.equal(r.match.location, 'Seattle, WA');
});

test('near titles are only offered, never matched', () => {
  const r = pickMatch([job('Senior Director of Engineering', 'Acme'), job('Director, Platform Engineering', 'Acme'), job('Barista', 'Acme')],
    { title: 'Director of Engineering', company: 'Acme' });
  assert.equal(r.match, null);
  assert.deepEqual(r.possible.map((x) => x.title), ['Senior Director of Engineering', 'Director, Platform Engineering']);
});

test('another company or a closed posting never matches', () => {
  assert.equal(pickMatch([job('Director of Engineering', 'Initech')], { title: 'Director of Engineering', company: 'Acme' }).match, null);
  assert.equal(pickMatch([job('Director of Engineering', 'Acme', { closed_at: '2026-10-01' })], { title: 'Director of Engineering', company: 'Acme' }).match, null);
});

test('summarize and usableSalary', () => {
  const s = summarize({ public_slug: 'x', url: 'https://boards.greenhouse.io/acme/jobs/1', source: 'greenhouse', posted_at: '2026-09-01T00:00:00Z',
    reality: { class: 'stale', age_days: 48, repost_count: 2, fake_freshness: true },
    enrichment: { salary_min: 160000, salary_max: 220000, salary_currency: 'USD', salary_period: 'year', visa_sponsorship: false } });
  assert.equal(s.ageDays, 48);
  assert.equal(s.fakeFreshness, true);
  assert.equal(s.visaSponsorship, false);
  assert.deepEqual(usableSalary(s), { low: 160000, high: 220000 });
  assert.equal(usableSalary({ salary: { min: 90000, max: 130000, currency: 'EUR', period: 'year' } }), null);
  assert.equal(usableSalary({ salary: { min: 50, max: 70, currency: 'USD', period: 'hour' } }), null);
});

test('aggregator reposts are not the company site', () => {
  assert.equal(pickMatch([job('Director of Engineering', 'Acme', { source: 'adzuna' })], { title: 'Director of Engineering', company: 'Acme' }).match, null);
});

test('pickCompany wants the exact company', () => {
  const cs = [{ slug: 'stripe-atlas', name: 'Stripe Atlas' }, { slug: 'stripe', name: 'Stripe' }];
  assert.equal(pickCompany(cs, 'Stripe').slug, 'stripe');
  assert.equal(pickCompany(cs, 'Stripe, Inc.').slug, 'stripe');
  assert.equal(pickCompany([{ slug: 'stripe-atlas', name: 'Stripe Atlas' }], 'Stripe'), null);
});
