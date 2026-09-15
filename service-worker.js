import { callAnthropic, extractText } from './lib/anthropic.js';
import { callAI } from './lib/aiRouter.js';
import { callJsonAnthropic } from './lib/json.js';
import {
  getApiKey, getModels,
  getProfile, getMasterResume, getCompTargets, getWritingSamples,
  getAutoAnalyzeEnabled,
  getWorkLocations, getWorkPreferences,
  getKnowledgeBase, getLocalModelSettings,
  addUsage, getUsage, getDailyUsage,
  logActivity, getActivity, clearActivity,
  upsertJob, getJob, listJobs, bulkGetJobsByIds, deleteJob, countJobs,
  setJobAnalysis, updateJobStatus, addTimelineEntry,
  bulkUpsertJobsWith, mergeJobRecord,
  findProbableDuplicate,
  getContextSettings,
  getSavedSearches, addSavedSearch, deleteSavedSearch,
  addRecentSearch, getRecentSearchesFiltered, clearRecentSearches, markSavedSearchRun,
  getNegativeKeywords,
  exportAll, importAll, setLastExportAt, getLastExportAt,
} from './lib/store.js';
import { MODEL_IDS } from './lib/models.js';
import { FIT_SYSTEM, FIT_PROMPT_VERSION, buildFitUserMessage } from './lib/prompts/fit.js';
import { COMP_SYSTEM, COMP_PROMPT_VERSION, buildCompUserMessage } from './lib/prompts/comp.js';
import {
  BRIEF_SYSTEM, QUESTION_PROMPT_VERSION, buildBriefUserMessage,
} from './lib/prompts/questionPrep.js';
import { LETTER_SYSTEM, LETTER_PROMPT_VERSION, buildLetterUserMessage } from './lib/prompts/coverLetter.js';
import { RESUME_SYSTEM, RESUME_PROMPT_VERSION, buildResumeUserMessage } from './lib/prompts/resume.js';
import { ASK_SYSTEM, ASK_PROMPT_VERSION, buildAskUserMessage } from './lib/prompts/ask.js';
import {
  BOOTSTRAP_PROMPT_VERSION,
  MASTER_RESUME_SYSTEM, buildMasterResumeUserMessage,
  PROFILE_SYSTEM, buildProfileUserMessage,
  KB_SYSTEM, buildKbUserMessage,
} from './lib/prompts/bootstrap.js';
import { upgradeStatus, normalizeTrackerStage, statusLabel, normalizeStatus, STATUS_ORDER } from './lib/statuses.js';
import { computeStrengthScore } from './lib/strength.js';
import { ROUND_SYSTEM, ROUND_PROMPT_VERSION, buildRoundUserMessage } from './lib/prompts/interviewRound.js';
import { FOLLOWUP_SYSTEM, FOLLOWUP_PROMPT_VERSION, buildFollowUpUserMessage } from './lib/prompts/followUpEmail.js';
import { fetchJobDetail } from './lib/enrich.js';
import {
  isReachable as ollamaReachable,
  listModels as ollamaListModels,
  getVersion as ollamaGetVersion,
  callOllamaJson, callOllamaText,
} from './lib/ollamaClient.js';

import { matchInbound } from './lib/search.js';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('setPanelBehavior failed:', error));

chrome.runtime.onInstalled.addListener((details) => {
  console.log('Jawbs installed.');
  reinjectContentScripts();
  // First-run onboarding — drop the user straight into the setup wizard
  // (not the marketing welcome page). Only fires on fresh install, not
  // on update / browser_update / shared_module_update.
  if (details?.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome/setup.html') })
      .catch((e) => console.warn('Setup wizard open failed:', e));
  }
});
chrome.runtime.onStartup?.addListener?.(reinjectContentScripts);

// On extension install / update / browser startup, re-inject content scripts
// into every matching tab that's already open. Without this, an extension
// reload leaves existing LinkedIn tabs with orphaned content scripts — they
// still exist in the tab but can't talk to the new service worker, and the
// user has to manually refresh every tab. This is the #1 cause of "sidebar
// doesn't recognize the job" complaints.
async function reinjectContentScripts() {
  const manifest = chrome.runtime.getManifest();
  for (const cs of manifest.content_scripts || []) {
    if (!cs.js?.length) continue;
    let tabs;
    try { tabs = await chrome.tabs.query({ url: cs.matches }); }
    catch { continue; }
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: cs.all_frames ?? false },
          files: cs.js,
        });
      } catch { /* some tabs (chrome://, discarded) aren't scriptable — skip */ }
    }
  }
}

// Send a message to a tab, and if the content script is orphaned/absent,
// inject it and retry once. This is the fallback for tabs that were open
// before the extension reloaded, when the proactive reinject above missed
// them (rare, but possible).
async function sendToTabWithReinject(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    if (!/Could not establish connection|Receiving end does not exist/i.test(e.message || '')) throw e;
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/scrape.js'] });
    } catch (injErr) {
      throw new Error(`Content script inject failed: ${injErr.message}`);
    }
    // Scrape.js has an async import at the top of its IIFE; give it time
    // to finish before the message listener is registered.
    await new Promise((r) => setTimeout(r, 500));
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

// Per-session dedupe for silent auto-enrichment. On search-results URLs the
// content script often falls to a page-container description; we fetch the
// standalone /jobs/view/{id}/ page (which usually has JSON-LD) and quietly
// upgrade the current job when it succeeds.
const autoEnrichedThisSession = new Set();

// ---------- Router ----------

const handlers = {
  'diagnostic': runDiagnostic,
  'ollama-status': runOllamaStatus,
  'get-usage-daily': (msg) => getDailyUsage(msg.days || 14).then((data) => ({ ok: true, data })),
  'get-activity': (msg) => getActivity({ limit: msg.limit }).then((entries) => ({ ok: true, entries })),
  'clear-activity': () => clearActivity().then(() => ({ ok: true })),
  'job-detected': (msg, sender) => handleJobDetected(msg.data, sender?.tab?.id),
  'recall-active': (msg, sender) => handleRecallActive(msg.jobId, sender?.tab?.id),
  'save-clicked': (msg) => handleSaveClicked(msg.data),
  'apply-clicked': (msg) => handleApplyClicked(msg.data),
  'linkedin-status-changed': (msg) => handleLinkedInStatusChanged(msg.jobId, msg.action),
  'auto-analyze-fit': (msg) => handleAutoAnalyzeFit(msg.data),
  'get-current-job': getCurrentJob,
  'get-recent-jobs': getRecentJobs,
  'tracker-list': (msg) => handleTrackerList(msg.jobs, msg.stage, msg.url),
  'get-tracker-state': getTrackerState,
  'backfill': (msg) => handleBackfill(msg.jobs, msg.stage),
  'sync-linkedin': () => runSyncLinkedIn(),
  'sync-linkedin-cancel': async () => { await setSyncCancelled(true); return { ok: true }; },
  'find-on-tracker': (msg) => runFindOnTracker(msg.jobId),
  'reconcile-linkedin': () => runReconcileLinkedIn(),
  'get-reconciliation-diff': getReconciliationDiff,
  'apply-reconciliation': (msg) => applyReconciliation(msg.resolutions),
  'get-last-sync': async () => {
    const r = await chrome.storage.local.get('linkedinSyncLast');
    return { ok: true, data: r.linkedinSyncLast || null };
  },
  'check-jobs-known': (msg) => handleCheckJobsKnown(msg.jobIds),
  'get-listing-decorations': (msg) => getListingDecorations(msg.jobIds),
  'list-jobs': listJobs,
  'get-job': (msg) => getJob(msg.jobId),
  'delete-job': (msg) => deleteJob(msg.jobId),
  'count-jobs': countJobs,
  'count-jobs-by-status': getJobStatusCounts,
  'panel-heartbeat': () => { lastPanelHeartbeatAt = Date.now(); return { ok: true }; },
  'panel-closed': () => { lastPanelHeartbeatAt = 0; return { ok: true }; },
  'is-panel-open': () => ({ ok: true, data: isPanelOpen() }),
  'list-searches': () => getSavedSearches().then((data) => ({ ok: true, data })),
  'save-search': (msg) => addSavedSearch({ name: msg.name, url: msg.url }).then((data) => ({ ok: true, data })),
  'delete-search': (msg) => deleteSavedSearch(msg.id),
  // Recent searches — automatic history reported by the content script
  // when a /jobs/search page loads. The SW dedups + also updates
  // lastRunAt on any saved search that matches the visited URL.
  'search-detected': async (msg) => {
    await addRecentSearch({ url: msg.url, name: msg.name });
    await markSavedSearchRun(msg.url);
    chrome.runtime.sendMessage({ type: 'recent-searches-updated' }).catch(() => {});
    return { ok: true };
  },
  'get-recent-searches': () => getRecentSearchesFiltered().then((data) => ({ ok: true, data })),
  'clear-recent-searches': () => clearRecentSearches().then(() => ({ ok: true })),
  // Called from the "Run" button on a saved search — bumps lastRunAt
  // so the stale-nudge (24h) treats it as fresh again.
  'mark-search-run': async (msg) => {
    await markSavedSearchRun(msg.url);
    return { ok: true };
  },
  'get-negative-keywords': () => getNegativeKeywords().then((data) => ({ ok: true, data })),
  'update-follow-state': (msg) => updateFollowState(msg.profileUrl, msg.following, msg.mode),
  'get-follow-map': () => getFollowMap().then((data) => ({ ok: true, data })),
  'generate-master-resume-field': (msg) => runGenerateMasterResume(msg.resumeText),
  'generate-profile-field': (msg) => runGenerateProfile(msg.masterResume, msg.existingProfile, msg.hints),
  'generate-kb-field': (msg) => runGenerateKb(msg.masterResume, msg.existingProfile, msg.existingKb, msg.hints),
  'save-to-archive': (msg) => handleSaveToArchive(msg.data),
  'check-duplicate': (msg) => handleCheckDuplicate({
    title: msg.title, company: msg.company, excludeJobId: msg.excludeJobId,
  }),
  'update-job-status': (msg) => updateJobStatus(msg.jobId, msg.status, msg.note),
  'add-timeline': (msg) => addTimelineEntry(msg.jobId, msg.entryType, msg.note),
  'analyze-fit': (msg) => instrumentAnalysis('analyze-fit', msg.jobId, () => runFit(msg.jobId)),
  'analyze-comp': (msg) => instrumentAnalysis('analyze-comp', msg.jobId, () => runComp(msg.jobId)),
  'build-brief': (msg) => instrumentAnalysis('build-brief', msg.jobId, () => runBrief(msg.jobId)),
  'generate-letter': (msg) => instrumentAnalysis('generate-letter', msg.jobId, () => runLetter(msg.jobId, msg.tone)),
  'generate-resume': (msg) => instrumentAnalysis('generate-resume', msg.jobId, () => runResume(msg.jobId)),
  'ask-llm': (msg) => instrumentAnalysis('ask-llm', msg.jobId, () => runAsk(msg.jobId, msg.prompt, msg.provider)),
  'get-chats': (msg) => getChats(msg.jobId),
  'enrich-job': (msg) => runEnrich(msg.jobId),
  'save-round': (msg) => handleSaveRound(msg.jobId, msg.round),
  'delete-round': (msg) => handleDeleteRound(msg.jobId, msg.roundId),
  'generate-round-prep': (msg) => runRoundPrep(msg.jobId, msg.roundId),
  'generate-round-followup': (msg) => runRoundFollowUp(msg.jobId, msg.roundId),
  'open-recall': (msg) => handleOpenRecall(msg.jobId, msg.data),
  'inbound-match': (msg) => runInboundMatch(msg.message),
  'export-all': exportAll,
  'import-all': (msg) => importAll(msg.data),
  // Content-script-callable: closes the sender's own tab. Used by the
  // tracker auto-confirm flow so the user returns to the sidepanel of the
  // jawb they were viewing once LinkedIn has processed the Yes click.
  // Safe because it can only close the sender's OWN tab, not arbitrary ones.
  'close-my-tab': async (_msg, sender) => {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number') return { ok: false, error: 'no tab id in sender' };
    try { await chrome.tabs.remove(tabId); return { ok: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  },
  'mark-exported': async () => { await setLastExportAt(new Date().toISOString()); return { ok: true }; },
  'get-last-export': getLastExportAt,
  'get-usage': getUsage,
};

// Handlers that are unsafe for a content-script to invoke — a
// compromised page script on any listed ATS host could otherwise
// wipe data, drive a sync tab, or import a poisoned backup. These
// are restricted to messages originating from an extension page
// (side panel, Recall, Jawboard, Options): `sender.tab` will be
// undefined for those, populated for content scripts.
const EXTENSION_ONLY_HANDLERS = new Set([
  // destructive
  'delete-job', 'delete-search', 'delete-round',
  'clear-activity', 'clear-recent-searches',
  // bulk import/export — poisoned data risk
  'import-all', 'export-all', 'mark-exported',
  // drives a visible LinkedIn tab
  'sync-linkedin', 'sync-linkedin-cancel',
  'find-on-tracker',
  'reconcile-linkedin', 'apply-reconciliation',
  // updates archive schema in bulk
  'backfill',
  // opens tabs / panel
  'open-recall',
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Every message must come from this extension's own context. Cross-
  // extension messages (chrome.runtime.sendMessage from another extension)
  // arrive with a different sender.id and are rejected here.
  if (sender?.id && sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: 'unauthorized sender' });
    return false;
  }

  if (msg?.type === 'open-side-panel') {
    const tabId = sender.tab?.id;
    if (tabId) chrome.sidePanel.open({ tabId }).catch((e) => console.error('sidePanel.open failed:', e));
    sendResponse({ ok: true });
    return false;
  }

  const handler = handlers[msg?.type];
  if (!handler) return false;

  // Destructive/bulk handlers can only be invoked from our own
  // extension pages (Jawboard, Recall, Options, side panel).
  // `sender.tab` presence alone is not a content-script signal —
  // extension pages opened as tabs also populate it. The reliable
  // marker is the sender's URL scheme: content scripts carry the
  // http(s) URL of the page they run on; extension pages carry a
  // chrome-extension:// URL. Side panel messages have neither
  // sender.tab nor sender.url — trust those (the sender.id check
  // above already blocks foreign extensions).
  if (EXTENSION_ONLY_HANDLERS.has(msg.type)) {
    const url = sender?.url || '';
    const isFromContentScript = /^https?:/i.test(url);
    if (isFromContentScript) {
      sendResponse({ ok: false, error: 'handler not callable from content script' });
      return false;
    }
  }

  Promise.resolve()
    .then(() => handler(msg, sender))
    .then((result) => {
      if (result && typeof result === 'object' && 'ok' in result) sendResponse(result);
      else sendResponse({ ok: true, data: result });
    })
    .catch((e) => {
      console.error(`Handler ${msg.type} failed:`, e);
      sendResponse({ ok: false, error: e.message, status: e.status ?? null });
    });
  return true;
});

