import { getApiKey, getOpenAIKey, getGeminiKey, getCloudProvider, getLinkedInProfileUrl, getContactEmail, getContactPhone, getContactLocation, getCompTargets, safeExternalUrl, defaultSearchName, condenseKeywords } from '../lib/store.js';
import { attachQuickFill } from '../lib/linkedInFill.js';
import { estimateCostUsd, formatUsd } from '../lib/pricing.js';
import { normalizeStatus, statusLabel, STATUS_ORDER } from '../lib/statuses.js';
import { derivePeople } from '../lib/people.js';
import { computeStrengthScore } from '../lib/strength.js';
import { trashSvg } from '../lib/icons.js';

const $ = (id) => document.getElementById(id);
const els = new Proxy({}, { get: (_, id) => $(id) });

let currentJob = null;
let letterTone = 'warm';
// profileUrl → { following: bool, mode: 'most-relevant'|'all' } for
// LinkedIn people the user is already following. Populated once at boot
// and updated by storage change events, then read synchronously by the
// people-recommendation renderer.
let followMap = {};
// User's comp targets — cached at module scope so the strength-score
// computation in renderVerdict stays synchronous. Refreshed at boot and
// on any settings change. Nullable until first load; the strength
// scorer handles a null targets object.
let compTargets = null;

// ---------- Helpers ----------

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('No response from service worker');
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response;
}

// Which window this side-panel instance belongs to. Set once on init so we
// can distinguish "the active tab in MY window" from "the active tab in some
// other window." Each browser window has its own panel; each panel tracks its
// own window's active tab so multiple LinkedIn tabs across multiple windows
// don't stomp on each other.
let panelWindowId = null;
let currentTabId = null;

async function activeTabId() {
  if (panelWindowId != null) {
    const [tab] = await chrome.tabs.query({ active: true, windowId: panelWindowId });
    return tab?.id || null;
  }
  // Fallback for the brief moment before init resolves the window id.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id || null;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

function fmtWhen(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}

function scoreTier(score) {
  if (score == null) return 'caution';
  if (score >= 70) return 'pos';
  if (score >= 40) return 'caution';
  return 'neg';
}

// Weak / fair / strong band label for the meta-strip circular gauges.
// Mirrors the score bands the mockup calls out: 0-39 weak, 40-69 fair,
// 70+ strong. Distinct from scoreTier() so the two labeling schemes
// stay independent — anything that reads scoreTier() (verdictBadges,
// fit-glance chips) keeps its own vocabulary.
function scoreBand(score) {
  const n = Number.isFinite(score) ? score : 0;
  if (n >= 70) return 'strong';
  if (n >= 40) return 'fair';
  return 'weak';
}

// Circular-gauge circumference for r=12 (mockup dimensions): 2·π·12 ≈ 75.4.
const GAUGE_CIRC = 75.4;

// Fills a mockup-style circular gauge (SVG). `svg` is the outer element
// used for the [data-band] color palette; `fillCircle` is the arc
// stroke whose dasharray we animate to represent the percentage;
// `text` is the numeric label in the middle. Score clamps 0-100.
function renderGauge(svg, fillCircle, text, score) {
  if (!svg || !fillCircle || !text) return;
  const n = Math.max(0, Math.min(100, Number(score) || 0));
  const dash = (n / 100) * GAUGE_CIRC;
  fillCircle.setAttribute('stroke-dasharray', `${dash.toFixed(2)} ${GAUGE_CIRC}`);
  text.textContent = String(Math.round(n));
  svg.setAttribute('data-band', scoreBand(n));
}

// Format a dollar amount as "$XXK" / "$X.XM" — matches the compact
// notation used elsewhere in the sidepanel.
function fmtMoneyK(n) {
  if (n == null || Number.isNaN(n)) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}

// Populates the Comp gauge and the source note under the meta strip.
// The gauge measures the TOP of the posting's base range against the
// user's Settings → target salary — a "how close does the ceiling get
// to what I want" signal. Hides when we lack both a range and a
// target (nothing meaningful to plot). Source note pulls from the
// comp analysis's `salary.sourceLabel` (already human-readable) and
// falls back to a source-key mapping when the label is absent.
function renderCompGauge(job) {
  const gaugeWrap = els.compGaugeGroup;
  const note = els.compSourceNote;
  if (!gaugeWrap && !note) return;

  const comp = job?.analyses?.comp?.result;
  const salary = comp?.salary;
  const low  = salary?.base?.low  ?? comp?.marketEstimate?.baseLow  ?? null;
  const high = salary?.base?.high ?? comp?.marketEstimate?.baseHigh ?? null;
  const target = Number(compTargets?.target) || null;
  const floor  = Number(compTargets?.floor)  || null;

  // Nothing to plot if we have neither a range nor a vsTarget verdict.
  const hasRange = high != null || low != null;
  const vsTarget = salary?.vsTargets?.vsTarget || comp?.vsTargets?.vsTarget;
  if (!hasRange && !vsTarget) {
    if (gaugeWrap) gaugeWrap.hidden = true;
    if (note) { note.hidden = true; note.textContent = ''; }
    return;
  }

  // Score: prefer the numeric ratio when we have both a target and a
  // top-of-range. Fall back to the LLM's vsTarget verdict when we
  // only have the qualitative signal. Fall back to a floor comparison
  // when even the target is missing.
  let score = null;
  const ratioAnchor = high ?? low;
  if (target && ratioAnchor) {
    score = Math.min(100, Math.round((ratioAnchor / target) * 100));
  } else if (vsTarget) {
    score = vsTarget === 'above' ? 100
          : vsTarget === 'at'    ? 80
          : vsTarget === 'below' ? 30
          : 50;
  } else if (floor && ratioAnchor) {
    // Anchor at 60 when the ceiling matches the floor exactly — floor
    // is the "acceptable but not aspirational" mark.
    score = Math.min(100, Math.round((ratioAnchor / floor) * 60));
  } else {
    score = 50;
  }

  if (gaugeWrap) {
    renderGauge(els.compGauge, els.compGaugeFill, els.compGaugeText, score);
    // Tooltip: full compare so the user can inspect without clicking.
    const rangeText = (low != null && high != null) ? `${fmtMoneyK(low)}–${fmtMoneyK(high)}`
                    : (high != null) ? `up to ${fmtMoneyK(high)}`
                    : (low != null) ? `from ${fmtMoneyK(low)}` : 'unknown range';
    const targetText = target ? fmtMoneyK(target) : 'not set';
    gaugeWrap.title = `Comp ${rangeText} vs your target ${targetText}. Score ${score}/100 — `
      + (score >= 70 ? 'strong.' : score >= 40 ? 'fair.' : 'weak.');
    gaugeWrap.hidden = false;
  }

  if (note) {
    // Comp-source paragraph retired from the header; the comp analysis
    // card carries the same source label + confidence lower down.
    note.hidden = true;
    note.textContent = '';
  }
}

function replaceGlance(glanceEl, node) {
  glanceEl.innerHTML = '';
  glanceEl.appendChild(node);
}

// ---------- Header ----------

els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
els.openArchive.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('archive/archive.html') });
});
els.openJawbridge?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('jawbridge/jawbridge.html') });
});

// Empty-state quick-launch cards route to the same destinations as the
// header icons — Jawboard opens the archive tab; each of the three
// settings cards opens Options pre-scrolled to its tab via ?tab=X.
els.emptyOpenJawboard?.addEventListener('click', () => els.openArchive.click());
els.tabRecentOpenJawboard?.addEventListener('click', () => els.openArchive.click());
els.emptyOpenJawbridge?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('jawbridge/jawbridge.html') });
});
document.querySelectorAll('.jc-empty-card[data-empty-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.emptyTab;
    chrome.tabs.create({
      url: chrome.runtime.getURL(`options/options.html?tab=${encodeURIComponent(tab)}`),
    });
  });
});

els.openFullView?.addEventListener('click', async () => {
  if (!currentJob?.jobId) return;
  els.openFullView.disabled = true;
  try {
    await send('open-recall', { jobId: currentJob.jobId, data: currentJob });
  } catch (e) {
    alert(`Open failed: ${e.message}`);
  } finally {
    els.openFullView.disabled = false;
    refreshArchiveCount();
  }
});

// Delete this job from the Jawboard. Destructive — wipes analyses, chats,
// timeline, notes. Reloads the current tab's state so the sidebar reflects
// the deletion (the scrape data may still be present, but archive fields —
// status, analyses, warmth — are gone).
els.deleteJob?.addEventListener('click', async () => {
  if (!currentJob?.jobId) return;
  const p = currentJob.posting || {};
  const label = [p.title, p.company].filter(Boolean).join(' at ') || `Jawb ${currentJob.jobId}`;
  if (!confirm(`Delete "${label}" and everything stored about it (analyses, chats, timeline, notes)?\n\nThis cannot be undone.`)) return;
  els.deleteJob.disabled = true;
  try {
    await send('delete-job', { jobId: currentJob.jobId });
    refreshArchiveCount();
    // Re-load whatever the tab currently shows — fresh scrape data without
    // archive merge. If the scrape produced nothing (or user has since
    // navigated away), the sidebar will render the empty state.
    await loadForActiveTab();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
  } finally {
    els.deleteJob.disabled = false;
  }
});

// Find this jawb on LinkedIn's own job tracker — opens the tracker at
// the stage matching its status, walks pages to locate the row, and
// flashes an outline around it. Same SW handler used by the Jawboard
// row-action. Feedback surfaces on the button title (transient, resets
// after 4s) and via an alert on outright failure.
els.findOnTracker?.addEventListener('click', async () => {
  if (!currentJob?.jobId) return;
  const btn = els.findOnTracker;
  const label = btn.querySelector('span');
  const originalTitle = btn.title;
  const originalLabel = label ? label.textContent : null;
  btn.disabled = true;
  btn.title = 'Opening LinkedIn tracker and searching…';
  if (label) label.textContent = 'Searching…';
  try {
    const r = await send('find-on-tracker', { jobId: currentJob.jobId });
    if (r.ok && r.found) {
      btn.title = `Found on ${r.stageLabel} · page ${r.page}${r.viaHint ? ' (via hint)' : ''}`;
    } else if (r.ok && !r.found) {
      const note = r.note || 'Job not found on the tracker.';
      btn.title = note;
      alert(note);
    } else {
      btn.title = r.error || 'Find failed.';
      alert(r.error || 'Find failed.');
    }
  } catch (e) {
    btn.title = e.message || 'Find failed.';
    alert(e.message || 'Find failed.');
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.title = originalTitle;
      if (label && originalLabel != null) label.textContent = originalLabel;
    }, 4000);
  }
});

// ---------- Usage strip ----------

function dayCostFromBuckets(byModel) {
  let total = 0;
  for (const [model, tokens] of Object.entries(byModel || {})) {
    // Local models cost nothing
    if (model.startsWith('local:')) continue;
    const c = estimateCostUsd(model, { input_tokens: tokens.inputTokens, output_tokens: tokens.outputTokens });
    if (c) total += c;
  }
  return total;
}

async function refreshUsageStrip() {
  try {
    const r = await send('get-usage-daily', { days: 30 });
    const days = r.data || [];
    if (!days.length) return;

    const costs = days.map((d) => dayCostFromBuckets(d.byModel));
    const todayCost = costs[costs.length - 1] || 0;
    const monthCost = costs.reduce((a, b) => a + b, 0);

    const lifetimeResp = await send('get-usage');
    const lifetime = lifetimeResp.data || {};
    let lifetimeCost = 0;
    for (const [model, tokens] of Object.entries(lifetime.byModel || {})) {
      if (model.startsWith('local:')) continue;
      const c = estimateCostUsd(model, { input_tokens: tokens.inputTokens, output_tokens: tokens.outputTokens });
      if (c) lifetimeCost += c;
    }

    els.usageToday.textContent = formatUsd(todayCost);
    els.usageMonth.textContent = formatUsd(monthCost);
    els.usageLifetime.textContent = formatUsd(lifetimeCost);

    renderUsageSparkline(costs.slice(-14));
  } catch (e) {
    console.warn('[Jawbs] usage strip refresh failed:', e);
  }
}

