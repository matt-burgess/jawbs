// How old a posting is, in whole days. `postedDate` is whatever the job
// page showed: an ISO date (JSON-LD) or LinkedIn's relative text
// ("2 days ago", "Reposted 3 weeks ago", "5 hours ago"). Relative text
// is relative to `asOf`, the moment it was read off the page.
// Returns null when it can't tell.
export function postingAgeDays(postedDate, asOf = Date.now()) {
  if (!postedDate) return null;
  const s = String(postedDate).trim().replace(/^(re)?posted( on)?\s*/i, '');
  if (/^(just now|today)/i.test(s)) return 0;
  if (/^yesterday/i.test(s)) return 1;
  const m = s.match(/^(\d+)\+?\s*(minute|min|hour|hr|day|week|wk|month|mo|year|yr)s?\b/i);
  if (m) {
    const perUnit = { minute: 0, min: 0, hour: 0, hr: 0, day: 1, week: 7, wk: 7, month: 30, mo: 30, year: 365, yr: 365 };
    return Number(m[1]) * perUnit[m[2].toLowerCase()];
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((asOf - t) / 86_400_000));
}

// "1,204 applicants" / "Over 200 people clicked apply" → number, or null.
export function applicantCount(text) {
  const n = parseInt(String(text || '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