// ---------- Capture & tracker state ----------

// LinkedIn follow-state cache: profileUrl → { following, mode, updatedAt }.
// Populated opportunistically as the user browses linkedin.com/in/* pages;
// read by Recall / Jawboard people renderers to show a ✓ Following badge.
// Stored in chrome.storage.local under 'peopleFollowing' so it survives
// service-worker recycles.
const FOLLOW_KEY = 'peopleFollowing';

async function getFollowMap() {
  const r = await chrome.storage.local.get(FOLLOW_KEY);
  return r[FOLLOW_KEY] || {};
}

async function updateFollowState(profileUrl, following, mode) {
  if (!profileUrl) return { ok: false, error: 'profileUrl required' };
  const map = await getFollowMap();
  const prev = map[profileUrl] || {};
  map[profileUrl] = {
    following: !!following,
    // Preserve prior mode when the current visit couldn't detect it
    // (popover wasn't open). Only overwrite when we have fresh info.
    mode: mode || prev.mode || null,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [FOLLOW_KEY]: map });
  return { ok: true };
}

// Panel-open detection. The side panel pings 'panel-heartbeat' every 5s
// while its document is alive. isPanelOpen() = "seen a heartbeat within
// the last 15s". Content scripts use is-panel-open to decide whether to
// nudge the user with an open-extension modal.
let lastPanelHeartbeatAt = 0;
function isPanelOpen() {
  return Date.now() - lastPanelHeartbeatAt < 15000;
}

// Session storage is now keyed per-tab so multiple LinkedIn tabs (or tabs on
// different companies' careers pages) each have their own "current job".
// Without this, the last-scraped job wins across every open sidebar.
const CURRENT_JOB_KEY = (tabId) => `currentJob:${tabId}`;

async function handleJobDetected(data, tabId) {
  if (tabId == null) {
    console.warn('[Jawbs] job-detected without tabId — ignoring per-tab store');
    return { ok: true };
  }
  await chrome.storage.session.set({ [CURRENT_JOB_KEY(tabId)]: data });
  // Broadcast includes tabId so sidebars in other windows can filter this out.
  chrome.runtime.sendMessage({ type: 'current-job-updated', tabId, data }).catch(() => {});
  // Add to recent-jobs list (max 5, dedup on jobId, most recent first).
  await addRecentJob(data).catch((e) => console.warn('addRecentJob failed:', e));

  // Auto-enrich existing archive record if there is one, without creating a new one.
  const existing = await getJob(data.jobId);
  if (existing) {
    await upsertJob(data.jobId, { posting: data.posting, url: data.url });
  }

  // Silent background upgrade when the scrape fell back. Standalone
  // /jobs/view/{id}/ pages usually ship JSON-LD even when search-results
  // doesn't. Fetches once per jobId per session; broadcasts a refreshed
  // current-job so the panel notice disappears in place.
  const src = data.posting?.descriptionSource;
  const shouldAutoEnrich = (src === 'container-fallback' || src === 'h1-inferred')
                         && !autoEnrichedThisSession.has(data.jobId);
  if (shouldAutoEnrich) {
    autoEnrichedThisSession.add(data.jobId);
    autoEnrichDescription(data, tabId).catch((e) => console.warn('auto-enrich failed:', e));
  }

  return { ok: true };
}

async function autoEnrichDescription(originalData, tabId) {
  const fetched = await fetchJobDetail(originalData.jobId);
  if (!fetched.ok) return;
  const better = fetched.descriptionText;
  if (!better || better.length < 400) return; // too short to be a real description

  const key = CURRENT_JOB_KEY(tabId);
  const r = await chrome.storage.session.get(key);
  const current = r[key];

  const updatedPosting = {
    ...(current?.posting || originalData.posting || {}),
    title: current?.posting?.title || fetched.title || originalData.posting?.title || null,
    company: current?.posting?.company || fetched.company || originalData.posting?.company || null,
    location: current?.posting?.location || fetched.location || originalData.posting?.location || null,
    postedDate: current?.posting?.postedDate || fetched.postedDate || null,
    postedSalaryRange: current?.posting?.postedSalaryRange || fetched.postedSalaryRange || null,
    descriptionText: better,
    descriptionSource: fetched.descriptionSource || 'jsonld-fetch',
  };

  // If the user is still looking at this job on this tab, broadcast the upgrade.
  if (current && current.jobId === originalData.jobId) {
    const updated = {
      ...current,
      posting: updatedPosting,
      fallbackNoise: false,
      confidence: 'high',
      sources: { ...(current.sources || {}), description: updatedPosting.descriptionSource },
    };
    await chrome.storage.session.set({ [key]: updated });
    chrome.runtime.sendMessage({ type: 'current-job-updated', tabId, data: updated }).catch(() => {});
  }

  // Update the archive record if this job is in the archive.
  const existing = await getJob(originalData.jobId);
  if (existing) {
    await upsertJob(originalData.jobId, { posting: updatedPosting });
  }
}

async function getCurrentJob(msg) {
  const tabId = msg?.tabId;
  if (tabId == null) return { ok: true, data: null };
  const key = CURRENT_JOB_KEY(tabId);
  const r = await chrome.storage.session.get(key);
  return { ok: true, data: r[key] || null };
}

// Tidy up per-tab state when a tab closes so session storage doesn't leak
// across a long browsing session (still bounded by session storage's own
// browser-close lifetime, but this keeps it small in the meantime).
chrome.tabs?.onRemoved?.addListener((tabId) => {
  chrome.storage.session.remove(CURRENT_JOB_KEY(tabId)).catch(() => {});
});

// ---------- Recent jobs (bottom of sidebar) ----------
// Rolling list of the last N jobs the user viewed. Persists across browser
// sessions via chrome.storage.local. Dedup on jobId so revisiting a job
// bumps it back to the top rather than adding a duplicate row.
const RECENT_JOBS_KEY = 'recentJobs';
// Storage cap — how many entries we keep across sessions. Callers
// slice down from this list (footer strip shows 5, Recent tab shows
// 20). Bumping to 20 for the tab; footer still trims to 5 client-side.
const RECENT_JOBS_MAX = 20;

async function addRecentJob(data) {
  if (!data?.jobId) return;
  const now = new Date().toISOString();
  const entry = {
    jobId: data.jobId,
    title: data.posting?.title || null,
    company: data.posting?.company || null,
    url: data.url || `https://www.linkedin.com/jobs/view/${data.jobId}/`,
    viewedAt: now,
  };
  const r = await chrome.storage.local.get(RECENT_JOBS_KEY);
  const existing = Array.isArray(r[RECENT_JOBS_KEY]) ? r[RECENT_JOBS_KEY] : [];
  const filtered = existing.filter((e) => e.jobId !== entry.jobId);
  filtered.unshift(entry);
  const next = filtered.slice(0, RECENT_JOBS_MAX);
  await chrome.storage.local.set({ [RECENT_JOBS_KEY]: next });
  chrome.runtime.sendMessage({ type: 'recent-jobs-updated' }).catch(() => {});
}

