import { searchJobs } from '../lib/search.js';
import { getLinkedInProfileUrl, getContactEmail, getContactPhone, getContactLocation, safeExternalUrl } from '../lib/store.js';
import { attachQuickFill } from '../lib/linkedInFill.js';
import { normalizeStatus, statusLabel, STATUS_ORDER, statusRank } from '../lib/statuses.js';
import { derivePeople, primaryRelationshipLabel, relationshipTags, relationshipTone } from '../lib/people.js';
import { trashSvg } from '../lib/icons.js';
import { computeStrengthScore } from '../lib/strength.js';

const cachedFill = { email: '', phone: '', linkedInUrl: '', location: '' };
attachQuickFill(document.body, () => cachedFill);
chrome.storage.onChanged.addListener((changes) => {
  if (changes['settings.linkedInProfileUrl']) cachedFill.linkedInUrl = changes['settings.linkedInProfileUrl'].newValue || '';
  if (changes['settings.email']) cachedFill.email = changes['settings.email'].newValue || '';
  if (changes['settings.phone']) cachedFill.phone = changes['settings.phone'].newValue || '';
  if (changes['settings.location']) cachedFill.location = changes['settings.location'].newValue || '';
});
Promise.all([getContactEmail(), getContactPhone(), getLinkedInProfileUrl(), getContactLocation()])
  .then(([email, phone, linkedInUrl, location]) => Object.assign(cachedFill, { email, phone, linkedInUrl, location }));

const $ = (id) => document.getElementById(id);
const els = new Proxy({}, { get: (_, id) => $(id) });

let jobs = [];
let followMap = {}; // profileUrl → { following, mode }
let compTargets = {}; // user's { floor, target } — loaded once per boot for strength scoring
let sortKey = 'strengthScore';
let sortDir = 'desc';
const selectedIds = new Set();

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('No response from service worker');
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response;
}

async function load() {
  try {
    const [listResp, countResp, followResp, ctSettings] = await Promise.all([
      send('list-jobs'),
      send('count-jobs'),
      send('get-follow-map').catch(() => ({ data: {} })),
      // compTargets are read straight from storage — no SW roundtrip
      // needed and they're small.
      chrome.storage.local.get('settings.compTargets').catch(() => ({})),
    ]);
    jobs = listResp.data || [];
    followMap = followResp?.data || {};
    compTargets = ctSettings['settings.compTargets'] || {};
    const indexCount = countResp.data ?? null;
    console.info('[Jawboard] list-jobs returned', jobs.length, 'records; count-jobs (index) returned', indexCount);
    if (indexCount != null && jobs.length !== indexCount) {
      console.warn('[Jawboard] MISMATCH: index has', indexCount, 'ids but', jobs.length, 'records loaded — some records are orphaned in the index');
    }

    // Diagnostic dump of raw storage — user reported "0 jobs" on Jawboard
    // while the sidebar's count says >0. Log the raw index and a sample of
    // job records so we can see whether the index is populated but records
    // are missing, or vice versa.
    try {
      const raw = await chrome.storage.local.get(null);
      const jobKeys = Object.keys(raw).filter((k) => k.startsWith('job.'));
      const indexRaw = raw['jobs.index'];
      console.info('[Jawboard] raw storage — jobs.index length:', Array.isArray(indexRaw) ? indexRaw.length : `(not array: ${typeof indexRaw})`);
      console.info('[Jawboard] raw storage — job.* keys count:', jobKeys.length);
      if (jobKeys.length > 0 && jobs.length === 0) {
        console.warn('[Jawboard] Storage has', jobKeys.length, 'job.* records but list-jobs returned 0 — index/records desync. Sample record:', raw[jobKeys[0]]);
      }
      if (Array.isArray(indexRaw) && jobKeys.length > 0 && jobs.length === 0) {
        // Try rebuilding: any job.<id> key that isn't in index gets appended.
        const inIndex = new Set(indexRaw.map(String));
        const orphanIds = jobKeys.map((k) => k.slice(4)).filter((id) => !inIndex.has(id));
        console.warn('[Jawboard] orphan job.* records not in index:', orphanIds.length, orphanIds.slice(0, 5));
      }
    } catch (diagE) {
      console.warn('[Jawboard] diagnostic dump failed:', diagE);
    }

    els.count.textContent = `${jobs.length} jawb${jobs.length === 1 ? '' : 's'} in your boat`
      + (indexCount != null && indexCount !== jobs.length ? ` (index says ${indexCount})` : '');
    els.emptyState.hidden = jobs.length > 0;
    // Pre-apply URL filters — set once per page load so drilldowns from
    // Jawbridge charts (?status=applied, ?q=director) land pre-filtered.
    applyUrlFilters();
    // Grid-actions bar shows/hides based on whether the archive has
    // any jawbs — nothing to Thresh/Enrich on an empty archive.
    const gridActions = document.getElementById('gridActions');
    if (gridActions) gridActions.hidden = jobs.length === 0;
    render();
    checkExportReminder();
  } catch (e) {
    console.error('[Jawboard] load failed:', e);
    els.count.textContent = `error: ${e.message}`;
    els.emptyState.hidden = false;
    els.emptyState.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.padding = '16px';
    wrap.style.color = 'var(--jc-neg)';
    wrap.textContent = `Load failed: ${e.message}. Open the Jawboard tab's DevTools console for details.`;
    els.emptyState.appendChild(wrap);
  }
}

