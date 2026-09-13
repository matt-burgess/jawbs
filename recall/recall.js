import { getLinkedInProfileUrl, getContactEmail, getContactPhone, getContactLocation, safeExternalUrl } from '../lib/store.js';
import { attachQuickFill } from '../lib/linkedInFill.js';
import { normalizeStatus, statusLabel } from '../lib/statuses.js';
import { derivePeople, relationshipTags, relationshipTone, primaryRelationshipLabel } from '../lib/people.js';

const $ = (id) => document.getElementById(id);
const els = new Proxy({}, { get: (_, id) => $(id) });

const params = new URLSearchParams(location.search);
const jobId = params.get('jobId');

let job = null;

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

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('No response from service worker');
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

function daysAgo(iso) {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
  if (days < 0) return null;
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
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

async function load() {
  if (!jobId) {
    els.jobTitle.textContent = 'No jawb ID in URL.';
    return;
  }
  // Fetch job + follow-state map in parallel; renderPeople reads followMap
  // synchronously when composing badges.
  const [jobResp, followResp] = await Promise.all([
    send('get-job', { jobId }),
    send('get-follow-map').catch(() => ({ data: {} })),
  ]);
  job = jobResp.data;
  followMap = followResp?.data || {};
  if (!job) {
    els.jobTitle.textContent = `Jawb ${jobId} not in Jawboard.`;
    return;
  }
  render();
  send('recall-active', { jobId }).catch(() => {});
}

function render() {
  const p = job.posting || {};
  document.title = `${p.title || 'Recall'} · Jawbs`;

  els.jobTitle.textContent = p.title || '(untitled)';
  const parts = [p.company, p.location, p.workplaceType, p.postedSalaryRange].filter(Boolean);
  els.metaLine.textContent = parts.join(' · ');

  // Toolbar center — title + company mirror the hero so the sticky
  // header identifies the job as the user scrolls the long Recall
  // page. Empty strings hide their spans via CSS (`:empty { display:
  // none }`), which also collapses the middle separator.
  els.toolbarTitleText.textContent = p.title || '';
  els.toolbarTitleCompany.textContent = p.company || '';

  const safeJobUrl = safeExternalUrl(job.url);
  els.jobUrl.hidden = !job.url || safeJobUrl === '#';
  if (job.url) els.jobUrl.href = safeJobUrl;
  // "Find on Corp Career Site" — a Google search that usually surfaces
  // the same role on the company's own careers page. Falls back on
  // just the company when the title is missing; hidden with no company
  // to search against.
  if (p.company) {
    const q = `${p.company} Careers${p.title ? ' - ' + p.title : ''}`;
    els.corpSiteSearch.href = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    els.corpSiteSearch.hidden = false;
  } else {
    els.corpSiteSearch.hidden = true;
  }
  els.postingArchivedBanner.hidden = !job.postingArchived;
  els.deleteJob.hidden = !job.status;

  renderHero();
  renderWhatsNext();
  renderVoyageLog();

  // Static summary — first ~400 chars of the description. No API call.
  const descText = p.descriptionText || job.cardText || '';
  if (descText) {
    const firstPara = descText.split(/\n\n+/)[0] || descText;
    els.summary.textContent = firstPara.length > 500 ? firstPara.slice(0, 480).trim() + '…' : firstPara.trim();
  } else {
    els.summary.textContent = 'No description on file. Enrich this jawb from the Jawboard, or add an interview round below to generate targeted prep.';
  }

  renderFitReadout();
  renderCompReadout();

  // Documents
  const letter = job.analyses?.coverLetter?.result?.letter;
  const resume = job.analyses?.resume?.result;
  els.documentsReadout.innerHTML = '';
  if (letter || resume) {
    if (letter) {
      const details = h('details', {},
        h('summary', {}, `Cover letter · ${job.analyses.coverLetter.tone || 'warm'} tone · generated ${fmtDate(job.analyses.coverLetter.generatedAt)}`),
        h('pre', { class: 'doc-body' }, letter),
      );
      els.documentsReadout.append(details);
    }
    if (resume) {
      const summary = resume.summaryParagraph || '';
      const details = h('details', {},
        h('summary', {}, `Tailored resume · generated ${fmtDate(job.analyses.resume.generatedAt)}`),
        h('div', { class: 'doc-body' }, summary),
      );
      els.documentsReadout.append(details);
    }
  } else {
    els.documentsReadout.textContent = 'No cover letter or tailored resume on record.';
  }

  // Timeline
  els.timeline.innerHTML = '';
  for (const entry of (job.timeline || []).slice().reverse()) {
    els.timeline.append(h('li', {},
      h('span', { class: 'tl-date' }, fmtDate(entry.at)),
      h('span', { class: 'tl-type' }, entry.type),
      h('span', { class: 'tl-note' }, entry.note || ''),
    ));
  }
  if (!job.timeline?.length) els.timeline.append(h('li', { class: 'jc-footnote' }, 'No entries yet.'));

  // Notes — but only if not currently being edited, so we don't clobber
  // in-flight typing on a background reload after a status change.
  if (document.activeElement !== els.notes) {
    els.notes.value = job.userNotes || '';
    lastSavedNotes = els.notes.value;
  }

  // Warmth panel (first-degree connections from Fit analysis)
  renderPeople();

  // Description
  const desc = p.descriptionText || job.cardText || '';
  els.description.textContent = desc;
  els.descLen.textContent = desc.length.toLocaleString();

  renderRounds();
}

// ---------- Interview rounds ----------

function renderRounds() {
  // Snapshot which rounds are currently expanded so renderRound() can
  // restore the [open] attribute on the freshly-created details nodes.
  // Without this, saveRound/generatePrep call load() → renderRounds()
  // and every round collapses, hiding the "Generating prep…" status
  // and the eventual result.
  openRoundIds = new Set(
    Array.from(els.roundsList.querySelectorAll('details.round-card[open]'))
      .map((d) => d.dataset.roundId)
      .filter(Boolean),
  );
  els.roundsList.innerHTML = '';
  const rounds = job.interviewRounds || [];
  if (!rounds.length) {
    els.roundsList.append(h('div', { class: 'jc-footnote' }, 'No rounds scheduled yet. Add one when you know the date.'));
    return;
  }
  // Sort by date/time ascending (upcoming first, then past)
  const sorted = [...rounds].sort((a, b) => {
    const ka = (a.date || '') + 'T' + (a.time || '00:00');
    const kb = (b.date || '') + 'T' + (b.time || '00:00');
    return ka.localeCompare(kb);
  });
  for (const r of sorted) els.roundsList.append(renderRound(r));
}

// Rounds that were expanded before the last re-render. Populated by
// renderRounds() from the live DOM and consumed here so the user's
// open/closed state survives load() → renderRounds() cycles (e.g.
// after Save round, Generate prep, or any other action that refreshes
// the job).
let openRoundIds = new Set();

function renderRound(round) {
  const details = h('details', { class: 'round-card', 'data-round-id': round.id });
  // Auto-open rounds that have no date yet (freshly added), or restore
  // the [open] state from before the last re-render so actions like
  // "Generate prep" don't collapse the round the user is working in.
  if (openRoundIds.has(round.id)) details.open = true;
  else if (!round.date && !round.interviewerName && !round.topic) details.open = true;

  // Summary line: date · time · interviewer · topic — with prep-status badge
  const summaryBits = [];
  if (round.date) {
    const d = round.time ? `${round.date} ${round.time}` : round.date;
    summaryBits.push(h('span', { class: 'round-summary__date' }, d));
  } else {
    summaryBits.push(h('span', { class: 'round-summary__date muted' }, '(no date)'));
  }
  if (round.interviewerName) summaryBits.push(h('span', {}, round.interviewerName));
  if (round.topic) summaryBits.push(h('span', { class: 'round-summary__topic' }, round.topic));

  const prepBadge = round.prep?.result
    ? h('span', { class: 'round-prep-badge', 'data-status': 'ready' }, '✓ Prep')
    : h('span', { class: 'round-prep-badge', 'data-status': 'none' }, 'No prep');

  const summary = h('summary', { class: 'round-summary' },
    h('div', { class: 'round-summary__bits' }, ...summaryBits),
    prepBadge,
    h('span', { class: 'round-summary__chev' }, '▸'),
  );
  details.append(summary);

  const grid = h('div', { class: 'round-card__grid' },
    fieldInput('Date', 'date', round.date || '', 'date'),
    fieldInput('Time', 'time', round.time || '', 'time'),
    fieldInput('Interviewer', 'interviewerName', round.interviewerName || '', 'text', 'Name'),
    fieldInput('LinkedIn URL', 'interviewerLinkedIn', round.interviewerLinkedIn || '', 'url', 'https://linkedin.com/in/…'),
    // Round type is a free-text field the user owns — the voyage log
    // reads it directly and stops guessing from the topic. Default is
    // pre-filled by ordinal position (see defaultRoundType) but the
    // user can overwrite it to anything ("COO Interview", "Skip level",
    // etc.).
    fieldInput('Round type', 'type', round.type || '', 'text', 'e.g., Recruiter, Hiring Mgr, COO, Panel'),
    fieldInput('Topic', 'topic', round.topic || '', 'text', 'e.g., technical deep-dive, exec fit', true),
    fieldTextarea('Your notes', 'notes', round.notes || '', 'Prep notes, expected panelists, any context'),
  );
  details.append(grid);

  const actions = h('div', { class: 'round-card__actions' },
    h('button', {
      class: 'jc-btn', 'data-size': 'sm', type: 'button',
      onClick: () => saveRound(details, round.id),
    }, 'Save round'),
    h('button', {
      class: 'jc-btn', 'data-variant': 'primary', 'data-size': 'sm', type: 'button',
      onClick: () => generatePrep(round.id, details),
    }, round.prep ? 'Regenerate prep' : 'Generate prep'),
    // Follow-up email — reads the round's own notes as the primary
    // source so the draft references specific things the user
    // captured during the interview. Disabled when there's nothing
    // to work from (no notes AND no interviewer name).
    h('button', {
      class: 'jc-btn', 'data-size': 'sm', type: 'button',
      title: 'Draft a post-interview follow-up email using the notes captured for this round.',
      onClick: () => generateFollowUp(round.id, details),
    }, round.followUp ? 'Regenerate follow-up' : 'Generate follow-up'),
    h('button', {
      class: 'jc-btn', 'data-variant': 'ghost', 'data-size': 'sm', type: 'button',
      onClick: async (ev) => {
        ev.stopPropagation();
        if (!confirm('Delete this round?')) return;
        await send('delete-round', { jobId, roundId: round.id });
        await load();
      },
    }, 'Delete'),
    h('span', { class: 'jc-footnote round-status', 'data-round-id': round.id }, ''),
  );
  details.append(actions);

  if (round.prep?.result) {
    details.append(renderPrep(round.prep.result));
    details.append(h('div', { class: 'jc-footnote' }, `Generated ${new Date(round.prep.generatedAt).toLocaleString()} · ${round.prep.model}`));
  }
  if (round.followUp?.result) {
    details.append(renderFollowUp(round.followUp));
  }

  return details;
}

// Follow-up email block — subject line + body with a copy button and
// a "Compose in mail app" mailto link. Uses the round's own notes as
// source material so drafts reference specifics the user captured.
function renderFollowUp(fu) {
  const r = fu.result || {};
  const wrap = h('div', { class: 'round-followup' });
  wrap.append(h('div', { class: 'label' }, 'Follow-up email draft'));
  if (r.subject) {
    wrap.append(h('div', { class: 'round-followup__subject' },
      h('span', { class: 'round-followup__label' }, 'Subject:'),
      h('span', {}, ` ${r.subject}`),
    ));
  }
  const bodyEl = h('div', { class: 'round-followup__body' }, r.body || '');
  wrap.append(bodyEl);

  const copyText = `Subject: ${r.subject || ''}\n\n${r.body || ''}`.trim();
  const copyBtn = h('button', {
    class: 'jc-btn', 'data-size': 'sm', type: 'button',
    onClick: async () => {
      try {
        await navigator.clipboard.writeText(copyText);
        copyBtn.textContent = '✓ Copied';
        setTimeout(() => (copyBtn.textContent = 'Copy email'), 1500);
      } catch { copyBtn.textContent = 'Copy failed'; }
    },
  }, 'Copy email');
  wrap.append(h('div', { class: 'round-followup__actions' },
    copyBtn,
    h('span', { class: 'jc-footnote' },
      `Generated ${new Date(fu.generatedAt).toLocaleString()} · ${fu.model}`),
  ));
  return wrap;
}

function fieldInput(label, key, value, type = 'text', placeholder = '', full = false) {
  const inputProps = { class: 'jc-input', type, value, placeholder, 'data-key': key };
  // Interview times are quantized to :00 / :15 / :30 / :45 — step=900
  // (seconds) makes the native time-picker snap to 15-min increments,
  // and isValidInterviewTime rejects any typed value that slipped past
  // the picker at save-time.
  if (type === 'time') inputProps.step = '900';
  return h('label', full ? { class: 'full' } : {},
    h('span', {}, label),
    h('input', inputProps),
  );
}

// Only :00, :15, :30, :45 are allowed for the Time field. Empty is fine
// (round without a specific time). Anything else is a validation error.
function isValidInterviewTime(v) {
  if (!v) return true;
  const m = String(v).match(/^(\d{2}):(\d{2})$/);
  if (!m) return false;
  return ['00', '15', '30', '45'].includes(m[2]);
}
function fieldTextarea(label, key, value, placeholder = '') {
  const wrap = h('label', { class: 'full' },
    h('span', {}, label),
  );
  const ta = h('textarea', { class: 'jc-textarea', placeholder, 'data-key': key });
  ta.value = value;
  wrap.append(ta);
  return wrap;
}

function collectRoundFrom(card) {
  const out = {};
  card.querySelectorAll('[data-key]').forEach((el) => {
    out[el.dataset.key] = el.value.trim() || null;
  });
  return out;
}

async function saveRound(card, existingId, opts = {}) {
  const status = card.querySelector(`.round-status[data-round-id="${existingId}"]`);
  const fields = collectRoundFrom(card);
  if (!isValidInterviewTime(fields.time)) {
    if (status) status.textContent = 'Time must end in :00, :15, :30, or :45.';
    return;
  }
  const payload = { ...fields, id: existingId };
  try {
    if (status) status.textContent = 'Saving…';
    await send('save-round', { jobId, round: payload });
    if (status) { status.textContent = 'Saved.'; setTimeout(() => (status.textContent = ''), 2000); }
    // Callers running a follow-up action (e.g. generatePrep) suppress
    // the reload so the DOM node they're holding doesn't get detached
    // out from under them before the follow-up runs.
    if (!opts.skipReload) await load();
  } catch (e) {
    if (status) status.textContent = `Failed: ${e.message}`;
  }
}

// Same shape as generatePrep — save any pending edits (skipReload so
// the card doesn't detach), call the follow-up generator, then reload.
async function generateFollowUp(roundId, card) {
  await saveRound(card, roundId, { skipReload: true }).catch(() => {});
  const status = () => document.querySelector(`.round-status[data-round-id="${roundId}"]`);
  const s0 = status(); if (s0) s0.textContent = 'Drafting follow-up email…';
  try {
    await send('generate-round-followup', { jobId, roundId });
    await load();
    const s2 = status(); if (s2) s2.textContent = '';
  } catch (e) {
    const s1 = status(); if (s1) s1.textContent = `Failed: ${e.message}`;
  }
}

async function generatePrep(roundId, card) {
  // Save any pending field edits, but SKIP the reload — otherwise the
  // details node re-renders and `card` becomes an orphaned reference,
  // silently swallowing our status writes and giving the user the
  // "clicking generate prep collapses the round and does nothing"
  // symptom.
  await saveRound(card, roundId, { skipReload: true }).catch(() => {});
  // Re-query the status span every step — after load() further down,
  // the old one is gone.
  const status = () => document.querySelector(`.round-status[data-round-id="${roundId}"]`);
  const s0 = status(); if (s0) s0.textContent = 'Generating prep…';
  try {
    await send('generate-round-prep', { jobId, roundId });
    await load();
    const s2 = status(); if (s2) s2.textContent = '';
  } catch (e) {
    const s1 = status(); if (s1) s1.textContent = `Failed: ${e.message}`;
  }
}

// Live-call layout — a tab strip across the top switches sections; the
// visible section's individual items (Q&A, stories) start collapsed so
// each tab is a scannable list. Click a question to reveal the answer
// inline. One thing on screen at a time makes the whole thing usable
// during an active interview.
function renderPrep(r) {
  const wrap = h('div', { class: 'round-prep' });

  // Build the list of tabs we actually have content for. Empty
  // sections are skipped so the tab strip only shows real options.
  const panes = [];
  if (r.openerNote) {
    panes.push({ key: 'opener', label: 'Opener', render: () => paneOpener(r.openerNote) });
  }
  if (r.likelyQuestions?.length) {
    panes.push({
      key: 'qa', label: 'Q&A', count: r.likelyQuestions.length,
      render: () => paneQAList(r.likelyQuestions, 'answerAngle', 'Answer angle'),
    });
  }
  if (r.questionsToAsk?.length) {
    panes.push({
      key: 'ask', label: 'Ask', count: r.questionsToAsk.length,
      render: () => paneQAList(r.questionsToAsk, 'why', 'Why ask this'),
    });
  }
  if (r.storyBank?.length) {
    panes.push({
      key: 'stories', label: 'Stories', count: r.storyBank.length,
      render: () => paneStories(r.storyBank),
    });
  }
  if (r.watchouts?.length) {
    panes.push({
      key: 'watchouts', label: 'Watchouts', count: r.watchouts.length,
      render: () => paneWatchouts(r.watchouts),
    });
  }
  if (r.afterCall) {
    panes.push({ key: 'after', label: 'After', render: () => paneAfter(r.afterCall) });
  }
  if (!panes.length) return wrap;

  const tabStrip = h('div', { class: 'prep-tabs', role: 'tablist' });
  const paneHost = h('div', { class: 'prep-pane-host' });
  const tabButtons = [];

  const activate = (i) => {
    tabButtons.forEach((b, j) => {
      const active = j === i;
      b.dataset.active = active ? 'true' : 'false';
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.tabIndex = active ? 0 : -1;
    });
    paneHost.innerHTML = '';
    paneHost.append(panes[i].render());
  };

  panes.forEach((p, i) => {
    const label = p.count != null
      ? [p.label, h('span', { class: 'prep-tab__count' }, `·${p.count}`)]
      : [p.label];
    const btn = h('button', {
      class: 'prep-tab', type: 'button', role: 'tab',
      'aria-selected': 'false', tabindex: '-1',
      onClick: () => activate(i),
    }, ...label);
    tabButtons.push(btn);
    tabStrip.append(btn);
  });

  wrap.append(tabStrip, paneHost);
  activate(0);
  return wrap;
}

// --- Pane builders ---

function paneOpener(text) {
  return h('div', { class: 'prep-pane prep-pane--prose' },
    h('p', {}, text),
  );
}

// Shared Q&A pane — used by both "Likely questions" (answerAngle) and
// "Ask them" (why). Each item is a <details> so the answer is one
// click away and the questions stay scannable at rest.
function paneQAList(items, valueKey, valueLabel) {
  const pane = h('div', { class: 'prep-pane prep-pane--qa' });
  const toolbar = h('div', { class: 'prep-toolbar' },
    h('button', {
      class: 'prep-linkbtn', type: 'button',
      onClick: () => pane.querySelectorAll('details').forEach((d) => d.open = true),
    }, 'Expand all'),
    h('button', {
      class: 'prep-linkbtn', type: 'button',
      onClick: () => pane.querySelectorAll('details').forEach((d) => d.open = false),
    }, 'Collapse all'),
  );
  pane.append(toolbar);
  for (const q of items) {
    const det = h('details', { class: 'prep-item' },
      h('summary', { class: 'prep-item__q' }, q.question),
      h('div', { class: 'prep-item__body' },
        h('div', { class: 'prep-item__label' }, valueLabel),
        h('div', { class: 'prep-item__answer' }, q[valueKey] || ''),
      ),
    );
    pane.append(det);
  }
  return pane;
}

function paneStories(stories) {
  const pane = h('div', { class: 'prep-pane prep-pane--stories' });
  const toolbar = h('div', { class: 'prep-toolbar' },
    h('button', {
      class: 'prep-linkbtn', type: 'button',
      onClick: () => pane.querySelectorAll('details').forEach((d) => d.open = true),
    }, 'Expand all'),
    h('button', {
      class: 'prep-linkbtn', type: 'button',
      onClick: () => pane.querySelectorAll('details').forEach((d) => d.open = false),
    }, 'Collapse all'),
  );
  pane.append(toolbar);
  for (const s of stories) {
    const summary = h('summary', { class: 'prep-item__q' },
      h('span', { class: 'prep-story__label' }, s.situation),
      s.anchor ? h('span', { class: 'prep-story__anchor' }, s.anchor) : null,
    );
    const body = h('div', { class: 'prep-item__body' });
    if (s.beats?.length) {
      const beats = h('ol', { class: 'prep-story__beats' });
      for (const b of s.beats) beats.append(h('li', {}, b));
      body.append(beats);
    }
    pane.append(h('details', { class: 'prep-item' }, summary, body));
  }
  return pane;
}

function paneWatchouts(items) {
  const pane = h('div', { class: 'prep-pane prep-pane--watchouts' });
  const ul = h('ul', { class: 'prep-watchouts' });
  for (const w of items) ul.append(h('li', {}, w));
  pane.append(ul);
  return pane;
}

function paneAfter(text) {
  return h('div', { class: 'prep-pane prep-pane--prose' },
    h('p', {}, text),
  );
}

// Standard interview funnel order. New rounds pre-fill their type
// based on how many rounds already exist so the user's first click
// gets a sensible label instead of a blank field. Everything past
// slot 5 defaults to Final; the user can still overwrite any value.
const ROUND_TYPE_DEFAULTS = [
  'Recruiter',      // 1st
  'Hiring Manager', // 2nd
  'Technical',      // 3rd
  'Panel',          // 4th
  'Final',          // 5th+
];
function defaultRoundType(existingCount) {
  return ROUND_TYPE_DEFAULTS[Math.min(existingCount, ROUND_TYPE_DEFAULTS.length - 1)];
}

els.addRound.addEventListener('click', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const existing = (job.interviewRounds || []).length;
  await send('save-round', {
    jobId,
    round: { date: today, topic: '', type: defaultRoundType(existing) },
  });
  await load();
});

