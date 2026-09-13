// Shared dashboard chart module — imported by archive.js (Jawboard)
// and jawbridge.js (all-charts page). No side effects on import;
// every export is a pure function or a static const.
//
// External deps: statuses.js. Chart-specific side effects like
// 'archive stale jobs' are injected via option callbacks so this
// module never reaches into a caller's storage or reload logic.

import { normalizeStatus, statusLabel, STATUS_ORDER, statusRank } from '../lib/statuses.js';


// ---------- Analytics dashboard ----------

export const STATUS_TONE = {
  analyzed:               'var(--jc-text-3)',
  saved:                  'var(--jc-accent)',
  inProgressDraft:        'var(--jc-caution)',
  inProgressClickedApply: 'var(--jc-caution)',
  applied:                'var(--jc-info)',
  interviewing:           'var(--jc-pos)',
  archived:               'var(--jc-text-3)',
  notMovingForward:       'var(--jc-neg)',
};

export function renderDashboard(jobsList) {
  const dash = document.getElementById('dashboard');
  if (!jobsList.length) { dash.hidden = true; return; }
  dash.hidden = false;
  // Priority order: funnel + voyage + aging are the most actionable, so
  // they render first (top of the deck). Original 4 stay at the bottom.
  renderStrikeFunnel(document.getElementById('funnelChart'), jobsList);
  renderVoyageLog(document.getElementById('voyageChart'), jobsList);
  renderLinesInWater(document.getElementById('agingChart'), jobsList);
  renderCalibration(document.getElementById('calibrationChart'), jobsList);
  renderCadence(document.getElementById('cadenceChart'), jobsList);
  renderTrophyBoard(document.getElementById('trophyChart'), jobsList);
  renderFirstBite(document.getElementById('firstBiteChart'), jobsList);
  renderStatusPie(document.getElementById('statusChart'), jobsList);
  renderCapturedLine(document.getElementById('capturedChart'), jobsList);
  renderFitHistogram(document.getElementById('fitChart'), jobsList);
  renderSalaryHistogram(document.getElementById('salaryChart'), jobsList);
}

// ================================================================
//   Shared helpers for the pipeline-analytics charts
// ================================================================

export const FUNNEL_STAGES = [
  { key: 'saved',        label: 'Saved',        rank: 1 },
  { key: 'applied',      label: 'Applied',      rank: 4 },
  { key: 'interviewing', label: 'Interviewing', rank: 5 },
  { key: 'offer',        label: 'Offer',        rank: 100 },
];

// Best "how far did this job get" measurement. Uses statusRank plus any
// round outcome that indicates 'offer'. Terminal negatives (archived,
// notMovingForward) still count the highest positive stage the job
// reached before going terminal.
export function furthestStage(job) {
  const rounds = job.interviewRounds || [];
  const hasOffer = rounds.some((r) => /offer/i.test(r.outcome || ''));
  if (hasOffer) return 100;
  // If a job is currently in a terminal state, use the highest positive
  // stage it must have passed through — reconstruct from timeline.
  const norm = normalizeStatus(job.status);
  if (norm === 'notMovingForward' || norm === 'archived') {
    // Walk timeline for the highest positive rank ever recorded.
    let best = 0;
    for (const entry of job.timeline || []) {
      if (entry.type !== 'status-change') continue;
      const m = /(saved|inProgressDraft|inProgressClickedApply|applied|interviewing)/i.exec(entry.note || '');
      if (m) {
        const rank = statusRank(m[1]);
        if (rank > best) best = rank;
      }
    }
    // If the job has any interview rounds, treat as at least reached interviewing.
    if (rounds.length) best = Math.max(best, statusRank('interviewing'));
    return best;
  }
  return statusRank(norm);
}

// Round-type classifier — returns the user's free-text `round.type` as
// entered (Recall's UI defaults it by ordinal; user can overwrite to
// anything: "COO", "Skip level", "Take-home review"). For legacy
// rounds without a type set, falls back to keyword matching against
// the topic field so old data still lights up the voyage chart.
export function classifyRoundType(round) {
  if (round.type && String(round.type).trim()) return String(round.type).trim();
  const topic = String(round.topic || '').toLowerCase();
  if (/recruit|screen|phone/.test(topic)) return 'Recruiter';
  if (/hiring manager|\bhm\b|manager/.test(topic)) return 'Hiring Mgr';
  if (/final|exec|leadership|c-level|founder/.test(topic)) return 'Final';
  if (/panel|onsite|loop|super\s?day/.test(topic)) return 'Panel';
  if (/tech|coding|system design|architecture/.test(topic)) return 'Technical';
  return 'Other';
}
// Canonical bucket for aggregation (mortality chart). Maps whatever
// classifyRoundType returned — including user-authored labels like
// "COO" or "VP Product" — to one of six fixed buckets so counts stay
// comparable across jobs. Any label that doesn't match a known bucket
// falls into 'other'.
export function bucketRoundType(round) {
  const raw = String(classifyRoundType(round)).toLowerCase();
  if (/recruit|screen|phone|hr\b/.test(raw)) return 'recruiter';
  if (/hiring\s?m|^hm\b|\bhm\b|manager/.test(raw)) return 'hiring-manager';
  if (/tech|coding|system design|architecture|take.?home/.test(raw)) return 'technical';
  if (/panel|onsite|loop|super\s?day/.test(raw)) return 'panel';
  if (/final|exec|leadership|c-level|founder|ceo|coo|cto|cpo|cfo|vp\b|skip.?level/.test(raw)) return 'final';
  return 'other';
}
export const ROUND_TYPE_LABEL = {
  recruiter: 'Recruiter', 'hiring-manager': 'Hiring Mgr',
  technical: 'Technical', panel: 'Panel', final: 'Final', other: 'Other',
};

// Round-outcome classifier. Explicit round.outcome wins; otherwise infer
// from position + job status: if a later round exists → this one passed;
// if job in notMovingForward and this is the last round → failed;
// interviewing + last round → pending.
export function classifyRoundOutcome(round, indexInJob, rounds, jobStatus) {
  if (round.outcome) {
    const o = String(round.outcome).toLowerCase();
    if (/pass|advanc|next|offer/.test(o)) return 'pass';
    if (/fail|reject|declin|no.?response|out/.test(o)) return 'fail';
    return o;
  }
  const isLast = indexInJob === rounds.length - 1;
  if (!isLast) return 'pass';
  const norm = normalizeStatus(jobStatus);
  if (norm === 'notMovingForward') return 'fail';
  return 'pending';
}

// ================================================================
//   Chart 1 · Strike Rate Funnel
// ================================================================