function renderUsageSparkline(costs) {
  if (!costs.length) { els.usageChart.innerHTML = ''; return; }
  const W = 180, H = 34, pad = 2;
  const max = Math.max(...costs, 0.001);
  const barW = (W - pad * 2) / costs.length - 1;
  const bars = costs.map((c, i) => {
    const x = pad + i * ((W - pad * 2) / costs.length);
    const h = max > 0 ? Math.max(1, (c / max) * (H - pad * 2)) : 1;
    const y = H - pad - h;
    const tone = c > 0 ? 'var(--jc-accent)' : 'var(--jc-border)';
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" style="fill:${tone};opacity:${c > 0 ? 0.85 : 0.3}" rx="1">
      <title>${costs.length - i} day${costs.length - i === 1 ? '' : 's'} ago: ${formatUsd(c)}</title>
    </rect>`;
  }).join('');
  els.usageChart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${bars}</svg>`;
}

async function refreshArchiveCount() {
  try {
    // Single trip that returns total + per-status breakdown + today's
    // capture count; feeds the header count, the "today" line, and
    // the status-count list under the Jawboard card.
    const r = await send('count-jobs-by-status');
    const total = r.data?.total ?? 0;
    const byStatus = r.data?.byStatus || {};
    const addedToday = r.data?.addedToday ?? 0;
    els.archiveCount.textContent = total;
    if (els.emptyJawboardCount) els.emptyJawboardCount.textContent = total;
    if (els.jawboardTodayCount) {
      els.jawboardTodayCount.textContent = addedToday === 0
        ? 'No new jawbs today'
        : `+${addedToday} new jawb${addedToday === 1 ? '' : 's'} today`;
      els.jawboardTodayCount.dataset.tone = addedToday > 0 ? 'pos' : 'neutral';
    }
    renderJawboardStatusCounts(byStatus);
  } catch {
    els.archiveCount.textContent = '?';
    if (els.emptyJawboardCount) els.emptyJawboardCount.textContent = '?';
    if (els.jawboardTodayCount) els.jawboardTodayCount.textContent = '';
    renderJawboardStatusCounts({});
  }
  refreshLastThresh().catch(() => {});
}

// Last-thresh timestamp readout retired. Kept as a no-op so any
// residual call sites don't need to be tracked down.
async function refreshLastThresh() {
  const el = els.lastThresh;
  if (el) { el.textContent = ''; el.hidden = true; }
}

// Compact rows of `status label · count` for statuses with at least one job.
// Sits below the Jawboard card description so users see the shape of their
// pipeline at a glance without opening the Jawboard.
function renderJawboardStatusCounts(byStatus) {
  const el = els.jawboardStatusCounts;
  if (!el) return;
  el.innerHTML = '';
  const nonZero = STATUS_ORDER.filter((s) => (byStatus[s] || 0) > 0);
  if (!nonZero.length) return;
  for (const s of nonZero) {
    const row = h('span', { class: 'jc-status-counts__row', dataset: { status: s } },
      h('span', { class: 'jc-status-counts__label' }, statusLabel(s)),
      h('span', { class: 'jc-status-counts__count' }, String(byStatus[s])),
    );
    el.appendChild(row);
  }
}

// Trim a string to at most 20 chars, adding a single-character ellipsis
// when we chopped. Kept local — no other consumer of a 20-char cap.
function truncate20(s) {
  if (!s) return '';
  return s.length > 20 ? s.slice(0, 20) + '…' : s;
}

// ---------- Top-level tabs ----------
//
// Jawbar defaults to the "current" view (verdict + analyses + empty
// state). Two extra tabs — Interviews and Jawb Searches — live above
// that content and are always available. Switching a tab hides the
// other content-area children so the pane owns the vertical space.
// The footer strips (Recent Jawbs, usage bar) are outside #body and
// stay pinned regardless.
const CURRENT_TAB_ELS = () => [
  els.verdictBlock, els.noticeSlot, els.noJob, els.analysisSection,
];
function switchTab(name) {
  const body = els.body;
  if (!body) return;
  body.dataset.activeTab = name;
  const currentEls = CURRENT_TAB_ELS();
  if (name === 'current') {
    // Restore whatever the elements' own [hidden] state said — no
    // forced inline style so verdictBlock/noJob keep their existing
    // "does a job exist?" logic.
    for (const el of currentEls) if (el) el.style.display = '';
    if (els.tabInterviews) els.tabInterviews.hidden = true;
    if (els.tabRecent)     els.tabRecent.hidden = true;
    if (els.tabSearches)   els.tabSearches.hidden = true;
  } else {
    for (const el of currentEls) if (el) el.style.display = 'none';
    if (els.tabInterviews) els.tabInterviews.hidden = name !== 'interviews';
    if (els.tabRecent)     els.tabRecent.hidden     = name !== 'recent';
    if (els.tabSearches)   els.tabSearches.hidden   = name !== 'searches';
    if (name === 'interviews') renderInterviewsTab().catch(() => {});
    if (name === 'recent')     renderRecentTab().catch(() => {});
    if (name === 'searches')   renderSearchesTab().catch(() => {});
  }
  document.querySelectorAll('#jcTabs [data-tab]').forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.dataset.active = active ? 'true' : 'false';
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

// Refresh the small circle badges on the Interviews and Searches
// tabs. Interviews shows upcoming rounds (date >= today) only when
// > 0; Searches shows the saved-searches count unconditionally
// (including 0) so the tab always advertises the state.
async function refreshTabBadges() {
  try {
    const r = await send('list-jobs');
    const jobs = Array.isArray(r?.data) ? r.data : [];
    const today = new Date().toISOString().slice(0, 10);
    let upcoming = 0;
    for (const j of jobs) {
      for (const rd of j.interviewRounds || []) {
        if (rd.date && rd.date >= today) upcoming++;
      }
    }
    const badge = els.tabBadgeInterviews;
    if (badge) {
      badge.textContent = String(upcoming);
      badge.hidden = upcoming === 0;
    }
  } catch { /* leave badge as-is on transient failure */ }

  try {
    const r = await send('list-searches');
    const list = Array.isArray(r?.data) ? r.data : [];
    const badge = els.tabBadgeSearches;
    if (badge) {
      badge.textContent = String(list.length);
      badge.hidden = false;
    }
  } catch { /* leave badge as-is */ }
}

// Interviews tab — upcoming rounds (date >= today) and recently
// completed rounds (date within last 14 days). Sourced from every
// archived jawb's interviewRounds list.
async function renderInterviewsTab() {
  const [upcomingEl, pastEl] = [els.interviewsUpcoming, els.interviewsPast];
  if (!upcomingEl || !pastEl) return;
  upcomingEl.innerHTML = '';
  pastEl.innerHTML = '';
  let jobs = [];
  try {
    const r = await send('list-jobs');
    jobs = Array.isArray(r.data) ? r.data : [];
  } catch { jobs = []; }
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 14);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const upcoming = [], past = [];
  for (const j of jobs) {
    for (const r of j.interviewRounds || []) {
      if (!r.date) continue;
      const entry = { job: j, round: r };
      if (r.date >= today) upcoming.push(entry);
      else if (r.date >= cutoffStr) past.push(entry);
    }
  }
  upcoming.sort((a, b) => (a.round.date + (a.round.time || '')).localeCompare(b.round.date + (b.round.time || '')));
  past.sort((a, b) => (b.round.date + (b.round.time || '')).localeCompare(a.round.date + (a.round.time || '')));

  const renderList = (host, list, emptyMsg) => {
    if (!list.length) {
      host.append(h('div', { class: 'jc-footnote' }, emptyMsg));
      return;
    }
    for (const { job, round } of list) {
      host.append(renderInterviewItem(job, round));
    }
  };
  renderList(upcomingEl, upcoming, 'No upcoming interviews scheduled.');
  renderList(pastEl, past, 'No interviews in the last 14 days.');
}

// "Wednesday, August 19 3:00 PM" — full weekday, long month, numeric
// day, optional 12h time. Parses ISO date+time as local wall-clock so
// a "10:00" round doesn't shift by the viewer's timezone.
function formatInterviewDate(dateIso, time) {
  if (!dateIso) return '';
  const [y, m, d] = dateIso.split('-').map(Number);
  if (!y || !m || !d) return time ? `${dateIso} ${time}` : dateIso;
  let hh = 0, mm = 0;
  if (time && /^\d{1,2}:\d{2}/.test(time)) {
    [hh, mm] = time.split(':').map(Number);
  }
  const dt = new Date(y, m - 1, d, hh, mm);
  const datePart = dt.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  if (!time) return datePart;
  const timePart = dt.toLocaleTimeString(undefined, {
    hour: 'numeric', minute: '2-digit',
  });
  return `${datePart} ${timePart}`;
}

function renderInterviewItem(job, round) {
  const p = job.posting || {};
  const label = [p.title, p.company].filter(Boolean).join(' at ') || `Jawb ${job.jobId}`;
  const dateStr = formatInterviewDate(round.date, round.time);
  const type = round.type || round.topic || 'Round';
  const person = round.interviewerName || '';
  // Round type + interviewer name on one line: "Recruiter · Alex Rivera"
  // The type stays leading (drives the visual scan for what kind of
  // round it is); the name is muted so the eye still lands on type
  // first. Separator falls away when there's no name.
  const typeLine = person ? `${type} · ${person}` : type;
  const recallHref = `../recall/recall.html?jobId=${encodeURIComponent(job.jobId)}`;
  return h('a', {
    class: 'jc-interview-item',
    href: recallHref,
    target: '_blank', rel: 'noopener',
    title: `Open ${label} in Recall`,
  },
    h('span', { class: 'jc-interview-item__date' }, dateStr),
    h('span', { class: 'jc-interview-item__body' },
      h('span', { class: 'jc-interview-item__type' }, typeLine),
      h('span', { class: 'jc-interview-item__co' }, label),
    ),
  );
}

// Recent tab — up to 20 unique jawbs the user has viewed, most recent
// first. Same data source as the footer Recent Jawbs strip; the tab
// just shows more of the list and gives each row more breathing room.
async function renderRecentTab() {
  const list = els.recentList, empty = els.recentEmpty;
  if (!list) return;
  list.innerHTML = '';
  let items = [];
  try {
    const r = await send('get-recent-jobs');
    items = Array.isArray(r.data) ? r.data : [];
  } catch { items = []; }
  if (!items.length) { empty.hidden = false; return; }
  empty.hidden = true;
  for (const j of items.slice(0, 20)) {
    const rawTitle = j.title || `Jawb ${j.jobId}`;
    const rawCompany = j.company || '';
    const linkChildren = [h('span', { class: 'jc-recent-tab__title' }, rawTitle)];
    if (rawCompany) linkChildren.push(h('span', { class: 'jc-recent-tab__co' }, rawCompany));
    // Fit score badge — same tone rules as the footer strip.
    const hasScore = typeof j.fitScore === 'number';
    const scoreTone = !hasScore ? null
      : j.fitScore >= 75 ? 'pos'
      : j.fitScore >= 55 ? 'caution'
      : 'neg';
    const scoreBadge = h('span', {
      class: 'jc-recent-tab__fit',
      dataset: scoreTone ? { tone: scoreTone } : {},
      title: hasScore ? `Fit score: ${j.fitScore}/100` : 'Fit not analyzed yet',
    }, hasScore ? String(j.fitScore) : 'TBD');
    list.append(h('li', { class: 'jc-recent-tab__row' },
      scoreBadge,
      h('a', {
        class: 'jc-recent-tab__link',
        href: safeExternalUrl(j.url || `https://www.linkedin.com/jobs/view/${j.jobId}/`),
        target: '_blank', rel: 'noopener noreferrer',
        title: rawCompany ? `${rawTitle} — ${rawCompany}` : rawTitle,
      }, ...linkChildren,
        h('img', {
          class: 'jc-li-icon', src: '../assets/linkedin.svg',
          alt: 'LinkedIn', width: '14', height: '14',
        }),
      ),
      h('span', { class: 'jc-recent-tab__when' }, recentWhen(j.viewedAt)),
    ));
  }
}

// Searches tab — three groups:
//   1. Stale saved (24h+ untouched) — nudge callout
//   2. Saved — user-curated list; click to re-run + mark run
//   3. Recent (unsaved) — auto-tracked from /jobs/search visits
async function renderSearchesTab() {
  const [savedR, recentR] = await Promise.all([
    send('list-searches').catch(() => ({ data: [] })),
    send('get-recent-searches').catch(() => ({ data: [] })),
  ]);
  const saved = Array.isArray(savedR?.data) ? savedR.data : [];
  const recent = Array.isArray(recentR?.data) ? recentR.data : [];
  renderStaleNudge(saved);
  renderSavedSearchesList(saved);
  renderRecentSearchesList(recent);
}

// A saved search is "stale" if it's never been run OR the last run
// was more than 24 hours ago. Callout is hidden entirely when there
// are none — no need to nag when everything is fresh.
function renderStaleNudge(saved) {
  const nudge = els.staleNudge;
  const listEl = els.staleNudgeList;
  const countEl = els.staleNudgeCount;
  if (!nudge || !listEl) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const stale = saved.filter((s) => {
    if (!s.lastRunAt) return true;
    return new Date(s.lastRunAt).getTime() < cutoff;
  });
  listEl.innerHTML = '';
  if (!stale.length) { nudge.hidden = true; return; }
  nudge.hidden = false;
  countEl.textContent = `${stale.length} of ${saved.length}`;
  for (const s of stale) listEl.append(savedSearchLi(s, { stale: true }));
}

function renderSavedSearchesList(saved) {
  const listEl = els.searchesList;
  const empty = els.searchesEmpty;
  if (!listEl) return;
  listEl.innerHTML = '';
  if (!saved.length) { if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;
  for (const s of saved) listEl.append(savedSearchLi(s));
}

function renderRecentSearchesList(recent) {
  const listEl = els.recentSearchesList;
  const empty = els.recentSearchesEmpty;
  if (!listEl) return;
  listEl.innerHTML = '';
  // Collapse by derived name — different URLs (e.g. same filters plus
  // a shifting currentJobId) can produce identical labels and read as
  // dupes even after canonical-URL dedup at write time. The list is
  // sorted most-recent-first from storage, so keeping the first sighting
  // of each name preserves the most-recent URL for that name.
  const seenNames = new Set();
  const deduped = [];
  for (const r of recent) {
    const key = (r.name || '').trim().toLowerCase();
    if (!key) { deduped.push(r); continue; } // no name → don't collapse
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    deduped.push(r);
  }
  recent = deduped;
  if (!recent.length) { if (empty) empty.hidden = false; return; }
  if (empty) empty.hidden = true;
  for (const r of recent) {
    const li = h('li', {},
      h('a', {
        href: safeExternalUrl(r.url), target: '_blank', rel: 'noopener noreferrer',
        title: r.url,
        onClick: () => {
          // Visiting a recent-search URL bumps its viewedAt via the
          // content script when the /jobs/search page loads. Fire an
          // early save-search opportunity so the user can promote it.
        },
      }, r.name || 'Search'),
      h('span', { class: 'jc-search-when' }, r.viewedAt ? recentWhen(r.viewedAt) : ''),
      h('button', {
        class: 'jc-btn', 'data-size': 'sm', type: 'button',
        title: 'Promote to saved searches',
        onClick: async (e) => {
          e.preventDefault();
          const name = prompt('Name this search:', r.name) || r.name;
          try {
            await send('save-search', { name, url: r.url });
            await renderSearchesTab();
            refreshTabBadges().catch(() => {});
          } catch (err) { alert(`Save failed: ${err.message}`); }
        },
      }, 'Save'),
    );
    listEl.append(li);
  }
}

// Shared row builder for a saved-search entry. `stale` triggers the
// caution-tinted variant used inside the stale nudge.
function savedSearchLi(s, opts = {}) {
  const ageBits = [];
  if (s.lastRunAt) {
    ageBits.push(`last run ${recentWhen(s.lastRunAt)}`);
  } else {
    ageBits.push('never run');
  }
  const deleteBtn = h('button', {
    type: 'button',
    class: 'jc-icon-btn jc-icon-btn--danger',
    'aria-label': `Delete saved search "${s.name}"`,
    title: `Delete saved search "${s.name}"`,
    onClick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm(`Delete saved search "${s.name}"?`)) return;
      try {
        await send('delete-search', { id: s.id });
        // Re-render the whole Searches tab so both stale-nudge and
        // main list reflect the removal.
        if (els.body?.dataset.activeTab === 'searches') renderSearchesTab().catch(() => {});
        refreshTabBadges().catch(() => {});
      } catch (err) { alert(`Delete failed: ${err.message}`); }
    },
  }, trashSvg());
  return h('li', {
    class: opts.stale ? 'jc-stale-row' : '',
  },
    h('a', {
      href: safeExternalUrl(s.url), target: '_blank', rel: 'noopener noreferrer',
      title: s.name,
      onClick: () => {
        // Optimistically bump lastRunAt so the stale nudge clears
        // right away — the content script's own search-detected on
        // the destination page will re-confirm it.
        send('mark-search-run', { url: s.url }).catch(() => {});
      },
    }, s.name || 'Saved search'),
    h('span', { class: 'jc-search-when' }, ageBits.join(' · ')),
    deleteBtn,
  );
}


// Recent-jawbs footer strip was removed; the Recent tab in the top
// tab bar surfaces the same list with more room. The service worker
// keeps maintaining `recentJobs` in storage — the Recent tab renderer
// still reads it.

// Saved-searches footer strip was removed — the Searches tab now
// (refreshSavedSearches removed — the Searches tab renderer owns
// both saved and recent lists now.)

// Compact "when viewed" formatter — relative for the last 24h, otherwise
// short absolute date.
function recentWhen(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

// ---------- Card toggle ----------

document.querySelectorAll('.jc-card__head[data-card]').forEach((head) => {
  head.addEventListener('click', () => {
    const card = head.closest('.jc-card');
    card.dataset.open = card.dataset.open === 'true' ? 'false' : 'true';
  });
});

// ---------- Action bar (quick-access buttons above the job title) ----------

document.querySelectorAll('.jc-btn[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => runAction(btn.dataset.action));
});

async function runAction(action) {
  if (!currentJob) return;
  switch (action) {
    case 'fit': return els.analyzeFit.click();
    case 'comp': return els.analyzeComp.click();
    case 'prep': return els.buildBrief.click();
    case 'resume': return els.generateResume.click();
    case 'letter': {
      // Force warm tone as the sensible default; the card's tone tabs remain
      // available for other tones on demand.
      const warmTab = document.querySelector('#letterToneTabs .jc-tab[data-tone-value="warm"]');
      if (warmTab) warmTab.click();
      return els.generateLetter.click();
    }
    case 'reprocess': return reprocessCurrentJob();
  }
}

async function reprocessCurrentJob() {
  if (!currentJob) return;
  // 1. Rescrape the LinkedIn page so we're working from freshest data
  const tabId = await activeTabId();
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'rescrape' }).catch(() => {});

  // 2. Regenerate every analysis that already exists (skip ones never run
  // so we don't spam API on features the user hasn't opted into for this job)
  const a = currentJob.analyses || {};
  const toRerun = [];
  if (a.fit) toRerun.push(() => els.analyzeFit.click());
  if (a.comp) toRerun.push(() => els.analyzeComp.click());
  if (a.brief) toRerun.push(() => els.buildBrief.click());
  if (a.coverLetter) toRerun.push(() => els.generateLetter.click());
  if (a.resume) toRerun.push(() => els.generateResume.click());

  if (!toRerun.length) return;
  if (!confirm(`Re-process will rescrape and regenerate ${toRerun.length} analysis result${toRerun.length === 1 ? '' : 's'}. Continue?`)) return;
  // Fire them sequentially with tiny delay so error/status doesn't stampede
  for (const fn of toRerun) {
    fn();
    await new Promise((r) => setTimeout(r, 200));
  }
}