// ---------- Hero + Next-actions ----------
//
// Score-dominant hero. Big fit number on the left, title/verdict/status
// on the right, and one-click status shortcuts below. Undoes the old
// select+button pattern which took too many clicks to advance a job.

const STATUS_TONE_MAP = {
  analyzed: 'neutral', saved: 'info',
  inProgressDraft: 'caution', inProgressClickedApply: 'caution',
  applied: 'info', interviewing: 'pos',
  archived: 'neutral', notMovingForward: 'neg',
};

function renderHero() {
  const fit = job.analyses?.fit?.result;
  const score = typeof fit?.fitScore === 'number' ? fit.fitScore : null;
  const scoreEl = els.heroScoreNum;
  scoreEl.textContent = score != null ? String(score) : '—';
  // Color the big score by tier
  const tier = score == null ? 'none'
    : score >= 75 ? 'pos'
    : score >= 55 ? 'caution'
    : 'neg';
  els.heroScore.dataset.tier = tier;

  // Hero badges intentionally left blank — verdict/status/applied-when/
  // reposted moved into the voyage-log strip above, so repeating them
  // here just piled duplicated chips under the score.
  els.heroBadges.innerHTML = '';

  // One-click status shortcuts. Only show buttons for statuses that
  // represent a forward or terminal move from the current one. All
  // three render as the default (secondary) button style so it's clear
  // they're status transitions, not the page's primary action. A
  // "Change status:" label leads the row so the intent of the buttons
  // is unambiguous even when only one option is available.
  els.heroActions.innerHTML = '';
  const norm = normalizeStatus(job.status);
  const shortcuts = [];
  if (norm !== 'applied' && norm !== 'interviewing' && norm !== 'notMovingForward') {
    shortcuts.push({ label: '→ Applied', status: 'applied' });
  }
  if (norm !== 'interviewing' && norm !== 'notMovingForward') {
    shortcuts.push({ label: '→ Interviewing', status: 'interviewing' });
  }
  if (norm !== 'notMovingForward' && norm !== 'archived') {
    shortcuts.push({ label: 'Not moving forward', status: 'notMovingForward' });
  }
  if (shortcuts.length) {
    els.heroActions.append(h('span', { class: 'change-status-label' }, 'Change status:'));
    for (const s of shortcuts) {
      els.heroActions.append(h('button', {
        class: 'jc-btn', 'data-size': 'sm', type: 'button',
        onClick: () => updateStatus(s.status),
      }, s.label));
    }
  }
}

