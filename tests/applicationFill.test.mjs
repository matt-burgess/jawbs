import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldKey, yesNoKey, buildValues, pickOption } from '../lib/applicationFill.js';

test('fieldKey reads labels the way the major ATSs write them', () => {
  const k = (label, hint = '', autocomplete = '') => fieldKey({ label, hint, autocomplete });
  assert.equal(k('First Name *'), 'firstName');
  assert.equal(k('Last name'), 'lastName');
  assert.equal(k('Full name'), 'fullName');
  assert.equal(k('Name'), 'fullName');
  assert.equal(k('Email address'), 'email');
  assert.equal(k('Phone'), 'phone');
  assert.equal(k('Phone type'), null);
  assert.equal(k('LinkedIn Profile URL'), 'linkedin');
  assert.equal(k('Website'), 'website');
  assert.equal(k('GitHub URL'), 'github');
  assert.equal(k('City'), 'city');
  assert.equal(k('Zip / Postal code'), 'postalCode');
  assert.equal(k('Current company'), 'currentCompany');
  assert.equal(k('Location (City)'), 'location');
  assert.equal(k('What are your salary expectations?'), 'salaryExpectation');
  // hints and autocomplete carry it when the label is missing or odd
  assert.equal(k('', 'legalNameSection_firstName'), 'firstName');
  assert.equal(k('', 'job_application[last_name]'), 'lastName');
  assert.equal(k('Whatever', '', 'section-a given-name'), 'firstName');
  // never fill someone else's details, or an essay box
  assert.equal(k("Reference's email"), null);
  assert.equal(k('Emergency contact phone'), null);
  assert.equal(k('Previous employer'), null);
  assert.equal(k('Tell us about a time you led a team through a difficult migration and what your company learned from it.'), null);
  assert.equal(k('Why do you want to work here?'), null);
});

test('yesNoKey', () => {
  assert.equal(yesNoKey('Are you legally authorized to work in the United States?'), 'workAuthorized');
  assert.equal(yesNoKey('Will you now or in the future require sponsorship for employment visa status?'), 'needsSponsorship');
  assert.equal(yesNoKey('Are you authorized to work in the US without sponsorship?'), 'authNoSponsor');
  assert.equal(yesNoKey('Have you worked here before?'), null);
});

test('buildValues', () => {
  const v = buildValues({
    name: 'Matt Burgess', email: 'm@example.com', phone: '', location: 'Austin, TX', linkedInUrl: 'https://linkedin.com/in/m',
    profile: { country: 'United States', workAuthorized: 'Yes', needsSponsorship: 'No', website: '' },
  });
  assert.equal(v.firstName, 'Matt');
  assert.equal(v.lastName, 'Burgess');
  assert.equal(v.city, 'Austin');
  assert.equal(v.state, 'TX');
  assert.equal(v.authNoSponsor, 'Yes');
  assert.ok(!('phone' in v) && !('website' in v));     // blanks are dropped, so those fields are left alone
  assert.equal(buildValues({ profile: { workAuthorized: 'Yes' } }).authNoSponsor, undefined); // half an answer is no answer
  assert.equal(buildValues({ profile: { workAuthorized: 'Yes', needsSponsorship: 'Yes' } }).authNoSponsor, 'No');
});

test('pickOption', () => {
  const opts = (...t) => t.map((text) => ({ text, value: '' }));
  assert.equal(pickOption(opts('Select…', 'Yes', 'No'), 'No'), 2);
  assert.equal(pickOption(opts('Yes, I am authorized', 'No, I am not'), 'Yes'), 0);
  assert.equal(pickOption(opts('Canada', 'United States of America'), 'United States'), 1);
  assert.equal(pickOption([{ text: 'Texas', value: 'TX' }], 'tx'), 0);
  assert.equal(pickOption(opts('Maybe'), 'Yes'), -1);
  assert.equal(pickOption(opts('Yes'), ''), -1);
});

test('the Comp pay answer beats the saved salary and feeds the short answer', async () => {
  const { buildValues } = await import('../lib/applicationFill.js');
  const v = buildValues({ profile: { salaryExpectation: '150000' }, pay: { number: 270000, short: 'I am targeting $260K to $290K.' } });
  assert.equal(v.salaryExpectation, '270000');
  assert.equal(v.salaryShort, 'I am targeting $260K to $290K.');
  assert.equal(buildValues({ profile: { salaryExpectation: '150000' } }).salaryExpectation, '150000');
});