function updateActionBarState(job) {
  const a = job?.analyses || {};
  const map = { fit: !!a.fit, comp: !!a.comp, prep: !!a.brief, letter: !!a.coverLetter, resume: !!a.resume };
  document.querySelectorAll('.jc-btn[data-action]').forEach((btn) => {
    const action = btn.dataset.action;
    if (action === 'reprocess') return;
    if (map[action]) btn.dataset.cached = 'true';
    else delete btn.dataset.cached;
  });

  // Dynamic primary in the Cast row: Fit is the recommended next click
  // until it's been run, then Comp becomes the recommended next click.
  // Only one of the two carries data-variant="primary" at a time.
  const actionBar = document.getElementById('actionBar');
  if (actionBar) {
    const fitBtn = actionBar.querySelector('.jc-btn[data-action="fit"]');
    const compBtn = actionBar.querySelector('.jc-btn[data-action="comp"]');
    if (fitBtn && compBtn) {
      if (map.fit) {
        // Fit done → point at Comp next.
        fitBtn.removeAttribute('data-variant');
        compBtn.setAttribute('data-variant', 'primary');
      } else {
        // No fit yet → primary the Fit button.
        fitBtn.setAttribute('data-variant', 'primary');
        compBtn.removeAttribute('data-variant');
      }
    }
  }
}

// ---------- Letter tone tabs ----------

document.querySelectorAll('#letterToneTabs .jc-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#letterToneTabs .jc-tab').forEach((t) => t.setAttribute('aria-selected', 'false'));
    tab.setAttribute('aria-selected', 'true');
    letterTone = tab.dataset.toneValue;
  });
});

// ---------- Main render ----------

async function renderJob(job) {
  currentJob = job;

  if (job?.jobId && !String(job.jobId).startsWith('manual-')) {
    try {
      const r = await send('get-job', { jobId: job.jobId });
      if (r.data) {
        // Merge archive-owned fields into the scrape. Without status merged
        // here, the archive-status badge and the delete-job button both stay
        // hidden even for jobs that ARE in the Jawboard, because their
        // visibility gates on currentJob.status. Warmth also merged so a
        // stale scrape's tier can be overridden by richer archive data.
        currentJob = {
          ...job,
          analyses: r.data.analyses || {},
          userNotes: r.data.userNotes,
          status: r.data.status,
          statusUpdatedAt: r.data.statusUpdatedAt,
          tags: r.data.tags,
          warmth: r.data.warmth?.detail ? r.data.warmth : (job.warmth || r.data.warmth),
        };
      }
    } catch {}
  }

  renderVerdict(currentJob);
  renderAnalysisSection(currentJob);
  // Reconcile progress bar + working-button state to THIS job's active
  // work. Without this, a fit analysis started on Job A would leave the
  // spinner + disabled buttons showing when the user pivots to Job B.
  applyProgressForCurrentJob();
}

function renderVerdict(job) {
  // Flip the Jawb tab label based on whether a single jawb is loaded.
  // "Jawb" when we have one; "Overview" when we're in the empty state
  // showing quick-launch cards instead.
  if (els.tabLabelCurrent) {
    els.tabLabelCurrent.textContent = job ? 'Jawb' : 'Overview';
  }
  if (!job) {
    els.verdictBlock.hidden = true;
    els.noJob.hidden = false;
    els.analysisSection.hidden = true;
    if (els.headerJobActions) els.headerJobActions.hidden = true;
    return;
  }
  els.noJob.hidden = true;
  els.verdictBlock.hidden = false;
  if (els.headerJobActions) els.headerJobActions.hidden = false;

  const p = job.posting || {};
  els.jobTitle.textContent = p.title || '(no title extracted)';

  // Mini hunt strip — 3-stage window on the 5-stage Captured → Saved →
  // Applied → Interviewing → Offer journey. Replaces the old single
  // status badge so users see where they are in context.
  renderMiniHunt(job);
  // Delete button is only meaningful when the job is actually in the Jawboard.
  // status presence is the same signal used for the badge above.
  if (els.deleteJob) els.deleteJob.hidden = !job.status;
  // Find on LinkedIn Tracker — only for LinkedIn-sourced jobs with a
  // tracker-eligible status (anything other than 'analyzed', which is
  // the internal-only "we looked at it" state). Google Jobs captures
  // aren't on LinkedIn's tracker so the button is hidden for those.
  if (els.findOnTracker) {
    const norm = normalizeStatus(job.status);
    const onTracker = norm !== 'analyzed' && (job.source || 'linkedin') === 'linkedin';
    els.findOnTracker.hidden = !onTracker;
  }
  // Company gets its own span so the Details↗ open-full-view and 🗑 delete buttons
  // can sit inline with it. Location / workplace live in a separate span
  // that follows the buttons.
  els.jobCompany.textContent = p.company || '';
  // Google-search shortcut: '[Company] Careers - [Job Title]'. Hidden when
  // we don't have a company to search for. Opens in a new tab.
  if (els.companyCareersSearch) {
    if (p.company) {
      const q = `${p.company} Careers${p.title ? ' - ' + p.title : ''}`;
      els.companyCareersSearch.href = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
      els.companyCareersSearch.hidden = false;
    } else {
      els.companyCareersSearch.hidden = true;
    }
  }
  els.jobMetaRest.innerHTML = '';
  const rest = [p.location, p.workplaceType].filter(Boolean);
  rest.forEach((part, i) => {
    if (i === 0) {
      const lead = document.createElement('span');
      lead.style.color = 'var(--jc-text-3)';
      lead.textContent = ' · ';
      els.jobMetaRest.appendChild(lead);
    }
    els.jobMetaRest.appendChild(document.createTextNode(part));
    if (i < rest.length - 1) {
      const sep = document.createElement('span');
      sep.style.color = 'var(--jc-text-3)';
      sep.textContent = ' · ';
      els.jobMetaRest.appendChild(sep);
    }
  });
  const fit = job.analyses?.fit?.result;

  if (!fit) {
    if (els.metaStrip) els.metaStrip.hidden = true;
    // Comp source note is a sibling of the meta strip, hide it too so
    // it doesn't linger under an empty area on jobs without analysis.
    if (els.compSourceNote) { els.compSourceNote.hidden = true; els.compSourceNote.textContent = ''; }
    els.verdictBadges.innerHTML = '';
    if (els.jobFitSummary) { els.jobFitSummary.textContent = ''; els.jobFitSummary.hidden = true; }
    return;
  }

  // Meta strip: shark tier + Fit / Strength / Comp gauges. Populated
  // whenever a fit result exists — that's what unlocks the strength
  // composite too. The comp gauge and source note are further gated
  // on the comp analysis existing (renderCompGauge decides).
  if (els.metaStrip) {
    const fitScore = fit.fitScore ?? 0;
    const strength = computeStrengthScore(job, { compTargets, followMap });
    // Connections gauge — scale the 0–20 connections component up to a
    // 0–100 percentage so it reads on the same scale as fit/comp.
    const conn = strength.breakdown?.connections;
    const connectionsPct = conn && conn.max
      ? Math.round((conn.score / conn.max) * 100)
      : 0;
    renderGauge(els.fitGauge, els.fitGaugeFill, els.fitGaugeText, fitScore);
    renderGauge(els.connectionsGauge, els.connectionsGaugeFill, els.connectionsGaugeText, connectionsPct);
    // Big strength score on the left of the shark icon.
    if (els.metaStrengthNum) els.metaStrengthNum.textContent = String(strength.score);
    if (els.metaStrength) {
      els.metaStrength.dataset.band = strength.score >= 75 ? 'strong'
        : strength.score >= 50 ? 'fair' : 'weak';
    }
    if (els.metaSharkImg && strength.tierImage) {
      els.metaSharkImg.src = chrome.runtime.getURL(strength.tierImage);
      els.metaSharkImg.alt = `${strength.tierLabel} shark`;
    }
    // Tint the shark's halo to reflect its tier — dark red (weakest)
    // through deep green (strongest). CSS holds the color per tier via
    // [data-tier].
    if (els.metaSharkIcon) els.metaSharkIcon.setAttribute('data-tier', strength.tier);
    if (els.metaSharkLabel) els.metaSharkLabel.textContent = strength.tierLabel;
    if (els.metaShark) {
      els.metaShark.title = `${strength.tierLabel} shark — ${strength.tierDescription || 'strength tier'}. `
        + `Strength ${strength.score}/100 = fit ${strength.breakdown.fit.note} · `
        + `comp ${strength.breakdown.comp.note} · connections ${strength.breakdown.connections.note}. `
        + `Weights: fit 50% · comp 30% · connections 20%.`;
    }
    renderCompGauge(job);
    els.metaStrip.hidden = false;
  }
  // One-line summary — surface the first alignment as the headline
  // takeaway. Falls back to the first gap when there's no alignment,
  // and hides the row entirely when neither exists.
  if (els.jobFitSummary) {
    // Fit-summary sentence retired from the header; the Career Fit card
    // already surfaces alignments and gaps below.
    els.jobFitSummary.textContent = '';
    els.jobFitSummary.hidden = true;
  }

  els.verdictBadges.innerHTML = '';
  // Verdict pill ("Apply if nothing better"), comp anchor ("$225K–$300K"
  // with the JD sub-badge), and people-stats badge ("People 1") all
  // retired — the strength card + comp card + people card carry the
  // same signal without piling chips under the score.

  if (fit.levelRead?.titleVsScopeMatch && fit.levelRead.titleVsScopeMatch !== 'match') {
    els.verdictBadges.append(h('span', { class: 'jc-badge' }, fit.levelRead.titleVsScopeMatch));
  } else if (fit.levelRead?.postedLevel) {
    els.verdictBadges.append(h('span', { class: 'jc-badge' }, fit.levelRead.postedLevel));
  }

  if (p.applicantCount) {
    const count = parseInt(String(p.applicantCount).replace(/[^\d]/g, ''), 10);
    const tone = count && count > 100 ? 'neg' : count && count > 50 ? 'caution' : undefined;
    els.verdictBadges.append(h('span', { class: 'jc-badge', dataset: tone ? { tone } : {} }, p.applicantCount));
  }
}