// Recall page tells us "this jobId is now front-and-center in this tab" so
// the side panel (which keys its current job by tabId) can render the same
// job the user is reading in full-screen. Without this the side panel on
// the Recall tab shows the empty state — because no LinkedIn scrape happens
// on a chrome-extension:// URL.
async function handleRecallActive(jobId, tabId) {
  if (!jobId || tabId == null) return { ok: true };
  const job = await getJob(jobId);
  if (!job) return { ok: true };
  // Build the same shape the content-script scrape would produce so the
  // side panel's renderJob flows work uniformly.
  const data = {
    jobId: job.jobId,
    url: job.url || `https://www.linkedin.com/jobs/view/${job.jobId}/`,
    posting: job.posting || {},
    warmth: job.warmth || null,
    hiringTeam: job.hiringTeam || [],
    analyses: job.analyses || {},
    status: job.status || null,
    statusUpdatedAt: job.statusUpdatedAt || null,
    tags: job.tags || [],
  };
  await chrome.storage.session.set({ [CURRENT_JOB_KEY(tabId)]: data });
  chrome.runtime.sendMessage({ type: 'current-job-updated', tabId, data }).catch(() => {});
  await addRecentJob(data).catch(() => {});
  return { ok: true };
}

// Breakdown of archive jobs by canonical status, in STATUS_ORDER. Powers the
// per-status list under the Jawboard card in the sidebar's empty state.
async function getJobStatusCounts() {
  const jobs = await listJobs();
  const byStatus = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  // Anything captured since local midnight counts as "today". Uses the
  // local date string on both sides so a 23:59 capture doesn't roll
  // forward the moment the user opens the panel after midnight.
  const today = new Date().toISOString().slice(0, 10);
  let addedToday = 0;
  for (const j of jobs) {
    const s = normalizeStatus(j.status);
    byStatus[s] = (byStatus[s] || 0) + 1;
    if (j.capturedAt && String(j.capturedAt).slice(0, 10) === today) addedToday++;
  }
  return { ok: true, data: { total: jobs.length, byStatus, addedToday } };
}

async function getRecentJobs() {
  const r = await chrome.storage.local.get(RECENT_JOBS_KEY);
  const explicit = Array.isArray(r[RECENT_JOBS_KEY]) ? r[RECENT_JOBS_KEY] : [];
  // Merge explicit views with archive fallback so the strip is useful even
  // before job-detected has fired since install / reload. Explicit views win
  // on dedup (they carry the freshest viewedAt); archive entries fill any
  // remaining slots sorted by updatedAt.
  const seen = new Set(explicit.map((e) => String(e.jobId)));
  const archived = await listJobs();
  const archiveEntries = archived
    .filter((j) => !seen.has(String(j.jobId)))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, RECENT_JOBS_MAX)
    .map((j) => ({
      jobId: j.jobId,
      title: j.posting?.title || null,
      company: j.posting?.company || null,
      url: j.url || `https://www.linkedin.com/jobs/view/${j.jobId}/`,
      viewedAt: j.updatedAt || j.capturedAt || null,
      fitScore: j.analyses?.fit?.result?.fitScore ?? null,
    }));
  // Enrich explicit entries with fitScore from archive so callers can render
  // the "TBD | <score>" indicator without a second roundtrip.
  const byId = new Map(archived.map((j) => [String(j.jobId), j]));
  const enrichedExplicit = explicit.map((e) => {
    const j = byId.get(String(e.jobId));
    return { ...e, fitScore: j?.analyses?.fit?.result?.fitScore ?? null };
  });
  const merged = [...enrichedExplicit, ...archiveEntries].slice(0, RECENT_JOBS_MAX);
  return { ok: true, data: merged };
}

// React to every navigation: if the new URL is NOT featuring a specific job,
// clear the tab's currentJob so the sidebar drops back to its empty state.
// A URL "features a job" when either the path is /jobs/view/{id}/ (dedicated
// job page) or the query has currentJobId=/savedJobId= (split view with a
// selected job). Tracker lists, feed, profile, messaging, other sites — all
// reset. Without this the sidebar keeps rendering a stale job after the user
// has moved on.
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  let featuresJob = false;
  try {
    if (/\/jobs\/view\/\d+/.test(changeInfo.url)) {
      featuresJob = true;
    } else {
      const u = new URL(changeInfo.url);
      if (u.searchParams.get('currentJobId') || u.searchParams.get('savedJobId')) featuresJob = true;
    }
  } catch { /* malformed URL — treat as not featuring a job */ }
  if (!featuresJob) {
    chrome.storage.session.remove(CURRENT_JOB_KEY(tabId)).catch(() => {});
    chrome.runtime.sendMessage({ type: 'current-job-updated', tabId, data: null }).catch(() => {});
  }
});

async function handleTrackerList(jobs, stage, url) {
  const state = { jobs, stage, url, capturedAt: new Date().toISOString() };
  await chrome.storage.session.set({ trackerState: state });
  chrome.runtime.sendMessage({ type: 'tracker-state-updated', data: state }).catch(() => {});

  // Passive backfill — as the user browses LinkedIn's tracker, upgrade
  // any EXISTING archive entries to reflect the stage they now appear
  // in. Deliberately upgrade-only (never demote) and existing-only
  // (don't create new records from a casual visit). Thresh remains the
  // way to bulk-import unseen jobs from every list.
  //
  // Without this, actions taken on LinkedIn's tracker (moving Saved →
  // Applied, marking Archived) silently didn't reach the extension
  // until the user clicked Thresh.
  try {
    await passiveBackfill(jobs, stage);
  } catch (e) {
    console.warn('[Jawbs] passive tracker backfill failed:', e);
  }
  return { ok: true };
}

// Upgrade-only, existing-only status sweep. Runs on every SPA nav
// through LinkedIn's tracker so status changes made outside the
// extension surface in the archive automatically. Never demotes and
// never creates new archive records — that's what Thresh is for.
async function passiveBackfill(jobs, stage) {
  if (!Array.isArray(jobs) || !jobs.length) return;
  const target = normalizeTrackerStage(stage);
  if (target === 'unknown' || !STATUS_ORDER.includes(target)) return;
  const now = new Date().toISOString();
  const ids = jobs.map((j) => String(j.jobId));

  // bulkUpsertJobsWith fetches every candidate record in one shot and
  // calls the callback with (id, existing|null). We only return a
  // record when: (a) existing already lived in the archive, AND
  // (b) upgradeStatus would change its status.
  const records = await bulkUpsertJobsWith(ids, (id, existing) => {
    if (!existing) return null;
    const newStatus = upgradeStatus(existing.status, target);
    if (newStatus === existing.status) return null;
    return mergeJobRecord(id, existing, {
      status: newStatus,
      statusUpdatedAt: now,
    }, {
      appendTimeline: [{
        at: now, type: 'synced',
        note: `Passive tracker sync (${stage}) · ${existing.status || 'new'} → ${newStatus}`,
      }],
    });
  });
  if (records.length) {
    chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
    await logActivity({
      type: 'passive-tracker-sync', ok: true,
      note: `stage=${stage} · ${records.length} status↑`,
    });
  }
}

async function getTrackerState() {
  const r = await chrome.storage.session.get('trackerState');
  return { ok: true, data: r.trackerState || null };
}

async function handleBackfill(jobs, stage) {
  const now = new Date().toISOString();
  // Map LinkedIn's tracker-stage strings ("Saved", "Applied", "Archived",
  // "In Progress", etc.) into our canonical status vocabulary.
  const target = normalizeTrackerStage(stage);

  // Overwrite existing title/company from the fresh sync when the stored value:
  //   - contains LinkedIn metadata (` · `, "ago", "Applied", "Reposted", "Promoted")
  //   - starts with one of our own injected pill labels ("↗ Careers site" etc.)
  //   - (for company) contains the title as a substring (title/company jammed)
  const looksBad = (s) => !s
    || / · |\bago\b|\b(Applied|Reposted|Promoted)\b/.test(s)
    || /^↗\s/.test(s)
    || /^(Sync|Import|Open in Jawbs|Careers site|Fill my LinkedIn)/i.test(s);

  // Index by jobId so the builder callback can look up its own source record.
  const byId = new Map(jobs.map((j) => [j.jobId, j]));
  let created = 0, upgraded = 0;

  // Single bulk-get + single bulk-set for all jobs, instead of ~3 storage
  // reads per job in a loop (the old code was O(N) roundtrips).
  const records = await bulkUpsertJobsWith(jobs.map((j) => j.jobId), (id, existing) => {
    const j = byId.get(id);
    if (!j) return null;
    const newStatus = upgradeStatus(existing?.status, target);
    const statusChanged = existing?.status !== newStatus;
    if (!existing) created++;
    else if (statusChanged) upgraded++;

    const existingTitle = existing?.posting?.title;
    const existingCompany = existing?.posting?.company;
    const companyContainsTitle = existingTitle && existingCompany
      && existingCompany !== existingTitle
      && existingCompany.includes(existingTitle);
    const nextTitle = looksBad(existingTitle) && j.titleGuess ? j.titleGuess : (existingTitle || j.titleGuess || null);
    const nextCompany = (!existingCompany || looksBad(existingCompany) || companyContainsTitle) && j.companyGuess
      ? j.companyGuess
      : (existingCompany || j.companyGuess || null);

    const updates = {
      url: existing?.url || j.url,
      captureSource: existing ? existing.captureSource : 'bulk-import',
      status: newStatus,
      statusUpdatedAt: statusChanged ? now : (existing?.statusUpdatedAt || now),
      posting: { title: nextTitle, company: nextCompany },
      cardText: j.cardText,
      // Hint for the "Find on LinkedIn" row action so it can jump
      // straight to the tracker page the job was last seen on. Only
      // record when the walker actually tagged a page (backwards-
      // compatible with older syncs).
      ...(j.pageIndex ? { linkedInTracker: { stage, page: j.pageIndex, seenAt: now } } : {}),
    };
    const ops = {
      appendTimeline: [{
        at: now, type: 'synced',
        note: statusChanged
          ? `Synced from tracker (${stage}) · ${existing?.status || 'new'} → ${newStatus}`
          : `Synced from tracker (${stage}) · status unchanged`,
      }],
    };
    return mergeJobRecord(id, existing, updates, ops);
  });

  chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  await logActivity({ type: 'sync-tracker', ok: true, note: `stage=${stage} · ${records.length} synced (${created} new, ${upgraded} status↑)` });
  return { ok: true, count: records.length, created, upgraded };
}

// ---------- Full LinkedIn tracker sync ----------
//
// Opens a visible LinkedIn tab, walks each tracker list (Saved → In Progress
// → Applied → Archived) page-by-page, aggregates every visible job, and
// applies UPGRADES ONLY via handleBackfill. Jobs absent from LinkedIn are
// deliberately not touched — silence is a null signal, not a demotion.

