// Company-site lookup via freehire's public catalogue (freehire.me, MIT,
// github.com/strelov1/freehire): postings crawled straight from companies'
// own ATS pages. Keyless; only the job's title and company are sent.
//
// Matching is deliberately conservative — a wrong link is worse than no
// link. A "match" needs the same company and the same title; anything
// looser is offered as "possible" for the user to pick, never merged.

export const FREEHIRE_API = 'https://freehire.me/api/v1';

// freehire sources that are the employer's own ATS or careers site, from
// its docs/sources.md ("ATS platforms" + "Company career sites"; state job
// boards removed). Aggregators republish postings, so a hit there isn't
// "the company site" and is ignored.
// ponytail: a snapshot — a new ATS freehire adds is ignored until added here.
const DIRECT_SOURCES = new Set('2gis adp alfabank alignerr amazon apple applicantpro apploi ashby ashbygraphql avature aviasales avito bairesdev bamboohr betterteam breezy briefhq bullhorn careerplug careerspage catsone cleverstaff clinch comeet compleo cornerstone dataart deel dodo domclick earcu eightfold emagine enlizt epam erecruiter factorial freshteam gem globalpayments google greenhouse gupy hibob hireology huntflow hurma icims inhire ismartrecruit isolvedhire jazzhr jibe jobscore jobvite join kuper lamoda lever likeit loxo lumenalta luxoft manatal meta micro1 mindsight mts mtslink neogov northstone odoo onstrider opencats oracle ozon pageup paycom paylocity peopleforce personio phenom pinpoint quickin radancy rapyd recruitee recruitingsolutions rippling rwb sber senior smartrecruiters softgarden solides spark speedrun successfactors talentadore talenthr talentlyft taleo tbank teamtailor traffit trakstar uber ukg vention vk vouch workable workablemarketplace workday wpyoast yandex yandexcrowd zohorecruit'.split(' '));

const norm = (s) => String(s || '').toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\b(inc|llc|ltd|corp|corporation|co|company|plc|gmbh|sa|ag|the)\b\.?/g, ' ')
  .replace(/[^a-z0-9+#]+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 1));

function sameCompany(a, b) {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `));
}

function titleSimilarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export const companiesUrl = (company) => `${FREEHIRE_API}/companies?q=${encodeURIComponent(company || '')}&limit=10`;
export const jobsUrl = (title, slug) => `${FREEHIRE_API}/jobs/search?q=${encodeURIComponent(title || '')}&q_fields=title&company_slug=${encodeURIComponent(slug)}&limit=25`;
export const jobUrl = (slug) => `${FREEHIRE_API}/jobs/${encodeURIComponent(slug)}`;

// The catalogue company for a LinkedIn company name: an exact name match
// only. "Stripe" must not resolve to "Stripe Atlas".
export function pickCompany(companies, company) {
  const want = norm(company);
  return (companies || []).find((c) => want && norm(c.name) === want) || null;
}

// From search results, the one posting that is this job — or a short list
// of possibles. Several identical titles at the same company are usually
// one role posted per city; the one in the LinkedIn location wins. If none
// is in that city they are only offered as possibles.
export function pickMatch(results, { title, company, location }) {
  const open = (results || []).filter((r) => !r.closed_at && DIRECT_SOURCES.has(r.source) && sameCompany(r.company, company));
  const exact = open.filter((r) => norm(r.title) === norm(title));
  if (exact.length) {
    const city = norm(String(location || '').split(',')[0]);
    const here = city && exact.find((r) => norm(`${r.location} ${(r.cities || []).join(' ')}`).includes(city));
    // Same title in another city is another job. With no city to go on,
    // or none that agrees, offer them instead of guessing.
    if (here || !city) return { match: here || exact[0], possible: [] };
    return { match: null, possible: exact.slice(0, 3) };
  }
  const possible = open
    .map((r) => ({ r, s: titleSimilarity(r.title, title) }))
    .filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.r);
  return { match: null, possible };
}

// The fields Jawbs uses from a freehire job, flattened. Salary, visa and
// work mode come from freehire's own AI reading of the posting
// ("enrichment"), so the UI attributes them to it.
export function summarize(j) {
  if (!j) return null;
  const e = j.enrichment || {};
  const r = j.reality || {};
  return {
    slug: j.public_slug, url: j.url, source: j.source, title: j.title, company: j.company, location: j.location,
    postedAt: j.posted_at || j.created_at || null, closedAt: j.closed_at || null,
    ageDays: Number.isFinite(r.age_days) ? r.age_days : null,
    repostCount: Number.isFinite(r.repost_count) ? r.repost_count : null,
    realityClass: r.class || null, fakeFreshness: !!r.fake_freshness,
    salary: e.salary_min || e.salary_max
      ? { min: e.salary_min ?? null, max: e.salary_max ?? null, currency: e.salary_currency || null, period: e.salary_period || null }
      : null,
    visaSponsorship: typeof e.visa_sponsorship === 'boolean' ? e.visa_sponsorship : null,
    workMode: j.work_mode || null,
  };
}

// A company-site salary Comp can use: annual USD only — the comp schema
// is annual USD, and converting would be an estimate.
export function usableSalary(site) {
  const s = site?.salary;
  if (!s || s.currency !== 'USD' || (s.period && s.period !== 'year')) return null;
  return s.min || s.max ? { low: s.min ?? s.max, high: s.max ?? s.min } : null;
}