// Mini hunt strip — the 3-stage window on the canonical 5-stage
// Captured → Saved → Applied → Interviewing → Offer journey. Centers
// on the current stage; slides to the front for jobs at the first
// stage (shows current + next 2) and to the back for jobs at the last
// stage (shows previous 2 + current). Bar segments between marks
// carry the past/next state coloring; markers reuse the voyage-log
// vocabulary (barrel = past, red fin = now, dashed circle = next).
const HUNT_STAGES = ['Captured', 'Saved', 'Applied', 'Interviewing', 'Offer'];
function huntStageIndex(status) {
  const norm = normalizeStatus(status || '');
  if (norm === 'interviewing') return 3;
  if (norm === 'applied' || norm === 'inProgressClickedApply' || norm === 'inProgressDraft') return 2;
  if (norm === 'saved') return 1;
  return 0;
}
function renderMiniHunt(job) {
  const el = document.getElementById('miniHunt');
  if (!el) return;
  if (!job || !job.status) { el.hidden = true; el.innerHTML = ''; return; }
  const cur = huntStageIndex(job.status);
  // Slide the 3-stage window so it always covers the current stage.
  // First stage → 0..2; last stage → last-2..last; anything in between
  // centers on cur.
  const last = HUNT_STAGES.length - 1;
  let start;
  if (cur <= 0) start = 0;
  else if (cur >= last) start = last - 2;
  else start = cur - 1;
  const items = [];
  for (let i = start; i < start + 3 && i <= last; i++) {
    const state = i < cur ? 'past' : i === cur ? 'now' : 'next';
    items.push(`<li class="mini-hunt__step" data-state="${state}">
      <span class="mini-hunt__mark" aria-hidden="true"></span>
      <span class="mini-hunt__label">${HUNT_STAGES[i]}</span>
    </li>`);
  }
  el.innerHTML = items.join('');
  el.hidden = false;
}

// Compact numeric summary of the people signal on a job. Renders a
// single .jc-badge into verdictBadges; skipped entirely when the
// derivePeople scorer surfaces nobody. Hover shows the same three
// numbers spelled out — no names, per the "just stats" directive.
function renderPeopleStatsBadge(job) {
  if (!job) return;
  const people = derivePeople(job, { followMap });
  if (!people.length) return;
  const atCo = people.filter((p) => p.degree === 1 && p.relationships?.companyConnection).length;
  const hiring = people.filter((p) => {
    const r = p.relationships || {};
    return r.hiringManager || r.recruiter || r.interviewer || r.jobPoster || r.teamMember;
  }).length;
  const bits = [`People ${people.length}`];
  if (atCo) bits.push(`at company ${atCo}`);
  if (hiring) bits.push(`hiring team ${hiring}`);
  const label = bits.join(' · ');
  // Tone climbs with signal strength: pos when there's someone at the
  // company or on the hiring team; caution when we just know there
  // are people; info as a neutral fallback.
  const tone = (atCo || hiring) ? 'pos' : 'caution';
  els.verdictBadges.append(h('span', {
    class: 'jc-badge people-stat-badge',
    dataset: { tone },
    title: `${people.length} people surfaced · ${atCo} 1st-degree at company · ${hiring} on hiring team`,
  }, label));
}


function renderAnalysisSection(job) {
  if (!job) { els.analysisSection.hidden = true; return; }
  els.analysisSection.hidden = false;
  const a = job.analyses || {};

  renderFitCard(a.fit);
  renderLevelCard(a.fit?.result);
  renderFlagsCard(a.fit?.result);
  renderCompCard(a.comp);
  renderPrepCard(a);
  renderLetterCard(a.coverLetter);
  renderResumeCard(a.resume);
  renderAskCard(a.chats);

  updateActionBarState(job);
  updateCardStatuses(a);
}

// Map each collapsible card to a boolean "done" test against the analyses
// object. Level / Flags derive from Fit — they're "done" once
// Fit has been run. Cards not in this map keep their default (undone) state.
const CARD_DONE_TESTS = {
  fitCard:    (a) => !!a.fit,
  levelCard:  (a) => !!a.fit,
  flagsCard:  (a) => !!a.fit,
  compCard:   (a) => !!a.comp,
  prepCard:   (a) => !!a.brief,
  letterCard: (a) => !!a.coverLetter,
  resumeCard: (a) => !!a.resume,
  askCard:    (a) => (a.chats?.items?.length || 0) > 0,
};
function updateCardStatuses(analyses) {
  for (const [cardId, test] of Object.entries(CARD_DONE_TESTS)) {
    const card = document.getElementById(cardId);
    if (!card) continue;
    card.dataset.status = test(analyses) ? 'done' : 'undone';
  }
}

// ---------- Ask (freeform LLM prompt for this job) ----------

function renderAskCard(chats) {
  els.askOutput.innerHTML = '';
  els.askError.hidden = true;
  const items = chats?.items || [];
  const last = items[items.length - 1];
  // Head-glance meta: show question count so users know at a glance whether
  // this job has any chat history without expanding the card.
  if (els.askMeta) {
    els.askMeta.innerHTML = '';
    els.askMeta.append(h('span', { class: 'jc-footnote' },
      items.length === 0 ? 'No questions asked' :
      items.length === 1 ? '1 question asked' :
      `${items.length} questions asked`,
    ));
  }
  if (last) {
    const providerTag = last.provider === 'local'
      ? 'local'
      : (last.fellback ? 'local→cloud' : 'cloud');
    const meta = h('div', { class: 'jc-footnote' },
      `${fmtWhen(last.at)} · ${last.model} · ${providerTag}` +
      (last.usage ? ` · in ${last.usage.input_tokens || 0} / out ${last.usage.output_tokens || 0}` : ''));
    const body = h('div', { class: 'jc-doc-body' }, last.answer || '');
    els.askOutput.append(meta, body);
    // One-click copy the answer — same pattern as the letter card.
    const copyLink = h('a', {
      href: '#', class: 'jc-copy-link',
      onClick: async (e) => {
        e.preventDefault();
        await navigator.clipboard.writeText(last.answer || '');
        copyLink.textContent = '✓ Copied';
        setTimeout(() => (copyLink.textContent = '📋 Copy answer'), 1500);
      },
    }, '📋 Copy answer');
    els.askOutput.append(copyLink);
  }
  // History: show every prior Q&A on this job in a collapsible details block.
  if (items.length > 0) {
    els.askHistoryWrap.hidden = false;
    els.askHistoryCount.textContent = items.length;
    els.askHistory.innerHTML = '';
    // Reverse so most-recent-first inside the details drawer.
    for (const item of items.slice().reverse()) {
      const q = h('div', { class: 'jc-footnote', style: 'margin-top: var(--jc-2); color: var(--jc-text)' }, `Q: ${item.prompt}`);
      const a = h('div', { class: 'jc-prose', style: 'padding: 4px 0 8px; border-bottom: 1px dashed var(--jc-border); white-space: pre-wrap' }, item.answer || '');
      els.askHistory.append(h('div', {}, q, a));
    }
  } else {
    els.askHistoryWrap.hidden = true;
  }
}

// ---------- Fit ----------

function renderFitCard(record) {
  const out = els.fitOutput;
  out.innerHTML = '';
  if (!record) {
    els.fitMeta.textContent = '';
    els.analyzeFit.textContent = 'Analyze';
    replaceGlance(els.fitGlance, h('span', { class: 'jc-footnote' }, 'Not analyzed'));
    return;
  }

  const r = record.result || {};
  els.fitMeta.textContent = `${fmtWhen(record.generatedAt)} · ${record.model}${record.usage ? ` · in ${record.usage.input_tokens} · out ${record.usage.output_tokens}` : ''}`;
  els.analyzeFit.textContent = 'Regenerate';

  const tier = scoreTier(r.fitScore);
  replaceGlance(els.fitGlance, h('span', { style: `color:var(--jc-${tier})` }, `${r.fitScore ?? '—'}/100`));

  // Alignments and gaps — bullet lists, no prose. Users scan these.
  if (r.alignments?.length) {
    out.append(h('span', { class: 'jc-eyebrow' }, 'Alignments'));
    out.append(h('ul', { class: 'jc-list' },
      ...r.alignments.map((a) => h('li', {}, a)),
    ));
  }
  if (r.gaps?.length) {
    out.append(h('span', { class: 'jc-eyebrow' }, 'Gaps'));
    out.append(h('ul', { class: 'jc-list' },
      ...r.gaps.map((g) => h('li', {}, g)),
    ));
  }

  if (r.verdict) {
    const rec = r.verdict.recommendation || '';
    const recTone = rec === 'apply-now' ? 'pos' : rec === 'skip' ? 'neg' : 'caution';
    const pillText = rec === 'apply-now' ? 'Apply' : rec === 'skip' ? 'Skip' : 'Apply if nothing better';
    const verdictBox = h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
      h('span', { class: 'jc-eyebrow' }, 'Verdict'),
      h('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;gap:var(--jc-2)' },
        h('span', { class: 'jc-verdict-inline', dataset: { tone: recTone } }, pillText),
      ),
    );
    out.append(verdictBox);
  }

  // Outreach — LLM's recommended first-contact and messaging strategy.
  // Only rendered when the model actually found network leverage; skipped
  // silently for cold jobs to avoid empty sections.
  const o = r.outreach;
  if (o && o.hasNetwork && o.bestContact) {
    const box = h('div', {
      class: 'jc-notice',
      dataset: { tone: 'pos' },
      style: 'margin-top: var(--jc-2)',
    },
      h('div', { class: 'jc-notice__body' },
        h('span', { class: 'jc-notice__title' }, `🔥 Message first: ${o.bestContact}`),
        o.why ? h('div', {}, o.why) : null,
        o.strategy ? h('p', { class: 'jc-prose', style: 'margin-top: 4px' }, o.strategy) : null,
      ),
    );
    out.append(box);
  }

  // Remote authenticity — LinkedIn's "Remote" tag lies constantly; surface
  // what the description actually says vs what LinkedIn labels.
  const ra = r.remoteAuthenticity;
  if (ra && (ra.postedAs || ra.actualExpectation || ra.flag)) {
    const tone = ra.flag ? 'neg' : (ra.matchesUserLocations === false ? 'caution' : 'pos');
    const box = h('div', {
      class: 'jc-notice',
      dataset: { tone },
      style: 'margin-top: var(--jc-2)',
    },
      h('div', { class: 'jc-notice__body' },
        h('span', { class: 'jc-notice__title' }, 'Remote / location'),
        ra.postedAs && ra.actualExpectation ? h('div', {},
          h('strong', {}, 'Posted: '), ra.postedAs, ' · ',
          h('strong', {}, 'Actual: '), ra.actualExpectation,
        ) : null,
        ra.requiresLocation ? h('div', { class: 'jc-footnote' }, `Constraint: ${ra.requiresLocation}`) : null,
        ra.flag ? h('div', { style: 'font-weight:600' }, ra.flag) : null,
      ),
    );
    out.append(box);
  }
}