export function renderStrikeFunnel(container, jobsList, opts = {}) {
  // Cumulative counts at each stage — a job in Interviewing counts toward
  // Saved, Applied, and Interviewing.
  const counts = FUNNEL_STAGES.map((stage) => ({
    ...stage,
    count: jobsList.filter((j) => furthestStage(j) >= stage.rank).length,
  }));
  const max = counts[0].count || 1;

  // Trend: this-calendar-month vs previous calendar month, using
  // statusUpdatedAt as the "when reached this stage" proxy.
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const inMonth = (job, from, to) => {
    const t = new Date(job.statusUpdatedAt || job.updatedAt || 0).getTime();
    return t >= from && t < to;
  };
  const deltas = counts.map((stage) => {
    const thisCount = jobsList.filter((j) => furthestStage(j) >= stage.rank && inMonth(j, thisMonth, Date.now() + 1)).length;
    const prevCount = jobsList.filter((j) => furthestStage(j) >= stage.rank && inMonth(j, prevMonth, thisMonth)).length;
    return thisCount - prevCount;
  });

  if (!counts[0].count) {
    container.innerHTML = '<div class="chart-empty">Save a job to start the funnel</div>';
    return;
  }

  // Each stage row can be a drilldown link to the Jawboard status-filtered.
  // Offer isn't a canonical status; skip its link. Rows with count=0 stay
  // read-only too.
  const rows = counts.map((s, i) => {
    const widthPct = Math.max(4, (s.count / max) * 100);
    const nextCount = i < counts.length - 1 ? counts[i + 1].count : null;
    const convPct = nextCount != null && s.count > 0
      ? Math.round((nextCount / s.count) * 100)
      : null;
    const delta = deltas[i];
    const deltaStr = delta === 0 ? '±0'
      : delta > 0 ? `▲${delta}`
      : `▼${Math.abs(delta)}`;
    const deltaTone = delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'neutral';
    // Color by stage: cold blue → warm green as jobs advance.
    const barColor = ['#6ec6f0', '#f5a54f', '#f4c56f', '#6dd68a'][i];
    const canLink = !!opts.links && s.key !== 'offer' && s.count > 0;
    const tag = canLink ? 'a' : 'div';
    const attrs = canLink
      ? ` class="funnel-row funnel-row--link" href="${opts.links.jawboard({ status: s.key })}" title="Filter Jawboard to ${s.label}"`
      : ' class="funnel-row"';
    return `
      <${tag}${attrs}>
        <div class="funnel-row__head">
          <span class="funnel-row__lbl">${s.label}</span>
          <span class="funnel-row__count">${s.count}</span>
          <span class="funnel-row__delta" data-tone="${deltaTone}">${deltaStr} m/m</span>
        </div>
        <div class="funnel-row__bar-wrap">
          <div class="funnel-row__bar" style="width:${widthPct.toFixed(1)}%; background:${barColor}"></div>
        </div>
        ${convPct != null ? `<div class="funnel-row__conv"><span>${convPct}%</span> convert to ${counts[i + 1].label}</div>` : ''}
      </${tag}>`;
  }).join('');

  // Callout — where is the biggest leak? Skip Interviewing → Offer:
  // most searches end with 0-1 offers, so 0% there is noise, not signal.
  const convs = [];
  for (let i = 0; i < counts.length - 1; i++) {
    if (counts[i].count === 0) continue;
    if (counts[i + 1].key === 'offer') continue;
    convs.push({
      from: counts[i].label, to: counts[i + 1].label,
      pct: Math.round((counts[i + 1].count / counts[i].count) * 100),
    });
  }
  const worst = convs.sort((a, b) => a.pct - b.pct)[0];
  const callout = worst
    ? `<div class="chart-callout" data-tone="${worst.pct < 20 ? 'neg' : 'caution'}">
         Weakest conversion: <strong>${worst.from} → ${worst.to}</strong> at ${worst.pct}%.
         ${worst.pct < 20 ? 'Big leak — investigate.' : ''}
       </div>`
    : '';

  container.innerHTML = `<div class="funnel">${rows}</div>${callout}`;
}

// ================================================================
//   Chart 4 · Interview Voyage Log
// ================================================================

export function renderVoyageLog(container, jobsList, opts = {}) {
  // Every job that has at least one interview round — whether it's still
  // active, ended in an offer, or died at some round. Historical record,
  // not a live-processes-only view. Sort: active first, then most-recent
  // activity, so the current pipeline stays on top.
  const withInterviews = jobsList
    .filter((j) => (j.interviewRounds || []).length > 0)
    .map((j) => {
      const rounds = j.interviewRounds || [];
      const latest = rounds
        .map((r) => (r.date ? new Date(r.date).getTime() : 0))
        .reduce((a, b) => Math.max(a, b), 0);
      const status = normalizeStatus(j.status);
      return { j, latest, active: status === 'interviewing' };
    })
    .sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.latest - a.latest;
    })
    .map((x) => x.j);

  if (!withInterviews.length) {
    container.innerHTML = '<div class="chart-empty">No interviews recorded yet</div>';
    return;
  }
  const active = withInterviews;

  // Aggregate for the mortality mini-chart: for every job in a terminal
  // state (notMovingForward), what was the LAST round type before the
  // process died? Group by canonical bucket so a user's "COO" and
  // "CTO" both count under Final. That's where the wall is.
  const mortalityBuckets = {};
  for (const j of jobsList) {
    if (normalizeStatus(j.status) !== 'notMovingForward') continue;
    const rounds = j.interviewRounds || [];
    if (!rounds.length) continue;
    const last = rounds[rounds.length - 1];
    const b = bucketRoundType(last);
    mortalityBuckets[b] = (mortalityBuckets[b] || 0) + 1;
  }

  const swimlanes = active.map((j) => {
    const rounds = [...(j.interviewRounds || [])].sort((a, b) => {
      const da = a.date ? new Date(a.date).getTime() : Infinity;
      const db = b.date ? new Date(b.date).getTime() : Infinity;
      return da - db;
    });
    const dots = rounds.map((r, i) => {
      // Voyage dot label shows the user's own type text as-typed
      // (Recruiter, COO, Skip level, …); mortality aggregation
      // upstream buckets it into a canonical category.
      const type = classifyRoundType(r);
      const outcome = classifyRoundOutcome(r, i, rounds, j.status);
      const now = Date.now();
      const t = r.date ? new Date(r.date).getTime() : null;
      const upcoming = t != null && t > now;
      const marker = upcoming ? '◇'
        : outcome === 'pass' ? '✓'
        : outcome === 'fail' ? '✗'
        : '●';
      const tone = upcoming ? 'info'
        : outcome === 'pass' ? 'pos'
        : outcome === 'fail' ? 'neg'
        : 'neutral';
      const title = `${type}${r.date ? ` · ${r.date}` : ''}${upcoming ? ' (scheduled)' : ` · ${outcome}`}`;
      return `<span class="voyage__dot" data-tone="${tone}" title="${escapeHtml(title)}">${marker}<span class="voyage__dot-lbl">${escapeHtml(type)}</span></span>`;
    }).join('<span class="voyage__connector"></span>');
    const company = j.posting?.company || '(unknown)';
    // Company name only — the same person rarely applies to multiple
    // roles at one company, so the title is redundant noise here.
    const companyHtml = opts.links
      ? `<a class="voyage-row__company voyage-row__company--link" href="${opts.links.recall(j.jobId)}" title="Open ${escapeHtml(company)} in Recall">${escapeHtml(company)}</a>`
      : `<span class="voyage-row__company">${escapeHtml(company)}</span>`;
    return `<div class="voyage-row">
              ${companyHtml}
              <div class="voyage-row__lane">${dots}</div>
            </div>`;
  }).join('');

  // Mortality mini-bars
  const mortalityKeys = Object.keys(mortalityBuckets);
  const mortalityMax = Math.max(1, ...Object.values(mortalityBuckets));
  const mortalityHtml = mortalityKeys.length
    ? `<div class="voyage-mortality">
         <div class="voyage-mortality__title">Round mortality — where processes die</div>
         ${mortalityKeys.map((k) => `
           <div class="voyage-mortality__row">
             <span class="voyage-mortality__lbl">${ROUND_TYPE_LABEL[k] || k}</span>
             <div class="voyage-mortality__bar-wrap">
               <div class="voyage-mortality__bar" style="width:${(mortalityBuckets[k] / mortalityMax * 100).toFixed(0)}%"></div>
             </div>
             <span class="voyage-mortality__count">${mortalityBuckets[k]}</span>
           </div>
         `).join('')}
       </div>`
    : '';

  container.innerHTML = `<div class="voyage">${swimlanes}</div>${mortalityHtml}`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ================================================================