// Which LinkedIn tracker stages to walk, in visit order. The `?stage=` param
// is what LinkedIn's jobs-tracker uses; scrape.js's detectTrackerStage reads
// it directly, so what we pass here round-trips through the scrape and into
// handleBackfill's normalizeTrackerStage.
const SYNC_STAGES = [
  { key: 'saved',              label: 'Saved',              url: 'https://www.linkedin.com/jobs-tracker/?stage=saved' },
  { key: 'clicked_apply',      label: 'In Progress',        url: 'https://www.linkedin.com/jobs-tracker/?stage=clicked_apply' },
  { key: 'applied',            label: 'Applied',            url: 'https://www.linkedin.com/jobs-tracker/?stage=applied' },
  { key: 'interview',          label: 'Interviewing',       url: 'https://www.linkedin.com/jobs-tracker/?stage=interview' },
  { key: 'archived',           label: 'Archived',           url: 'https://www.linkedin.com/jobs-tracker/?stage=archived' },
  { key: 'not-moving-forward', label: 'Not Moving Forward', url: 'https://www.linkedin.com/jobs-tracker/?stage=not-moving-forward' },
];

// Simple mutex + cancel flag. Only one sync at a time; user can cancel
// from UI. Backed by `chrome.storage.session` so a service-worker
// recycle mid-sync doesn't leave the mutex stuck to `true` (previously
// module-scoped, which vanished on SW restart and stranded the flag
// in the wrong state).
const SYNC_IN_FLIGHT_KEY = 'syncInFlight';
const SYNC_CANCELLED_KEY = 'syncCancelled';
async function isSyncInFlight() {
  const r = await chrome.storage.session.get(SYNC_IN_FLIGHT_KEY);
  return !!r[SYNC_IN_FLIGHT_KEY];
}
async function setSyncInFlight(v) {
  await chrome.storage.session.set({ [SYNC_IN_FLIGHT_KEY]: !!v });
}
async function isSyncCancelled() {
  const r = await chrome.storage.session.get(SYNC_CANCELLED_KEY);
  return !!r[SYNC_CANCELLED_KEY];
}
async function setSyncCancelled(v) {
  await chrome.storage.session.set({ [SYNC_CANCELLED_KEY]: !!v });
}

// Walk a single tracker stage. The content-script walker now owns
// pagination entirely — it clicks LinkedIn's Next button
// ([data-testid="pagination-controls-next-button-visible"]) until
// there's no more Next. SW just navigates to the stage URL once and
// forwards the diagnostic to the SW console (visible via
// chrome://extensions → Inspect service worker).
//
// Returns { jobs, stageCounts } — stageCounts is LinkedIn's own
// per-stage tab-bar count snapshot, used by the caller to audit
// whether the walker captured everything LinkedIn claims exists.
async function walkStagePaginated(tabId, stageUrl, broadcast) {
  let jobs = [];
  let stageCounts = {};
  try {
    const r = await sendToTabWithReinject(tabId, {
      type: 'walk-tracker-full',
      maxIters: 60, waitMs: 8000,
    });
    if (r?.ok && Array.isArray(r.jobs)) jobs = r.jobs;
    if (r?.stageCounts && typeof r.stageCounts === 'object') stageCounts = r.stageCounts;
    if (r?.diagnostic?.length) {
      console.groupCollapsed(`[walkStagePaginated] ${stageUrl} · ${jobs.length} jobs · counts:`, stageCounts);
      for (const line of r.diagnostic) console.log(line);
      console.groupEnd();
    }
  } catch (e) {
    console.warn(`[walkStagePaginated] walk failed for ${stageUrl}:`, e.message);
    throw e;
  }
  if (broadcast) broadcast({ page: 1, added: jobs.length, total: jobs.length });
  return { jobs, stageCounts };
}

function broadcastSyncProgress(payload) {
  chrome.runtime.sendMessage({ type: 'sync-linkedin-progress', ...payload }).catch(() => {});
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Resolves when the given tab reaches status='complete', or rejects on timeout.
function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdate);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);
    function onUpdate(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdate);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

// Map an internal status code to the SYNC_STAGES entry whose LinkedIn
// tracker URL houses jobs in that state. Returns null for statuses
// that don't correspond to any tracker stage (e.g. `analyzed`, an
// internal-only fallback for jobs never touched in LinkedIn).
function stageForStatus(status) {
  switch (normalizeStatus(status)) {
    case 'saved':                  return SYNC_STAGES.find((s) => s.key === 'saved');
    case 'inProgressDraft':
    case 'inProgressClickedApply': return SYNC_STAGES.find((s) => s.key === 'clicked_apply');
    case 'applied':                return SYNC_STAGES.find((s) => s.key === 'applied');
    case 'interviewing':           return SYNC_STAGES.find((s) => s.key === 'interview');
    case 'archived':               return SYNC_STAGES.find((s) => s.key === 'archived');
    case 'notMovingForward':       return SYNC_STAGES.find((s) => s.key === 'not-moving-forward');
    default:                       return null;
  }
}

// Open the correct LinkedIn tracker stage, then have the content
// script walk to the target row and flash a highlight. Called by
// the "Find on LinkedIn" Jawboard row action. The stored
// linkedInTracker.page is passed as a hint so common lookups jump
// straight to the last-known page instead of walking from page 1.
async function runFindOnTracker(jobId) {
  if (!jobId) return { ok: false, error: 'Missing jobId' };
  const job = await getJob(jobId);
  if (!job) return { ok: false, error: 'Job not found in Jawboard' };
  const stage = stageForStatus(job.status);
  if (!stage) {
    return { ok: false, error: `Status "${job.status || 'unknown'}" isn't tracked on LinkedIn — nothing to find.` };
  }
  // If the last sync recorded a page hint on the same stage, forward
  // it. If the stage doesn't match (job moved between stages since
  // sync), drop the hint — walker will start from page 1.
  let hintPage = 0;
  if (job.linkedInTracker?.stage === stage.key && Number(job.linkedInTracker.page) > 0) {
    hintPage = Number(job.linkedInTracker.page);
  }

  const tab = await chrome.tabs.create({ url: stage.url, active: true });
  const tabId = tab.id;
  await waitForTabComplete(tabId);
  // LinkedIn's SPA needs a moment after 'complete' to hydrate the list.
  await sleep(2000);

  let result;
  try {
    result = await sendToTabWithReinject(tabId, {
      type: 'find-tracker-row',
      jobId: String(jobId),
      hintPage,
    });
  } catch (e) {
    return { ok: false, error: `Find failed: ${e.message}` };
  }
  if (!result?.ok) return { ok: false, error: result?.error || 'Find failed' };
  if (!result.found) {
    return {
      ok: true,
      found: false,
      stage: stage.key, stageLabel: stage.label,
      pagesScanned: result.pagesScanned,
      note: `Walked ${result.pagesScanned} page(s) of ${stage.label} without finding this job. It may have moved to a different stage.`,
    };
  }
  return {
    ok: true,
    found: true,
    stage: stage.key, stageLabel: stage.label,
    page: result.page,
    viaHint: !!result.viaHint,
  };
}

async function runSyncLinkedIn() {
  if (await isSyncInFlight()) return { ok: false, error: 'A sync is already in progress.' };
  await setSyncInFlight(true);
  await setSyncCancelled(false);

  const totalStages = SYNC_STAGES.length;
  const summary = {};
  let tab;

  broadcastSyncProgress({ phase: 'starting', totalStages });

  try {
    // Open a visible tab so the user can watch — matches the "transparent,
    // indistinguishable from a human clicking through pages" design goal.
    tab = await chrome.tabs.create({ url: SYNC_STAGES[0].url, active: true });
    const tabId = tab.id;
    await waitForTabComplete(tabId);
    // LinkedIn's SPA needs a moment after 'complete' to hydrate the tracker list.
    await sleep(2000);

    for (let i = 0; i < SYNC_STAGES.length; i++) {
      if (await isSyncCancelled()) throw new Error('Cancelled');
      const s = SYNC_STAGES[i];
      const stageIdx = i + 1;

      // Navigate — skip on the first iteration since we opened at that URL.
      if (i > 0) {
        broadcastSyncProgress({ phase: 'navigating', stageKey: s.key, stageLabel: s.label, stageIdx, totalStages });
        await chrome.tabs.update(tabId, { url: s.url });
        await waitForTabComplete(tabId);
        await sleep(2000);
      }

      broadcastSyncProgress({ phase: 'walking', stageKey: s.key, stageLabel: s.label, stageIdx, totalStages });

      let jobs = [];
      let stageCounts = {};
      try {
        const walked = await walkStagePaginated(tabId, s.url, (p) => {
          broadcastSyncProgress({
            phase: 'walking', stageKey: s.key, stageLabel: s.label, stageIdx, totalStages,
            page: p.page, walked: p.total,
          });
        });
        jobs = walked.jobs;
        stageCounts = walked.stageCounts;
      } catch (e) {
        console.warn(`[sync-linkedin] walk failed for ${s.key}:`, e.message);
        summary[s.key] = { walked: 0, created: 0, upgraded: 0, error: e.message };
        broadcastSyncProgress({ phase: 'stage-done', stageKey: s.key, stageLabel: s.label, stageIdx, totalStages, walked: 0, error: e.message });
        continue;
      }

      // Audit — LinkedIn's tab bar tells us how many jobs are in
      // this stage. If our walker returned fewer, we missed some
      // (pagination didn't finish, load skeleton scraped, etc.);
      // if we returned more, LinkedIn's count is stale (LinkedIn
      // doesn't update instantly). Log either way so the sync
      // console shows the truth.
      const linkedInCount = stageCounts[s.key];
      let auditNote = null;
      if (typeof linkedInCount === 'number' && linkedInCount !== jobs.length) {
        auditNote = `walked ${jobs.length} but LinkedIn shows ${linkedInCount} (diff ${jobs.length - linkedInCount})`;
        console.warn(`[sync-linkedin] ${s.key}: ${auditNote}`);
      }

      // Apply upgrades only — handleBackfill uses upgradeStatus which never
      // regresses status and now respects terminal states (archived, notMovingForward).
      let bf = { count: 0, created: 0, upgraded: 0 };
      if (jobs.length) bf = await handleBackfill(jobs, s.key);
      summary[s.key] = {
        walked: jobs.length, created: bf.created, upgraded: bf.upgraded,
        linkedInCount: linkedInCount ?? null,
        auditNote,
      };

      broadcastSyncProgress({
        phase: 'stage-done', stageKey: s.key, stageLabel: s.label, stageIdx, totalStages,
        walked: jobs.length, created: bf.created, upgraded: bf.upgraded,
        linkedInCount, auditNote,
      });
    }
  } catch (e) {
    await logActivity({ type: 'sync-linkedin', ok: false, error: e.message });
    broadcastSyncProgress({ phase: 'error', error: e.message, summary });
    return { ok: false, error: e.message, summary };
  } finally {
    if (tab?.id != null) chrome.tabs.remove(tab.id).catch(() => {});
    await setSyncInFlight(false);
  }

  const totalWalked = Object.values(summary).reduce((a, s) => a + (s.walked || 0), 0);
  const totalCreated = Object.values(summary).reduce((a, s) => a + (s.created || 0), 0);
  const totalUpgraded = Object.values(summary).reduce((a, s) => a + (s.upgraded || 0), 0);
  const completedAt = new Date().toISOString();
  // Persist so the sidebar can show "Last synced X ago · N walked · N new"
  // next to the Sync-now button without needing to run another sync.
  await chrome.storage.local.set({
    linkedinSyncLast: { at: completedAt, totalWalked, totalCreated, totalUpgraded, summary },
  });
  await logActivity({
    type: 'sync-linkedin', ok: true,
    note: `${totalStages} lists · ${totalWalked} walked · ${totalCreated} new · ${totalUpgraded} status↑`,
  });
  broadcastSyncProgress({ phase: 'complete', summary, totalWalked, totalCreated, totalUpgraded, at: completedAt });
  return { ok: true, summary, totalWalked, totalCreated, totalUpgraded, at: completedAt };
}