// ---------- Level signals ----------

function renderLevelCard(fit) {
  // Level signals no longer come from the slim Fit prompt. Hide the card
  // entirely unless the loaded result still has them (backward compat with
  // v2 fit records from before v3 slimmed the prompt).
  const signals = fit?.levelRead?.signals || [];
  const match = fit?.levelRead?.titleVsScopeMatch;
  const postedLevel = fit?.levelRead?.postedLevel;
  const hasData = signals.length > 0 || match || postedLevel;
  els.levelCard.hidden = !hasData;
  if (!hasData) return;

  let glanceText = postedLevel || 'analyzed';
  let glanceTone;
  if (match === 'title-inflated') { glanceText = 'title-inflated'; glanceTone = 'neg'; }
  else if (match === 'title-deflated') { glanceText = `reads ${postedLevel || 'higher'}`; glanceTone = 'caution'; }
  else if (match === 'match') { glanceText = 'level match'; glanceTone = 'pos'; }
  replaceGlance(els.levelGlance, h('span', { class: 'jc-badge', dataset: glanceTone ? { tone: glanceTone } : {} }, glanceText));

  els.levelList.innerHTML = '';
  for (const sig of signals) els.levelList.append(h('li', {}, sig));
}

// ---------- Red flags ----------

function renderFlagsCard(fit) {
  // Red flags are Interview-prep-only. Hide unless old v2 result has them.
  const flags = fit?.redFlags || [];
  els.flagsCard.hidden = flags.length === 0;
  if (!flags.length) return;
  const count = flags.length;
  const tone = count >= 3 ? 'neg' : 'caution';
  replaceGlance(els.flagsGlance, h('span', { class: 'jc-badge', dataset: { tone } }, String(count)));
  els.flagsBody.innerHTML = '';
  for (const f of flags) {
    els.flagsBody.append(h('div', { class: 'jc-finding', dataset: { tone: 'neg' } },
      h('p', { class: 'jc-prose' }, f),
    ));
  }
}

// ---------- Comp ----------

function renderCompCard(record) {
  // Hydrate the offer form from whatever's on the job (form still stores
  // offer data for record-keeping; the comp analysis no longer uses it).
  hydrateOfferForm(currentJob?.offerDetails);

  const out = els.compOutput;
  out.innerHTML = '';
  if (!record) {
    els.compMeta.textContent = '';
    els.analyzeComp.textContent = 'Analyze';
    replaceGlance(els.compGlance, h('span', { class: 'jc-footnote' }, 'Not analyzed'));
    return;
  }
  const r = record.result || {};
  els.compMeta.textContent = `${fmtWhen(record.generatedAt)} · ${record.model}`;
  els.analyzeComp.textContent = 'Regenerate';

  const s = r.salary || {};
  const base = s.base || {};
  const rangeText = (base.low != null && base.high != null)
    ? `$${Math.round(base.low / 1000)}K – $${Math.round(base.high / 1000)}K`
    : (base.low != null ? `$${Math.round(base.low / 1000)}K+` : (base.high != null ? `up to $${Math.round(base.high / 1000)}K` : '—'));
  replaceGlance(els.compGlance, h('span', {}, rangeText));

  // Big number: base range
  out.append(h('div', { class: 'jc-metric jc-metric--hero' },
    h('span', { class: 'jc-metric__label' }, 'Base salary'),
    h('span', { class: 'jc-metric__value' },
      base.low != null && base.high != null
        ? `$${base.low.toLocaleString()} – $${base.high.toLocaleString()}`
        : (base.raw || rangeText)),
  ));

  // Source label — always shown, prominent. Confidence pill on the right.
  const srcTone = s.source === 'posting' ? 'pos'
                 : s.source === 'company-research' ? 'info'
                 : s.source === 'title-benchmark' ? 'caution'
                 : 'neg';
  const confLabel = s.confidence === 'high' ? 'high confidence'
                   : s.confidence === 'medium' ? 'medium confidence'
                   : s.confidence === 'low' ? 'low confidence'
                   : 'unknown';
  out.append(h('div', { class: 'jc-notice', dataset: { tone: srcTone }, style: 'margin-top:var(--jc-2)' },
    h('div', { class: 'jc-notice__body' },
      h('span', { class: 'jc-notice__title' }, 'Source'),
      h('span', {}, s.sourceLabel || '(not provided)'),
      h('span', { class: 'jc-footnote', style: 'margin-top:2px' }, `${sourceHuman(s.source)} · ${confLabel}`),
    ),
  ));

  // If posted band verbatim exists, show it distinctly.
  if (base.raw && s.source === 'posting') {
    out.append(h('div', { class: 'jc-metric', style: 'margin-top:var(--jc-2)' },
      h('span', { class: 'jc-metric__label' }, 'As posted'),
      h('span', { class: 'jc-metric__value', style: 'font-family:var(--jc-font-mono)' }, base.raw),
    ));
  }

  // Bonus (only when source explicitly provided).
  const bonus = s.bonus || {};
  if (bonus.percent != null || bonus.note) {
    out.append(h('div', { class: 'jc-metric', style: 'margin-top:var(--jc-2)' },
      h('span', { class: 'jc-metric__label' }, 'Bonus'),
      h('span', { class: 'jc-metric__value' },
        bonus.percent != null ? `${bonus.percent}% target` : '',
        bonus.note ? h('div', { class: 'jc-footnote' }, bonus.note) : null,
      ),
    ));
  }

  // Equity (only when source explicitly provided).
  const equity = s.equity || {};
  if (equity.note) {
    out.append(h('div', { class: 'jc-metric', style: 'margin-top:var(--jc-2)' },
      h('span', { class: 'jc-metric__label' }, 'Equity'),
      h('span', { class: 'jc-metric__value jc-footnote' }, equity.note),
    ));
  }

  // Floor/target comparison flag — the only "warning" we surface.
  const vt = r.vsTargets || {};
  if (vt.flag) {
    out.append(h('div', { class: 'jc-notice', dataset: { tone: 'neg' }, style: 'margin-top:var(--jc-2)' },
      h('div', { class: 'jc-notice__body' },
        h('span', { class: 'jc-notice__title' }, 'Below your floor'),
        h('span', {}, vt.flag),
      ),
    ));
  } else if (vt.vsFloor || vt.vsTarget) {
    // Show relative-to-targets summary when set.
    const parts = [];
    if (vt.vsFloor && vt.vsFloor !== 'unknown') parts.push(`vs floor: ${vt.vsFloor}`);
    if (vt.vsTarget && vt.vsTarget !== 'unknown') parts.push(`vs target: ${vt.vsTarget}`);
    if (parts.length) {
      out.append(h('div', { class: 'jc-footnote', style: 'margin-top:var(--jc-2)' }, parts.join(' · ')));
    }
  }
}

// Map internal source code → human phrase.
function sourceHuman(src) {
  if (src === 'posting') return 'From the job posting';
  if (src === 'company-research') return 'Company research (comparable to Glassdoor)';
  if (src === 'title-benchmark') return 'General title benchmark';
  return 'Source unknown';
}

function makeCounterRow(label, current, recommend, reasoning, prefix = '') {
  const row = h('div', { class: 'jc-counter-row' },
    h('span', { class: 'jc-counter-row__label' }, label),
    h('span', { class: 'jc-counter-row__from' },
      current != null && current !== '' ? `${prefix}${typeof current === 'number' ? Number(current).toLocaleString() : current} →` : ''
    ),
    h('span', { class: 'jc-counter-row__to' },
      recommend != null && recommend !== '' ? `${prefix}${typeof recommend === 'number' ? Number(recommend).toLocaleString() : recommend}` : '—'
    ),
  );
  if (reasoning) row.append(h('div', { class: 'jc-counter-row__reason' }, reasoning));
  return row;
}

function hydrateOfferForm(offer) {
  if (!els.offerBase) return; // form not in DOM (stale panel.html)
  const o = offer || {};
  els.offerBase.value = o.base ?? '';
  els.offerBonusPercent.value = o.bonusPercent ?? '';
  els.offerBonusAmount.value = o.bonusAmount ?? '';
  els.offerEquityValue.value = o.equityValue ?? '';
  els.offerEquityType.value = o.equityType ?? '';
  els.offerEquityVesting.value = o.equityVesting ?? '';
  els.offerSignOn.value = o.signOn ?? '';
  els.offerNotes.value = o.notes ?? '';
}

function collectOfferForm() {
  const num = (v) => v === '' || v == null ? null : Number(v);
  const trim = (v) => (v || '').trim() || null;
  const details = {
    base: num(els.offerBase.value),
    bonusPercent: num(els.offerBonusPercent.value),
    bonusAmount: num(els.offerBonusAmount.value),
    equityValue: num(els.offerEquityValue.value),
    equityType: trim(els.offerEquityType.value),
    equityVesting: trim(els.offerEquityVesting.value),
    signOn: num(els.offerSignOn.value),
    notes: trim(els.offerNotes.value),
  };
  // Return null if every field is empty
  const anyPresent = Object.values(details).some((v) => v != null && v !== '');
  return anyPresent ? details : null;
}

els.saveOffer?.addEventListener('click', async () => {
  if (!currentJob) return;
  const details = collectOfferForm();
  els.offerStatus.textContent = 'Saving…';
  try {
    // Ensure job is in archive first
    const existing = await send('get-job', { jobId: currentJob.jobId });
    if (!existing.data) await send('save-to-archive', { data: currentJob });
    // Persist offerDetails
    await send('save-to-archive', { data: { jobId: currentJob.jobId, offerDetails: details } });
    currentJob = { ...currentJob, offerDetails: details };
    els.offerStatus.textContent = 'Saved. Re-analyzing…';
    // Trigger comp re-analysis so counter-offer output appears
    els.analyzeComp.click();
    setTimeout(() => { els.offerStatus.textContent = ''; }, 4000);
  } catch (e) {
    els.offerStatus.textContent = `Failed: ${e.message}`;
  }
});

els.clearOffer?.addEventListener('click', async () => {
  if (!currentJob) return;
  if (!confirm('Clear offer details for this job?')) return;
  hydrateOfferForm(null);
  await send('save-to-archive', { data: { jobId: currentJob.jobId, offerDetails: null } });
  currentJob = { ...currentJob, offerDetails: null };
  els.offerStatus.textContent = 'Cleared.';
  setTimeout(() => { els.offerStatus.textContent = ''; }, 2000);
});

function makeCopyButton(text) {
  return h('button', {
    class: 'jc-btn', 'data-size': 'sm', type: 'button',
    style: 'align-self:flex-start',
    onClick: async (e) => {
      await navigator.clipboard.writeText(text);
      e.target.textContent = 'Copied';
      setTimeout(() => (e.target.textContent = 'Copy'), 1200);
    },
  }, 'Copy');
}

// ---------- Question Prep ----------

function renderPrepCard(analyses) {
  const brief = analyses?.brief;
  const out = els.briefOutput;
  out.innerHTML = '';

  if (brief) {
    els.buildBrief.textContent = 'Rebait';
    els.questionMeta.textContent = `${fmtWhen(brief.generatedAt)} · ${brief.model}`;
    replaceGlance(els.prepGlance, h('span', {}, 'Prep ready'));
    out.append(h('div', { class: 'jc-doc-body' }, brief.brief || ''));
    out.append(h('button', {
      class: 'jc-btn', 'data-size': 'sm', type: 'button',
      style: 'margin-top:var(--jc-2)',
      onClick: async (e) => {
        await navigator.clipboard.writeText(brief.brief || '');
        e.target.textContent = 'Copied';
        setTimeout(() => (e.target.textContent = 'Copy prep'), 1200);
      },
    }, 'Copy prep'));
  } else {
    els.buildBrief.textContent = 'Bait';
    els.questionMeta.textContent = '';
    replaceGlance(els.prepGlance, h('span', { class: 'jc-footnote' }, 'Not baited'));
  }
}

// ---------- Cover letter ----------

