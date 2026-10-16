// Field recognition for application-form autofill (content/externalFill.js).
// Pure functions, no DOM — the content script describes a field (its
// label, name/id hints, autocomplete token) and this decides which piece
// of the user's saved profile belongs there, if any.
//
// Deliberately label-driven rather than per-ATS selectors: Greenhouse,
// Lever, Ashby, Workday and the rest all label "First name" in words, and
// words survive their redesigns better than class names do.
//
// ponytail: recognises single-value fields only. Repeating sections (work
// history, education) are left alone — every ATS that asks for them also
// offers its own "autofill from resume" upload, which does it better.

// Fields about somebody else. "Reference's email" must never get ours.
const NOT_ME = /referr|reference|emergency|recruiter|hiring manager|school|universit|degree|previous|former|spouse|parent|guardian|supervisor/i;

// HTML autocomplete tokens → profile key. The most reliable signal when present.
const AUTOCOMPLETE = {
  'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName',
  email: 'email', tel: 'phone', 'tel-national': 'phone',
  'street-address': 'street', 'address-line1': 'street',
  'address-level2': 'city', 'address-level1': 'state',
  'postal-code': 'postalCode', country: 'country', 'country-name': 'country',
  organization: 'currentCompany', 'organization-title': 'currentTitle',
};

// [key, pattern]. Order matters: specific before general ("LinkedIn URL"
// before "URL", "first name" before "name").
const TEXT_RULES = [
  ['firstName', /\b(first|given)[\s_-]*name\b|\bfname\b/i],
  ['lastName', /\b(last|family)[\s_-]*name\b|\bsurname\b|\blname\b/i],
  ['fullName', /\b(full|legal|your)[\s_-]*name\b|^name\b/i],
  ['email', /\be-?mail\b/i],
  ['phone', /\b(phone|mobile|cell)\b(?!.*\b(type|extension|country code)\b)/i],
  ['linkedin', /linked\s*in/i],
  ['github', /git\s*hub/i],
  ['website', /\b(website|portfolio)\b|personal (site|url)|\burl\b/i],
  ['location', /\blocation\b|where are you (based|located)/i],
  ['street', /\bstreet\b|address[\s_-]*(line[\s_-]*)?1\b|^address$/i],
  ['postalCode', /\b(zip|postal)\b/i],
  ['city', /\bcity\b|\btown\b/i],
  ['state', /\bstate\b|\bprovince\b/i],
  ['country', /\bcountry\b(?!.*\bcode\b)/i],
  ['currentCompany', /current (company|employer)|\b(company|employer)\b/i],
  ['currentTitle', /current (job )?(title|role|position)|\bjob title\b|^title$/i],
  ['salaryExpectation', /\b(salary|compensation)\b|desired pay|pay (expectation|requirement)/i],
  ['noticePeriod', /notice period|when (can|could) you start|available to start|\bstart date\b/i],
];

// Split camelCase and separators so "legalNameSection_firstName" reads as words.
const words = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.[\]]+/g, ' ');

// Which profile value goes in a free-text or dropdown field. `label` is
// the visible question; `hint` is name/id/automation-id. A long label is
// an essay question, not a field name, so it's never matched as text.
export function fieldKey({ label = '', hint = '', autocomplete = '' }) {
  const auto = AUTOCOMPLETE[String(autocomplete).trim().toLowerCase().split(/\s+/).pop()];
  if (auto) return auto;
  const l = String(label).trim();
  const h = words(hint);
  if (NOT_ME.test(l) || NOT_ME.test(h)) return null;
  for (const text of [l.length <= 80 ? l : '', h]) {
    if (!text) continue;
    const rule = TEXT_RULES.find(([, re]) => re.test(text));
    if (rule) return rule[0];
  }
  return null;
}

// Which yes/no answer a question is asking for, or null.
//   workAuthorized    "Are you legally authorized to work in the US?"
//   needsSponsorship  "Will you now or in the future require sponsorship?"
//   authNoSponsor     "Are you authorized to work without sponsorship?" — both at once
export function yesNoKey(question) {
  const q = String(question || '');
  if (NOT_ME.test(q)) return null;
  const auth = /authori[sz]ed to work|(legally|lawfully) (authori[sz]ed|eligible|permitted|able)|eligible to work|right to work/i.test(q);
  const sponsor = /sponsor/i.test(q);
  if (auth && sponsor) return 'authNoSponsor';
  if (sponsor) return 'needsSponsorship';
  if (auth) return 'workAuthorized';
  return null;
}

// Flattens saved settings into the values the rules above refer to.
// Blank values are dropped, so a field with nothing saved is simply left.
// ponytail: first word is the first name, the rest the last name — wrong
// for "Mary Ann Smith". Add explicit first/last fields if that bites.
export function buildValues({ name = '', email = '', phone = '', location = '', linkedInUrl = '', profile = {} }) {
  const [first, ...rest] = name.trim().split(/\s+/).filter(Boolean);
  const [city, state] = location.split(',').map((s) => s.trim());
  const yn = (v) => (v === 'Yes' || v === 'No' ? v : '');
  const auth = yn(profile.workAuthorized);
  const sponsor = yn(profile.needsSponsorship);
  const values = {
    firstName: first, lastName: rest.join(' '), fullName: name.trim(),
    email, phone, linkedin: linkedInUrl, location,
    city, state,
    street: profile.street, postalCode: profile.postalCode, country: profile.country,
    website: profile.website, github: profile.github,
    currentCompany: profile.currentCompany, currentTitle: profile.currentTitle,
    salaryExpectation: profile.salaryExpectation, noticePeriod: profile.noticePeriod,
    workAuthorized: auth, needsSponsorship: sponsor,
    authNoSponsor: auth && sponsor ? (auth === 'Yes' && sponsor === 'No' ? 'Yes' : 'No') : '',
  };
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v));
}

// Index of the dropdown/radio option that means `want`, or -1. Exact
// match first; "Yes"/"No" also match longer options that start with the
// word ("Yes, I am authorized"); the US matches its common spellings.
export function pickOption(options, want) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const w = norm(want);
  if (!w) return -1;
  const opts = options.map((o) => ({ text: norm(o.text), value: norm(o.value) }));
  let i = opts.findIndex((o) => o.text === w || o.value === w);
  if (i < 0 && (w === 'yes' || w === 'no')) i = opts.findIndex((o) => new RegExp(`^${w}\\b`).test(o.text));
  if (i < 0 && /^(us|usa|u\.s\.a?\.?|united states( of america)?)$/.test(w)) {
    i = opts.findIndex((o) => /^united states( of america)?$/.test(o.text) || o.value === 'us' || o.value === 'usa');
  }
  return i;
}