//   Chart 3 · Most-Cast Titles — what positions the user targets most
// ================================================================
//
// (Formerly "Lines in the Water" staleness chart — replaced with a title-
// frequency chart so users can see whether they're aiming at a consistent
// target species or scattering casts across too many role types.)
//
// Counts jobs that reached Applied or further, grouped by normalized
// title. Normalization is lightweight — lowercase, collapse whitespace,
// strip parentheticals + trailing " - Remote"/location tags. The bar
// label shows the most common original casing for each group.

const TITLE_ALIASES = [
  [/\bsr\.?\b/gi, 'senior'],
  [/\bjr\.?\b/gi, 'junior'],
  [/\bvp\b/gi, 'vice president'],
  [/\bmgr\.?\b/gi, 'manager'],
  [/\bdir\.?\b/gi, 'director'],
  [/\beng\.?\b/gi, 'engineering'],
];

function normalizeTitle(raw) {
  if (!raw) return '';
  let t = String(raw).toLowerCase();
  t = t.replace(/\([^)]*\)/g, ' ');           // strip parentheticals
  t = t.replace(/\s+[-–—]\s+.*$/, '');        // strip trailing " - Remote", " — NYC"
  t = t.replace(/[,/]/g, ' ');                // "Director, Engineering" → "Director Engineering"
  for (const [pat, replacement] of TITLE_ALIASES) t = t.replace(pat, replacement);
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

export function renderLinesInWater(container, jobsList, opts = {}) {
  // Any job whose furthest stage reached applied — includes jobs currently
  // in Interviewing / Archived / NotMovingForward that were applied to.
  const applied = jobsList.filter((j) => furthestStage(j) >= statusRank('applied'));

  if (!applied.length) {
    container.innerHTML = '<div class="chart-empty">No applications logged yet</div>';
    return;
  }

  // Group by normalized title, tracking the most common original casing.
  const groups = new Map();
  for (const j of applied) {
    const original = j.posting?.title;
    if (!original) continue;
    const key = normalizeTitle(original);
    if (!key) continue;
    const entry = groups.get(key) || { key, count: 0, variants: new Map() };
    entry.count += 1;
    entry.variants.set(original, (entry.variants.get(original) || 0) + 1);
    groups.set(key, entry);
  }
  const ranked = [...groups.values()]
    .map((g) => {
      // Pick the most common original casing as the display label.
      let best = '', bestCount = 0;
      for (const [variant, count] of g.variants) {
        if (count > bestCount) { best = variant; bestCount = count; }
      }
      return { label: best, count: g.count };
    })
    .sort((a, b) => b.count - a.count);

  if (!ranked.length) {
    container.innerHTML = '<div class="chart-empty">No titles to group</div>';
    return;
  }

  const shown = ranked.slice(0, 10);
  const max = shown[0].count;

  const rows = shown.map((r) => {
    const width = Math.max(4, (r.count / max) * 100);
    const canLink = !!opts.links;
    const tag = canLink ? 'a' : 'div';
    const attrs = canLink
      ? ` class="titles-row titles-row--link" href="${opts.links.jawboard({ q: r.label })}" title="Filter Jawboard to jobs matching “${escapeHtml(r.label)}”"`
      : ' class="titles-row"';
    return `
      <${tag}${attrs}>
        <span class="titles-row__label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>
        <div class="titles-row__bar-wrap">
          <div class="titles-row__bar" style="width:${width.toFixed(1)}%"></div>
        </div>
        <span class="titles-row__count">${r.count}</span>
      </${tag}>`;
  }).join('');

  const caption = ranked.length > shown.length
    ? `<div class="chart-caption">Top 10 of ${ranked.length} distinct titles · ${applied.length} apps total</div>`
    : `<div class="chart-caption">${ranked.length} distinct title${ranked.length === 1 ? '' : 's'} · ${applied.length} apps total</div>`;

  container.innerHTML = `<div class="titles-chart">${rows}</div>${caption}`;
}

// ================================================================
//   Chart 2 · Fit Score Calibration
// ================================================================