function renderLetterCard(record) {
  els.letterOutput.innerHTML = '';
  if (!record) {
    els.letterMeta.innerHTML = '';
    els.letterMeta.append(h('span', { class: 'jc-footnote' }, 'Not generated'));
    els.generateLetter.textContent = 'Generate';
    els.letterCopy.hidden = true;
    els.letterPdf.hidden = true;
    if (els.letterCopyTop) els.letterCopyTop.hidden = true;
    return;
  }
  const r = record.result || {};
  const tone = record.tone || 'warm';
  els.letterMeta.innerHTML = '';
  els.letterMeta.append(h('span', { class: 'jc-footnote' }, `Generated ${fmtWhen(record.generatedAt)} · ${tone}`));
  els.generateLetter.textContent = 'Regenerate';
  els.letterCopy.hidden = false;
  els.letterPdf.hidden = false;
  if (els.letterCopyTop) els.letterCopyTop.hidden = false;

  const letterEl = h('div', { class: 'jc-doc-body', contenteditable: 'true' }, r.letter || '');
  els.letterOutput.append(letterEl);

  // Inline copy link — sits at the bottom of the letter body so it's obvious
  // where to click when the user is done reading and wants to paste into an
  // application form. Duplicates the top-right Copy button intentionally;
  // this location is where the user's eye naturally lands after reading.
  const copyText = () => navigator.clipboard.writeText(letterEl.innerText);
  const copyLink = h('a', {
    href: '#', class: 'jc-copy-link',
    onClick: async (e) => {
      e.preventDefault();
      await copyText();
      copyLink.textContent = '✓ Copied — paste into the application';
      setTimeout(() => (copyLink.textContent = '📋 Copy cover letter to clipboard'), 1800);
    },
  }, '📋 Copy cover letter to clipboard');
  els.letterOutput.append(copyLink);

  if (r.wordCount) els.letterOutput.append(h('span', { class: 'jc-footnote' }, `Word count: ${r.wordCount}`));
  if (r.flags?.length) els.letterOutput.append(h('span', { class: 'jc-footnote', style: 'color:var(--jc-caution)' }, `Flags: ${r.flags.join('; ')}`));

  els.letterCopy.onclick = async () => {
    await copyText();
    els.letterCopy.textContent = 'Copied';
    setTimeout(() => (els.letterCopy.textContent = 'Copy'), 1200);
  };
  // Mirror the same copy behavior on the top-of-sidebar Generate-row button,
  // so users don't have to scroll down to the artifact card to copy.
  if (els.letterCopyTop) {
    els.letterCopyTop.onclick = async () => {
      await copyText();
      els.letterCopyTop.textContent = '✓ Copied';
      setTimeout(() => (els.letterCopyTop.textContent = '📋 Copy'), 1200);
    };
  }
  els.letterPdf.onclick = () => openPrintTab({
    kind: 'CoverLetter',
    company: (currentJob?.posting?.company || 'Company').replace(/[^A-Za-z0-9]+/g, ''),
    body: letterEl.innerText,
  });
}

// ---------- Tailored resume ----------

function renderResumeCard(record) {
  els.resumeOutput.innerHTML = '';
  if (!record) {
    els.resumeMeta.innerHTML = '';
    els.resumeMeta.append(h('span', { class: 'jc-footnote' }, 'Not generated'));
    els.generateResume.textContent = 'Generate';
    els.resumeCopy.hidden = true;
    els.resumeDownload.hidden = true;
    els.resumePdf.hidden = true;
    if (els.resumeDownloadTop) els.resumeDownloadTop.hidden = true;
    return;
  }
  const r = record.result || {};
  els.resumeMeta.innerHTML = '';
  els.resumeMeta.append(h('span', { class: 'jc-footnote' }, `Generated ${fmtWhen(record.generatedAt)}`));
  els.generateResume.textContent = 'Regenerate';
  els.resumeCopy.hidden = false;
  els.resumeDownload.hidden = false;
  els.resumePdf.hidden = false;
  if (els.resumeDownloadTop) els.resumeDownloadTop.hidden = false;

  const out = els.resumeOutput;

  if (r.summaryParagraph) {
    out.append(h('span', { class: 'jc-eyebrow' }, 'Summary'));
    out.append(h('p', { class: 'jc-prose' }, r.summaryParagraph));
  }

  for (const section of r.sections || []) {
    out.append(h('span', { class: 'jc-eyebrow', style: 'margin-top:var(--jc-3);display:block' }, section.heading || ''));
    for (const entry of section.entries || []) {
      out.append(h('div', { class: 'jc-resume-role' }, entry.role || ''));
      const ul = h('ul');
      for (const b of entry.bullets || []) {
        const li = h('li', {}, b.text || '');
        if (b.action) li.append(h('span', { class: 'jc-bullet-tag', dataset: { action: b.action } }, b.action));
        ul.append(li);
      }
      out.append(ul);
    }
  }

  if (r.cutBullets?.length) {
    const details = h('details', { style: 'margin-top:var(--jc-3)' },
      h('summary', { style: 'cursor:pointer;font-size:var(--jc-text-xs);color:var(--jc-text-2)' }, `Cut bullets (${r.cutBullets.length})`),
    );
    for (const c of r.cutBullets) {
      details.append(h('div', { style: 'padding:6px 0;border-bottom:1px dashed var(--jc-border)' },
        h('div', { class: 'jc-prose' }, c.text || ''),
        h('div', { class: 'jc-footnote' }, `Reason: ${c.reason || ''}`),
      ));
    }
    out.append(details);
  }

  if (r.flags?.length) {
    out.append(h('div', { class: 'jc-footnote', style: 'color:var(--jc-caution)' }, `Flags: ${r.flags.join('; ')}`));
  }

  els.resumeCopy.onclick = async () => {
    await navigator.clipboard.writeText(resumeToPlainText(r));
    els.resumeCopy.textContent = 'Copied';
    setTimeout(() => (els.resumeCopy.textContent = 'Copy'), 1200);
  };
  const doDownload = () => {
    const company = (currentJob?.posting?.company || 'Company').replace(/[^A-Za-z0-9]+/g, '');
    downloadTextFile({
      filename: `Burgess_${company}_Resume.md`,
      mimeType: 'text/markdown;charset=utf-8',
      body: resumeToMarkdown(r),
    });
  };
  els.resumeDownload.onclick = () => {
    doDownload();
    els.resumeDownload.textContent = '✓ Downloaded';
    setTimeout(() => (els.resumeDownload.textContent = '↓ Download'), 1500);
  };
  // Mirror on the top-of-sidebar Generate-row button so download is one click
  // away from the trigger, without scrolling down to the resume card.
  if (els.resumeDownloadTop) {
    els.resumeDownloadTop.onclick = () => {
      doDownload();
      els.resumeDownloadTop.textContent = '✓ Downloaded';
      setTimeout(() => (els.resumeDownloadTop.textContent = '↓ Download'), 1500);
    };
  }
  els.resumePdf.onclick = () => openPrintTab({
    kind: 'Resume',
    company: (currentJob?.posting?.company || 'Company').replace(/[^A-Za-z0-9]+/g, ''),
    body: resumeToPlainText(r),
  });
}

