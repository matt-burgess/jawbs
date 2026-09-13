// Fetch a LinkedIn /jobs/view/{id} page from the service worker and extract
// posting fields. Uses the browser session cookies via credentials: 'include'.
// Politeness: caller should throttle. If LinkedIn returns a login redirect or
// error page, we mark the job as posting-archived so it isn't retried forever.

const PARSER_URL_PREFIX = 'https://www.linkedin.com/jobs/view/';

// Simple in-memory rate limit — no more than N fetches per rolling
// minute per SW lifetime. Enrich is authenticated with the user's
// LinkedIn cookies via `credentials: 'include'`; without a limit a
// runaway loop or a spoofed enrich message could hammer LinkedIn from
// the user's session and trigger abuse detection.
const ENRICH_MAX_PER_MIN = 20;
const enrichHits = [];
function checkEnrichRateLimit() {
  const now = Date.now();
  const cutoff = now - 60_000;
  while (enrichHits.length && enrichHits[0] < cutoff) enrichHits.shift();
  if (enrichHits.length >= ENRICH_MAX_PER_MIN) return false;
  enrichHits.push(now);
  return true;
}

export async function fetchJobDetail(jobId) {
  const url = `${PARSER_URL_PREFIX}${jobId}/`;
  if (!checkEnrichRateLimit()) {
    return { ok: false, error: 'enrich rate limit exceeded (>20/min)', url };
  }
  let res;
  try {
    res = await fetch(url, { credentials: 'include', redirect: 'follow' });
  } catch (e) {
    return { ok: false, error: `network: ${e.message}`, url };
  }
  if (!res.ok) {
    return { ok: false, error: `http ${res.status}`, url, status: res.status };
  }
  const html = await res.text();
  const parsed = parseJobHtml(html);
  return { ok: true, url, ...parsed, htmlLength: html.length };
}

function parseJobHtml(html) {
  // Try JSON-LD JobPosting first — standalone view pages usually include it.
  const scriptMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const s of scriptMatches) {
    const inner = s.replace(/<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    try {
      const data = JSON.parse(inner);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item && item['@type'] === 'JobPosting') {
          return jsonLdToPosting(item);
        }
      }
    } catch {}
  }

  // Fallback: pull <title> and open-graph description.
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
  const parts = parseDocTitle(titleMatch?.[1] || '');
  return {
    title: parts?.title || null,
    company: parts?.company || null,
    location: parts?.location || null,
    descriptionText: ogDesc?.[1] || null,
    descriptionSource: 'og',
  };
}

function jsonLdToPosting(item) {
  return {
    title: item.title || null,
    company: item.hiringOrganization?.name || null,
    location: item.jobLocation
      ? [item.jobLocation.address?.addressLocality, item.jobLocation.address?.addressRegion, item.jobLocation.address?.addressCountry].filter(Boolean).join(', ')
      : null,
    postedDate: item.datePosted || null,
    descriptionText: item.description ? htmlToPlainText(item.description) : null,
    descriptionSource: 'jsonld',
    postedSalaryRange: formatSalary(item.baseSalary),
    employmentType: item.employmentType || null,
  };
}

function htmlToPlainText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatSalary(baseSalary) {
  if (!baseSalary) return null;
  const v = baseSalary.value || baseSalary;
  const unit = (v.unitText || 'YEAR').toLowerCase();
  const currency = baseSalary.currency || 'USD';
  if (v.minValue != null && v.maxValue != null) {
    return `${currency} ${Number(v.minValue).toLocaleString()}–${Number(v.maxValue).toLocaleString()} / ${unit}`;
  }
  if (v.value != null) return `${currency} ${Number(v.value).toLocaleString()} / ${unit}`;
  return null;
}

function parseDocTitle(docTitle) {
  if (!docTitle) return null;
  const t = docTitle.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
  const hiring = t.match(/^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+(.+))?$/i);
  if (hiring) return { company: hiring[1].trim(), title: hiring[2].trim(), location: hiring[3]?.trim() || null };
  const pipe = t.split(/\s*\|\s*/);
  if (pipe.length === 2 && pipe[0] && pipe[1]) return { title: pipe[0].trim(), company: pipe[1].trim(), location: null };
  return null;
}