export function renderCalibration(container, jobsList) {
  // Only jobs that have BOTH a fit score AND have been applied to.
  const scored = jobsList.filter((j) => typeof j.analyses?.fit?.result?.fitScore === 'number');
  const applied = scored.filter((j) => furthestStage(j) >= statusRank('applied'));
  if (applied.length < 5) {
    container.innerHTML = `<div class="chart-empty">Need at least 5 applied jobs with fit scores (have ${applied.length})</div>`;
    return;
  }

  const buckets = [
    { label: '0-19', min: 0,  max: 19 },
    { label: '20-39', min: 20, max: 39 },
    { label: '40-59', min: 40, max: 59 },
    { label: '60-79', min: 60, max: 79 },
    { label: '80-100', min: 80, max: 100 },
  ];
  const rows = buckets.map((b) => {
    const inBucket = applied.filter((j) => {
      const s = j.analyses.fit.result.fitScore;
      return s >= b.min && s <= b.max;
    });
    const n = inBucket.length;
    const interviewed = inBucket.filter((j) => furthestStage(j) >= statusRank('interviewing')).length;
    const offered = inBucket.filter((j) => furthestStage(j) >= 100).length;
    return {
      ...b, n,
      interviewPct: n ? Math.round((interviewed / n) * 100) : 0,
      offerPct: n ? Math.round((offered / n) * 100) : 0,
    };
  });

  // Chart: for each bucket, two stacked bars — interview% and offer%.
  const W = 320, H = 160, padL = 34, padR = 8, padT = 10, padB = 32;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const colW = innerW / buckets.length;
  const maxPct = 100;
  const bars = rows.map((r, i) => {
    if (!r.n) return '';
    const iH = (r.interviewPct / maxPct) * innerH;
    const oH = (r.offerPct / maxPct) * innerH;
    const x = padL + i * colW + colW * 0.15;
    const bw = colW * 0.35;
    return `
      <rect x="${x.toFixed(1)}" y="${(padT + innerH - iH).toFixed(1)}"
            width="${bw.toFixed(1)}" height="${iH.toFixed(1)}" fill="#f4c56f" />
      <rect x="${(x + bw + 2).toFixed(1)}" y="${(padT + innerH - oH).toFixed(1)}"
            width="${bw.toFixed(1)}" height="${oH.toFixed(1)}" fill="#6dd68a" />
      <text x="${(x + bw).toFixed(1)}" y="${(H - padB + 12).toFixed(1)}"
            text-anchor="middle" style="fill:#94825a" font-family="var(--jc-font-mono)" font-size="9">${r.label}</text>
      <text x="${(x + bw).toFixed(1)}" y="${(H - padB + 22).toFixed(1)}"
            text-anchor="middle" style="fill:#94825a" font-family="var(--jc-font-mono)" font-size="8">n=${r.n}</text>`;
  }).join('');

  // Axes
  const axis = `
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#4a3b1a" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#4a3b1a" />
    <text x="${padL - 4}" y="${padT + 4}" text-anchor="end" style="fill:#94825a" font-family="var(--jc-font-mono)" font-size="9">100%</text>
    <text x="${padL - 4}" y="${H - padB}" text-anchor="end" style="fill:#94825a" font-family="var(--jc-font-mono)" font-size="9">0</text>`;

  // Callout: does score predict? Compare top-two vs bottom-two interview%.
  const bottom = rows.slice(0, 2).reduce((a, b) => a + b.n * b.interviewPct, 0) / Math.max(1, rows.slice(0, 2).reduce((a, b) => a + b.n, 0));
  const top = rows.slice(-2).reduce((a, b) => a + b.n * b.interviewPct, 0) / Math.max(1, rows.slice(-2).reduce((a, b) => a + b.n, 0));
  const gap = top - bottom;
  const callout = gap > 15
    ? `<div class="chart-callout" data-tone="pos">Fit score IS predictive (top buckets +${Math.round(gap)}pp on interview rate). Consider raising your minimum-fit threshold.</div>`
    : gap < -5
    ? `<div class="chart-callout" data-tone="neg">Fit score is INVERSELY correlated with outcomes — don't over-rely on it.</div>`
    : `<div class="chart-callout" data-tone="caution">Fit score isn't strongly predictive yet (gap ${Math.round(gap)}pp). Score is a hint, not a filter.</div>`;

  const legend = `
    <div class="two-line-legend">
      <span><span class="legend-swatch" style="background:#f4c56f"></span>Interview %</span>
      <span><span class="legend-swatch" style="background:#6dd68a"></span>Offer %</span>
    </div>`;

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${axis}${bars}</svg>${legend}${callout}`;
}

// ================================================================
//   Chart 5 · Cast Cadence vs. Bite Rate
// ================================================================

export function renderCadence(container, jobsList) {
  // Weekly buckets — ISO week starting Monday. We chart apps-submitted
  // (bars) with an overlaid line of interviews-landed shifted 2 weeks
  // to reflect typical response lag.
  const now = new Date();
  const WEEKS = 12;
  const weeks = [];
  for (let i = WEEKS - 1; i >= 0; i--) {
    const anchor = new Date(now);
    anchor.setDate(anchor.getDate() - i * 7);
    // Snap to Monday
    const dow = (anchor.getDay() + 6) % 7;
    anchor.setDate(anchor.getDate() - dow);
    anchor.setHours(0, 0, 0, 0);
    weeks.push({ start: anchor.getTime(), key: anchor.toISOString().slice(5, 10) });
  }

  const applyDates = jobsList.map((j) => statusChangeAt(j, 'applied')).filter(Boolean).map((s) => new Date(s).getTime());
  const interviewDates = jobsList.map((j) => firstInterviewAt(j)).filter(Boolean).map((s) => new Date(s).getTime());
  const saveDates = jobsList.map((j) => statusChangeAt(j, 'saved')).filter(Boolean).map((s) => new Date(s).getTime());

  const bucket = (dates, offsetWeeks = 0) => weeks.map((w) => {
    const start = w.start + offsetWeeks * 7 * 86400_000;
    const end = start + 7 * 86400_000;
    return dates.filter((t) => t >= start && t < end).length;
  });
  const applyCounts = bucket(applyDates, 0);
  const interviewCounts = bucket(interviewDates, -2); // shift interviews 2 weeks earlier to align with the apply that triggered them
  const saveCounts = bucket(saveDates, 0);
  const maxCount = Math.max(1, ...applyCounts, ...interviewCounts, ...saveCounts);

  if (applyCounts.every((v) => v === 0) && saveCounts.every((v) => v === 0)) {
    container.innerHTML = '<div class="chart-empty">No weekly cadence yet — save or apply to some jobs</div>';
    return;
  }

  const W = 320, H = 160, padL = 26, padR = 8, padT = 14, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const colW = innerW / WEEKS;

  const bars = applyCounts.map((c, i) => {
    const x = padL + i * colW + colW * 0.15;
    const bw = colW * 0.7;
    const h = (c / maxCount) * innerH;
    return `<rect x="${x.toFixed(1)}" y="${(padT + innerH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="#6ec6f0" opacity="0.75" />`;
  }).join('');

  const linePts = interviewCounts.map((c, i) => {
    const x = padL + i * colW + colW / 2;
    const y = padT + innerH - (c / maxCount) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const dots = interviewCounts.map((c, i) => {
    const x = padL + i * colW + colW / 2;
    const y = padT + innerH - (c / maxCount) * innerH;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5" fill="#6dd68a" />`;
  }).join('');

  const axis = `
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#4a3b1a" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#4a3b1a" />
    <text x="${padL - 4}" y="${padT + 4}" text-anchor="end" style="fill:#94825a" font-family="var(--jc-font-mono)" font-size="9">${maxCount}</text>
    <text x="${padL - 4}" y="${H - padB}" text-anchor="end" style="fill:#94825a" font-family="var(--jc-font-mono)" font-size="9">0</text>
    <text x="${padL}" y="${H - 6}" style="fill:#94825a" font-family="var(--jc-font-mono)" font-size="8">${weeks[0].key}</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end" style="fill:#94825a" font-family="var(--jc-font-mono)" font-size="8">${weeks[WEEKS - 1].key}</text>`;

  // Callout: scouting-without-fishing detection
  const recentSaves = saveCounts.slice(-4).reduce((a, b) => a + b, 0);
  const recentApps = applyCounts.slice(-4).reduce((a, b) => a + b, 0);
  const callout = recentSaves >= 5 && recentApps <= 1
    ? `<div class="chart-callout" data-tone="caution">Saves are climbing (${recentSaves} in last 4wk) but apply rate is flat (${recentApps}). Scouting without fishing.</div>`
    : '';

  const legend = `
    <div class="two-line-legend">
      <span><span class="legend-swatch" style="background:#6ec6f0"></span>Applications</span>
      <span><span class="legend-swatch" style="background:#6dd68a"></span>Interviews (2wk lag)</span>
    </div>`;

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${axis}${bars}<polyline points="${linePts}" fill="none" stroke="#6dd68a" stroke-width="1.5" />${dots}</svg>${legend}${callout}`;
}

// ================================================================
//   Chart 6 · Trophy Weight Board
// ================================================================

// Vertical bar chart of salary ranges. One bar per job. The bar's
// vertical span is [low, high]; a marker sits at the midpoint. Sorted by
// midpoint descending. Colored by status. Dashed horizontal line at the
// user's ask target for reference.
export function renderTrophyBoard(container, jobsList, opts = {}) {
  const jobsWithComp = jobsList.map((j) => {
    const comp = j.analyses?.comp?.result;
    const base = comp?.salary?.base;
    let low = null, high = null;
    if (base && (base.low != null || base.high != null)) {
      low = base.low ?? base.high;
      high = base.high ?? base.low;
    } else if (comp?.marketEstimate) {
      low = comp.marketEstimate.baseLow ?? comp.marketEstimate.baseMid;
      high = comp.marketEstimate.baseHigh ?? comp.marketEstimate.baseMid;
    }
    if (low == null || high == null || low <= 0 || high <= 0) return null;
    const mid = (low + high) / 2;
    return {
      job: j,
      low, high, mid,
      status: normalizeStatus(j.status),
      company: j.posting?.company || '?',
      title: j.posting?.title || 'job',
    };
  })
    .filter(Boolean)
    .sort((a, b) => b.mid - a.mid);

  if (jobsWithComp.length < 2) {
    container.innerHTML = `<div class="chart-empty">Need ≥2 jobs with compensation analyzed (have ${jobsWithComp.length})</div>`;
    return;
  }

  // Cap bar count so labels stay legible; jobs are already sorted so we
  // keep the highest earners.
  const MAX_BARS = 20;
  const shown = jobsWithComp.slice(0, MAX_BARS);

  const W = 340, H = 220;
  const padL = 48, padR = 12, padT = 16, padB = 44;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const domainMax = Math.max(...shown.map((s) => s.high));
  const domainMin = Math.min(...shown.map((s) => s.low));
  // Pad the axis by 5% below the min and above the max so the bars breathe.
  const yMin = Math.max(0, domainMin - (domainMax - domainMin) * 0.05);
  const yMax = domainMax + (domainMax - domainMin) * 0.05;
  const yRange = Math.max(1, yMax - yMin);
  const yFor = (v) => padT + innerH - ((v - yMin) / yRange) * innerH;

  const barSlot = innerW / shown.length;
  const barW = Math.max(4, Math.min(24, barSlot * 0.6));

  const statusColor = {
    saved: '#6ec6f0', applied: '#f4c56f', interviewing: '#6dd68a',
    archived: '#94825a', notMovingForward: '#ff6b6b',
    analyzed: '#94825a', inProgressDraft: '#f5a54f', inProgressClickedApply: '#f5a54f',
  };
  const fmtK = (n) => `$${Math.round(n / 1000)}k`;

  const bars = shown.map((s, i) => {
    const cx = padL + i * barSlot + barSlot / 2;
    const x = cx - barW / 2;
    const yHi = yFor(s.high);
    const yLo = yFor(s.low);
    const h = Math.max(2, yLo - yHi);
    const yMid = yFor(s.mid);
    const color = statusColor[s.status] || '#f4c56f';
    const title = `${s.title} @ ${s.company} · ${fmtK(s.low)}–${fmtK(s.high)}`;
    const bar = `<rect x="${x.toFixed(1)}" y="${yHi.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${color}" opacity="0.85" style="cursor:${opts.links ? 'pointer' : 'default'}"><title>${escapeHtml(title)}</title></rect>`;
    const midMark = `<line x1="${(x - 2).toFixed(1)}" y1="${yMid.toFixed(1)}" x2="${(x + barW + 2).toFixed(1)}" y2="${yMid.toFixed(1)}" stroke="var(--jc-text)" stroke-width="1.5" opacity="0.7" />`;
    // Rotated company label along the x-axis
    const label = `<text x="${cx.toFixed(1)}" y="${(H - padB + 10).toFixed(1)}" text-anchor="end" transform="rotate(-40 ${cx.toFixed(1)} ${(H - padB + 10).toFixed(1)})" style="fill:var(--jc-text-3)" font-family="var(--jc-font-mono)" font-size="8">${escapeHtml((s.company || '').slice(0, 14))}</text>`;
    const wrapped = opts.links
      ? `<a href="${opts.links.recall(s.job.jobId)}" target="_top">${bar}${midMark}</a>${label}`
      : `${bar}${midMark}${label}`;
    return wrapped;
  }).join('');

  // Y-axis with min/max/mid ticks and $-formatted labels
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  const ticks = yTicks.map((v) => {
    const y = yFor(v);
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="var(--jc-border)" stroke-width="0.5" stroke-dasharray="2 3" opacity="0.4" />
      <text x="${(padL - 4).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end" style="fill:var(--jc-text-3)" font-family="var(--jc-font-mono)" font-size="9">${fmtK(v)}</text>`;
  }).join('');

  const axis = `
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--jc-border-strong)" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="var(--jc-border-strong)" />`;

  // Ask-target reference line, async fetch. Hidden until we get a value.
  const askLine = `<line id="trophyAsk" stroke="#ff6b6b" stroke-width="1.2" stroke-dasharray="3 3" opacity="0" />
    <text id="trophyAskLabel" x="${(W - padR - 4).toFixed(1)}" y="0" text-anchor="end" style="fill:#ff6b6b" font-family="var(--jc-font-mono)" font-size="9" opacity="0">ASK</text>`;
  (async () => {
    try {
      const r = await chrome.storage.local.get('settings.compTargets');
      const target = r['settings.compTargets']?.target || r['settings.compTargets']?.floor;
      if (target && target >= yMin && target <= yMax) {
        const y = yFor(target);
        const el = document.getElementById('trophyAsk');
        const lbl = document.getElementById('trophyAskLabel');
        if (el) {
          el.setAttribute('x1', padL);
          el.setAttribute('x2', W - padR);
          el.setAttribute('y1', y.toFixed(1));
          el.setAttribute('y2', y.toFixed(1));
          el.setAttribute('opacity', '0.7');
        }
        if (lbl) {
          lbl.setAttribute('y', (y - 3).toFixed(1));
          lbl.setAttribute('opacity', '0.8');
        }
      }
    } catch {}
  })();

  const truncationNote = jobsWithComp.length > MAX_BARS
    ? ` · top ${MAX_BARS} of ${jobsWithComp.length}`
    : '';

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${axis}${ticks}${bars}${askLine}</svg>
    <div class="chart-caption">Salary ranges · sorted by midpoint · color = status${truncationNote}</div>`;
}

// ================================================================
//   Chart 7 · Time-to-First-Bite
// ================================================================

export function renderFirstBite(container, jobsList) {
  const lags = collectInterviewLags(jobsList);
  if (lags.length < 3) {
    container.innerHTML = `<div class="chart-empty">Need ≥3 Applied → Interview timings (have ${lags.length}). Chart fills in as your hunt progresses.</div>`;
    return;
  }

  const buckets = [
    { label: '0-3d', min: 0, max: 3 },
    { label: '4-7d', min: 4, max: 7 },
    { label: '8-14d', min: 8, max: 14 },
    { label: '15-28d', min: 15, max: 28 },
    { label: '29+d', min: 29, max: 9999 },
  ];
  const counts = buckets.map((b) => lags.filter((d) => d >= b.min && d <= b.max).length);
  const max = Math.max(1, ...counts);

  const sorted = [...lags].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const W = 300, H = 160, padL = 30, padR = 8, padT = 14, padB = 30;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const colW = innerW / buckets.length;

  const bars = counts.map((c, i) => {
    const x = padL + i * colW + colW * 0.15;
    const bw = colW * 0.7;
    const h = (c / max) * innerH;
    // Highlight the bucket containing the median
    const bucket = buckets[i];
    const holdsMedian = median >= bucket.min && median <= bucket.max;
    const fill = holdsMedian ? '#f4c56f' : '#6ec6f0';
    return `
      <rect x="${x.toFixed(1)}" y="${(padT + innerH - h).toFixed(1)}"
            width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}" />
      <text x="${(x + bw / 2).toFixed(1)}" y="${(H - padB + 12).toFixed(1)}"
            text-anchor="middle" style="fill:#94825a" font-family="var(--jc-font-mono)" font-size="9">${bucket.label}</text>
      <text x="${(x + bw / 2).toFixed(1)}" y="${(padT + innerH - h - 3).toFixed(1)}"
            text-anchor="middle" style="fill:#e8dcb1" font-family="var(--jc-font-mono)" font-size="9">${c || ''}</text>`;
  }).join('');

  const axis = `
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#4a3b1a" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="#4a3b1a" />`;

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${axis}${bars}</svg>
    <div class="chart-caption">Median ${median}d · n=${lags.length} · Amber bar = median bucket</div>`;
}

// Scan the timeline for the FIRST timestamp when this job entered a given
// status. Falls back to statusUpdatedAt when the timeline is sparse.
export function statusChangeAt(job, targetStatus) {
  const target = normalizeStatus(targetStatus);
  const timeline = Array.isArray(job.timeline) ? job.timeline : [];
  for (const entry of timeline) {
    if (entry.type !== 'status-change') continue;
    // Match on note text — mergeJobRecord writes 'Status → applied' etc.,
    // but LinkedIn Save/Apply flows write more human labels. Compare both.
    const note = String(entry.note || '').toLowerCase();
    if (note.includes(target.toLowerCase())) return entry.at;
  }
  if (normalizeStatus(job.status) === target) return job.statusUpdatedAt;
  return null;
}
export function firstInterviewAt(job) {
  return statusChangeAt(job, 'interviewing');
}

export function renderStatusPie(container, jobsList, opts = {}) {
  // Normalize legacy status codes (screening/offer/closed/passed) so counts
  // roll up under the current LinkedIn-aligned vocabulary.
  const counts = {};
  for (const j of jobsList) {
    const s = normalizeStatus(j.status);
    counts[s] = (counts[s] || 0) + 1;
  }
  const total = jobsList.length;
  if (!total) { container.innerHTML = '<div class="chart-empty">No data yet</div>'; return; }

  const slices = STATUS_ORDER.filter((s) => counts[s]).map((s) => ({
    status: s, count: counts[s], color: STATUS_TONE[s] || 'var(--jc-text-3)',
  }));

  // Donut (SVG) — 120×120 with 40px hole in the middle for a total count.
  const size = 140, r = 58, ir = 34, cx = 70, cy = 70;
  let acc = 0;
  const paths = slices.map((s) => {
    if (!s.count) return '';
    const angle = (s.count / total) * Math.PI * 2;
    const start = acc; const end = acc + angle;
    acc = end;
    const x1 = cx + r * Math.sin(start), y1 = cy - r * Math.cos(start);
    const x2 = cx + r * Math.sin(end), y2 = cy - r * Math.cos(end);
    const ix1 = cx + ir * Math.sin(end), iy1 = cy - ir * Math.cos(end);
    const ix2 = cx + ir * Math.sin(start), iy2 = cy - ir * Math.cos(start);
    const large = angle > Math.PI ? 1 : 0;
    return `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${ix1} ${iy1} A ${ir} ${ir} 0 ${large} 0 ${ix2} ${iy2} Z" style="fill: ${s.color}" />`;
  }).join('');

  const centerLabel = `<text x="${cx}" y="${cy - 2}" text-anchor="middle" style="fill: var(--jc-text)" font-family="var(--jc-font-mono)" font-size="20" font-weight="700">${total}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" style="fill: var(--jc-text-3)" font-family="var(--jc-font-mono)" font-size="9" letter-spacing="0.1em">JOBS</text>`;

  const svg = `<svg viewBox="0 0 ${size} ${size}" width="140" height="140" style="align-self:center">${paths}${centerLabel}</svg>`;
  const legend = `<ul class="chart-legend">${slices.map((s) => {
    const inner = `
      <span class="legend-dot" style="background:${s.color}"></span>
      <span class="legend-label">${s.status}</span>
      <span class="legend-value">${s.count} · ${Math.round(s.count / total * 100)}%</span>`;
    return opts.links
      ? `<li><a class="legend-link" href="${opts.links.jawboard({ status: s.status })}" title="Filter Jawboard to ${s.status}">${inner}</a></li>`
      : `<li>${inner}</li>`;
  }).join('')}</ul>`;

  container.innerHTML = svg + legend;
}

