// Small dependency-free fuzzy + full-text helpers for the archive.
// Optimized for a personal-scale corpus (hundreds of jobs, not millions).

export function normalize(s) {
  return (s || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
}

// Company-name fuzzy score: 1.0 = identical, tolerates suffixes like "Inc", "LLC",
// spacing variants like "OneTrust" vs "one trust", missing punctuation.
export function companyMatchScore(query, target) {
  const q = normalize(query).replace(/[.,]/g, '');
  const t = normalize(target).replace(/[.,]/g, '');
  if (!q || !t) return 0;

  const stripCorp = (s) => s.replace(/\b(inc|llc|ltd|co|corp|corporation|company|gmbh|plc)\.?\b/g, '').trim();
  const qs = stripCorp(q);
  const ts = stripCorp(t);

  if (qs === ts) return 1.0;
  const qCompact = qs.replace(/\s+/g, '');
  const tCompact = ts.replace(/\s+/g, '');
  if (qCompact === tCompact) return 0.95;
  if (tCompact.includes(qCompact) || qCompact.includes(tCompact)) return 0.85;

  // Token overlap
  const qTokens = new Set(qs.split(' ').filter(Boolean));
  const tTokens = new Set(ts.split(' ').filter(Boolean));
  const common = [...qTokens].filter((x) => tTokens.has(x)).length;
  const denom = Math.max(qTokens.size, tTokens.size);
  return denom ? common / denom * 0.7 : 0;
}

// Search jobs by free-text query. Returns [{ job, score, snippet }].
export function searchJobs(jobs, query) {
  const q = normalize(query);
  if (!q) return jobs.map((job) => ({ job, score: 0, snippet: '' }));

  const terms = q.split(' ').filter(Boolean);
  const results = [];

  for (const job of jobs) {
    const haystackParts = [
      job.posting?.title, job.posting?.company, job.posting?.location,
      job.posting?.descriptionText, job.cardText,
      job.userNotes,
      ...Object.values(job.analyses || {}).flatMap((a) => JSON.stringify(a?.result || {}).slice(0, 5000)),
      ...(job.panel || []).map((p) => `${p.name} ${p.role} ${p.notes}`),
    ];
    const haystack = normalize(haystackParts.filter(Boolean).join('\n'));

    // Score: sum of term-hit counts (0 if any term missing)
    let score = 0;
    for (const term of terms) {
      const count = (haystack.match(new RegExp(escapeRegex(term), 'g')) || []).length;
      if (count === 0) { score = 0; break; }
      score += count;
    }
    if (score === 0) continue;

    // Company fuzzy bonus
    if (job.posting?.company) {
      const fuzzy = companyMatchScore(query, job.posting.company);
      score += fuzzy * 5;
    }

    results.push({ job, score, snippet: makeSnippet(haystack, terms[0]) });
  }

  // Recency tiebreaker (updatedAt desc)
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.job.updatedAt || '').localeCompare(a.job.updatedAt || '');
  });
  return results;
}

function makeSnippet(haystack, term, window = 60) {
  const idx = haystack.indexOf(term);
  if (idx < 0) return '';
  const start = Math.max(0, idx - window);
  const end = Math.min(haystack.length, idx + term.length + window);
  return (start > 0 ? '…' : '') + haystack.slice(start, end) + (end < haystack.length ? '…' : '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fuzzy-match an inbound message against archived jobs. Returns top N candidates.
export function matchInbound(jobs, messageText, limit = 5) {
  const msg = normalize(messageText);
  if (!msg) return [];

  const candidates = jobs.map((job) => {
    let score = 0;
    const reasons = [];

    if (job.posting?.company) {
      const s = companyMatchScore(job.posting.company, msg);
      if (s > 0.3) { score += s * 10; reasons.push(`company match ${(s * 100).toFixed(0)}%`); }
      // Also check literal inclusion
      if (msg.includes(normalize(job.posting.company))) { score += 8; reasons.push('company name in message'); }
    }
    if (job.posting?.title && msg.includes(normalize(job.posting.title))) {
      score += 6; reasons.push('title in message');
    }
    // Recruiter/panel name matches
    for (const p of job.panel || []) {
      if (p.name && msg.includes(normalize(p.name))) {
        score += 5; reasons.push(`panel member ${p.name} in message`);
      }
    }
    if (job.posting?.recruiter && msg.includes(normalize(job.posting.recruiter))) {
      score += 5; reasons.push('recruiter name in message');
    }
    // Description phrase overlap (weak signal)
    if (job.posting?.descriptionText) {
      const desc = normalize(job.posting.descriptionText);
      const words = desc.split(' ').filter((w) => w.length > 6);
      const hits = words.filter((w) => msg.includes(w)).length;
      if (hits > 5) { score += Math.min(hits / 10, 3); reasons.push(`${hits} description phrases`); }
    }
    return { job, score, reasons };
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates.filter((c) => c.score > 2).slice(0, limit);
}