// Reconcile — full sync + diff.
//
// Walks every LinkedIn tracker stage (same walker Thresh uses), then
// builds a delta between what LinkedIn reports and what the extension
// has stored. Non-destructive: returns the diff for user review rather
// than applying changes. The paired `apply-reconciliation` handler is
// what actually writes.
//
// Diff shape:
//   {
//     linkedInStages: { <stage>: [<jobId>...], ... },  // raw walk result
//     missingOnLinkedIn: [                             // in archive, no LinkedIn presence
//       { jobId, title, company, currentStatus }, ...
//     ],
//     statusMismatches: [                              // present on LinkedIn but at different status
//       { jobId, title, company, currentStatus, linkedInStatus, linkedInStage }, ...
//     ],
//   }
async function runReconcileLinkedIn() {
  if (await isSyncInFlight()) return { ok: false, error: 'A sync is already in progress.' };
  await setSyncInFlight(true);
  await setSyncCancelled(false);

  const totalStages = SYNC_STAGES.length;
  const seenByJobId = new Map(); // jobId → { stage, walkedInfo }
  const reconcileLinkedInCounts = {}; // stage key → LinkedIn's tab-bar count
  const stageAudit = {};              // stage key → { walked, linkedInCount, delta }
  let tab;

  broadcastSyncProgress({ phase: 'starting', totalStages, mode: 'reconcile' });

  try {
    tab = await chrome.tabs.create({ url: SYNC_STAGES[0].url, active: true });
    const tabId = tab.id;
    await waitForTabComplete(tabId);
    await sleep(2000);

    for (let i = 0; i < SYNC_STAGES.length; i++) {
      if (await isSyncCancelled()) throw new Error('Cancelled');
      const s = SYNC_STAGES[i];
      const stageIdx = i + 1;
      if (i > 0) {
        broadcastSyncProgress({ phase: 'navigating', stageKey: s.key, stageLabel: s.label, stageIdx, totalStages, mode: 'reconcile' });
        await chrome.tabs.update(tabId, { url: s.url });
        await waitForTabComplete(tabId);
        await sleep(2000);
      }
      broadcastSyncProgress({ phase: 'walking', stageKey: s.key, stageLabel: s.label, stageIdx, totalStages, mode: 'reconcile' });
      let jobs = [];
      let stageCounts = {};
      try {
        const walked = await walkStagePaginated(tabId, s.url, (p) => {
          broadcastSyncProgress({
            phase: 'walking', stageKey: s.key, stageLabel: s.label, stageIdx, totalStages,
            page: p.page, walked: p.total, mode: 'reconcile',
          });
        });
        jobs = walked.jobs;
        stageCounts = walked.stageCounts;
      } catch (e) {
        console.warn(`[reconcile] walk failed for ${s.key}:`, e.message);
        broadcastSyncProgress({ phase: 'stage-done', stageKey: s.key, stageLabel: s.label, stageIdx, totalStages, walked: 0, error: e.message, mode: 'reconcile' });
        continue;
      }
      // Merge LinkedIn's own tab-bar counts into the audit map.
      // Every stage page shows the full tab bar, so any walk gives
      // us the counts for every stage — later walks override earlier
      // (freshest wins) and any missing key just means LinkedIn's
      // tab wasn't populated for that stage.
      Object.assign(reconcileLinkedInCounts, stageCounts);

      // Per-stage audit — walker returned X, LinkedIn said Y. Always
      // record an entry, even when LinkedIn's count couldn't be
      // scraped (linkedInCount == null) — otherwise stages like Saved
      // and In Progress silently disappear from the audit table when
      // the tab-bar scrape misses them, hiding the fact that we
      // actually walked those stages.
      const linkedInCount = stageCounts[s.key];
      if (typeof linkedInCount === 'number') {
        const delta = jobs.length - linkedInCount;
        if (delta !== 0) console.warn(`[reconcile] ${s.key}: walked ${jobs.length} but LinkedIn shows ${linkedInCount}`);
        stageAudit[s.key] = { walked: jobs.length, linkedInCount, delta };
      } else {
        stageAudit[s.key] = { walked: jobs.length, linkedInCount: null, delta: null };
      }

      // Later stages override earlier ones — a job in both Applied
      // and Interviewing on LinkedIn should be treated as Interviewing.
      // SYNC_STAGES is ordered saved → in-progress → applied →
      // interviewing → archived → not-moving-forward, which matches
      // this priority.
      for (const j of jobs) {
        seenByJobId.set(String(j.jobId), { stage: s.key, walked: j });
      }
      broadcastSyncProgress({ phase: 'stage-done', stageKey: s.key, stageLabel: s.label, stageIdx, totalStages, walked: jobs.length, mode: 'reconcile', linkedInCount });
    }
  } catch (e) {
    await logActivity({ type: 'reconcile-linkedin', ok: false, error: e.message });
    broadcastSyncProgress({ phase: 'error', error: e.message, mode: 'reconcile' });
    return { ok: false, error: e.message };
  } finally {
    if (tab?.id != null) chrome.tabs.remove(tab.id).catch(() => {});
    await setSyncInFlight(false);
  }

  // Build the diff. Only compare against LinkedIn-source archive
  // records — Google Jobs captures shouldn't drift-check against a
  // LinkedIn walk.
  const jobs = await listJobs();
  const missing = [];
  const mismatches = [];
  const linkedInStages = {};
  for (const [id, v] of seenByJobId) {
    (linkedInStages[v.stage] ||= []).push(id);
  }
  for (const j of jobs) {
    if ((j.source || 'linkedin') !== 'linkedin') continue;
    const seen = seenByJobId.get(String(j.jobId));
    const currentStatus = normalizeStatus(j.status);
    // Terminal states are user-owned; don't flag them as drift.
    // notMovingForward and archived stay put whether or not LinkedIn
    // still lists the record — the user has made their call.
    const isTerminal = currentStatus === 'archived' || currentStatus === 'notMovingForward';
    if (!seen) {
      // In archive, absent from every LinkedIn list.
      if (!isTerminal) {
        missing.push({
          jobId: j.jobId,
          title: j.posting?.title || null,
          company: j.posting?.company || null,
          currentStatus,
          capturedAt: j.capturedAt || null,
        });
      }
      continue;
    }
    const linkedInStatus = normalizeTrackerStage(seen.stage);
    if (linkedInStatus !== currentStatus) {
      mismatches.push({
        jobId: j.jobId,
        title: j.posting?.title || null,
        company: j.posting?.company || null,
        currentStatus,
        linkedInStatus,
        linkedInStage: seen.stage,
      });
    }
  }

  const diff = {
    at: new Date().toISOString(),
    linkedInStages,
    missingOnLinkedIn: missing,
    statusMismatches: mismatches,
    totalArchive: jobs.filter((j) => (j.source || 'linkedin') === 'linkedin').length,
    totalLinkedIn: seenByJobId.size,
    // Ground-truth counts from LinkedIn's tab bar + per-stage audit
    // (walked vs LinkedIn count). Anything with a non-zero delta means
    // the walker didn't capture what LinkedIn claims exists — surface
    // in the UI so the user knows to re-run or investigate.
    linkedInStageCounts: reconcileLinkedInCounts,
    stageAudit,
  };
  // Persist so the UI can pick up the last diff without re-running.
  await chrome.storage.session.set({ reconciliationDiff: diff });
  await logActivity({
    type: 'reconcile-linkedin', ok: true,
    note: `LinkedIn: ${diff.totalLinkedIn} · archive: ${diff.totalArchive} · missing: ${missing.length} · mismatch: ${mismatches.length}`,
  });
  broadcastSyncProgress({ phase: 'complete', mode: 'reconcile', diff });
  return { ok: true, diff };
}

// Apply user-approved resolutions from the Reconcile UI. Each item is
// { jobId, resolution } where resolution is:
//   'accept-linkedin' — take LinkedIn's status (for mismatches) or
//                       mark as notMovingForward (for missing).
//   'keep-local'      — no change; log timeline entry noting drift accepted.
//   'delete'          — delete the archive record (missing-only).
//   'skip'            — no action at all.
async function applyReconciliation(resolutions) {
  if (!Array.isArray(resolutions)) return { ok: false, error: 'resolutions array required' };
  const r = await chrome.storage.session.get('reconciliationDiff');
  const diff = r.reconciliationDiff;
  if (!diff) return { ok: false, error: 'no reconciliation diff cached — run reconcile first' };
  const missingById = new Map((diff.missingOnLinkedIn || []).map((m) => [String(m.jobId), m]));
  const mismatchById = new Map((diff.statusMismatches || []).map((m) => [String(m.jobId), m]));
  const now = new Date().toISOString();
  let applied = 0, deleted = 0, skipped = 0;

  for (const { jobId, resolution } of resolutions) {
    const id = String(jobId);
    const existing = await getJob(id);
    if (!existing) { skipped++; continue; }
    const missing = missingById.get(id);
    const mismatch = mismatchById.get(id);
    if (resolution === 'skip' || (!missing && !mismatch)) { skipped++; continue; }

    if (resolution === 'delete' && missing) {
      await deleteJob(id);
      deleted++;
      await logActivity({ type: 'reconcile-apply', jobId: id, ok: true, note: 'deleted (missing on LinkedIn)' });
      continue;
    }

    let patch;
    if (resolution === 'accept-linkedin') {
      if (mismatch) {
        // Direct status write — user intent overrides upgrade-only.
        patch = {
          status: mismatch.linkedInStatus,
          statusUpdatedAt: now,
          timeline: [
            ...(existing.timeline || []),
            { at: now, type: 'reconcile', note: `Accepted LinkedIn: ${existing.status || 'analyzed'} → ${mismatch.linkedInStatus}` },
          ],
        };
      } else if (missing) {
        // "Accept" for a missing record = "LinkedIn no longer tracks
        // this" → set to notMovingForward (soft-archive).
        patch = {
          status: 'notMovingForward',
          statusUpdatedAt: now,
          timeline: [
            ...(existing.timeline || []),
            { at: now, type: 'reconcile', note: 'Accepted LinkedIn: no longer on any list → notMovingForward' },
          ],
        };
      }
    } else if (resolution === 'keep-local') {
      // No status change — audit trail only.
      const note = mismatch
        ? `Kept local (${existing.status}), LinkedIn shows ${mismatch.linkedInStatus}`
        : `Kept local (${existing.status}), missing from LinkedIn`;
      patch = { timeline: [...(existing.timeline || []), { at: now, type: 'reconcile', note }] };
    }

    if (patch) {
      await upsertJob(id, patch);
      applied++;
    } else {
      skipped++;
    }
  }
  chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  await logActivity({
    type: 'reconcile-apply', ok: true,
    note: `applied ${applied} · deleted ${deleted} · skipped ${skipped}`,
  });
  return { ok: true, applied, deleted, skipped };
}