// Two-line time series: cumulative jobs captured (amber) and cumulative
// jobs that reached Interviewing (green). Caption underneath reports the
// avg days from Applied → first Interview so pipeline velocity is visible
// alongside pipeline volume.
// Unified pipeline-activity chart. Cumulative counts of three series on
// a shared day axis: Jobs captured (amber), Applications submitted
// (blue), Interviews landed (green). Replaces both the old
// Captured-over-Time and the old Cast-Cadence charts — same data,
// stacked in one view.
export function renderCapturedLine(container, jobsList) {
  const dayKey = (iso) => (iso ? iso.slice(0, 10) : null);
  const captures = jobsList.map((j) => dayKey(j.capturedAt)).filter(Boolean).sort();
  const appliedDates = jobsList
    .map((j) => dayKey(statusChangeAt(j, 'applied')))
    .filter(Boolean).sort();
  const interviewDates = jobsList
    .map((j) => dayKey(firstInterviewAt(j)))
    .filter(Boolean).sort();

  if (!captures.length && !appliedDates.length && !interviewDates.length) {
    container.innerHTML = '<div class="chart-empty">No pipeline activity yet</div>';
    return;
  }

  // Shared day axis — union of every day where any series has data.
  const daySet = new Set([...captures, ...appliedDates, ...interviewDates]);
  const days = [...daySet].sort();
  const captureCum = cumulate(days, captures);
  const appliedCum = cumulate(days, appliedDates);
  const interviewCum = cumulate(days, interviewDates);
  const maxY = Math.max(
    captureCum[captureCum.length - 1] || 0,
    appliedCum[appliedCum.length - 1] || 0,
    interviewCum[interviewCum.length - 1] || 0,
    1
  );

  const W = 300, H = 170;
  const padL = 30, padR = 14, padT = 14, padB = 24;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const firstT = new Date(days[0]).getTime();
  const lastT = new Date(days[days.length - 1]).getTime();
  const rangeT = Math.max(1, lastT - firstT);

  const project = (day, cum) => {
    const t = new Date(day).getTime();
    const x = padL + ((t - firstT) / rangeT) * innerW;
    const y = padT + innerH - (cum / maxY) * innerH;
    return { x, y };
  };
  const seriesPts = (cum) => days.map((d, i) => project(d, cum[i]));

  const polyline = (pts, stroke, dash) =>
    `<polyline points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}"
       fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''} />`;
  const dots = (pts, fill) => pts.map((p) =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2" fill="${fill}" />`
  ).join('');

  const fmt = (t) => new Date(t).toISOString().slice(5, 10);
  const axis = `
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}"
          stroke="var(--jc-border-strong)" stroke-width="1" />
    <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}"
          stroke="var(--jc-border-strong)" stroke-width="1" />
    <text x="${padL - 4}" y="${padT + 4}" text-anchor="end"
          style="fill: var(--jc-text-3)" font-family="var(--jc-font-mono)" font-size="9">${maxY}</text>
    <text x="${padL - 4}" y="${H - padB}" text-anchor="end"
          style="fill: var(--jc-text-3)" font-family="var(--jc-font-mono)" font-size="9">0</text>
    <text x="${padL}" y="${H - 6}"
          style="fill: var(--jc-text-3)" font-family="var(--jc-font-mono)" font-size="9">${fmt(firstT)}</text>
    <text x="${W - padR}" y="${H - 6}" text-anchor="end"
          style="fill: var(--jc-text-3)" font-family="var(--jc-font-mono)" font-size="9">${fmt(lastT)}</text>`;

  const capturePts   = seriesPts(captureCum);
  const appliedPts   = seriesPts(appliedCum);
  const interviewPts = seriesPts(interviewCum);
  const legend = `
    <div class="two-line-legend">
      <span><span class="legend-swatch" style="background:var(--jc-accent)"></span>Jobs · ${captureCum[captureCum.length - 1] || 0}</span>
      <span><span class="legend-swatch" style="background:var(--jc-info)"></span>Applications · ${appliedCum[appliedCum.length - 1] || 0}</span>
      <span><span class="legend-swatch" style="background:var(--jc-pos)"></span>Interviews · ${interviewCum[interviewCum.length - 1] || 0}</span>
    </div>`;

  const lags = collectInterviewLags(jobsList);
  const lagCaption = lags.length
    ? `Avg <strong>${Math.round(lags.reduce((a, b) => a + b, 0) / lags.length)}</strong> days from Applied → first Interview (range ${Math.min(...lags)}–${Math.max(...lags)}, n=${lags.length})`
    : 'No Applied → Interview timing recorded yet';

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    ${axis}
    ${polyline(capturePts, 'var(--jc-accent)')}
    ${polyline(appliedPts, 'var(--jc-info)')}
    ${polyline(interviewPts, 'var(--jc-pos)')}
    ${dots(capturePts, 'var(--jc-accent)')}
    ${dots(appliedPts, 'var(--jc-info)')}
    ${dots(interviewPts, 'var(--jc-pos)')}
  </svg>
  ${legend}
  <div class="chart-caption">${lagCaption}</div>`;
}

// Turn a sorted list of ISO-date strings into a cumulative count aligned
// to `days`. Result[i] = count of events at or before days[i].
export function cumulate(days, events) {
  const perDay = new Map();
  for (const e of events) perDay.set(e, (perDay.get(e) || 0) + 1);
  let running = 0;
  return days.map((d) => {
    running += perDay.get(d) || 0;
    return running;
  });
}

// Per-job days between the Applied timeline entry and the first
// Interviewing entry — used by both the trend chart caption and the
// standalone Apply→Interview KPI card.
export function collectInterviewLags(jobsList) {
  const lags = [];
  for (const j of jobsList) {
    if (normalizeStatus(j.status) !== 'interviewing') continue;
    const applied = statusChangeAt(j, 'applied');
    const interview = firstInterviewAt(j);
    if (!applied || !interview) continue;
    const days = Math.round((new Date(interview).getTime() - new Date(applied).getTime()) / 86400_000);
    if (days >= 0) lags.push(days);
  }
  return lags;
}

export function renderFitHistogram(container, jobsList) {
  const scores = jobsList
    .map((j) => j.analyses?.fit?.result?.fitScore)
    .filter((s) => typeof s === 'number');
  if (!scores.length) {
    container.innerHTML = '<div class="chart-empty">Run fit analysis to see the distribution</div>';
    return;
  }

  const buckets = [
    { label: '0–19',   color: 'var(--jc-neg)',     min: 0,  max: 19 },
    { label: '20–39',  color: 'var(--jc-neg)',     min: 20, max: 39 },
    { label: '40–59',  color: 'var(--jc-caution)', min: 40, max: 59 },
    { label: '60–79',  color: 'var(--jc-caution)', min: 60, max: 79 },
    { label: '80–100', color: 'var(--jc-pos)',     min: 80, max: 100 },
  ];
  for (const b of buckets) b.count = scores.filter((s) => s >= b.min && s <= b.max).length;
  const maxCount = Math.max(...buckets.map((b) => b.count));
  const median = [...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)];

  const W = 300, H = 160, pad = 24;
  const slotW = (W - pad * 2) / buckets.length;
  const bars = buckets.map((b, i) => {
    const x = pad + i * slotW + 4;
    const bw = slotW - 8;
    const bh = maxCount ? (b.count / maxCount) * (H - pad * 2 - 14) : 0;
    const y = H - pad - bh;
    return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" style="fill: ${b.color}; opacity: 0.85" rx="2" />
      ${b.count ? `<text x="${x + bw/2}" y="${y - 3}" text-anchor="middle" style="fill: var(--jc-text)" font-family="var(--jc-font-mono)" font-size="10" font-weight="700">${b.count}</text>` : ''}
      <text x="${x + bw/2}" y="${H - 6}" text-anchor="middle" style="fill: var(--jc-text-3)" font-family="var(--jc-font-mono)" font-size="9">${b.label}</text>`;
  }).join('');

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    <line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" style="stroke: var(--jc-border-strong)" stroke-width="1" />
    ${bars}
  </svg>
  <div class="chart-caption">${scores.length} analyzed · median <strong style="color:var(--jc-text)">${median}</strong></div>`;
}

export function renderSalaryHistogram(container, jobsList) {
  // Use the base-salary MIDPOINT from each job's comp analysis. Legacy records
  // may still have anchorRecommendation; support both.
  const anchors = jobsList
    .map((j) => {
      const s = j.analyses?.comp?.result?.salary?.base;
      if (s?.low != null && s?.high != null) return (s.low + s.high) / 2;
      if (s?.low != null) return s.low;
      if (s?.high != null) return s.high;
      // Legacy fallback
      return j.analyses?.comp?.result?.anchorRecommendation?.baseNumber;
    })
    .filter((n) => typeof n === 'number' && n > 0);
  if (!anchors.length) {
    container.innerHTML = '<div class="chart-empty">Run compensation analysis to see salary distribution</div>';
    return;
  }

  const buckets = [
    { label: '<$150K',    min: 0,      max: 149999 },
    { label: '$150–200K', min: 150000, max: 199999 },
    { label: '$200–250K', min: 200000, max: 249999 },
    { label: '$250–300K', min: 250000, max: 299999 },
    { label: '$300K+',    min: 300000, max: Infinity },
  ];
  for (const b of buckets) b.count = anchors.filter((a) => a >= b.min && a <= b.max).length;
  const maxCount = Math.max(...buckets.map((b) => b.count));
  const sorted = [...anchors].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];

  const W = 300, H = 160, pad = 24;
  const slotW = (W - pad * 2) / buckets.length;
  const bars = buckets.map((b, i) => {
    const x = pad + i * slotW + 4;
    const bw = slotW - 8;
    const bh = maxCount ? (b.count / maxCount) * (H - pad * 2 - 14) : 0;
    const y = H - pad - bh;
    return `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" style="fill: var(--jc-pos); opacity: 0.85" rx="2" />
      ${b.count ? `<text x="${x + bw/2}" y="${y - 3}" text-anchor="middle" style="fill: var(--jc-text)" font-family="var(--jc-font-mono)" font-size="10" font-weight="700">${b.count}</text>` : ''}
      <text x="${x + bw/2}" y="${H - 6}" text-anchor="middle" style="fill: var(--jc-text-3)" font-family="var(--jc-font-mono)" font-size="9">${b.label}</text>`;
  }).join('');

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
    <line x1="${pad}" y1="${H-pad}" x2="${W-pad}" y2="${H-pad}" style="stroke: var(--jc-border-strong)" stroke-width="1" />
    ${bars}
  </svg>
  <div class="chart-caption">${anchors.length} anchors · median <strong style="color:var(--jc-text)">$${Math.round(median/1000)}K</strong> · range $${Math.round(lo/1000)}K–$${Math.round(hi/1000)}K</div>`;
}

