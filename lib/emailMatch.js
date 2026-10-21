// Which saved job a pasted recruiter email is about. Pure, no I/O.
// Order after Dossier's mail matching (github.com/AienTech/dossier,
// AGPL-3.0); reimplemented, no code copied.

const FREEMAIL = new Set(['gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'msn', 'yahoo', 'ymail', 'aol', 'icloud', 'me', 'mac',
  'proton', 'protonmail', 'pm', 'gmx', 'mail', 'zoho', 'fastmail', 'hey', 'tutanota', 'yandex']);
// Hosts that carry many employers' postings or mail, so they say nothing
// about which company this is.
const SHARED = new Set(['linkedin', 'greenhouse', 'lever', 'myworkdayjobs', 'workday', 'ashbyhq', 'smartrecruiters', 'icims', 'jobvite',
  'bamboohr', 'workable', 'indeed', 'google', 'glassdoor', 'freehire', 'recruitee', 'teamtailor', 'breezy', 'jazzhr', 'successfactors', 'taleo']);

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const squash = (s) => norm(s).replace(/\b(inc|llc|ltd|corp|corporation|co|limited|gmbh|group|technologies|labs)\b/g, '').replace(/\s+/g, '');

// ponytail: last two labels as the company domain; wrong for co.uk-style
// suffixes (acme.co.uk → co.uk). Use a public-suffix list if that matters.
function baseDomain(host) {
  const labels = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  return labels.length >= 2 ? labels.slice(-2).join('.') : '';
}
const brand = (domain) => domain.split('.')[0];
const isCompanyDomain = (d) => d && !FREEMAIL.has(brand(d)) && !SHARED.has(brand(d));

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Company mail domains this job has shown us: its apply links, the
// employer's own careers site, the application page.
function jobDomains(job) {
  const urls = [...(job.applyLinks || []).map((l) => (typeof l === 'string' ? l : l?.url)), job.companySite?.match?.url, job.application?.url,
    ...(job.hiringTeam || []).map((p) => p?.profileUrl || p?.url)];
  return new Set(urls.map((u) => baseDomain(hostOf(u))).filter(isCompanyDomain));
}

// "From:" and "Subject:" lines if the paste has them; otherwise the first
// address in the opening lines is the sender. The rest is the body.
export function parseEmail(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let from = '';
  let subject = '';
  const body = [];
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^\s*(from|subject)\s*:\s*(.*)$/i);
    if (m && i < 15 && !(m[1].toLowerCase() === 'from' ? from : subject)) {
      if (m[1].toLowerCase() === 'from') from = m[2].trim(); else subject = m[2].trim();
      continue;
    }
    body.push(line);
  }
  if (!from) from = lines.slice(0, 6).find((l) => /[\w.+-]+@[\w-]+\.[\w.-]+/.test(l))?.trim() || '';
  return { from, subject, body: body.join('\n').trim() };
}

const senderAddress = (from) => (String(from).match(/[\w.+-]+@([\w-]+\.[\w.-]+)/) || [])[1] || '';
const displayName = (from) => String(from).replace(/<[^>]*>/g, '').replace(/[\w.+-]+@[\w.-]+/g, '').replace(/["']/g, '').trim();

// → up to three [{ job, score, reason }], best first. Signals:
//   100  sender's domain is one this job has shown (apply link, careers site)
//    90  sender's domain is the company's name (jane@stripe.com, "Stripe")
//    60  company name in the sender's name or the subject
//    40  job title in the subject or the opening of the body
// A job's score is its strongest signal plus 10 for each other one.
export function matchEmail({ from = '', subject = '', body = '' }, jobs) {
  const domain = baseDomain(senderAddress(from));
  const company = isCompanyDomain(domain) ? domain : '';
  const who = norm(`${displayName(from)} ${subject}`);
  const opening = norm(`${subject} ${String(body).slice(0, 300)}`);
  const out = [];
  for (const job of jobs || []) {
    const p = job.posting || {};
    const signals = [];
    if (company && jobDomains(job).has(company)) signals.push([100, `Sent from ${company}, a domain on this job's links`]);
    else if (company && squash(p.company) && squash(p.company) === brand(company).replace(/-/g, '')) signals.push([90, `Sent from ${company}`]);
    const name = norm(p.company);
    if (name && (` ${who} `).includes(` ${name} `)) signals.push([60, `${p.company} is in the sender or subject`]);
    const title = norm(p.title);
    if (title && (` ${opening} `).includes(` ${title} `)) signals.push([40, `"${p.title}" is in the email`]);
    if (!signals.length) continue;
    signals.sort((a, b) => b[0] - a[0]);
    out.push({ job, score: signals[0][0] + 10 * (signals.length - 1), reason: signals.map((s) => s[1]).join('; ') });
  }
  return out.sort((a, b) => b.score - a.score || Date.parse(b.job.updatedAt || 0) - Date.parse(a.job.updatedAt || 0)).slice(0, 3);
}