// Markdown flavor of the resume — preserves section headings, role titles, and
// bullet structure. Chosen over .txt because it round-trips cleanly through
// pandoc → .docx/.pdf and is readable as-is in any editor.
function resumeToMarkdown(r) {
  const lines = [];
  if (r.summaryParagraph) { lines.push('## Summary', '', r.summaryParagraph, ''); }
  for (const s of r.sections || []) {
    if (s.heading) lines.push(`## ${s.heading}`, '');
    for (const entry of s.entries || []) {
      if (entry.role) lines.push(`### ${entry.role}`, '');
      for (const b of entry.bullets || []) lines.push(`- ${b.text || ''}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// Trigger a browser download without needing the "downloads" permission by
// using a blob URL + synthetic anchor click. Works in extension side panels.
function downloadTextFile({ filename, mimeType, body }) {
  const blob = new Blob([body], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick so the download has a chance to start first.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function resumeToPlainText(r) {
  const lines = [];
  if (r.summaryParagraph) { lines.push(r.summaryParagraph, ''); }
  for (const s of r.sections || []) {
    lines.push(s.heading || '', '');
    for (const entry of s.entries || []) {
      lines.push(entry.role || '');
      for (const b of entry.bullets || []) lines.push(`• ${b.text}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ---------- Analysis triggers ----------

// Track in-flight requests so the global progress bar shows whenever ANY
// analysis is running, and mirror per-button working state to the twin in the
// action bar.
// Short human-readable descriptions for the progress-message line under the
// loading bar. Each shows what the extension is actively doing so the user
// isn't staring at an unlabeled spinner. Keyed by the same msgType strings
// dispatched to the service worker.
const PROGRESS_MESSAGE = {
  'analyze-fit':      'Analyzing role fit against your profile…',
  'analyze-comp':     'Analyzing compensation range…',
  'build-brief':      'Building interview prep brief…',
  'generate-letter':  'Drafting cover letter…',
  'generate-resume':  'Tailoring your resume…',
  'ask-llm':          'Asking the model…',
};

// In-flight analysis state, keyed by jobId. Value is an ordered array of
// msgTypes currently running for that job. Keyed (rather than a single
// global counter) so switching jobs in the Jawbar shows the CURRENT
// job's progress + buttons — not whichever job started an analysis last.
// A background analysis for a job you've since navigated away from
// keeps running silently; when you come back, the progress bar and
// working-state buttons reappear for it.
const inFlightByJob = new Map(); // jobId → msgType[]

function noteAnalysisStart(jobId, msgType) {
  if (!jobId) return;
  const list = inFlightByJob.get(jobId) || [];
  list.push(msgType);
  inFlightByJob.set(jobId, list);
  applyProgressForCurrentJob();
}

function noteAnalysisEnd(jobId, msgType) {
  if (!jobId) return;
  const list = inFlightByJob.get(jobId);
  if (!list) return;
  const idx = list.lastIndexOf(msgType);
  if (idx >= 0) list.splice(idx, 1);
  if (!list.length) inFlightByJob.delete(jobId);
  applyProgressForCurrentJob();
}

// Reconciles the sidepanel's progress bar, per-button working state, and
// card processing shimmers to match ONLY what's in-flight for the
// currently-focused job. Called on start/end of every analysis and on
// every job switch — so state never bleeds between jobs.
function applyProgressForCurrentJob() {
  const jobId = currentJob?.jobId;
  const active = jobId ? (inFlightByJob.get(jobId) || []) : [];
  const anyActive = active.length > 0;

  // Progress bar visibility + message (latest push wins).
  if (els.progressBar) els.progressBar.hidden = !anyActive;
  if (els.progressMessage) {
    const latest = active[active.length - 1];
    els.progressMessage.textContent = anyActive
      ? (PROGRESS_MESSAGE[latest] || 'Working…')
      : '';
  }

  // Buttons: reset every action button, then re-mark the ones whose
  // msgType is still active for THIS job. Doing this from scratch each
  // pass makes the reconciler idempotent and forgetful — no need to
  // pair every start with a matching end on the same button.
  const activeSet = new Set(active);
  for (const [msgType, primary] of Object.entries(ACTION_BUTTONS_BY_MSGTYPE)) {
    const btn = els[primary];
    const twin = actionBarTwin(btn);
    const working = activeSet.has(msgType);
    const label = WORKING_LABEL[msgType] || 'Working…';
    setButtonWorkingState(btn, working, label);
    setButtonWorkingState(twin, working, label);
    // Card processing shimmer follows the same activeSet.
    const cards = PROCESSING_CARDS[msgType] || [];
    for (const id of cards) {
      const card = document.getElementById(id);
      if (!card) continue;
      if (working) card.dataset.processing = 'true';
      else delete card.dataset.processing;
    }
  }

}

// Analysis-button el-id lookup, keyed by the msgType the button triggers.
// Used by the reconciler to reset then re-mark buttons per job.
const ACTION_BUTTONS_BY_MSGTYPE = {
  'analyze-fit':     'analyzeFit',
  'analyze-comp':    'analyzeComp',
  'build-brief':     'buildBrief',
  'generate-letter': 'generateLetter',
  'generate-resume': 'generateResume',
  'ask-llm':         'askSend',
};

// Idempotent — safe to call repeatedly with the same working state.
// Replaces markButtonWorking, which flipped state without checking
// what was already there and left stale origLabel copies behind.
function setButtonWorkingState(button, working, label) {
  if (!button) return;
  if (working) {
    if (!button.dataset.origLabel) button.dataset.origLabel = button.textContent;
    button.dataset.running = 'true';
    button.textContent = label;
    button.disabled = true;
  } else {
    if (button.dataset.origLabel) {
      button.textContent = button.dataset.origLabel;
      delete button.dataset.origLabel;
    }
    delete button.dataset.running;
    button.disabled = false;
  }
}

// Cast (Fit / Comp) → "Casting…"
// Bait (Cover letter / Resume/CV / Prep brief) → "Baiting…"
// Anything else falls back to a neutral "Working…" so a new button added later
// doesn't crash — just uses the default label until it's added to this map.
const WORKING_LABEL = {
  'analyze-fit': 'Casting…',
  'analyze-comp': 'Casting…',
  'build-brief': 'Baiting…',
  'generate-letter': 'Baiting…',
  'generate-resume': 'Baiting…',
};

// Which card(s) to visually flag as "processing" for a given action.
// The main card that owns the result goes first; secondary cards that
// derive from the same call (levelCard/flagsCard both read fit.result)
// are included so the shimmer lights the whole affected region.
const PROCESSING_CARDS = {
  'analyze-fit':     ['fitCard', 'levelCard', 'flagsCard'],
  'analyze-comp':    ['compCard'],
  'build-brief':     ['prepCard'],
  'generate-letter': ['letterCard'],
  'generate-resume': ['resumeCard'],
  'ask-llm':         ['askCard'],
};
// Map card-button IDs to action-bar action names so we can mirror state.
const ACTION_MIRROR = {
  analyzeFit: 'fit',
  analyzeComp: 'comp',
  buildBrief: 'prep',
  generateLetter: 'letter',
  generateResume: 'resume',
};

function actionBarTwin(button) {
  const action = ACTION_MIRROR[button?.id];
  if (!action) return null;
  return document.querySelector(`#actionBar .jc-btn[data-action="${action}"]`);
}

async function runAnalysis(button, errorEl, msgType, payload, onSuccess) {
  if (!currentJob) return;
  const jobId = payload.jobId || currentJob.jobId;
  if (!jobId) { errorEl.hidden = false; errorEl.textContent = 'No jobId'; return; }
  errorEl.hidden = true;

  noteAnalysisStart(jobId, msgType);

  try {
    const existing = await send('get-job', { jobId });
    if (!existing.data) {
      await send('save-to-archive', { data: currentJob });
      refreshArchiveCount();
    }
    const r = await send(msgType, { ...payload, jobId });
    onSuccess(r);
    // Only touch the visible UI when the user is still on the job we
    // ran the analysis for. If they switched away mid-flight, the
    // result lands in the archive silently and rendering happens the
    // next time they navigate to this job.
    if (currentJob?.jobId === jobId) {
      const refreshed = await send('get-job', { jobId });
      if (refreshed.data) {
        currentJob = { ...currentJob, analyses: refreshed.data.analyses, warmth: refreshed.data.warmth ?? currentJob.warmth };
        renderVerdict(currentJob);
        renderAnalysisSection(currentJob);
        // Auto-expand the just-finished card so the user sees the result
        // without an extra click. Only for cards that render generated
        // content; analysis-only cards keep the user's manual choice.
        const AUTO_OPEN = { 'generate-letter': 'letterCard', 'generate-resume': 'resumeCard' };
        const cardId = AUTO_OPEN[msgType];
        const card = cardId && document.getElementById(cardId);
        if (card) card.dataset.open = 'true';
      }
    }
  } catch (e) {
    // Surface the error only if the user is still on the job — otherwise
    // the message would render against whichever job they've since
    // opened, which is confusing.
    if (currentJob?.jobId === jobId) {
      errorEl.hidden = false;
      errorEl.textContent = e.message;
    }
  } finally {
    noteAnalysisEnd(jobId, msgType);
  }
}

els.analyzeFit.addEventListener('click', () => runAnalysis(els.analyzeFit, els.fitError, 'analyze-fit', { jobId: currentJob?.jobId }, () => {}));
els.analyzeComp.addEventListener('click', () => runAnalysis(els.analyzeComp, els.compError, 'analyze-comp', { jobId: currentJob?.jobId }, () => {}));
els.buildBrief.addEventListener('click', () => runAnalysis(els.buildBrief, els.briefError, 'build-brief', { jobId: currentJob?.jobId }, () => {}));
els.generateLetter.addEventListener('click', () => runAnalysis(els.generateLetter, els.letterError, 'generate-letter', { jobId: currentJob?.jobId, tone: letterTone }, () => {}));
els.generateResume.addEventListener('click', () => runAnalysis(els.generateResume, els.resumeError, 'generate-resume', { jobId: currentJob?.jobId }, () => {}));

els.askSend?.addEventListener('click', async () => {
  const prompt = els.askInput.value.trim();
  if (!prompt || !currentJob) { els.askInput.focus(); return; }
  const jobId = currentJob.jobId;
  els.askError.hidden = true;
  noteAnalysisStart(jobId, 'ask-llm');
  try {
    // Ensure the job is in the archive so the prior-analyses context works.
    const existing = await send('get-job', { jobId });
    if (!existing.data) await send('save-to-archive', { data: currentJob });
    await send('ask-llm', {
      jobId,
      prompt,
      provider: els.askProvider.value, // 'auto' | 'local' | 'cloud'
    });
    if (currentJob?.jobId === jobId) els.askInput.value = '';
    // Refresh the job so the newly-appended chat item is picked up by the render.
    if (currentJob?.jobId === jobId) {
      const refreshed = await send('get-job', { jobId });
      if (refreshed.data) {
        currentJob = { ...currentJob, analyses: refreshed.data.analyses };
        renderAskCard(refreshed.data.analyses?.chats);
      }
    }
  } catch (e) {
    if (currentJob?.jobId === jobId) {
      els.askError.hidden = false;
      els.askError.textContent = `Failed: ${e.message || 'unknown error'}`;
    }
  } finally {
    noteAnalysisEnd(jobId, 'ask-llm');
  }
});

// The explicit "Save to archive" button was removed — archive capture is now
// entirely driven by clicking LinkedIn's own Save button (watched in
// content/scrape.js) or Apply, plus auto-capture on high-match. If we need
// to save the current scraped job on demand (e.g., before running an
// analysis on a job that isn't yet archived), runAnalysis handles that inline.

// ---------- Print / PDF ----------

async function openPrintTab({ kind, company, body }) {
  const filename = `Burgess_${company}_${kind}.pdf`;
  const url = chrome.runtime.getURL('print/print.html');
  const key = `print.${Date.now()}`;
  await chrome.storage.session.set({ [key]: { kind, filename, body } });
  chrome.tabs.create({ url: `${url}?k=${encodeURIComponent(key)}` });
}

// ---------- Init + listeners ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'current-job-updated') {
    // Only apply if this update belongs to the tab this panel is currently
    // watching. A LinkedIn tab in another window shouldn't repaint this
    // panel; and if the user has switched to a non-LinkedIn tab in this
    // window, that tab's currentJob (or lack of one) wins.
    if (msg.tabId != null && msg.tabId !== currentTabId) return;
    // If the user navigated to a NEW jawb posting while looking at a
    // non-Jawb tab (Interviews / Recent / Searches), snap focus back
    // to Jawb so the new posting is what they see. Re-renders for
    // the SAME jawb (analysis completed, warmth upgraded, etc.) are
    // silent — don't yank the user out of what they were doing.
    const prevJobId = currentJob?.jobId;
    const nextJobId = msg.data?.jobId;
    if (nextJobId && nextJobId !== prevJobId && els.body?.dataset.activeTab !== 'current') {
      switchTab('current');
    }
    renderJob(msg.data).catch((e) => console.warn('renderJob:', e));
  }
  else if (msg?.type === 'archive-updated') {
    refreshArchiveCount();
    // Interview count on the tab strip depends on archive contents.
    refreshTabBadges().catch(() => {});
  }
  else if (msg?.type === 'usage-updated') refreshUsageStrip();
  else if (msg?.type === 'recent-jobs-updated') {
    // If the Recent tab is currently active, re-render it so a
    // newly-viewed jawb shows up without waiting for a tab switch.
    if (els.body?.dataset.activeTab === 'recent') renderRecentTab().catch(() => {});
  }
  else if (msg?.type === 'recent-searches-updated') {
    // Same idea for the Searches tab — refresh live when a new
    // search URL is detected on any LinkedIn tab.
    if (els.body?.dataset.activeTab === 'searches') renderSearchesTab().catch(() => {});
    // Saved-search count on the tab strip can also change (a new
    // saved search from anywhere).
    refreshTabBadges().catch(() => {});
  }
  else if (msg?.type === 'auto-analysis-complete' && currentJob?.jobId === msg.jobId) {
    // Re-fetch the just-updated analyses and re-render
    (async () => {
      try {
        const r = await send('get-job', { jobId: msg.jobId });
        if (r.data) {
          currentJob = { ...currentJob, analyses: r.data.analyses };
          renderVerdict(currentJob);
          renderAnalysisSection(currentJob);
        }
      } catch (e) { console.warn('auto-analysis refresh:', e); }
    })();
  }
});

// Cached contact values for the floating quick-fill toolbar; refreshed on storage change.
const cachedFill = { email: '', phone: '', linkedInUrl: '', location: '' };
(async () => {
  const [email, phone, linkedInUrl, location] = await Promise.all([
    getContactEmail(), getContactPhone(), getLinkedInProfileUrl(), getContactLocation(),
  ]);
  Object.assign(cachedFill, { email, phone, linkedInUrl, location });
})();
attachQuickFill(document.body, () => cachedFill);
chrome.storage.onChanged.addListener((changes) => {
  if (changes['settings.linkedInProfileUrl']) cachedFill.linkedInUrl = changes['settings.linkedInProfileUrl'].newValue || '';
  if (changes['settings.email']) cachedFill.email = changes['settings.email'].newValue || '';
  if (changes['settings.phone']) cachedFill.phone = changes['settings.phone'].newValue || '';
  if (changes['settings.location']) cachedFill.location = changes['settings.location'].newValue || '';
  // peopleFollowing changes when the user visits a LinkedIn profile.
  // The people-stats badge doesn't depend on the follow map (just
  // counts), so we cache the update but skip the re-render — the
  // whole verdict block will refresh naturally on the next job load.
  if (changes['peopleFollowing']) {
    followMap = changes['peopleFollowing'].newValue || {};
  }
  // Comp target edits change the strength-score comp component — re-render
  // the verdict block so the strength badge reflects the new targets.
  if (changes['settings.compTargets']) {
    compTargets = changes['settings.compTargets'].newValue || null;
    if (currentJob) renderVerdict(currentJob);
  }
});

// Load whatever job (if any) is being viewed on the active tab of this
// panel's window, and render — including the empty state if there is none.
async function loadForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: panelWindowId });
    currentTabId = tab?.id ?? null;
    renderSearchContext(tab?.url || null);
    if (currentTabId == null) { await renderJob(null); return; }
    const { data: job } = await send('get-current-job', { tabId: currentTabId });
    await renderJob(job || null);
  } catch (e) {
    console.warn('loadForActiveTab:', e);
    await renderJob(null);
  }
}

// Save-this-search bar under the Jawbar header. Populated whenever the
// active tab is a LinkedIn /jobs/search page OR a Google Jobs search
// (udm=8) with meaningful filters. Auto-hides otherwise. Persists
// across tab switches inside the Jawbar since it lives outside #body.
function renderSearchContext(url) {
  const el = els.searchContext;
  if (!el) return;
  const info = parseAnySearch(url);
  if (!info) { el.hidden = true; return; }
  el.hidden = false;
  els.searchContextSummary.textContent = info.name;
  els.searchContextSummary.title = info.name;
  // Fresh onclick each render — closes over the current `url`.
  els.saveThisSearch.onclick = async () => {
    const name = prompt('Name this search:', info.name) || info.name;
    els.saveThisSearch.disabled = true;
    els.saveThisSearchStatus.textContent = 'Saving…';
    try {
      const r = await send('save-search', { name, url });
      if (r?.ok) {
        els.saveThisSearchStatus.textContent = '✓ Saved';
        refreshTabBadges().catch(() => {});
        setTimeout(() => { els.saveThisSearchStatus.textContent = ''; els.saveThisSearch.disabled = false; }, 1800);
      } else {
        els.saveThisSearchStatus.textContent = `Failed: ${r?.error || 'unknown'}`;
        els.saveThisSearch.disabled = false;
      }
    } catch (e) {
      els.saveThisSearchStatus.textContent = `Failed: ${e.message}`;
      els.saveThisSearch.disabled = false;
    }
  };
}

// Try LinkedIn first, then Google Jobs. Returns { name, source } or null.
function parseAnySearch(url) {
  if (!url) return null;
  const li = parseLinkedInSearch(url);
  if (li) return { ...li, source: 'linkedin' };
  const gj = parseGoogleJobsSearch(url);
  if (gj) return { ...gj, source: 'google_jobs' };
  return null;
}

function parseGoogleJobsSearch(url) {
  try {
    const u = new URL(url);
    if (!/^([^/]+\.)?google\.[a-z.]+$/i.test(u.hostname)) return null;
    if (!/^\/search\/?$/.test(u.pathname)) return null;
    const isJobs = u.searchParams.get('udm') === '8'
      || /htl;\s*jobs/i.test(u.searchParams.get('ibp') || '');
    if (!isJobs) return null;
    const q = (u.searchParams.get('q') || '').trim();
    const label = q ? condenseKeywords(q) : 'Google Jobs search';
    return { name: `${label} · Google Jobs` };
  } catch { return null; }
}

function parseLinkedInSearch(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^([^/]+\.)?linkedin\.com$/.test(u.hostname)) return null;
    if (!/\/jobs\/search\/?/.test(u.pathname) && !/\/jobs\/search-results\/?/.test(u.pathname)) return null;
    const q = u.searchParams;
    // Require at least one meaningful filter — same guard the content
    // script uses to avoid showing on the empty landing page.
    if (!['keywords','f_TPR','f_WT','f_E','f_JT','f_JIYN','f_AL','geoId'].some((k) => q.get(k))) return null;
    return {
      name: defaultSearchName(url),
      isPast24h: q.get('f_TPR') === 'r86400',
      isInNetwork: q.get('f_JIYN') === 'true',
      easyApplyOn: q.get('f_AL') === 'true',
    };
  } catch { return null; }
}