// ================================================================
//   Chart registry — canonical list of every chart, in a stable
//   order. Both Jawboard and Jawbridge iterate this to render.
// ================================================================

export const CHARTS = [
  { id: 'funnel',      title: 'Strike Rate Funnel',    render: renderStrikeFunnel,    wide: true  },
  { id: 'voyage',      title: 'Interview Voyage Log',  render: renderVoyageLog,       wide: true  },
  { id: 'aging',       title: 'Most-Cast Titles',      render: renderLinesInWater,    wide: true  },
  { id: 'firstBite',   title: 'Time-to-First-Bite',    render: renderFirstBite,       wide: false },
  { id: 'calibration', title: 'Fit Score Calibration', render: renderCalibration,     wide: false },
  // 'cadence' merged into the unified Pipeline Activity chart (captured).
  { id: 'trophy',      title: 'Trophy Weight Board',   render: renderTrophyBoard,     wide: true  },
  { id: 'status',      title: 'Status Distribution',   render: renderStatusPie,       wide: false },
  { id: 'captured',    title: 'Pipeline Activity',     render: renderCapturedLine,    wide: false },
  { id: 'fit',         title: 'Fit Scores',            render: renderFitHistogram,    wide: false },
  { id: 'salary',      title: 'Salary Anchors',        render: renderSalaryHistogram, wide: false },
];