async function getReconciliationDiff() {
  const r = await chrome.storage.session.get('reconciliationDiff');
  return { ok: true, data: r.reconciliationDiff || null };
}

// Batch decoration lookup for the on-page badge injector in scrape.js.
// Given a list of visible jobIds on a LinkedIn listing surface,
// returns { jobId → { status, fitScore, compLow, compHigh, strengthScore,
// strengthTier, strengthTierLabel } } for the jobs we already have in
// Jawboard. Unknown jobs are omitted. Single storage roundtrip for the
// job records; comp targets and follow map are loaded once and reused
// across the whole batch so strength scoring stays cheap.
// Squash the posting's comp range (top-of-range preferred, low as
// fallback) into a 0-100 score against the user's target — same logic
// the Jawbar uses so LinkedIn-card gauges and the sidepanel agree. If
// there's no target, fall back to the LLM's vsTarget verdict; if only
// a floor is set, anchor "matches floor exactly" at 60/100.
function computeCompGaugeScore(comp, compTargets) {
  const salary = comp?.salary;
  const low  = salary?.base?.low  ?? comp?.marketEstimate?.baseLow  ?? null;
  const high = salary?.base?.high ?? comp?.marketEstimate?.baseHigh ?? null;
  const target = Number(compTargets?.target) || null;
  const floor  = Number(compTargets?.floor)  || null;
  const vsTarget = salary?.vsTargets?.vsTarget || comp?.vsTargets?.vsTarget;
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

async function getListingDecorations(jobIds) {
  if (!Array.isArray(jobIds) || !jobIds.length) return { ok: true, decorations: {} };
  const [records, compTargets, followMap] = await Promise.all([
    bulkGetJobsByIds(jobIds),
    getCompTargets(),
    getFollowMap(),
  ]);
  const decorations = {};
  for (const [id, job] of Object.entries(records)) {
    const fit = job.analyses?.fit?.result;
    const comp = job.analyses?.comp?.result;
    const strength = computeStrengthScore(job, { compTargets, followMap });
    decorations[id] = {
      status: job.status || null,
      statusLabel: job.status ? statusLabel(job.status) : null,
      fitScore: typeof fit?.fitScore === 'number' ? fit.fitScore : null,
      compLow:  comp?.salary?.base?.low  ?? comp?.marketEstimate?.baseLow  ?? null,
      compHigh: comp?.salary?.base?.high ?? comp?.marketEstimate?.baseHigh ?? null,
      compScore: computeCompGaugeScore(comp, compTargets),
      strengthScore: strength.score,
      strengthTier: strength.tier,
      strengthTierLabel: strength.tierLabel,
      strengthTierImage: strength.tierImage,
      // Connections normalized to 0-100 so the on-page mini-gauge in
      // scrape.js can render it with the same weak/fair/strong palette
      // as fit and comp. Raw component tops out at 20 (the network
      // weight); we scale up so the trio reads consistently.
      connectionsScore: strength.breakdown?.connections
        ? Math.round((strength.breakdown.connections.score / strength.breakdown.connections.max) * 100)
        : null,
    };
  }
  return { ok: true, decorations };
}

async function handleCheckJobsKnown(jobIds) {
  if (!Array.isArray(jobIds) || !jobIds.length) {
    return { ok: true, knownCount: 0, unknownCount: 0, unknownIds: [] };
  }
  const r = await chrome.storage.local.get('jobs.index');
  const known = new Set(r['jobs.index'] || []);
  const unknownIds = jobIds.filter((id) => !known.has(String(id)));
  return {
    ok: true,
    knownCount: jobIds.length - unknownIds.length,
    unknownCount: unknownIds.length,
    unknownIds,
  };
}

async function handleSaveClicked(data) {
  const now = new Date().toISOString();
  const existing = await getJob(data.jobId);
  const newStatus = upgradeStatus(existing?.status, 'saved');
  const statusChanged = existing?.status !== newStatus;
  await logActivity({ type: 'linkedin-save', jobId: data.jobId, ok: true, note: `${existing?.status || 'new'} → ${newStatus}` });
  const record = await upsertJob(data.jobId, {
    url: data.url,
    posting: data.posting,
    captureSource: existing ? existing.captureSource : 'save-click',
    status: newStatus,
    statusUpdatedAt: statusChanged ? now : existing?.statusUpdatedAt,
    timeline: [
      ...(existing?.timeline || []),
      { at: now, type: 'saved', note: statusChanged
        ? `LinkedIn Save clicked (${existing?.status || 'new'} → saved)`
        : 'LinkedIn Save clicked (status unchanged — already advanced)' },
    ],
  });
  chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  return { ok: true, record };
}

async function handleApplyClicked(data) {
  const now = new Date().toISOString();
  const existing = await getJob(data.jobId);
  const newStatus = upgradeStatus(existing?.status, 'applied');
  const statusChanged = existing?.status !== newStatus;
  await logActivity({ type: 'linkedin-apply', jobId: data.jobId, ok: true, note: `${existing?.status || 'new'} → ${newStatus}` });
  const record = await upsertJob(data.jobId, {
    url: data.url,
    posting: data.posting,
    captureSource: existing?.captureSource || 'apply-click',
    status: newStatus,
    statusUpdatedAt: statusChanged ? now : existing?.statusUpdatedAt,
    timeline: [
      ...(existing?.timeline || []),
      { at: now, type: 'applied', note: statusChanged
        ? `LinkedIn Apply clicked (${existing?.status || 'new'} → applied)`
        : 'LinkedIn Apply clicked (status unchanged)' },
    ],
  });
  chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  return { ok: true, record };
}

// Real-time on-device signal that the user changed a job's LinkedIn
// state (unsaved it, moved it to Not Moving Forward, etc.) from the
// job detail page. Adds a timeline entry every time so drift is
// auditable. For explicit terminal actions ('not-moving-forward',
// 'archived') we DO apply the status directly, bypassing the upgrade-
// only guard — this is user intent, not silent sync. Unsave logs but
// doesn't touch status; the Reconcile flow surfaces it for review.
async function handleLinkedInStatusChanged(jobId, action) {
  if (!jobId) return { ok: false, error: 'jobId required' };
  const existing = await getJob(jobId);
  if (!existing) return { ok: true, skipped: 'not-in-archive' };
  const now = new Date().toISOString();
  const noteMap = {
    'unsave': 'Unsaved on LinkedIn (status unchanged — reconcile to resolve)',
    'not-moving-forward': 'Moved to Not Moving Forward on LinkedIn',
    'archived': 'Archived on LinkedIn',
  };
  const timelineNote = noteMap[action] || `LinkedIn state changed: ${action}`;
  const patch = {
    timeline: [
      ...(existing.timeline || []),
      { at: now, type: 'linkedin-status', note: timelineNote },
    ],
  };
  // Explicit terminal transitions replace status directly; the
  // upgrade-only guard doesn't apply here because this is user intent
  // captured on-device, not passive sync noise.
  if (action === 'not-moving-forward') {
    patch.status = 'notMovingForward';
    patch.statusUpdatedAt = now;
  } else if (action === 'archived') {
    patch.status = 'archived';
    patch.statusUpdatedAt = now;
  }
  const record = await upsertJob(jobId, patch);
  await logActivity({ type: 'linkedin-status', jobId, ok: true, note: `${action}` });
  chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  return { ok: true, record };
}

async function handleAutoAnalyzeFit(data) {
  const enabled = await getAutoAnalyzeEnabled();
  if (!enabled) return { ok: true, skipped: 'disabled' };

  const existing = await getJob(data.jobId);
  if (existing?.analyses?.fit) return { ok: true, skipped: 'already-analyzed' };

  const now = new Date().toISOString();
  await upsertJob(data.jobId, {
    url: data.url,
    posting: data.posting,
    captureSource: existing?.captureSource || 'auto-linkedin-match',
    timeline: [
      ...(existing?.timeline || []),
      { at: now, type: 'auto-triggered', note: 'LinkedIn flagged posting as a high match' },
    ],
  });

  try {
    const result = await runFit(data.jobId);
    chrome.runtime.sendMessage({
      type: 'auto-analysis-complete',
      jobId: data.jobId,
      feature: 'fit',
    }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
    return { ok: true, analyzed: true, record: result?.record };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Fields we let a save-to-archive caller pass through to upsertJob.
// Anything else on `data` is ignored — this doubles as a light-touch
// input validator and stops random new fields from silently landing
// in the archive.
const SAVE_TO_ARCHIVE_FIELDS = [
  'url', 'posting', 'userNotes', 'tags', 'status',
  'offerDetails', 'interviewRounds',
  'warmth', 'hiringTeam',
  'source', 'via', 'applyLinks', 'googleSearchUrl',
];
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

async function handleSaveToArchive(data) {
  const patch = pick(data, SAVE_TO_ARCHIVE_FIELDS);
  patch.captureSource = data.captureSource || 'manual';
  const record = await upsertJob(data.jobId, patch);
  return { ok: true, record };
}

// Duplicate check — Google Jobs aggregates LinkedIn + other boards, so
// the same role often appears in both. Called from the Google Jobs
// content script before a Bait to surface a themed confirmation.
async function handleCheckDuplicate({ title, company, excludeJobId }) {
  const match = await findProbableDuplicate({ title, company, excludeJobId });
  return { ok: true, data: { match } };
}

// ---------- Analysis runners ----------

// ---------- Analysis instrumentation ----------
//
// Wraps every analysis runner with activity-log entries and a
// usage-updated broadcast so the sidebar strip refreshes live.

async function instrumentAnalysis(action, jobId, fn) {
  const started = performance.now();
  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - started);
    const rec = result?.record || {};
    await logActivity({
      type: action, jobId,
      ok: true,
      model: rec.model || null,
      provider: rec.provider || 'cloud',
      inputTokens: rec.usage?.input_tokens || 0,
      outputTokens: rec.usage?.output_tokens || 0,
      fellback: !!rec.fellback,
      durationMs,
    });
    chrome.runtime.sendMessage({ type: 'usage-updated' }).catch(() => {});
    return result;
  } catch (e) {
    await logActivity({
      type: action, jobId,
      ok: false,
      error: e.message,
      durationMs: Math.round(performance.now() - started),
    });
    throw e;
  }
}

// ---------- Provider routing (local vs cloud) ----------
//
// Each feature can opt into local (Ollama) execution via Settings. When
// enabled, we try local first, fall back to cloud on failure. Cloud is the
// default. Returns { result, usage, model, retried, provider, fellback }.

async function routeCall(feature, { local, cloud, forceProvider }) {
  const localSettings = await getLocalModelSettings();
  // forceProvider (from the sidebar Ask box) overrides the routing table.
  // 'local' → try local, no fallback; 'cloud' → skip local entirely;
  // 'auto' / undefined → use the per-feature routing setting.
  let useLocal;
  if (forceProvider === 'local') useLocal = true;
  else if (forceProvider === 'cloud') useLocal = false;
  else useLocal = localSettings.enabled && localSettings.features[feature];
  const noFallback = forceProvider === 'local';
  let fellback = false;
  let fallbackReason = null;

  if (useLocal) {
    try {
      if (!(await ollamaReachable(1500))) throw new Error('Ollama not reachable at localhost:11434');
      const r = await local(localSettings.model);
      return { ...r, provider: 'local', fellback, localModel: localSettings.model };
    } catch (e) {
      if (noFallback) throw e;
      fellback = true;
      fallbackReason = e.message;
      // Emit a dedicated activity entry so the reason is visible in the log,
      // not just buried in a "fellback: true" flag on the outer analysis record.
      await logActivity({
        type: `local-fallback:${feature}`,
        ok: false,
        error: e.message,
        model: localSettings.model,
        note: 'Local call failed; using cloud instead',
      });
      console.warn(`[Jawbs] Local ${feature} failed, falling back to cloud:`, e.message);
    }
  }

  const r = await cloud();
  return { ...r, provider: 'cloud', fellback, fallbackReason };
}

async function loadContext(jobId) {
  // getContextSettings() is cached across analyses and auto-invalidates when
  // the user saves settings — so the second-and-onward analyses do only 1
  // storage read (the job itself), not 10.
  // API key required only for cloud calls — checked inside those callers so a
  // local-only routing setup can run key-less.
  const [ctx, job] = await Promise.all([getContextSettings(), getJob(jobId)]);
  if (!job) throw new Error(`Job ${jobId} not in Jawboard. Save it first.`);
  // Extended knowledge base is prepended to the profile so every prompt sees
  // it. Profile stays first-class (short summary), KB is deeper context.
  const enrichedProfile = ctx.knowledgeBase
    ? `${ctx.profile}\n\n----- EXTENDED KNOWLEDGE BASE -----\n\n${ctx.knowledgeBase}`
    : ctx.profile;
  return { ...ctx, profile: enrichedProfile, job };
}

// Best-effort: find ANY LinkedIn tab currently viewing this jobId (whether
// via /jobs/view/, /jobs/search/?currentJobId=, or /jobs/collections/…), ask
// its content script to walk the "People you can reach out to" modal, and
// store the resulting warmth (named contacts + tier). Never throws — a
// failure just means the fit prompt sees whatever preview-tier data the
// original scrape captured. Each attempt logs an activity entry so it's
// visible in Options → Activity log why enrichment did or didn't happen.
async function enrichWarmthOnDemand(jobId) {
  try {
    // Match any LinkedIn tab. Includes /jobs/view/{id}/, but also
    // /jobs/search/?currentJobId={id}, /jobs/collections/?currentJobId={id},
    // and any other surface where the jobId appears as a query param.
    const tabs = await chrome.tabs.query({ url: '*://*.linkedin.com/*' });
    const idStr = String(jobId);
    const target = tabs.find((t) => {
      if (!t.url) return false;
      if (t.url.includes(`/jobs/view/${idStr}`)) return true;
      try {
        const u = new URL(t.url);
        if (u.searchParams.get('currentJobId') === idStr) return true;
        if (u.searchParams.get('savedJobId') === idStr) return true;
      } catch {}
      return false;
    });
    if (!target) {
      await logActivity({
        type: 'warmth-enrich', jobId, ok: false,
        note: 'Skipped: no LinkedIn tab open for this job',
      });
      return null;
    }
    let r;
    try {
      r = await sendToTabWithReinject(target.id, { type: 'walk-connections-modal' });
    } catch (e) {
      await logActivity({ type: 'warmth-enrich', jobId, ok: false, error: `Content script unreachable: ${e.message}` });
      return null;
    }
    if (r?.ok && r.warmth) {
      await upsertJob(jobId, { warmth: r.warmth });
      const d = r.warmth.detail || {};
      const nFirst = d.firstDegree?.length || 0;
      const nAlum = d.alumniShared?.length || 0;
      const nSchool = d.schoolAlumni?.length || 0;
      // Surface the diagnostic whenever 1st-degree extraction returned zero.
      // The content script populates _diagnostic in that case with a rich
      // breakdown (link count, degree marker counts, headings matched,
      // text head, HTML head) — enough to fix the parser without needing
      // to open DevTools on the LinkedIn tab.
      let note = `tier=${r.warmth.tier} · 1st=${nFirst}, alum=${nAlum}, school=${nSchool}`;
      if (d._diagnostic) {
        note += ` · ${d._diagnostic.slice(0, 500).replace(/\s+/g, ' ')}`;
      }
      await logActivity({ type: 'warmth-enrich', jobId, ok: nFirst + nAlum + nSchool > 0, note });
      return r.warmth;
    }
    await logActivity({
      type: 'warmth-enrich', jobId, ok: false,
      error: r?.error || 'Modal walk returned no warmth data',
    });
  } catch (e) {
    console.warn('[warmth] on-demand enrichment failed:', e.message);
    await logActivity({ type: 'warmth-enrich', jobId, ok: false, error: e.message });
  }
  return null;
}

async function runFit(jobId) {
  // Fire off the connections-modal walk before the LLM call so the fit
  // prompt sees named contacts if any exist. Non-blocking — if the tab
  // isn't open or modal extraction fails, fit still runs with preview data.
  await enrichWarmthOnDemand(jobId);
  const ctx = await loadContext(jobId);
  const userMessage = buildFitUserMessage({
    profile: ctx.profile, masterResume: ctx.resume, job: ctx.job,
    workLocations: ctx.workLocations, workPreferences: ctx.workPreferences,
  });
  const r = await routeCall('fit', {
    local: (model) => callOllamaJson({ model, system: FIT_SYSTEM, userMessage, maxTokens: 1200 }),
    cloud: () => callJsonAnthropic({
      apiKey: ctx.apiKey, model: ctx.models.fit,
      system: FIT_SYSTEM, userMessage, maxTokens: 1200,
    }),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const record = {
    result: r.result, model: modelLabel, usage: r.usage, retried: r.retried,
    provider: r.provider, fellback: r.fellback,
    generatedAt: new Date().toISOString(),
    promptVersion: FIT_PROMPT_VERSION,
  };
  await setJobAnalysis(jobId, 'fit', record);
  return { ok: true, record };
}

async function runComp(jobId) {
  const ctx = await loadContext(jobId);
  const userMessage = buildCompUserMessage({ compTargets: ctx.comp, job: ctx.job });
  const r = await routeCall('comp', {
    local: (model) => callOllamaJson({ model, system: COMP_SYSTEM, userMessage, maxTokens: 2000 }),
    cloud: () => callJsonAnthropic({
      apiKey: ctx.apiKey, model: ctx.models.comp,
      system: COMP_SYSTEM, userMessage, maxTokens: 2000,
    }),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const record = {
    result: r.result, model: modelLabel, usage: r.usage, retried: r.retried,
    provider: r.provider, fellback: r.fellback,
    generatedAt: new Date().toISOString(),
    promptVersion: COMP_PROMPT_VERSION,
  };
  await setJobAnalysis(jobId, 'comp', record);
  return { ok: true, record };
}

async function runBrief(jobId) {
  const ctx = await loadContext(jobId);
  const fitResult = ctx.job.analyses?.fit?.result || null;
  const userMessage = buildBriefUserMessage({
    profile: ctx.profile,
    masterResume: ctx.resume,
    writingSamples: ctx.samples,
    fitResult,
    prepQuestions: ctx.prepQuestions,
    job: ctx.job,
  });
  const r = await routeCall('brief', {
    local: async (model) => {
      const t = await callOllamaText({ model, system: BRIEF_SYSTEM, userMessage, maxTokens: 4000 });
      return { text: t.text, usage: t.usage, model: t.model };
    },
    cloud: async () => {
      const r = await callAI({
        apiKey: ctx.apiKey, model: ctx.models.questionPrep, maxTokens: 4000,
        system: BRIEF_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
      });
      return { text: r.text, usage: r.usage || null, model: r.model };
    },
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const record = {
    brief: r.text, model: modelLabel, usage: r.usage,
    provider: r.provider, fellback: r.fellback,
    generatedAt: new Date().toISOString(),
    promptVersion: QUESTION_PROMPT_VERSION,
  };
  await setJobAnalysis(jobId, 'brief', record);
  return { ok: true, record };
}

async function runAsk(jobId, prompt, providerOverride) {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is empty.');
  const ctx = await loadContext(jobId);
  const userMessage = buildAskUserMessage({
    profile: ctx.profile, masterResume: ctx.resume, writingSamples: ctx.samples,
    job: ctx.job, priorAnalyses: ctx.job.analyses || {}, prompt,
  });
  // Freeform text in, freeform text out — no JSON schema. Local uses
  // callOllamaText, cloud uses callAnthropic with extractText.
  const r = await routeCall('ask', {
    forceProvider: providerOverride, // 'local' | 'cloud' | 'auto' | undefined
    local: async (model) => {
      const t = await callOllamaText({ model, system: ASK_SYSTEM, userMessage, maxTokens: 2500 });
      return { text: t.text, usage: t.usage, model };
    },
    cloud: async () => {
      const r = await callAI({
        apiKey: ctx.apiKey, model: ctx.models.questionPrep,
        system: ASK_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        maxTokens: 2500,
      });
      return { text: r.text, usage: r.usage || null, model: r.model };
    },
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const existing = ctx.job.analyses?.chats || { items: [] };
  const entry = {
    at: new Date().toISOString(),
    prompt, answer: r.text,
    model: modelLabel, provider: r.provider, fellback: !!r.fellback,
    usage: r.usage,
    promptVersion: ASK_PROMPT_VERSION,
  };
  const items = [...(existing.items || []), entry];
  await setJobAnalysis(jobId, 'chats', { items });
  return { ok: true, entry, record: { model: modelLabel, provider: r.provider, fellback: !!r.fellback, usage: r.usage } };
}

async function getChats(jobId) {
  const job = await getJob(jobId);
  return { ok: true, items: job?.analyses?.chats?.items || [] };
}

// Field generators — three purpose-specific one-shots. Each takes the
// text the user has ON SCREEN (not from storage) so unsaved edits are
// respected. Fills exactly one textarea; the user reviews + clicks Save.
//
// Cloud-only — setup-time operations where the strongest model matters.

async function runFieldGenerator({ system, userMessage, maxTokens }) {
  const models = await getModels();
  const model = models.fit || models.default;
  const r = await callAI({
    model, system,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens,
  });
  await addUsage({ model: r.model, usage: r.usage || null });
  return {
    ok: true,
    data: {
      text: (r.text || '').trim(),
      model: r.model,
      usage: r.usage || null,
      promptVersion: BOOTSTRAP_PROMPT_VERSION,
    },
  };
}

async function runGenerateMasterResume(resumeText) {
  if (!resumeText || resumeText.trim().length < 200) {
    throw new Error('Paste at least ~200 characters of resume text into the Master Resume textarea first.');
  }
  return runFieldGenerator({
    system: MASTER_RESUME_SYSTEM,
    userMessage: buildMasterResumeUserMessage({ resumeText }),
    maxTokens: 4000,
  });
}

async function runGenerateProfile(masterResume, existingProfile, hints = {}) {
  if (!masterResume || masterResume.trim().length < 200) {
    throw new Error('Paste your Master Resume first — the Profile generator reads from it.');
  }
  return runFieldGenerator({
    system: PROFILE_SYSTEM,
    userMessage: buildProfileUserMessage({ masterResume, existingProfile, hints }),
    maxTokens: 1500,
  });
}

async function runGenerateKb(masterResume, existingProfile, existingKb, hints = {}) {
  if (!masterResume || masterResume.trim().length < 200) {
    throw new Error('Paste your Master Resume first — the Knowledge Base generator reads from it.');
  }
  return runFieldGenerator({
    system: KB_SYSTEM,
    userMessage: buildKbUserMessage({ masterResume, existingProfile, existingKb, hints }),
    maxTokens: 4000,
  });
}

async function runLetter(jobId, tone = 'warm') {
  const ctx = await loadContext(jobId);
  const fitResult = ctx.job.analyses?.fit?.result || null;
  const userMessage = buildLetterUserMessage({
    profile: ctx.profile, masterResume: ctx.resume, writingSamples: ctx.samples,
    fitResult, job: ctx.job, tone,
  });
  const r = await routeCall('coverLetter', {
    local: (model) => callOllamaJson({ model, system: LETTER_SYSTEM, userMessage, maxTokens: 2500 }),
    cloud: () => callJsonAnthropic({
      apiKey: ctx.apiKey, model: ctx.models.coverLetter,
      system: LETTER_SYSTEM, userMessage, maxTokens: 2500,
    }),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const record = {
    result: r.result, tone, model: modelLabel, usage: r.usage, retried: r.retried,
    provider: r.provider, fellback: r.fellback,
    generatedAt: new Date().toISOString(),
    promptVersion: LETTER_PROMPT_VERSION,
  };
  await setJobAnalysis(jobId, 'coverLetter', record);
  return { ok: true, record };
}

async function runResume(jobId) {
  const ctx = await loadContext(jobId);
  if (!ctx.resume) throw new Error('Master resume not uploaded. Add it in Settings first.');
  const fitResult = ctx.job.analyses?.fit?.result || null;
  const userMessage = buildResumeUserMessage({
    profile: ctx.profile, masterResume: ctx.resume, fitResult, job: ctx.job,
  });
  const r = await routeCall('resume', {
    local: (model) => callOllamaJson({ model, system: RESUME_SYSTEM, userMessage, maxTokens: 6000 }),
    cloud: () => callJsonAnthropic({
      apiKey: ctx.apiKey, model: ctx.models.resume,
      system: RESUME_SYSTEM, userMessage, maxTokens: 6000,
    }),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const record = {
    result: r.result, model: modelLabel, usage: r.usage, retried: r.retried,
    provider: r.provider, fellback: r.fellback,
    generatedAt: new Date().toISOString(),
    promptVersion: RESUME_PROMPT_VERSION,
  };
  await setJobAnalysis(jobId, 'resume', record);
  return { ok: true, record };
}

// ---------- Recall view launcher ----------
//
// Opens the per-job full-page view. Silently upserts a minimal record if the
// job isn't yet in the archive so Recall has something to render. This is the
// one implicit save that stays — it's a prerequisite for the action the user
// just took (open the full view), not a "save" button in disguise.

async function handleOpenRecall(jobId, data) {
  if (!jobId) throw new Error('No jobId provided');
  const existing = await getJob(jobId);
  if (!existing && data && data.jobId === jobId) {
    await upsertJob(jobId, {
      url: data.url,
      posting: data.posting,
      captureSource: 'opened-full-view',
    });
    chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  }
  const url = `${chrome.runtime.getURL('recall/recall.html')}?jobId=${encodeURIComponent(jobId)}`;
  await chrome.tabs.create({ url });
  return { ok: true };
}

// ---------- Interview rounds ----------

async function handleSaveRound(jobId, round) {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not in Jawboard`);
  const rounds = [...(job.interviewRounds || [])];
  if (round.id) {
    const idx = rounds.findIndex((r) => r.id === round.id);
    if (idx >= 0) rounds[idx] = { ...rounds[idx], ...round };
    else rounds.push(round);
  } else {
    round.id = `round-${Date.now()}`;
    rounds.push(round);
  }
  const updated = await upsertJob(jobId, { interviewRounds: rounds });
  return { ok: true, record: updated };
}

async function handleDeleteRound(jobId, roundId) {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not in Jawboard`);
  const rounds = (job.interviewRounds || []).filter((r) => r.id !== roundId);
  const updated = await upsertJob(jobId, { interviewRounds: rounds });
  return { ok: true, record: updated };
}

// Shared skeleton for any per-round LLM job (prep, follow-up email, …).
// Loads the cached settings context in a single storage read, resolves
// the round, calls the LLM, and writes the result back onto the round
// under the caller-specified field (`prep`, `followUp`, …). This
// replaces two near-identical ~30-line runners that only differed in
// system prompt, model choice, field name, and max-tokens.
async function runRoundJob(jobId, roundId, {
  system, buildUserMessage, model, maxTokens, field, promptVersion,
}) {
  const [ctx, job] = await Promise.all([getContextSettings(), getJob(jobId)]);
  if (!ctx.apiKey) throw new Error('API key is not set. Open Settings.');
  if (!job) throw new Error(`Job ${jobId} not in Jawboard`);
  const round = (job.interviewRounds || []).find((r) => r.id === roundId);
  if (!round) throw new Error(`Round ${roundId} not found`);

  const fitResult = job.analyses?.fit?.result || null;
  const { result, usage, model: usedModel, retried } = await callJsonAnthropic({
    apiKey: ctx.apiKey,
    model,
    system,
    userMessage: buildUserMessage({ profile: ctx.profile, masterResume: ctx.resume, fitResult, job, round }),
    maxTokens,
  });
  await addUsage({ model: usedModel, usage });

  const generatedAt = new Date().toISOString();
  const payload = { result, model: usedModel, usage, retried, generatedAt, promptVersion };
  const rounds = (job.interviewRounds || []).map((r) =>
    r.id === roundId ? { ...r, [field]: payload } : r
  );
  const updated = await upsertJob(jobId, { interviewRounds: rounds });
  return { ok: true, record: updated };
}

async function runRoundPrep(jobId, roundId) {
  const { models } = await getContextSettings();
  return runRoundJob(jobId, roundId, {
    system: ROUND_SYSTEM,
    buildUserMessage: buildRoundUserMessage,
    model: models.questionPrep,
    maxTokens: 3500,
    field: 'prep',
    promptVersion: ROUND_PROMPT_VERSION,
  });
}

// Draft a post-interview follow-up email for a specific round. Uses
// the user's notes from that round as the primary source material —
// specific topics, questions, personal details — so the email reads
// authentic instead of template-y. Routed through the same
// coverLetter model as other short-form generation.
async function runRoundFollowUp(jobId, roundId) {
  const { models } = await getContextSettings();
  return runRoundJob(jobId, roundId, {
    system: FOLLOWUP_SYSTEM,
    buildUserMessage: buildFollowUpUserMessage,
    model: models.coverLetter || models.default,
    maxTokens: 1500,
    field: 'followUp',
    promptVersion: FOLLOWUP_PROMPT_VERSION,
  });
}

// ---------- Enrichment ----------

async function runEnrich(jobId) {
  const existing = await getJob(jobId);
  if (!existing) throw new Error(`Job ${jobId} not in Jawboard`);
  const fetched = await fetchJobDetail(jobId);
  if (!fetched.ok) {
    if (fetched.status === 404) {
      await upsertJob(jobId, { postingArchived: true });
      await logActivity({ type: 'enrich-job', jobId, ok: true, note: 'posting archived (404)' });
      return { ok: true, enriched: false, postingArchived: true, error: fetched.error };
    }
    await logActivity({ type: 'enrich-job', jobId, ok: false, error: fetched.error });
    return { ok: false, error: fetched.error };
  }
  const patch = {
    posting: {
      title: existing.posting?.title || fetched.title || null,
      company: existing.posting?.company || fetched.company || null,
      location: existing.posting?.location || fetched.location || null,
      postedDate: existing.posting?.postedDate || fetched.postedDate || null,
      postedSalaryRange: existing.posting?.postedSalaryRange || fetched.postedSalaryRange || null,
      descriptionText: fetched.descriptionText || existing.posting?.descriptionText || null,
      descriptionSource: fetched.descriptionSource || existing.posting?.descriptionSource || null,
    },
    timeline: [
      ...(existing.timeline || []),
      { at: new Date().toISOString(), type: 'enriched', note: `Fetched from live posting (${fetched.descriptionSource})` },
    ],
  };
  const record = await upsertJob(jobId, patch);
  await logActivity({ type: 'enrich-job', jobId, ok: true, note: `desc source: ${fetched.descriptionSource}` });
  return { ok: true, enriched: true, record };
}

// ---------- Inbound matching ----------

async function runInboundMatch(message) {
  const jobs = await listJobs();
  const matches = matchInbound(jobs, message, 5);
  return { ok: true, matches };
}

// ---------- Diagnostic ----------

async function runOllamaStatus() {
  try {
    const version = await ollamaGetVersion(2500);
    const models = await ollamaListModels();
    return { ok: true, reachable: true, version, models };
  } catch (e) {
    return { ok: true, reachable: false, error: e.message };
  }
}

async function runDiagnostic() {
  const started = performance.now();
  const models = await getModels();
  const model = models.diagnostic || MODEL_IDS.haiku;

  const r = await callAI({
    model, maxTokens: 32,
    system: 'You are a connectivity probe. Reply with exactly the word: OK',
    messages: [{ role: 'user', content: 'ping' }],
  });

  const elapsedMs = Math.round(performance.now() - started);
  await addUsage({ model: r.model, usage: r.usage || null });
  return { ok: true, text: r.text, model: r.model, provider: r.provider, elapsedMs, usage: r.usage || null };
}