function render() {
  const query = els.search.value.trim();
  const status = els.statusFilter.value;
  const source = els.sourceFilter?.value || '';
  const showArchived = !!els.showArchived?.checked;

  let rows = jobs.slice();
  // Archived jawbs are hidden by default so the day-to-day list stays
  // focused on active pipeline. The Show Archived checkbox opts back
  // in. When the user explicitly picks Archived from the status
  // dropdown, honor that regardless of the checkbox.
  if (!showArchived && status !== 'archived') {
    rows = rows.filter((j) => normalizeStatus(j.status) !== 'archived');
  }
  if (status) rows = rows.filter((j) => normalizeStatus(j.status) === status);
  // "Waters" filter — capture source. Records without a source field
  // (legacy) are treated as LinkedIn per jobSource() default.
  if (source) rows = rows.filter((j) => (j.source || 'linkedin') === source);
  if (query) rows = searchJobs(rows, query).map((r) => r.job);

  rows.sort((a, b) => {
    const av = extractSortValue(a, sortKey);
    const bv = extractSortValue(b, sortKey);
    if (av === bv) return 0;
    const cmp = av > bv ? 1 : -1;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  els.tbody.innerHTML = '';
  for (const job of rows) {
    els.tbody.appendChild(renderRow(job));
  }
  renderPipelineStrip(rows);
  renderBoardFoot(rows);
  updateSortHeaders();
  updateSelectionUi();
}

// Pipeline strip — colored horizontal bar under the toolbar showing
// stage counts. Widths are proportional to counts so the visual
// weight of each segment reflects the actual share of the board.
// Clicking a segment sets the status filter — a fast way to drill
// into a stage without opening the dropdown.
const PIPELINE_STAGES = [
  { key: 'saved',                   label: 'Saved' },
  { key: 'inProgressDraft',         label: 'In Progress · Draft' },
  { key: 'inProgressClickedApply',  label: 'In Progress · Clicked' },
  { key: 'applied',                 label: 'Applied' },
  { key: 'interviewing',            label: 'Interviewing' },
  { key: 'archived',                label: 'Archived' },
  { key: 'notMovingForward',        label: 'Not Moving Forward' },
];
function renderPipelineStrip(rows) {
  const strip = document.getElementById('pipelineStrip');
  if (!strip) return;
  // Counts are computed against ALL jobs (not the filtered rows) so
  // the pipeline stays a stable overview even while the user filters.
  const counts = {};
  for (const j of jobs) {
    const s = normalizeStatus(j.status);
    counts[s] = (counts[s] || 0) + 1;
  }
  // Hide the strip entirely when no jobs have any tracker-eligible status.
  const total = PIPELINE_STAGES.reduce((n, s) => n + (counts[s.key] || 0), 0);
  if (!total) { strip.hidden = true; strip.innerHTML = ''; return; }
  strip.hidden = false;
  strip.innerHTML = '';
  const current = els.statusFilter?.value || '';
  for (const stage of PIPELINE_STAGES) {
    const n = counts[stage.key] || 0;
    if (!n) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jc-jb-pipeline__seg';
    btn.dataset.stage = stage.key;
    btn.style.flex = String(n);
    btn.title = `${stage.label}: ${n} jawbs — click to filter`;
    btn.setAttribute('aria-pressed', current === stage.key ? 'true' : 'false');
    // Count leads (big number, primary scan target); label sits under
    // it in small mono; proportional bar renders at the bottom.
    const countSpan = document.createElement('span');
    countSpan.className = 'jc-jb-pipeline__count';
    countSpan.textContent = String(n);
    btn.appendChild(countSpan);
    const label = document.createElement('span');
    label.className = 'jc-jb-pipeline__label';
    label.textContent = stage.label;
    btn.appendChild(label);
    const bar = document.createElement('span');
    bar.className = 'jc-jb-pipeline__bar';
    btn.appendChild(bar);
    btn.addEventListener('click', () => {
      // Toggle: clicking the active stage clears the filter.
      els.statusFilter.value = els.statusFilter.value === stage.key ? '' : stage.key;
      els.statusFilter.dispatchEvent(new Event('change'));
    });
    strip.appendChild(btn);
  }
}

// Board footer summary — "Showing N of M · sorted by X" plus a stale
// nudge when any visible jawb hasn't seen movement in 21+ days.
function renderBoardFoot(rows) {
  const foot = document.getElementById('boardFoot');
  const summary = document.getElementById('boardSummary');
  const stale = document.getElementById('boardStale');
  if (!foot || !summary) return;
  if (!jobs.length) { foot.hidden = true; return; }
  foot.hidden = false;
  const sortLabel = SORT_LABELS[sortKey] || sortKey;
  summary.textContent = `Showing ${rows.length} of ${jobs.length} · sorted by ${sortLabel} ${sortDir === 'asc' ? '↑' : '↓'}`;
  if (stale) {
    const staleCutoff = Date.now() - 21 * 86400_000;
    const staleCount = rows.filter((j) => {
      const status = normalizeStatus(j.status);
      if (status !== 'applied' && status !== 'interviewing') return false;
      const t = Date.parse(j.statusUpdatedAt || j.updatedAt || j.capturedAt || '');
      return t && t < staleCutoff;
    }).length;
    if (staleCount) {
      stale.hidden = false;
      stale.textContent = `⚠ ${staleCount} jawb${staleCount === 1 ? '' : 's'} going stale — no move in 21+ days`;
    } else {
      stale.hidden = true;
    }
  }
}
const SORT_LABELS = {
  title: 'title', company: 'company', status: 'status',
  strengthScore: 'strength',
  peopleCount: 'people',
  capturedAt: 'captured', interviewAt: 'interview',
  compLow: 'comp low', compHigh: 'comp high',
};

// Analytics dashboard preview was removed from the Jawboard. The
// full chart suite still lives on the Jawbridge page (jawbridge.js
// imports from ./dashboardCharts.js directly).

// Comp gauge score — top-of-range as a % of the user's Settings →
// target salary. Same signal the Jawbar meta strip renders, and the
// same numeric formula the LinkedIn-card decorator uses (kept in sync
// with service-worker's computeCompGaugeScore + panel.js's renderCompGauge).
// Returns null when we have neither a comp range nor a vsTarget verdict.
function computeCompGaugeScore(job) {
  const comp = job?.analyses?.comp?.result;
  if (!comp) return null;
  const salary = comp.salary;
  const low  = salary?.base?.low  ?? comp.marketEstimate?.baseLow  ?? null;
  const high = salary?.base?.high ?? comp.marketEstimate?.baseHigh ?? null;
  const target = Number(compTargets?.target) || null;
  const floor  = Number(compTargets?.floor)  || null;
  const vsTarget = salary?.vsTargets?.vsTarget || comp.vsTargets?.vsTarget;
  const hasRange = high != null || low != null;
  if (!hasRange && !vsTarget) return null;
  const anchor = high ?? low;
  if (target && anchor) return Math.min(100, Math.round((anchor / target) * 100));
  if (vsTarget) {
    return vsTarget === 'above' ? 100
         : vsTarget === 'at'    ? 80
         : vsTarget === 'below' ? 30
         : 50;
  }
  if (floor && anchor) return Math.min(100, Math.round((anchor / floor) * 60));
  return 50;
}

function extractSortValue(job, key) {
  const p = job.posting || {};
  const comp = job.analyses?.comp?.result;
  switch (key) {
    case 'title': return (p.title || '').toLowerCase();
    case 'company': return (p.company || '').toLowerCase();
    case 'status': return job.status || '';
    case 'peopleCount': return collectJobPeople(job).length;
    case 'capturedAt': return job.capturedAt || '';
    case 'strengthScore': return computeStrengthScore(job, { compTargets, followMap }).score;
    case 'interviewAt': {
      // Upcoming rounds sort ahead of past rounds, both ordered by
      // proximity to now. Missing rounds sort last.
      const i = nextOrLatestInterview(job);
      if (!i) return '';
      // Prefix so upcoming (which we want first in ascending order)
      // beats past regardless of raw date compare.
      return (i.tense === 'upcoming' ? '1_' : '2_') + i.iso;
    }
    case 'compLow': {
      const n = comp?.salary?.base?.low ?? comp?.marketEstimate?.baseLow;
      return typeof n === 'number' ? n : -1;
    }
    case 'compHigh': {
      const n = comp?.salary?.base?.high ?? comp?.marketEstimate?.baseHigh;
      return typeof n === 'number' ? n : -1;
    }
    default: return '';
  }
}

function fitScoreTier(score) {
  if (score == null) return 'none';
  if (score >= 70) return 'pos';
  if (score >= 40) return 'caution';
  return 'neg';
}

function fmtK(n) {
  if (n == null || Number.isNaN(n)) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}


// Compact People cell — leads with the highest-priority relationship
// (e.g. "Hiring Mgr", "1st at co."), followed by the total count and a
// follow-check when any people are being followed. Hover title
// enumerates the full list.
// People cell — plain-text list of degree counts, e.g. "1st × 3, 2nd × 2".
// Deliberately drops the badge treatment so the column reads as data,
// not another status pill. Only degrees present in the record show up.
function renderPeopleCell(job) {
  const people = derivePeople(job, { followMap });
  if (!people.length) return h('span', { class: 'col-empty' }, '—');

  const buckets = new Map();
  for (const p of people) {
    const d = Number(p.degree);
    if (d === 1) buckets.set(1, (buckets.get(1) || 0) + 1);
    else if (d === 2) buckets.set(2, (buckets.get(2) || 0) + 1);
    else if (d === 3) buckets.set(3, (buckets.get(3) || 0) + 1);
    else buckets.set(0, (buckets.get(0) || 0) + 1); // other/unknown
  }
  const parts = [];
  for (const deg of [1, 2, 3, 0]) {
    const n = buckets.get(deg);
    if (!n) continue;
    const label = deg === 1 ? '1st' : deg === 2 ? '2nd' : deg === 3 ? '3rd' : 'other';
    parts.push(`${label} × ${n}`);
  }

  // Full names + relationships still surface in the hover title so the
  // column stays useful without opening the job.
  const tipLines = people.slice(0, 20).map((p) => {
    const tags = relationshipTags(p);
    const bits = [`[${tags[0] || 'Contact'}]`, p.name || '(unnamed)'];
    if (p.headline) bits.push(`— ${p.headline.slice(0, 60)}`);
    return bits.join(' ');
  });

  // Render each degree bucket on its own line so multi-level rows
  // stay legible (e.g. "1st × 2" over "2nd × 3" rather than smushed
  // together). The wrapper's CSS turns it into a compact stack.
  return h('span', {
    class: 'col-people',
    title: tipLines.join('\n'),
  }, ...parts.map((line) => h('span', { class: 'col-people__line' }, line)));
}

// Kept for sort-key extraction (uses .length only).
function collectJobPeople(job) {
  return derivePeople(job, { followMap });
}

// Strength cell — two-row layout mirroring the Jawbar's meta strip.
//   Row 1: big strength score + shark portrait
//   Row 2: three mini circular gauges (Fit · Strength · Comp) using
//          the same band-colored SVG rings the Jawbar renders.
// Full breakdown still surfaces in the hover title.
function renderStrengthCell(job) {
  const s = computeStrengthScore(job, { compTargets, followMap });
  const b = s.breakdown;
  const tip = [
    `${s.tierLabel} — ${s.tierDescription}`,
    ``,
    `Fit:         ${Math.round(b.fit.score)}/${b.fit.max}   ${b.fit.note}`,
    `Comp:        ${Math.round(b.comp.score)}/${b.comp.max}   ${b.comp.note}`,
    `Connections: ${Math.round(b.connections.score)}/${b.connections.max}   ${b.connections.note}`,
  ].join('\n');
  const fitRaw = job?.analyses?.fit?.result?.fitScore;
  const compRaw = computeCompGaugeScore(job);
  // Connections gauge normalizes the raw connections component (0-20
  // per the rebalanced weights) up to a 0-100 scale so it reads on
  // the same axis as Fit and Comp. `null` when no connections signal
  // exists so the gauge renders as an empty placeholder.
  const connectionsRaw = b.connections?.max
    ? Math.round((b.connections.score / b.connections.max) * 100)
    : null;
  return h('span', { class: 'strength-cell', 'data-tier': s.tier, title: tip },
    // Row 1 — big score + shark portrait side by side.
    h('span', { class: 'strength-cell__row strength-cell__row--head' },
      h('span', { class: 'strength-cell__score' }, String(s.score)),
      h('img', {
        class: 'strength-cell__shark',
        src: `../${s.tierImage}`,
        alt: s.tierLabel,
        title: s.tierLabel,
        width: '69', height: '42',
      }),
    ),
    // Row 2 — Fit / Connections / Comp mini gauges (the three
    // components of the composite strength score, mirroring what the
    // Jawbar meta strip surfaces for the same job).
    h('span', { class: 'strength-cell__row strength-cell__row--gauges' },
      strengthMiniGaugeGroup('Fit', fitRaw),
      strengthMiniGaugeGroup('Conn', connectionsRaw),
      strengthMiniGaugeGroup('Comp', compRaw),
    ),
  );
}

// Compact column: mini gauge on top + tiny label beneath. Kept
// consistent with the Jawbar meta-strip layout so both surfaces read
// as the same visual system.
function strengthMiniGaugeGroup(label, score) {
  const wrap = h('span', { class: 'strength-mini', title: `${label}: ${score == null ? '—' : `${Math.round(score)}/100`}` });
  wrap.appendChild(miniGaugeSvg(score));
  wrap.appendChild(h('span', { class: 'strength-mini__label' }, label));
  return wrap;
}

// Mini circular gauge (r=8, circumference ≈ 50.27) built inline as
// SVG so no external stylesheet is needed. Band colors match the
// LinkedIn card decorator: weak coral / fair amber / strong teal.
function miniGaugeSvg(score) {
  const n = score == null ? null : Math.max(0, Math.min(100, Math.round(score)));
  const CIRC = 50.27;
  const dash = n == null ? 0 : (n / 100) * CIRC;
  const band = n == null ? 'none' : (n >= 70 ? 'strong' : n >= 40 ? 'fair' : 'weak');
  const palette = {
    weak:   { stroke: '#D85A30', track: '#FAECE7', text: '#993C1D' },
    fair:   { stroke: '#BA7517', track: '#FAEEDA', text: '#854F0B' },
    strong: { stroke: '#1D9E75', track: '#E1F5EE', text: '#085041' },
    none:   { stroke: '#B0B0AF', track: '#EDEDEB', text: '#66696B' },
  }[band];
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '26'); svg.setAttribute('height', '26');
  svg.setAttribute('viewBox', '0 0 26 26');
  svg.setAttribute('role', 'img');
  svg.classList.add('strength-mini__svg');
  const track = document.createElementNS(NS, 'circle');
  track.setAttribute('cx', '13'); track.setAttribute('cy', '13'); track.setAttribute('r', '8');
  track.setAttribute('fill', 'none');
  track.setAttribute('stroke', palette.track);
  track.setAttribute('stroke-width', '3');
  svg.appendChild(track);
  if (n != null) {
    const fill = document.createElementNS(NS, 'circle');
    fill.setAttribute('cx', '13'); fill.setAttribute('cy', '13'); fill.setAttribute('r', '8');
    fill.setAttribute('fill', 'none');
    fill.setAttribute('stroke', palette.stroke);
    fill.setAttribute('stroke-width', '3');
    fill.setAttribute('stroke-linecap', 'round');
    fill.setAttribute('transform', 'rotate(-90 13 13)');
    fill.setAttribute('stroke-dasharray', `${dash.toFixed(2)} ${CIRC}`);
    svg.appendChild(fill);
  }
  const text = document.createElementNS(NS, 'text');
  text.setAttribute('x', '13'); text.setAttribute('y', '16');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('fill', palette.text);
  text.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
  text.setAttribute('font-size', '9');
  text.setAttribute('font-weight', '700');
  text.textContent = n == null ? '—' : String(n);
  svg.appendChild(text);
  return svg;
}

function renderRow(job) {
  const p = job.posting || {};
  const openRecall = () => {
    window.open(`../recall/recall.html?jobId=${encodeURIComponent(job.jobId)}`, '_blank');
  };

  // Comp — pull low/high (prefer new schema, fall back to marketEstimate).
  const comp = job.analyses?.comp?.result;
  const base = comp?.salary?.base;
  const compLow  = base?.low  ?? comp?.marketEstimate?.baseLow  ?? null;
  const compHigh = base?.high ?? comp?.marketEstimate?.baseHigh ?? null;
  const compLoCell = compLow != null
    ? h('span', { class: 'col-comp-num' }, fmtK(compLow))
    : h('span', { class: 'col-empty' }, '—');
  const compHiCell = compHigh != null
    ? h('span', { class: 'col-comp-num col-comp-num--hi' }, fmtK(compHigh))
    : h('span', { class: 'col-empty' }, '—');

  const checkbox = h('input', {
    type: 'checkbox', class: 'row-select',
    onClick: (e) => {
      e.stopPropagation();
      if (e.target.checked) selectedIds.add(job.jobId);
      else selectedIds.delete(job.jobId);
      updateSelectionUi();
    },
  });
  if (selectedIds.has(job.jobId)) checkbox.checked = true;

  // Interview date cell — next scheduled round if any are in the future,
  // otherwise the most recent past round. Empty when there are no rounds.
  const interviewInfo = nextOrLatestInterview(job);
  const interviewCell = interviewInfo
    ? h('span', {
        class: `col-interview col-interview--${interviewInfo.tense}`,
        title: interviewInfo.tense === 'upcoming'
          ? `Next interview: ${interviewInfo.iso}`
          : `Most recent interview: ${interviewInfo.iso}`,
      }, fmtDate(interviewInfo.iso))
    : h('span', { class: 'col-empty' }, '—');

  const source = job.source || 'linkedin';
  const sourceHint = source === 'google_jobs' ? 'Captured from Google Jobs' : 'Captured from LinkedIn';
  // Tag the row with the job's strength tier so the CSS can paint a
  // colored left rail matching the shark tier (great-white gold →
  // pygmy red). The tier reflects the same score the Strength cell
  // shows, so the rail reads as a fast visual prioritization cue.
  const rowTier = computeStrengthScore(job, { compTargets, followMap }).tier;
  return h('tr', { 'data-tier': rowTier, title: sourceHint },
    h('td', { class: 'col-select' }, checkbox),
    // Title cell — job title (bold near-navy) on top, company name
    // as a Google-search link beneath, and the row's action group
    // beneath that. The dedicated Actions column was retired since
    // grouping the buttons with the title reduces horizontal scroll
    // and puts every affordance for a row in one visual anchor.
    h('td', { class: 'col-title' },
      h('div', { class: 'col-title__wrap' },
        h('div', { class: 'col-title__row' },
          h('span', {
            class: 'col-title__text clickable',
            title: 'Open the Recall page for this jawb',
            onClick: openRecall,
          }, p.title || '(untitled)'),
        ),
        p.company
          ? h('a', {
              class: 'col-title__company',
              href: `https://www.google.com/search?q=${encodeURIComponent(p.company)}`,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: `Search Google for ${p.company}`,
            }, p.company)
          : h('span', { class: 'col-title__company col-title__company--empty' }, '—'),
        renderRowActions(job, openRecall),
      ),
    ),
    h('td', {}, (() => {
      const s = normalizeStatus(job.status);
      return h('span', { class: `status-badge status-${s}`, dataset: { status: s } }, statusLabel(s));
    })()),
    h('td', { class: 'col-strength' }, renderStrengthCell(job)),
    h('td', { class: 'col-people-wrap' }, renderPeopleCell(job)),
    h('td', { class: 'col-captured' }, fmtDate(job.capturedAt)),
    h('td', { class: 'col-interview-wrap' }, interviewCell),
    h('td', { class: 'col-comp-cell' }, compLoCell),
    h('td', { class: 'col-comp-cell' }, compHiCell),
  );
}

// Row action group — segmented control containing every affordance
// for a single job. Rendered inside the title cell (beneath the
// company link) so each row's controls sit next to the row's
// identity rather than at a far-away right edge. Every child is a
// small button/link picked up by the shared .col-actions__row rules.
function renderRowActions(job, openRecall) {
  const p = job.posting || {};
  return h('div', { class: 'col-actions' },
    h('div', { class: 'col-actions__row' },
      job.url ? h('a', {
        href: safeExternalUrl(job.url), target: '_blank', rel: 'noopener',
        class: 'jc-icon-btn', title: 'Open on LinkedIn', 'aria-label': 'Open on LinkedIn',
      },
        h('img', {
          class: 'jc-li-icon', src: '../assets/linkedin.svg',
          alt: 'LinkedIn', width: '14', height: '14',
        }),
      ) : null,
      renderFindOnTrackerBtn(job),
      renderCorpSiteBtn(job),
      h('button', {
        type: 'button',
        class: 'jc-icon-btn jc-icon-btn--danger',
        'aria-label': 'Delete jawb from Jawboard',
        title: `Delete "${p.title || job.jobId}" from Jawboard`,
        onClick: async (e) => {
          e.preventDefault();
          if (!confirm(`Delete "${p.title || job.jobId}" from Jawboard?`)) return;
          await send('delete-job', { jobId: job.jobId });
          load();
        },
      }, trashSvg()),
    ),
    needsEnrichment(job) ? h('a', {
      class: 'col-actions__enrich',
      href: '#', onClick: async (e) => {
        e.preventDefault();
        e.target.textContent = '…';
        try { await send('enrich-job', { jobId: job.jobId }); await load(); }
        catch (err) { e.target.textContent = 'failed'; console.warn(err); }
      },
    }, 'Enrich') : null,
  );
}

// Interview column data — returns the next scheduled round when at
// least one is in the future; otherwise the most recent past round.
// Rounds live on job.interviewRounds; each has an ISO `date` (and
// optional `time`). Returns { iso, tense: 'upcoming' | 'past' } or
// null when the job has no rounds.
function nextOrLatestInterview(job) {
  const rounds = Array.isArray(job?.interviewRounds) ? job.interviewRounds : [];
  const dated = rounds
    .map((r) => r?.date ? (r.time ? `${r.date}T${r.time}` : r.date) : null)
    .filter(Boolean)
    .sort();
  if (!dated.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = dated.find((d) => d.slice(0, 10) >= today);
  if (upcoming) return { iso: upcoming.slice(0, 10), tense: 'upcoming' };
  return { iso: dated[dated.length - 1].slice(0, 10), tense: 'past' };
}

// "Find on LinkedIn tracker" row action. Opens a LinkedIn tab at the
// right stage URL and walks pages until the job's row is on screen,
// where it flashes an outline. Disabled for jobs whose status isn't
// on the tracker at all (analyzed-only records). Source filter: the
// tracker only holds LinkedIn jobs, so Google Jobs captures show
// nothing to find.
function renderFindOnTrackerBtn(job) {
  const normalized = normalizeStatus(job.status);
  const onTracker = normalized !== 'analyzed' && (job.source || 'linkedin') === 'linkedin';
  const btn = h('button', {
    type: 'button',
    class: 'jc-icon-btn jc-jawb-tracker-btn',
    'aria-label': 'Find on LinkedIn tracker',
    title: onTracker
      ? `Find on LinkedIn tracker (${statusLabel(normalized)})`
      : 'Not on LinkedIn tracker (analyzed only or Google Jobs capture)',
    onClick: async (e) => {
      e.preventDefault();
      if (btn.disabled) return;
      const label = btn.title;
      btn.disabled = true;
      btn.title = 'Opening LinkedIn tracker and searching…';
      try {
        const r = await send('find-on-tracker', { jobId: job.jobId });
        if (r.ok && r.found) {
          btn.title = `Found on ${r.stageLabel} · page ${r.page}${r.viaHint ? ' (via hint)' : ''}`;
        } else if (r.ok && !r.found) {
          btn.title = r.note || 'Job not found on the tracker.';
          alert(r.note || 'Job not found on the tracker.');
        } else {
          btn.title = r.error || 'Find failed.';
          alert(r.error || 'Find failed.');
        }
      } catch (err) {
        btn.title = err.message || 'Find failed.';
        alert(err.message || 'Find failed.');
      } finally {
        setTimeout(() => { btn.disabled = false; btn.title = label; }, 4000);
      }
    },
  },
    h('img', {
      class: 'jc-li-icon', src: '../assets/linkedin.svg',
      alt: '', 'aria-hidden': 'true', width: '14', height: '14',
    }),
    h('span', { class: 'jc-jawb-tracker-btn__label' }, 'JT'),
  );
  if (!onTracker) btn.disabled = true;
  return btn;
}

// "Find on Corp Career Site" row action — icon-only magnifier that
// opens a Google search for "[Company] Careers - [Title]", matching the
// Jawbar's Corp Site button. Disabled with a clear tooltip when the
// job has no company recorded (nothing to search for).
function renderCorpSiteBtn(job) {
  const p = job.posting || {};
  const company = p.company;
  const magnifier = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    c.setAttribute('cx', '11'); c.setAttribute('cy', '11'); c.setAttribute('r', '7');
    svg.appendChild(c);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M21 21l-4.35-4.35');
    svg.appendChild(path);
    return svg;
  };
  if (!company) {
    const btn = h('button', {
      type: 'button',
      class: 'jc-icon-btn',
      'aria-label': 'Find on corp career site',
      title: 'No company recorded — nothing to search for.',
      disabled: 'disabled',
    }, magnifier());
    return btn;
  }
  const q = `${company} Careers${p.title ? ' - ' + p.title : ''}`;
  return h('a', {
    href: `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    target: '_blank', rel: 'noopener noreferrer',
    class: 'jc-icon-btn',
    'aria-label': `Google search: ${q}`,
    title: `Google: ${q}`,
  }, magnifier());
}

function needsEnrichment(job) {
  const d = job.posting?.descriptionText;
  return !job.postingArchived && (!d || d.length < 500);
}

// ---------- Sorting ----------

document.querySelectorAll('th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    else { sortKey = key; sortDir = 'asc'; }
    render();
    updateSortHeaders();
  });
});

// Sync each th's aria-sort attribute with the current sortKey/sortDir
// so the ::after arrow CSS shows the active direction without JS
// touching innerHTML. Called after every render.
function updateSortHeaders() {
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    if (th.dataset.sort === sortKey) {
      th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  });
}

// Selection & bulk-delete
function visibleJobIds() {
  return Array.from(els.tbody.querySelectorAll('tr'))
    .map((tr) => {
      const check = tr.querySelector('.row-select');
      return check ? { tr, cb: check } : null;
    })
    .filter(Boolean);
}

function updateSelectionUi() {
  const btn = document.getElementById('deleteSelected');
  const count = document.getElementById('selectedCount');
  if (btn && count) {
    btn.hidden = selectedIds.size === 0;
    count.textContent = selectedIds.size;
  }
  // Also update the sticky bulk bar
  const bar = document.getElementById('bulkBar');
  const bulkCount = document.getElementById('bulkCount');
  if (bar && bulkCount) {
    bar.hidden = selectedIds.size === 0;
    bulkCount.textContent = selectedIds.size;
  }
  const master = document.getElementById('selectAll');
  if (master) {
    const rows = visibleJobIds();
    const allSelected = rows.length > 0 && rows.every(({ cb }) => cb.checked);
    const anySelected = rows.some(({ cb }) => cb.checked);
    master.checked = allSelected;
    master.indeterminate = anySelected && !allSelected;
  }
}

document.getElementById('selectAll')?.addEventListener('click', (e) => {
  const check = e.target.checked;
  // Iterate current filtered/rendered rows only — select-all shouldn't
  // touch jobs the user has filtered out of view.
  els.tbody.querySelectorAll('tr').forEach((tr) => {
    const cb = tr.querySelector('.row-select');
    if (!cb) return;
    cb.checked = check;
    // Recover jobId by row order — same iteration order as render()
  });
  // Rebuild selectedIds from currently-visible rows
  selectedIds.clear();
  if (check) {
    const query = els.search.value.trim();
    const status = els.statusFilter.value;
    let rows = jobs.slice();
    if (status) rows = rows.filter((j) => normalizeStatus(j.status) === status);
    if (query) rows = searchJobs(rows, query).map((r) => r.job);
    for (const j of rows) selectedIds.add(j.jobId);
  }
  updateSelectionUi();
});

// Sticky bulk-bar buttons mirror the toolbar Delete
document.getElementById('bulkDeselect')?.addEventListener('click', () => {
  selectedIds.clear();
  els.tbody.querySelectorAll('.row-select').forEach((cb) => { cb.checked = false; });
  updateSelectionUi();
});

document.getElementById('bulkDelete')?.addEventListener('click', () => {
  document.getElementById('deleteSelected')?.click();
});

document.getElementById('deleteSelected')?.addEventListener('click', async () => {
  const count = selectedIds.size;
  if (!count) return;
  if (!confirm(`Delete ${count} jawb${count === 1 ? '' : 's'} from the archive?\n\nThis removes analyses, offer details, interview rounds, and timeline. Cannot be undone (except via re-import from a JSON backup).`)) return;
  const btn = document.getElementById('deleteSelected');
  // The button holds an SVG + a text span (id=selectedCount inside a
  // wrapper span). Update just the label span so the trash icon stays
  // in place through the delete cycle.
  const labelSpan = btn.querySelector('span:last-of-type');
  const originalLabelHtml = labelSpan?.innerHTML;
  btn.disabled = true;
  if (labelSpan) labelSpan.textContent = `Deleting ${count}…`;
  let ok = 0, failed = 0;
  for (const id of Array.from(selectedIds)) {
    try { await send('delete-job', { jobId: id }); ok++; }
    catch (e) { failed++; console.warn('delete failed for', id, e); }
  }
  selectedIds.clear();
  btn.disabled = false;
  if (labelSpan && originalLabelHtml != null) labelSpan.innerHTML = originalLabelHtml;
  if (failed) alert(`Deleted ${ok}. ${failed} failed — check console.`);
  await load();
});

// ---------- Search / filter ----------

// Read ?status= and ?q= from the URL and seed the filters. Only runs at
// initial load so navigating within the page doesn't wipe user edits.
let urlFiltersApplied = false;
function applyUrlFilters() {
  if (urlFiltersApplied) return;
  urlFiltersApplied = true;
  try {
    const params = new URLSearchParams(location.search);
    const status = params.get('status');
    const q = params.get('q');
    if (status && [...els.statusFilter.options].some((o) => o.value === status)) {
      els.statusFilter.value = status;
    }
    if (q) els.search.value = q;
  } catch { /* malformed URL — ignore */ }
}

els.search.addEventListener('input', () => render());
// "/" jumps focus to the search box, like GitHub / Slack / Notion. Guarded
// so it doesn't fire when the user is already typing in any input.
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.preventDefault();
  els.search.focus();
  els.search.select();
});
els.statusFilter.addEventListener('change', () => render());
els.sourceFilter?.addEventListener('change', () => render());
els.showArchived?.addEventListener('change', () => render());

// ---------- LinkedIn progress relay ----------
// Progress messages stream from the SW via 'sync-linkedin-progress'
// during a Sync run — route the walker's per-stage updates into the
// sync panel's progress line so the user can watch it advance.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'sync-linkedin-progress') return;
  let line = null;
  switch (msg.phase) {
    case 'starting':   line = `Syncing (${msg.totalStages} lists)…`; break;
    case 'navigating': line = `Opening ${msg.stageLabel} (${msg.stageIdx}/${msg.totalStages})…`; break;
    case 'walking':
      line = msg.page
        ? `Walking ${msg.stageLabel} · page ${msg.page} · ${msg.walked} so far`
        : `Walking ${msg.stageLabel}…`;
      break;
    case 'stage-done': line = msg.error ? null : `${msg.stageLabel}: ${msg.walked} walked`; break;
  }
  if (line && els.reconcileProgress) els.reconcileProgress.textContent = line;
  if (msg.phase === 'complete' && msg.mode === 'reconcile' && msg.diff) {
    renderReconcileReview(msg.diff);
  }
});

// ---------- Sync with LinkedIn ----------

// Live-updating elapsed-time counter for the running indicator.
// Multi-stage walks can take 3–5 minutes on large archives; without
// a ticking timer users assume the process froze.
let reconcileTimerId = null;
let reconcileStartedAt = 0;
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
function startReconcileRunning() {
  reconcileStartedAt = Date.now();
  if (els.reconcileElapsed) els.reconcileElapsed.textContent = '0:00';
  if (els.reconcileRunning) els.reconcileRunning.hidden = false;
  if (els.reconcileFoot) els.reconcileFoot.hidden = true;
  if (reconcileTimerId) clearInterval(reconcileTimerId);
  reconcileTimerId = setInterval(() => {
    if (els.reconcileElapsed) {
      els.reconcileElapsed.textContent = fmtElapsed(Date.now() - reconcileStartedAt);
    }
  }, 1000);
}
function stopReconcileRunning({ showFoot } = {}) {
  if (reconcileTimerId) { clearInterval(reconcileTimerId); reconcileTimerId = null; }
  if (els.reconcileRunning) els.reconcileRunning.hidden = true;
  if (showFoot && els.reconcileFoot) els.reconcileFoot.hidden = false;
}

// Top-toolbar Sync button delegates to the existing reconcile handler
// so the mockup's red CTA and the inline grid-action pill both trigger
// the same walker.
els.syncLinkedInTop?.addEventListener('click', () => els.reconcileLinkedIn?.click());

// Runs the full-stage walk + diff via the SW, then renders the review
// panel. Non-destructive until the user hits "Apply resolutions".
els.reconcileLinkedIn?.addEventListener('click', async () => {
  if (els.reconcileLinkedIn.disabled) return;
  els.reconcileLinkedIn.disabled = true;
  // Only mutate the label span so the leading SVG icon stays in place;
  // rewriting textContent would strip the icon.
  const label = els.reconcileLinkedIn.querySelector('span');
  const originalLabel = label ? label.textContent : null;
  if (label) label.textContent = 'Syncing…';
  els.reconcilePanel.hidden = false;
  els.reconcileEmpty.hidden = true;
  els.reconcileMissingWrap.hidden = true;
  els.reconcileMismatchWrap.hidden = true;
  els.reconcileMissingList.innerHTML = '';
  els.reconcileMismatchList.innerHTML = '';
  els.reconcileProgress.textContent = 'Opening LinkedIn tab…';
  els.reconcileApplyStatus.textContent = '';
  startReconcileRunning();
  try {
    const r = await send('reconcile-linkedin');
    if (r.diff) renderReconcileReview(r.diff);
  } catch (e) {
    els.reconcileProgress.textContent = `Failed: ${e.message}`;
    stopReconcileRunning({ showFoot: false });
  } finally {
    els.reconcileLinkedIn.disabled = false;
    if (label && originalLabel != null) label.textContent = originalLabel;
  }
});

els.reconcileClose?.addEventListener('click', () => {
  stopReconcileRunning({ showFoot: false });
  els.reconcilePanel.hidden = true;
});

function renderReconcileReview(diff) {
  // Walk finished — kill the running indicator and reveal the
  // Apply-resolutions footer. Elapsed timer's final value is left in
  // the panel head via reconcileProgress for reference.
  const elapsed = reconcileStartedAt ? fmtElapsed(Date.now() - reconcileStartedAt) : null;
  stopReconcileRunning({ showFoot: true });
  const stats = `LinkedIn: ${diff.totalLinkedIn} · archive: ${diff.totalArchive} · missing: ${diff.missingOnLinkedIn.length} · mismatch: ${diff.statusMismatches.length}`;
  els.reconcileProgress.textContent = elapsed ? `${stats} · ${elapsed} elapsed` : stats;
  renderReconcileAudit(diff.stageAudit);
  const nothingToDo = !diff.missingOnLinkedIn.length && !diff.statusMismatches.length;
  els.reconcileEmpty.hidden = !nothingToDo;
  els.reconcileMissingWrap.hidden = diff.missingOnLinkedIn.length === 0;
  els.reconcileMismatchWrap.hidden = diff.statusMismatches.length === 0;
  els.reconcileMissingCount.textContent = diff.missingOnLinkedIn.length ? `(${diff.missingOnLinkedIn.length})` : '';
  els.reconcileMismatchCount.textContent = diff.statusMismatches.length ? `(${diff.statusMismatches.length})` : '';
  els.reconcileMissingList.innerHTML = '';
  els.reconcileMismatchList.innerHTML = '';

  for (const m of diff.missingOnLinkedIn) {
    els.reconcileMissingList.appendChild(reconcileRow({
      jobId: m.jobId,
      title: m.title, company: m.company,
      current: m.currentStatus,
      right: 'not on LinkedIn',
      choices: [
        { value: 'accept-linkedin', label: 'Mark Not Moving Forward' },
        { value: 'keep-local', label: 'Keep local' },
        { value: 'delete', label: 'Delete' },
        { value: 'skip', label: 'Skip' },
      ],
      defaultChoice: 'accept-linkedin',
    }));
  }
  for (const m of diff.statusMismatches) {
    els.reconcileMismatchList.appendChild(reconcileRow({
      jobId: m.jobId,
      title: m.title, company: m.company,
      current: m.currentStatus,
      right: statusLabel(m.linkedInStatus),
      choices: [
        { value: 'accept-linkedin', label: `Accept ${statusLabel(m.linkedInStatus)}` },
        { value: 'keep-local', label: 'Keep local' },
        { value: 'skip', label: 'Skip' },
      ],
      defaultChoice: 'accept-linkedin',
    }));
  }
}

// Render the walker-vs-LinkedIn audit table. Anything with a
// non-zero delta gets a caution row so the user knows the walker
// didn't capture every job LinkedIn claims exists (or LinkedIn's
// count is stale — LinkedIn's numbers lag a few minutes behind).
function renderReconcileAudit(audit) {
  const wrap = els.reconcileAudit;
  const table = els.reconcileAuditTable;
  if (!wrap || !table) return;
  const keys = Object.keys(audit || {});
  if (!keys.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  table.innerHTML = '';
  const head = document.createElement('tr');
  for (const label of ['Stage', 'Walked', 'LinkedIn says', 'Delta']) {
    const th = document.createElement('th');
    th.textContent = label;
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const k of keys) {
    const a = audit[k];
    const tr = document.createElement('tr');
    // Only flag caution when LinkedIn's own count is known and disagrees.
    // linkedInCount === null means the tab-bar scraper missed it — the
    // walker still ran, so show the walked count without a delta.
    const knownDelta = typeof a.delta === 'number';
    if (knownDelta && a.delta !== 0) tr.dataset.tone = 'caution';
    const liCell = a.linkedInCount == null ? '?' : a.linkedInCount;
    const deltaCell = !knownDelta ? '—' : (a.delta > 0 ? `+${a.delta}` : String(a.delta));
    for (const v of [k, a.walked, liCell, deltaCell]) {
      const td = document.createElement('td');
      td.textContent = String(v);
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
}

function reconcileRow({ jobId, title, company, current, right, choices, defaultChoice }) {
  // Use the explicit data-job-id attribute rather than a nested dataset
  // object — h() only knows how to setAttribute, and passing `dataset`
  // as a prop stringifies the whole object into a single unusable
  // attribute. That silently broke Apply resolutions: every row's
  // sel.dataset.jobId came back undefined and the SW skipped every
  // resolution.
  const select = h('select', { class: 'jc-select reconcile-row__choice', 'data-job-id': String(jobId) });
  for (const c of choices) {
    const opt = document.createElement('option');
    opt.value = c.value; opt.textContent = c.label;
    if (c.value === defaultChoice) opt.selected = true;
    select.appendChild(opt);
  }
  return h('div', { class: 'reconcile-row' },
    h('div', { class: 'reconcile-row__meta' },
      h('div', { class: 'reconcile-row__title' }, title || `(untitled ${jobId})`),
      h('div', { class: 'reconcile-row__co jc-footnote' }, company || '—'),
    ),
    h('div', { class: 'reconcile-row__states' },
      h('span', { class: 'jc-footnote' }, `local: ${statusLabel(current)}`),
      h('span', { class: 'jc-footnote' }, `→ linkedin: ${right}`),
    ),
    select,
  );
}

// Bulk "apply this choice to every row in this group" buttons.
els.reconcilePanel?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-bulk][data-choice]');
  if (!btn) return;
  const group = btn.dataset.bulk === 'missing' ? els.reconcileMissingList : els.reconcileMismatchList;
  const choice = btn.dataset.choice;
  for (const sel of group.querySelectorAll('.reconcile-row__choice')) {
    // Only apply the bulk choice when that choice actually exists in
    // this row's dropdown (mismatch rows don't have "Delete", etc.).
    if (Array.from(sel.options).some((o) => o.value === choice)) sel.value = choice;
  }
});

els.reconcileApply?.addEventListener('click', async () => {
  const rows = els.reconcilePanel.querySelectorAll('.reconcile-row__choice');
  const resolutions = Array.from(rows).map((sel) => ({
    jobId: sel.dataset.jobId,
    resolution: sel.value,
  }));
  if (!resolutions.length) return;
  els.reconcileApply.disabled = true;
  els.reconcileApplyStatus.textContent = 'Applying…';
  try {
    // applyReconciliation returns { ok, applied, deleted, skipped }
    // at the top level — no `data` wrapper. Reading r.data.applied
    // previously always showed "Applied 0" even on a successful run.
    const r = await send('apply-reconciliation', { resolutions });
    els.reconcileApplyStatus.textContent = `Applied ${r.applied ?? 0} · deleted ${r.deleted ?? 0} · skipped ${r.skipped ?? 0}`;
    await load();
    // Auto-close after 2s so the user sees the confirmation.
    setTimeout(() => { els.reconcilePanel.hidden = true; }, 2500);
  } catch (e) {
    els.reconcileApplyStatus.textContent = `Failed: ${e.message}`;
  } finally {
    els.reconcileApply.disabled = false;
  }
});

// ---------- Export / Import ----------

els.exportJson.addEventListener('click', async () => {
  const r = await send('export-all');
  const data = r.data || r;
  downloadFile('jawb-export.json', 'application/json', JSON.stringify(data, null, 2));
  await send('mark-exported');
  checkExportReminder();
});

els.exportCsv.addEventListener('click', () => {
  const rows = [
    ['jobId', 'title', 'company', 'location', 'status', 'capturedAt', 'statusUpdatedAt', 'postedSalary', 'url'],
    ...jobs.map((j) => [
      j.jobId,
      j.posting?.title || '',
      j.posting?.company || '',
      j.posting?.location || '',
      j.status || '',
      j.capturedAt || '',
      j.statusUpdatedAt || '',
      j.posting?.postedSalaryRange || '',
      j.url || '',
    ]),
  ];
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  downloadFile('jawb-export.csv', 'text/csv', csv);
});

function csvEscape(v) {
  const s = (v == null ? '' : String(v));
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadFile(name, type, content) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files?.[0];
  if (!file) return;
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { alert(`Invalid JSON: ${e.message}`); return; }
  try {
    const r = await send('import-all', { data });
    alert(`Imported ${r.data?.imported ?? 0} jawbs.`);
    load();
  } catch (e) {
    alert(`Import failed: ${e.message}`);
  }
});

// ---------- Batch analysis (Fit / Comp) ----------
//
// Description enrichment is now a prerequisite inside each analysis run —
// if a job's description is missing, we fetch it first, THEN run the LLM.
// This gives one button per analysis type instead of one dumb enrich button.

let batchCancelled = false;

async function runBatch({ targets, label, perJob, costEstimateUsd }) {
  if (!targets.length) { alert(`Nothing to run — every eligible jawb already has a ${label} analysis.`); return; }
  const costText = costEstimateUsd
    ? `Rough cost estimate: $${(costEstimateUsd * targets.length).toFixed(2)} in Anthropic tokens.`
    : '';
  if (!confirm(`Run ${label} on ${targets.length} jawb${targets.length === 1 ? '' : 's'}?\n\n${costText}\n\nDescriptions are fetched automatically for any jawb missing one. Cancellable mid-run.`)) return;
  batchCancelled = false;
  els.enrichProgress.hidden = false;
  let done = 0, ok = 0, skipped = 0, failed = 0;
  for (const job of targets) {
    if (batchCancelled) break;
    els.enrichText.textContent = `[${done + 1}/${targets.length}] ${label}: ${job.posting?.company || job.jobId}`;
    try {
      // If the description is thin, fetch first — free HTTP, no API cost.
      if (needsEnrichment(job)) {
        try { await send('enrich-job', { jobId: job.jobId }); }
        catch (e) { console.warn('enrich (prerequisite) failed for', job.jobId, e); }
      }
      const result = await perJob(job);
      if (result === 'skipped') skipped++;
      else ok++;
    } catch (e) {
      failed++;
      console.warn(`${label} failed for`, job.jobId, e);
    }
    done++;
    if (done < targets.length && !batchCancelled) await new Promise((r) => setTimeout(r, 2000));
  }
  els.enrichText.textContent = `Done: ${ok} analyzed, ${skipped} skipped, ${failed} failed.`;
  setTimeout(() => { els.enrichProgress.hidden = true; }, 8000);
  load();
}

els.enrichFit?.addEventListener('click', async () => {
  // Skip archived jawbs — no reason to spend tokens scoring fit on
  // roles the user has already moved past. Matches the Show
  // Archived default-hide behavior of the grid itself.
  const targets = jobs.filter((j) =>
    !j.analyses?.fit?.result && normalizeStatus(j.status) !== 'archived'
  );
  await runBatch({
    targets,
    label: 'Fit analysis',
    costEstimateUsd: 0.03,
    perJob: (job) => send('analyze-fit', { jobId: job.jobId }),
  });
});

els.enrichComp?.addEventListener('click', async () => {
  // Only run comp on jobs the user has committed to tracking: saved / applied /
  // downstream states. Analyzed-only jobs get skipped to avoid running comp
  // on postings he looked at once and never came back to.
  // Only run comp on jobs the user has committed to tracking. `analyzed`-only jobs
  // (opened once, never saved) are skipped; terminal states (archived,
  // notMovingForward) are skipped because comp is no longer relevant.
  const eligibleStatuses = new Set([
    'saved', 'inProgressDraft', 'inProgressClickedApply', 'applied', 'interviewing',
  ]);

  // Diagnostics — console shows exactly what's being filtered
  const statusBreakdown = jobs.reduce((acc, j) => {
    const s = normalizeStatus(j.status);
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  const eligible = jobs.filter((j) => eligibleStatuses.has(normalizeStatus(j.status)));
  const alreadyDone = eligible.filter((j) => j.analyses?.comp?.result);
  const targets = eligible.filter((j) => !j.analyses?.comp?.result);
  console.info('[Jawbs Archive] Enrich Comp filter:', {
    total: jobs.length,
    statusBreakdown,
    eligibleByStatus: eligible.length,
    alreadyHaveComp: alreadyDone.length,
    targets: targets.length,
  });

  if (!eligible.length) {
    const lines = Object.entries(statusBreakdown).map(([s, n]) => `  ${s}: ${n}`).join('\n');
    const offer = confirm(
      `No jobs in saved / applied / screening / interviewing / offer status.\n\n` +
      `Current status breakdown:\n${lines}\n\n` +
      `Comp analysis is targeted at jobs you're actively tracking. ` +
      `Click OK to run comp on ALL ${jobs.length} archived jobs anyway (any status). ` +
      `Cancel to do nothing.`
    );
    if (!offer) return;
    // Even in the "run on all" fallback, still skip archived jawbs —
    // they're closed roles and comp analysis on them is wasted spend.
    const allTargets = jobs.filter((j) =>
      !j.analyses?.comp?.result && normalizeStatus(j.status) !== 'archived'
    );
    return runBatch({
      targets: allTargets,
      label: 'Compensation',
      costEstimateUsd: 0.04,
      perJob: (job) => send('analyze-comp', { jobId: job.jobId }),
    });
  }

  if (!targets.length) {
    alert(`All ${eligible.length} eligible jawb${eligible.length === 1 ? '' : 's'} (saved/applied/…) already have a compensation analysis.`);
    return;
  }

  await runBatch({
    targets,
    label: 'Compensation',
    costEstimateUsd: 0.04,
    perJob: (job) => send('analyze-comp', { jobId: job.jobId }),
  });
});

els.enrichCancel.addEventListener('click', () => { batchCancelled = true; });

// Saved-searches list is no longer surfaced on the Jawboard; the
// Jawbar has a dedicated tab for it. The service worker still owns
// list-searches / save-search / delete-search so it remains available.

// ---------- Backup reminder ----------

async function checkExportReminder() {
  const r = await send('get-last-export').catch(() => ({}));
  const lastIso = r.data;
  if (!jobs.length) { els.exportReminder.hidden = true; return; }
  if (!lastIso) {
    els.exportReminder.hidden = false;
    els.exportReminder.textContent = 'No export yet. chrome.storage.local can be wiped by a profile reset — export a JSON backup.';
    return;
  }
  const daysSince = (Date.now() - new Date(lastIso).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince > 30) {
    els.exportReminder.hidden = false;
    els.exportReminder.textContent = `Last export was ${Math.floor(daysSince)} days ago. Consider backing up.`;
  } else {
    els.exportReminder.hidden = true;
  }
}

load();