// Voyage log — mockup 1b's "The hunt" strip. Renders the 5 canonical
// job-search stages (Captured → Saved → Applied → Interviewing → Offer)
// with past/now/next state so users see where a jawb is at a glance.
// Data pulled from job.timeline + normalized job.status.
function renderVoyageLog() {
  const wrap = document.getElementById('voyageLog');
  const stagesEl = document.getElementById('voyageLogStages');
  const ageEl = document.getElementById('voyageLogAge');
  if (!wrap || !stagesEl) return;
  const STAGES = [
    { key: 'captured',     label: 'Captured' },
    { key: 'saved',        label: 'Saved' },
    { key: 'applied',      label: 'Applied' },
    { key: 'interviewing', label: 'Interviewing' },
    { key: 'offer',        label: 'Offer' }
  ];
  const norm = normalizeStatus(job.status || '');
  const stageAtIdx = (() => {
    if (norm === 'interviewing') return 3;
    if (norm === 'applied' || norm === 'inProgressClickedApply' || norm === 'inProgressDraft') return 2;
    if (norm === 'saved') return 1;
    if (norm === 'archived' || norm === 'notMovingForward') return -1;
    return 0; // analyzed or empty
  })();
  const stageDate = (idx) => {
    if (idx === 0) return job.capturedAt ? fmtDateShort(job.capturedAt) : '';
    const key = STAGES[idx]?.key;
    if (!key) return '';
    const at = statusChangeAt(key);
    return at ? fmtDateShort(at) : '';
  };
  stagesEl.innerHTML = STAGES.map((s, i) => {
    const state = stageAtIdx < 0 ? 'past' : (i < stageAtIdx ? 'past' : i === stageAtIdx ? 'now' : 'next');
    const date = state === 'next' ? '—' : (stageDate(i) || '—');
    return `<li class="voyage-stage" data-state="${state}">
      <div class="voyage-stage__row">
        <span class="voyage-stage__mark"></span>
        <span class="voyage-stage__bar"></span>
      </div>
      <span class="voyage-stage__label">${s.label}</span>
      <span class="voyage-stage__date">${date}</span>
    </li>`;
  }).join('');
  wrap.hidden = false;
  // Days-since-last-move readout — the mockup shows "24 days since last
  // move" next to the strip; a fresh capture reads "just started."
  const lastMoveAt = (job.timeline || [])
    .filter((e) => e && e.at)
    .map((e) => new Date(e.at).getTime())
    .sort((a, b) => b - a)[0] || (job.capturedAt ? new Date(job.capturedAt).getTime() : null);
  if (ageEl && lastMoveAt) {
    const days = Math.max(0, Math.floor((Date.now() - lastMoveAt) / 86400000));
    ageEl.textContent = days === 0 ? 'moved today' : `${days} day${days === 1 ? '' : 's'} since last move`;
  } else if (ageEl) {
    ageEl.textContent = '';
  }
}