export const DEFAULT_TOP4 = ['funnel', 'voyage', 'aging', 'firstBite'];

// Render a selected set of charts into a container. Rebuilds the DOM
// so charts can be added/removed without leftover cards. Options:
//   selectedIds  — array of chart IDs to render (in order)
//   onArchiveStale(jobIds) — optional callback for the Lines-in-Water
//                            'Archive stale' button
//   links — enable click-through from chart items. When omitted, charts
//     render as plain read-only. When present, provides URL builders:
//     links.recall(jobId)     → open the per-job Recall page
//     links.jawboard({status,q}) → open Jawboard pre-filtered
export function renderDashboardCharts(container, jobsList, { selectedIds, onArchiveStale, links } = {}) {
  container.innerHTML = '';
  const ids = Array.isArray(selectedIds) && selectedIds.length
    ? selectedIds
    : DEFAULT_TOP4;
  for (const id of ids) {
    const meta = CHARTS.find((c) => c.id === id);
    if (!meta) continue;
    const card = document.createElement('div');
    card.className = meta.wide ? 'dash-card dash-card--wide' : 'dash-card';
    card.dataset.chartId = meta.id;
    const eyebrow = document.createElement('span');
    eyebrow.className = 'jc-eyebrow';
    eyebrow.textContent = meta.title;
    const chart = document.createElement('div');
    chart.className = 'chart';
    card.appendChild(eyebrow);
    card.appendChild(chart);
    container.appendChild(card);
    meta.render(chart, jobsList, { onArchiveStale, links });
  }
}

// Default URL builders that work from any extension page. Callers can
// override, but the defaults are Right Enough for both Jawboard + Jawbridge.
export function defaultLinks() {
  return {
    recall: (jobId) => chrome.runtime.getURL(`recall/recall.html?jobId=${encodeURIComponent(jobId)}`),
    jawboard: ({ status, q } = {}) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (q) params.set('q', q);
      const qs = params.toString();
      return chrome.runtime.getURL(`archive/archive.html${qs ? `?${qs}` : ''}`);
    },
  };
}