// Refresh the panel whenever the active tab changes within our window.
chrome.tabs.onActivated.addListener((info) => {
  if (info.windowId !== panelWindowId) return;
  currentTabId = info.tabId;
  loadForActiveTab();
});

// If the active tab navigates (URL change), refresh — the content script's
// new scrape will land shortly after via 'current-job-updated', but this
// handles the interim gracefully (empty state if navigated to a non-job page).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== currentTabId) return;
  if (changeInfo.url) loadForActiveTab();
});

async function init() {
  // Tag the panel so you can confirm fresh code loaded (visible in DevTools).
  console.info('[Jawbs] Panel init · v0.8.0 · per-tab job state');

  // Anchor this panel to its window so tab-activation events can be filtered.
  try {
    const win = await chrome.windows.getCurrent();
    panelWindowId = win?.id ?? null;
  } catch (e) {
    console.warn('windows.getCurrent failed:', e);
  }

  const [_email, _phone, _linkedInUrl, _location] = await Promise.all([
    getContactEmail(), getContactPhone(), getLinkedInProfileUrl(), getContactLocation(),
  ]);
  Object.assign(cachedFill, { email: _email, phone: _phone, linkedInUrl: _linkedInUrl, location: _location });

  // Load LinkedIn follow-state map so the recommended-follows widget in
  // renderVerdict can show ✓ Following markers without an async gap.
  try {
    const r = await send('get-follow-map');
    followMap = r?.data || {};
  } catch { followMap = {}; }

  // Comp targets feed the strength-score computation in renderVerdict.
  // Read once at boot; the settings-change listener below refreshes them
  // whenever the user edits comp floor/target/walk-away.
  try { compTargets = await getCompTargets(); } catch { compTargets = null; }

  // Check whichever provider is currently active. Nothing leaves the
  // browser until the user provides a key for their chosen cloud AI.
  const [provider, anthKey, oaKey, gmKey] = await Promise.all([
    getCloudProvider(),
    getApiKey(),
    getOpenAIKey(),
    getGeminiKey(),
  ]);
  const activeKey = provider === 'openai' ? oaKey : provider === 'gemini' ? gmKey : anthKey;
  if (!activeKey) {
    const providerLabel = provider === 'openai' ? 'OpenAI'
                        : provider === 'gemini' ? 'Google Gemini'
                        : 'Anthropic';
    els.statusText.textContent = '';
    els.noticeSlot.innerHTML = '';
    els.noticeSlot.append(h('div', { class: 'jc-notice', dataset: { tone: 'info' } },
      h('div', { class: 'jc-notice__body' },
        h('span', { class: 'jc-notice__title' }, 'API key required'),
        h('span', {}, `Add an ${providerLabel} API key to run analyses, or switch to a different provider in Settings. Nothing leaves your browser until you do.`),
        h('button', {
          class: 'jc-btn', 'data-variant': 'primary', 'data-size': 'sm', type: 'button',
          style: 'align-self:flex-start',
          onClick: () => chrome.runtime.openOptionsPage(),
        }, 'Open settings'),
      )
    ));
  } else {
    els.statusText.textContent = 'API key present. Ready.';
  }

  refreshArchiveCount();
  refreshUsageStrip();
  refreshTabBadges().catch(() => {});
  evaluateTipNudge().catch(() => {});

  // Load the job (or empty state) for whichever tab is active right now.
  await loadForActiveTab();
}

// ---------- Tip / share nudge ----------
//
// Only surfaces once the user has racked up real value:
//   * ≥10 archived jobs OR
//   * ≥5 applied OR
//   * ≥1 in interviewing OR
//   * ≥7 days since install
// Frequency guards ensure it never nags:
//   * tipped:true = silent forever
//   * dismiss → hidden 30 days, morphs into share fallback
//   * share dismiss → both hidden 30 days
// State lives at chrome.storage.local.tip; installedAt seeded on first
// evaluation so day-count is honest even for pre-existing installs.
const TIP_SILENCE_DAYS = 30;
const TIP_BMAC_URL = 'https://buymeacoffee.com/mattburgess';
const TIP_SHARE_URL = 'https://github.com/mattburgess/aijobhuntingbrowserextension';
const TIP_SHARE_TEXT = 'Jawbs — a browser extension that reads LinkedIn job postings, scores fit, and helps you prep. Local-first, no telemetry.';

async function evaluateTipNudge() {
  const wrap = document.getElementById('tipNudge');
  if (!wrap) return;
  const s = (await chrome.storage.local.get('tip')).tip || {};
  const now = Date.now();
  // Master toggle from Settings → System → Tip prompts. Default is on
  // when the field is missing so behavior is unchanged for users who
  // never open the toggle.
  if (s.enabled === false) { wrap.hidden = true; return; }

  // Force-show flag set from Settings → Tip prompts → "Show tip prompt
  // on next load". One-shot: bypasses tipped/dismiss/eligibility guards,
  // forces the tip mode (not share fallback), and clears itself so the
  // next load evaluates normally.
  if (s.forceShow) {
    const { forceShow, ...kept } = s;
    await chrome.storage.local.set({ tip: kept });
    renderTipNudge(wrap);
    return;
  }

  if (s.tipped) { wrap.hidden = true; return; }
  const dismissed = s.dismissedAt ? new Date(s.dismissedAt).getTime() : 0;
  const shareDismissed = s.shareDismissedAt ? new Date(s.shareDismissedAt).getTime() : 0;
  const withinTipSilence = dismissed && (now - dismissed) < TIP_SILENCE_DAYS * 86400_000;
  const withinShareSilence = shareDismissed && (now - shareDismissed) < TIP_SILENCE_DAYS * 86400_000;
  if (withinShareSilence) { wrap.hidden = true; return; }

  let installedAt = s.installedAt;
  if (!installedAt) {
    installedAt = new Date(now).toISOString();
    await chrome.storage.local.set({ tip: { ...s, installedAt } });
  }

  // Milestone check via the same list-jobs channel every other panel
  // metric uses — avoids piling on a bespoke count endpoint.
  let eligible = false;
  try {
    const r = await send('count-jobs-by-status');
    const byStatus = r.data?.byStatus || {};
    const total = r.data?.total ?? 0;
    const applied = byStatus.applied || 0;
    const interviewing = byStatus.interviewing || 0;
    const daysUsed = (now - new Date(installedAt).getTime()) / 86400_000;
    eligible = total >= 10 || applied >= 5 || interviewing >= 1 || daysUsed >= 7;
  } catch { /* fall through — no nudge on error */ }
  if (!eligible) { wrap.hidden = true; return; }

  if (withinTipSilence) {
    renderShareNudge(wrap);
  } else {
    renderTipNudge(wrap);
  }
}

function renderTipNudge(wrap) {
  wrap.dataset.mode = 'tip';
  wrap.innerHTML = `
    <div class="jc-tip-nudge__body">
      <img src="../assets/tip-jar.png" class="jc-tip-nudge__jar" alt="" width="56" height="56" />
      <div class="jc-tip-nudge__copy">
        <span class="jc-tip-nudge__title">Show <span class="jc-tip-nudge__heart" aria-label="love" role="img">❤</span> 4 <span class="jc-brand">Jawbs</span></span>
        <span class="jc-tip-nudge__msg">Buy your cap'n a drink. 30 seconds. Much appreciated.</span>
      </div>
      <div class="jc-tip-nudge__actions">
        <a class="jc-tip-nudge__cta" href="${TIP_BMAC_URL}" target="_blank" rel="noopener" data-tip-action="tip">Tip Captain</a>
      </div>
      <button class="jc-tip-nudge__x" type="button" data-tip-action="dismiss" aria-label="Dismiss">×</button>
    </div>`;
  wrap.hidden = false;
}

function renderShareNudge(wrap) {
  wrap.dataset.mode = 'share';
  const share = (net, url) => `<button class="jc-tip-nudge__share-btn" data-tip-action="share" data-net="${net}" aria-label="Share on ${net}" title="Share on ${net}">${shareIcon(net)}</button>`;
  wrap.innerHTML = `
    <div class="jc-tip-nudge__body">
      <img src="../assets/tip-jar.png" class="jc-tip-nudge__jar" alt="" width="56" height="56" />
      <div class="jc-tip-nudge__copy">
        <span class="jc-tip-nudge__title">Share <span class="jc-brand">Jawbs</span> instead?</span>
        <span class="jc-tip-nudge__msg">One post from you helps me more than you'd think.</span>
      </div>
      <div class="jc-tip-nudge__actions">
        ${share('linkedin')}${share('x')}${share('facebook')}${share('copy')}
      </div>
      <button class="jc-tip-nudge__x" type="button" data-tip-action="share-dismiss" aria-label="Dismiss">×</button>
    </div>`;
  wrap.hidden = false;
}

function shareIcon(net) {
  const paths = {
    linkedin: '<path d="M4 4h4v16H4zM6 2.5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM11 8h4v2c.7-1.2 2.2-2.3 4.5-2.3 3.4 0 4.5 2.2 4.5 5.6V20h-4v-6c0-1.4-.5-2.4-2-2.4-1.6 0-2.5 1.1-2.5 2.6V20h-4z"/>',
    x: '<path d="M17 3h3l-6.5 7.4L21 21h-6l-4.7-6.1L4.9 21H2l7-8L2 3h6l4.2 5.6L17 3z"/>',
    facebook: '<path d="M13 22v-8h3l.5-4H13V7.5c0-1.2.3-2 2-2h2V2.1C16.6 2 15.4 2 14.2 2c-3.4 0-5.7 2.1-5.7 5.8V10H5v4h3.5v8H13z"/>',
    copy: '<path d="M9 3h9a2 2 0 0 1 2 2v11h-2V5H9V3zM5 7h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm0 2v11h9V9H5z"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${paths[net] || ''}</svg>`;
}

function shareUrlFor(net) {
  const u = encodeURIComponent(TIP_SHARE_URL);
  const t = encodeURIComponent(TIP_SHARE_TEXT);
  if (net === 'linkedin') return `https://www.linkedin.com/sharing/share-offsite/?url=${u}`;
  if (net === 'x')        return `https://x.com/intent/tweet?url=${u}&text=${t}`;
  if (net === 'facebook') return `https://www.facebook.com/sharer/sharer.php?u=${u}`;
  return null;
}

async function patchTipState(patch) {
  const s = (await chrome.storage.local.get('tip')).tip || {};
  await chrome.storage.local.set({ tip: { ...s, ...patch } });
}

// Delegated click handler — one listener catches every action button
// rendered by either mode so re-renders don't leak listeners.
document.getElementById('tipNudge')?.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-tip-action]');
  if (!target) return;
  const action = target.dataset.tipAction;
  const wrap = document.getElementById('tipNudge');
  const nowIso = new Date().toISOString();
  if (action === 'tip') {
    // Let the anchor open BMAC in a new tab. Mark tipped-optimistically —
    // the user can always un-set from options if they didn't finish. This
    // silences the nudge forever without a follow-up modal.
    await patchTipState({ tipped: true });
    if (wrap) wrap.hidden = true;
  } else if (action === 'dismiss') {
    await patchTipState({ dismissedAt: nowIso });
    if (wrap) renderShareNudge(wrap);
  } else if (action === 'share-dismiss') {
    await patchTipState({ shareDismissedAt: nowIso });
    if (wrap) wrap.hidden = true;
  } else if (action === 'share') {
    e.preventDefault();
    const net = target.dataset.net;
    if (net === 'copy') {
      try { await navigator.clipboard.writeText(TIP_SHARE_URL); target.title = 'Copied!'; } catch {}
    } else {
      const url = shareUrlFor(net);
      if (url) chrome.tabs.create({ url });
    }
    await patchTipState({ shareDismissedAt: nowIso });
    if (wrap) { setTimeout(() => { wrap.hidden = true; }, 400); }
  }
});

// Tab click handlers — bind once on load.
document.querySelectorAll('#jcTabs [data-tab]').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Clear the auto-tracked recent-searches list from the Searches tab.
document.getElementById('clearRecentSearches')?.addEventListener('click', async () => {
  if (!confirm('Clear all recent unsaved searches? Saved searches are untouched.')) return;
  try {
    await send('clear-recent-searches');
    if (els.body?.dataset.activeTab === 'searches') renderSearchesTab().catch(() => {});
  } catch (e) { alert(`Clear failed: ${e.message}`); }
});

init();

// Heartbeat so LinkedIn content scripts can detect whether the panel is
// currently open (no direct API for this). We ping the SW every 5s while
// the panel document is alive; SW records the timestamp and answers
// is-panel-open queries by checking staleness.
function pingPanelOpen() { chrome.runtime.sendMessage({ type: 'panel-heartbeat' }).catch(() => {}); }
pingPanelOpen();
setInterval(pingPanelOpen, 5000);
window.addEventListener('beforeunload', () => {
  chrome.runtime.sendMessage({ type: 'panel-closed' }).catch(() => {});
});