function fmtDateShort(v) {
  if (!v) return '';
  try {
    return new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
}

// Find the first timestamp when the job entered a given status. Matches
// the note text produced by mergeJobRecord + updateJobStatus.
function statusChangeAt(targetStatus) {
  const target = normalizeStatus(targetStatus);
  for (const entry of job.timeline || []) {
    if (entry.type !== 'status-change') continue;
    if (String(entry.note || '').toLowerCase().includes(target.toLowerCase())) return entry.at;
  }
  return null;
}

async function updateStatus(status) {
  try {
    await send('update-job-status', { jobId, status });
    await load();
  } catch (e) {
    alert(`Failed: ${e.message}`);
  }
}

// ---------- What's next ----------
//
// Above-the-fold callout. Prioritizes: (1) next scheduled round with
// countdown, (2) aging warning for stale Applied jobs, (3) hidden.
function renderWhatsNext() {
  const el = els.whatsNext;
  el.innerHTML = '';
  const rounds = job.interviewRounds || [];
  const now = Date.now();

  const upcoming = rounds
    .filter((r) => r.date)
    .map((r) => ({ r, t: new Date(`${r.date}T${r.time || '09:00'}`).getTime() }))
    .filter((x) => Number.isFinite(x.t) && x.t > now)
    .sort((a, b) => a.t - b.t)[0];

  if (upcoming) {
    const days = Math.round((upcoming.t - now) / 86400_000);
    const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
    const bits = [`Next round: ${upcoming.r.topic || 'Interview'}`];
    if (upcoming.r.interviewerName) bits.push(`with ${upcoming.r.interviewerName}`);
    bits.push(`— ${when}`);
    el.dataset.tone = days <= 2 ? 'urgent' : 'info';
    el.innerHTML = `<span class="whats-next__label">Coming up</span> <span class="whats-next__msg">${escapeHtml(bits.join(' '))}</span>`;
    el.hidden = false;
    return;
  }

  // Aging-warning callout retired — the voyage-log strip already shows
  // "N days since last move" for the same signal.
  el.hidden = true;
}

// ---------- Fit + Comp readouts (v6 fit / v4 comp aware) ----------

function renderFitReadout() {
  const fit = job.analyses?.fit?.result;
  els.fitReadout.innerHTML = '';
  if (!fit) {
    els.fitReadout.append(h('div', { class: 'jc-footnote' }, 'No fit analysis on record.'));
    els.fitReadout.append(h('div', { class: 'empty-cta' },
      'Open the LinkedIn posting and run ',
      h('strong', {}, 'Analyze'),
      ' on the Career Fit card.',
    ));
    if (job.url) {
      els.fitReadout.append(h('a', {
        class: 'jc-btn', 'data-variant': 'primary', 'data-size': 'sm',
        href: job.url, target: '_blank', rel: 'noopener',
      }, '↗ Open posting'));
    }
    return;
  }

  // Alignments — v6 outputs plain string bullets
  if (fit.alignments?.length) {
    els.fitReadout.append(h('div', { class: 'label' }, 'Alignments'));
    const ul = h('ul', { class: 'fit-bullets fit-bullets--pos' });
    for (const a of fit.alignments) {
      ul.append(h('li', {}, typeof a === 'string' ? a : (a.what || JSON.stringify(a))));
    }
    els.fitReadout.append(ul);
  }
  // Gaps — same shape
  if (fit.gaps?.length) {
    els.fitReadout.append(h('div', { class: 'label' }, 'Gaps'));
    const ul = h('ul', { class: 'fit-bullets fit-bullets--neg' });
    for (const g of fit.gaps) {
      ul.append(h('li', {}, typeof g === 'string' ? g : (g.gap || g.what || JSON.stringify(g))));
    }
    els.fitReadout.append(ul);
  }
  // Remote authenticity flag
  const ra = fit.remoteAuthenticity;
  if (ra?.flag) {
    els.fitReadout.append(h('div', { class: 'jc-notice', 'data-tone': 'caution' },
      h('div', { class: 'jc-notice__body' },
        h('span', { class: 'jc-notice__title' }, 'Remote authenticity'),
        h('span', {}, ra.flag),
      ),
    ));
  }
  // Outreach recommendation
  const out = fit.outreach;
  if (out?.hasNetwork && out?.bestContact) {
    const block = h('div', { class: 'outreach-block' },
      h('div', { class: 'label' }, 'Outreach — first move'),
      h('div', { class: 'outreach-block__contact' }, out.bestContact),
    );
    if (out.why) block.append(h('div', { class: 'outreach-block__why' }, out.why));
    if (out.strategy) block.append(h('div', { class: 'outreach-block__strat' }, out.strategy));
    els.fitReadout.append(block);
  }
}

function renderCompReadout() {
  const comp = job.analyses?.comp?.result;
  els.compReadout.innerHTML = '';
  if (!comp) {
    els.compReadout.append(h('div', { class: 'jc-footnote' }, 'No comp analysis on record.'));
    els.compReadout.append(h('div', { class: 'empty-cta' },
      'Open the LinkedIn posting and run ',
      h('strong', {}, 'Analyze'),
      ' on the Compensation card.',
    ));
    if (job.url) {
      els.compReadout.append(h('a', {
        class: 'jc-btn', 'data-variant': 'primary', 'data-size': 'sm',
        href: job.url, target: '_blank', rel: 'noopener',
      }, '↗ Open posting'));
    }
    return;
  }

  // v4 salary structure: salary.base = {low, high}, salary.source, sourceLabel
  const salary = comp.salary || {};
  const base = salary.base || {};
  const fmtUsd = (n) => n == null ? '—' : `$${Math.round(n).toLocaleString()}`;
  if (base.low != null || base.high != null) {
    els.compReadout.append(h('div', { class: 'comp-range' },
      h('span', { class: 'comp-range__num' }, `${fmtUsd(base.low)} – ${fmtUsd(base.high)}`),
      h('span', { class: 'comp-range__lbl' }, 'base'),
    ));
  } else if (comp.marketEstimate) {
    // Legacy v3 fallback
    const m = comp.marketEstimate;
    els.compReadout.append(h('div', { class: 'comp-range' },
      h('span', { class: 'comp-range__num' }, `${fmtUsd(m.baseLow)} – ${fmtUsd(m.baseHigh)}`),
      h('span', { class: 'comp-range__lbl' }, 'base (legacy estimate)'),
    ));
  }

  // Source badge — the whole point of v4 was "always show where the number came from"
  const source = salary.source || 'unknown';
  const sourceLabelMap = {
    posting: 'From the posting',
    research: 'From company research',
    'title-benchmark': 'Title benchmark',
    unknown: 'Source unknown',
  };
  const sourceTone = source === 'posting' ? 'pos' : source === 'research' ? 'info' : 'caution';
  els.compReadout.append(h('span', {
    class: 'hero-badge', 'data-tone': sourceTone, style: 'align-self:flex-start',
  }, salary.sourceLabel || sourceLabelMap[source] || source));

  // Bonus / equity if present
  if (salary.bonusPercent != null) {
    els.compReadout.append(h('div', {}, `Bonus: ${salary.bonusPercent}%`));
  }
  if (salary.equityNote) {
    els.compReadout.append(h('div', {}, `Equity: ${salary.equityNote}`));
  }
  if (comp.floorFlag) {
    els.compReadout.append(h('div', { class: 'jc-notice', 'data-tone': 'neg' },
      h('div', { class: 'jc-notice__body' },
        h('span', { class: 'jc-notice__title' }, 'Below floor'),
        h('span', {}, comp.floorFlag),
      ),
    ));
  }
}

// ---------- People (fit warmth + panel) ----------

// Render a person's name — as a link if we have a profile URL (from either
// the warmth scrape or an explicitly-entered panel member LinkedIn URL),
// otherwise as plain <strong>. Names captured before the profile-URL
// upgrade won't be linked until that job is re-scraped.
function renderPersonName(name, profileUrl) {
  const label = name || '(unnamed)';
  if (!profileUrl) return h('strong', {}, label);
  return h('a', {
    class: 'person-link',
    href: profileUrl, target: '_blank', rel: 'noopener noreferrer',
    title: `Open ${label}'s LinkedIn profile`,
  }, label,
    // LinkedIn mark — same treatment as recent-jawbs so it's obvious
    // where the click will land.
    h('img', {
      class: 'jc-li-icon', src: '../assets/linkedin.svg',
      alt: 'LinkedIn', width: '14', height: '14',
    }),
  );
}

// Following state is populated asynchronously — this cache is filled by
// load() from the SW's peopleFollowing map. renderPeople reads it
// synchronously when composing badges.
let followMap = {};

function followBadge(profileUrl) {
  if (!profileUrl) return null;
  const entry = followMap[profileUrl];
  if (!entry || !entry.following) return null;
  const modeLabel = entry.mode === 'all' ? 'All posts'
    : entry.mode === 'most-relevant' ? 'Most relevant'
    : 'Following';
  const tone = entry.mode === 'all' ? 'pos' : 'info';
  return h('span', {
    class: 'hero-badge', 'data-tone': tone,
    style: 'margin-left:8px',
    title: `You follow this person${entry.mode ? ' (' + modeLabel + ')' : ''}`,
  }, `✓ ${modeLabel}`);
}

function renderPeople() {
  els.panelList.innerHTML = '';
  const people = derivePeople(job, { followMap });
  const panel = job.panel || [];

  if (!people.length && !panel.length) {
    els.panelList.append(h('div', { class: 'jc-footnote' }, 'No people captured for this posting.'));
    return;
  }

  // Recommended-follow strip — the actionable people first. Any person
  // marked followingRecommended who isn't yet followed goes at the top
  // with a "Consider following" cue.
  const recs = people.filter((p) => p.followingRecommended && !p.following);
  if (recs.length) {
    els.panelList.append(h('div', { class: 'label', style: 'margin-top:2px' },
      '★ Consider following',
    ));
    for (const p of recs.slice(0, 5)) els.panelList.append(renderPersonRow(p, { emphasize: true }));
  }

  // The full list, sorted by priority. Group headers make scanning easy.
  const key = (p) => {
    const r = p.relationships;
    if (r.hiringManager || r.recruiter || r.interviewer || r.jobPoster || r.teamMember) return 'team';
    if (p.degree === 1 || r.companyConnection) return 'first';
    if (p.degree === 2) return 'second';
    if (r.companyAlumni) return 'coAlumni';
    if (r.schoolAlumni) return 'schoolAlumni';
    return 'other';
  };
  const groups = {
    team: { label: 'Hiring team', people: [] },
    first: { label: '1st degree at company', people: [] },
    second: { label: '2nd degree at company', people: [] },
    coAlumni: { label: 'Company alumni', people: [] },
    schoolAlumni: { label: 'School alumni', people: [] },
    other: { label: 'Other', people: [] },
  };
  for (const p of people) groups[key(p)].people.push(p);
  for (const g of Object.values(groups)) {
    if (!g.people.length) continue;
    els.panelList.append(h('div', { class: 'label', style: 'margin-top:10px' }, g.label));
    for (const p of g.people) els.panelList.append(renderPersonRow(p));
  }

  // Explicit panel/interviewers array (user-entered per round). Kept
  // separate from LinkedIn-scraped people because it has different
  // provenance.
  if (panel.length) {
    els.panelList.append(h('div', { class: 'label', style: 'margin-top:10px' }, 'Panel / interviewers'));
    for (const person of panel) {
      const url = person.linkedInUrl || person.profileUrl;
      els.panelList.append(h('div', { class: 'panel-person' },
        renderPersonName(person.name, url),
        person.role ? h('span', { class: 'jc-footnote' }, ` — ${person.role}`) : null,
        followBadge(url),
      ));
    }
  }
}

// Single person row — name link + relationship tags + follow badge.
// emphasize = highlighted recommended-follow row at the top.
function renderPersonRow(person, opts = {}) {
  const tags = relationshipTags(person);
  const primaryTone = relationshipTone(person);
  return h('div', {
    class: opts.emphasize ? 'panel-person panel-person--rec' : 'panel-person',
    'data-priority': String(person.priorityScore),
  },
    renderPersonName(person.name, person.profileUrl),
    person.headline ? h('span', { class: 'jc-footnote' }, ` — ${person.headline}`) : null,
    ...tags.map((t, i) => h('span', {
      class: 'hero-badge',
      'data-tone': i === 0 ? primaryTone : 'neutral',
      style: 'margin-left:6px',
    }, t)),
    person.messagable ? h('span', { class: 'hero-badge', 'data-tone': 'pos', style: 'margin-left:6px' }, 'DM-able') : null,
    followBadge(person.profileUrl),
  );
}

// ---------- Actions ----------
//
// Per-round AI prep is handled inside the round card. Top-level "Prep me
// for this call" was removed; each interview lives as a round.

els.logContact.addEventListener('click', async () => {
  const note = els.contactNote.value.trim();
  if (!note) return;
  try {
    await send('add-timeline', { jobId, entryType: 'contact', note });
    els.contactNote.value = '';
    await load();
  } catch (e) { alert(`Failed: ${e.message}`); }
});

// Autosave notes — debounced 800ms after last keystroke. No explicit Save
// button; the tiny status footer tells the user when the last write landed.
let notesTimer = null;
let lastSavedNotes = '';
els.notes.addEventListener('input', () => {
  clearTimeout(notesTimer);
  els.notesStatus.textContent = 'Editing…';
  notesTimer = setTimeout(async () => {
    const val = els.notes.value;
    if (val === lastSavedNotes) { els.notesStatus.textContent = ''; return; }
    try {
      await send('save-to-archive', { data: { jobId, userNotes: val } });
      lastSavedNotes = val;
      els.notesStatus.textContent = 'Saved.';
      setTimeout(() => { els.notesStatus.textContent = ''; }, 1500);
    } catch (e) {
      els.notesStatus.textContent = `Failed: ${e.message}`;
    }
  }, 800);
});

// Delete job — destructive; explicit confirm.
els.deleteJob.addEventListener('click', async () => {
  const label = job.posting?.title || `Job ${jobId}`;
  if (!confirm(`Delete "${label}" from the Jawboard? This cannot be undone.`)) return;
  els.deleteJob.disabled = true;
  els.deleteJob.textContent = 'Deleting…';
  try {
    await send('delete-job', { jobId });
    // Return to the Jawboard.
    location.href = '../archive/archive.html';
  } catch (e) {
    els.deleteJob.disabled = false;
    els.deleteJob.textContent = 'Delete';
    alert(`Failed: ${e.message}`);
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

load();
