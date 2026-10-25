import { callAnthropic, extractText } from './lib/anthropic.js';
import { callAI } from './lib/aiRouter.js';
import { callJsonAnthropic } from './lib/json.js';
import {
  getModels,
  getProfile,
  getMasterResume,
  getCompTargets,
  getWritingSamples,
  getAutoAnalyzeEnabled,
  getLocalModelSettings,
  addUsage,
  getUsage,
  getDailyUsage,
  logActivity,
  getActivity,
  clearActivity,
  upsertJob,
  getJob,
  listJobs,
  getApplicationProfile,
  getCompanySiteLookupEnabled,
  getStrictFacts, getDocumentSettings,
  bulkGetJobsByIds,
  deleteJob,
  countJobs,
  setJobAnalysis,
  updateJobStatus,
  addTimelineEntry,
  bulkUpsertJobsWith,
  mergeJobRecord,
  findProbableDuplicate,
  getContextSettings,
  getSavedSearches,
  addSavedSearch,
  deleteSavedSearch,
  addRecentSearch,
  getRecentSearchesFiltered,
  clearRecentSearches,
  markSavedSearchRun,
  getNegativeKeywords,
  exportAll,
  importAll,
  setLastExportAt,
  getLastExportAt,
} from './lib/store.js';
import { MODEL_IDS } from './lib/models.js';
import { FIT_SYSTEM, FIT_PROMPT_VERSION, buildFitUserMessage } from './lib/prompts/fit.js';
import { COMP_SYSTEM, COMP_PROMPT_VERSION, buildCompUserMessage } from './lib/prompts/comp.js';
import { normalizeComp } from './lib/jawbSteps.js';
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
import { upgradeStatus, resolveTransition, stageOf, undoTarget, normalizeTrackerStage, statusLabel, normalizeStatus, STATUS, STATUS_ORDER } from './lib/statuses.js';
import { computeStrengthScore, computeCompGaugeScore, roundFitToTens } from './lib/strength.js';
import { ROUND_SYSTEM, ROUND_PROMPT_VERSION, buildRoundUserMessage } from './lib/prompts/interviewRound.js';
import { FOLLOWUP_SYSTEM, FOLLOWUP_PROMPT_VERSION, buildFollowUpUserMessage } from './lib/prompts/followUpEmail.js';
import { HUMAN_STYLE } from './lib/prompts/humanStyle.js';
import { UNTRUSTED_POSTING, STRICT_FACTS } from './lib/prompts/parts.js';
import { APPLICATION_FOLLOWUP_SYSTEM, APPLICATION_FOLLOWUP_PROMPT_VERSION, buildApplicationFollowUpUserMessage } from './lib/prompts/applicationFollowUp.js';
import { quietness } from './lib/followups.js';
import { companiesUrl, jobsUrl, jobUrl, pickCompany, pickMatch, summarize, usableSalary } from './lib/freehire.js';
import { LETTER_REVIEW_SYSTEM, LETTER_REVIEW_PROMPT_VERSION, buildLetterReviewUserMessage } from './lib/prompts/letterReview.js';
import { EXTRACT_REQUIREMENTS_SYSTEM, EXTRACT_REQUIREMENTS_PROMPT_VERSION, buildExtractRequirementsUserMessage } from './lib/prompts/extractRequirements.js';
import { MATCH_REQUIREMENTS_SYSTEM, MATCH_REQUIREMENTS_PROMPT_VERSION, buildMatchRequirementsUserMessage } from './lib/prompts/matchRequirements.js';
import { decideRequirements, summarizeRequirements } from './lib/requirementMatch.js';
import { fetchJobDetail } from './lib/enrich.js';
import {
  isReachable as ollamaReachable,
  listModels as ollamaListModels,
  getVersion as ollamaGetVersion,
  callOllamaJson, callOllamaText,
} from './lib/ollamaClient.js';

import { parseEmail, matchEmail } from './lib/emailMatch.js';
import { CLASSIFY_EMAIL_SYSTEM, CLASSIFY_EMAIL_PROMPT_VERSION, buildClassifyEmailUserMessage } from './lib/prompts/classifyEmail.js';
import { DRAFT_REPLY_SYSTEM, DRAFT_REPLY_PROMPT_VERSION, buildDraftReplyUserMessage } from './lib/prompts/draftReply.js';
import { defaultRoundType, defaultTopicFor } from './lib/rounds.js';
import { FLOW_STEPS } from './lib/progressSteps.js';
import { toneKey, signOffUnit } from './lib/tones.js';
import { postingAgeDays, applicantCount } from './lib/freshness.js';
import { sharedTerms, verifyResume, resumeText } from './lib/keywords.js';
import { guard, buildCorpus } from './lib/factGuard.js';
import { splitLetter, joinUnits, resumeFromUnits, unitsFromResume, applyRefine, keptUnits, EDITABLE_KINDS } from './lib/documentUnits.js';
import { newDoc, commit as commitVersion, undo as undoVersion, restore as restoreVersion, docFromJob } from './lib/documentHistory.js';
import {
  REGENERATE_UNIT_SYSTEM, REGENERATE_UNIT_PROMPT_VERSION, buildRegenerateUnitUserMessage,
  REFINE_DOCUMENT_SYSTEM, REFINE_DOCUMENT_PROMPT_VERSION, buildRefineDocumentUserMessage,
} from './lib/prompts/documentEdit.js';

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
  'linkedin-signal': (msg) => handleLinkedInSignal(msg),
  'linkedin-signal-unmatched': (msg) => logActivity({
    type: 'linkedin-unmatched', ok: false, note: String(msg.note || '').slice(0, 300),
  }).then(() => ({ ok: true })),
  'auto-analyze-fit': (msg) => handleAutoAnalyzeFit(msg.data),
  'get-current-job': getCurrentJob,
  'get-recent-jobs': getRecentJobs,
  'tracker-list': (msg) => handleTrackerList(msg.jobs, msg.stage, msg.url),
  'get-tracker-state': getTrackerState,
  'backfill': (msg) => handleBackfill(msg.jobs, msg.stage),
  'sync-linkedin': () => runSyncLinkedIn(),
  // Cancel BOTH signals the walker (which will exit its next tick) AND
  // pre-clears the in-flight flag so the user can start a new sync
  // immediately. If the walker was still running, its own finally block
  // will call setSyncInFlight(false) again — idempotent, no harm done.
  'sync-linkedin-cancel': async () => {
    await setSyncCancelled(true);
    await setSyncInFlight(false);
    return { ok: true };
  },
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
  // The Fill button was used on a company's application form. If that
  // followed an Apply click within the hour, note it on that job and keep
  // the form's address — the link between a LinkedIn job and where the
  // application actually lives. Followed from the click, never guessed
  // from title or company.
  // "View in Jawbs" link on the on-LinkedIn toast. Opens our own page
  // only, so it's safe to accept from a content script.
  'open-job-details': async (msg) => {
    if (!/^\d+$/.test(String(msg.jobId || ''))) return { ok: false, error: 'bad jobId' };
    await chrome.tabs.create({ url: `${chrome.runtime.getURL('recall/recall.html')}?jobId=${msg.jobId}` });
    return { ok: true };
  },
  'application-filled': async (msg, sender) => {
    const c = (await chrome.storage.local.get('ui.applyClick'))['ui.applyClick'];
    const url = sender?.tab?.url || '';
    if (!c || Date.now() - c.at > 60 * 60_000 || !/^https:/.test(url)) return { ok: true, skipped: 'no-recent-apply' };
    const existing = await getJob(c.jobId);
    if (!existing) return { ok: true, skipped: 'not-in-archive' };
    const now = new Date().toISOString();
    await upsertJob(c.jobId,
      { application: { ...(existing.application || {}), siteUrl: existing.application?.siteUrl || url.slice(0, 500) } },
      { appendTimeline: [{ at: now, type: 'application', note: `Autofilled ${Number(msg.count) || 0} fields on ${new URL(url).hostname}` }] });
    return { ok: true };
  },
  // The user says they messaged the contact Fit recommended (or takes it
  // back). Recorded so outcomes can be compared with and without outreach.
  'mark-outreach-sent': async (msg) => {
    const now = new Date().toISOString();
    const record = await upsertJob(msg.jobId,
      { outreach: msg.sent ? { sentAt: now, contact: String(msg.contact || '').slice(0, 200) } : null },
      { appendTimeline: [{ at: now, type: 'outreach', note: msg.sent ? `Messaged ${msg.contact || 'contact'}` : 'Outreach un-marked' }] });
    return { ok: true, data: record.outreach };
  },
  // Fit, then the per-requirement map (two more calls). A requirements
  // failure never fails the Fit the user asked for; it's logged and can be
  // re-run on its own with 'analyze-requirements'.
  'analyze-fit': (msg) => instrumentAnalysis('analyze-fit', msg.jobId, async () => {
    const fit = await runFit(msg.jobId);
    await instrumentAnalysis('analyze-requirements', msg.jobId, () => runRequirements(msg.jobId)).catch(() => {});
    return fit;
  }),
  'analyze-requirements': (msg) => instrumentAnalysis('analyze-requirements', msg.jobId, () => runRequirements(msg.jobId)),
  'analyze-comp': (msg) => instrumentAnalysis('analyze-comp', msg.jobId, () => runComp(msg.jobId)),
  'build-brief': (msg) => instrumentAnalysis('build-brief', msg.jobId, () => runBrief(msg.jobId)),
  'generate-letter': (msg) => instrumentAnalysis('generate-letter', msg.jobId, () => runLetter(msg.jobId, msg.tone)),
  'draft-application-followup': (msg) => instrumentAnalysis('draft-application-followup', msg.jobId, () => runApplicationFollowUp(msg.jobId)),
  'undo-status': (msg) => undoStatus(msg.jobId),
  'company-site-lookup': (msg) => lookupCompanySite(msg),
  'company-site-choose': (msg) => chooseCompanySite(msg.jobId, msg.slug),
  'refresh-company-sites': () => refreshCompanySites(),
  // The user opened this job's company-site posting from the side panel:
  // remember it the same way an Apply click does, for the Fill button and
  // the answer drafter on that page. No status change.
  'company-site-opened': async (msg) => {
    const job = await getJob(String(msg.jobId || ''));
    const posting = job?.posting || {};
    await chrome.storage.local.set({
      'ui.applyClick': { jobId: String(msg.jobId), title: posting.title || '', company: posting.company || '', at: Date.now() },
      'ui.activeApplicationJawbId': String(msg.jobId),
    });
    return { ok: true };
  },
  'review-letter': (msg) => instrumentAnalysis('review-letter', msg.jobId, () => runLetterReview(msg.jobId)),
  // The tone picked on the Letter tab, kept on the job if it's saved.
  'set-letter-tone': async (msg) => {
    const id = String(msg.jobId || '');
    if (await getJob(id)) await upsertJob(id, { letterTone: toneKey(msg.tone) });
    return { ok: true };
  },
  'document-commit': (msg) => commitDocumentChanges(msg.jobId, msg.kind, msg.changes, msg.cause, msg.note),
  'document-undo': (msg) => changeDocument(msg.jobId, msg.kind, (doc) => undoVersion(doc)),
  'document-restore': (msg) => changeDocument(msg.jobId, msg.kind, (doc) => restoreVersion(doc, msg.versionId)),
  'regenerate-unit': (msg) => instrumentAnalysis('regenerate-unit', msg.jobId, () => runRegenerateUnit(msg.jobId, msg.kind, msg.unitId, msg.instruction)),
  'refine-document': (msg) => instrumentAnalysis('refine-document', msg.jobId, () => runRefineDocument(msg.jobId, msg.kind, msg.request)),
  'generate-resume': (msg) => instrumentAnalysis('generate-resume', msg.jobId, () => runResume(msg.jobId, msg.mustInclude)),
  'ask-llm': (msg) => instrumentAnalysis('ask-llm', msg.jobId, () => runAsk(msg.jobId, msg.prompt, msg.provider)),
  'get-chats': (msg) => getChats(msg.jobId),
  'enrich-job': (msg) => runEnrich(msg.jobId),
  'save-round': (msg) => handleSaveRound(msg.jobId, msg.round),
  'delete-round': (msg) => handleDeleteRound(msg.jobId, msg.roundId),
  'draft-application-answer': (msg) => handleDraftApplicationAnswer(msg),
  'generate-round-prep': (msg) => runRoundPrep(msg.jobId, msg.roundId),
  'generate-round-followup': (msg) => runRoundFollowUp(msg.jobId, msg.roundId),
  'open-recall': (msg) => handleOpenRecall(msg.jobId, msg.data),
  'email-match': (msg) => runEmailMatch(msg.text),
  'classify-email': (msg) => instrumentAnalysis('classify-email', msg.jobId, () => runClassifyEmail(msg.jobId, msg.email)),
  'draft-reply': (msg) => instrumentAnalysis('draft-reply', msg.jobId, () => runDraftReply(msg.jobId, msg.at)),
  'email-move-status': (msg) => moveStatusFromEmail(msg.jobId, msg.status),
  'email-add-round': (msg) => addRoundFromEmail(msg.jobId, msg.at),
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
  // AI calls and edits on the user's own documents and mail
  'classify-email', 'draft-reply', 'email-move-status', 'email-add-round',
  'document-commit', 'document-undo', 'document-restore', 'regenerate-unit', 'refine-document',
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
    // How many jobs this list moved — the page tells the user.
    return { ok: true, moved: await passiveBackfill(jobs, stage) };
  } catch (e) {
    console.warn('[Jawbs] passive tracker backfill failed:', e);
    return { ok: true, moved: 0 };
  }
}

// Existing-only status sweep. Runs on every SPA nav through LinkedIn's
// tracker so status changes made outside the extension surface in the
// archive automatically. The tab a job sits in is LinkedIn's own record,
// so it can move a status in either direction (see resolveTransition for
// the two cases where it doesn't). Never creates new archive records —
// that's what Thresh is for.
async function passiveBackfill(jobs, stage) {
  if (!Array.isArray(jobs) || !jobs.length) return 0;
  const target = normalizeTrackerStage(stage);
  if (!target) return 0;
  const now = new Date().toISOString();
  const moves = [];

  const records = await bulkUpsertJobsWith(jobs.map((j) => String(j.jobId)), (id, existing) => {
    if (!existing) return null;
    const from = normalizeStatus(existing.status);
    const next = resolveTransition(existing, { kind: 'tracker', explicit: false, status: target });
    const changed = next.status !== from;
    if (!changed && next.linkedInStage === existing.linkedInStage && next.manualLock === !!existing.manualLock) return null;
    if (changed) moves.push(`${id} ${from}→${next.status}`);
    return mergeJobRecord(id, existing, {
      linkedInStage: next.linkedInStage,
      manualLock: next.manualLock,
      ...(changed ? { status: next.status, statusUpdatedAt: now } : {}),
    }, changed ? {
      appendTimeline: [{
        at: now, type: 'status-change', from, to: next.status, source: 'linkedin:tracker-seen',
        note: `Seen on LinkedIn tracker (${stage}) · ${from} → ${next.status}`,
      }],
    } : {});
  });
  if (moves.length) {
    chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
    await logActivity({
      type: 'passive-tracker-sync', ok: true,
      note: `stage=${stage} · ${moves.length} of ${records.length} changed · ${moves.slice(0, 8).join(', ')}`,
    });
  }
  return moves.length;
}

async function getTrackerState() {
  const r = await chrome.storage.session.get('trackerState');
  return { ok: true, data: r.trackerState || null };
}

async function handleBackfill(jobs, stage) {
  const now = new Date().toISOString();
  // Map LinkedIn's tracker-stage strings ("Saved", "Applied", "Archived",
  // "In Progress", etc.) into our canonical status vocabulary. An
  // unrecognized stage carries no status information: existing records
  // keep theirs, new ones land as saved (they're on the tracker).
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
    const next = target
      ? resolveTransition(existing, { kind: 'tracker', explicit: false, status: target })
      : { status: existing ? normalizeStatus(existing.status) : 'saved', linkedInStage: existing?.linkedInStage, manualLock: !!existing?.manualLock };
    const newStatus = next.status;
    const statusChanged = (existing ? normalizeStatus(existing.status) : null) !== newStatus;
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
      linkedInStage: next.linkedInStage,
      manualLock: next.manualLock,
      posting: { title: nextTitle, company: nextCompany },
      cardText: j.cardText,
      // Hint for the "Find on LinkedIn" row action so it can jump
      // straight to the tracker page the job was last seen on. Only
      // record when the walker actually tagged a page (backwards-
      // compatible with older syncs).
      ...(j.pageIndex ? { linkedInTracker: { stage, page: j.pageIndex, seenAt: now } } : {}),
    };
    const ops = {
      appendTimeline: [statusChanged
        ? { at: now, type: 'status-change', from: existing?.status || null, to: newStatus, source: 'linkedin:sync',
            note: `Synced from tracker (${stage}) · ${existing?.status || 'new'} → ${newStatus}` }
        : { at: now, type: 'synced', note: `Synced from tracker (${stage}) · status unchanged` }],
    };
    return mergeJobRecord(id, existing, updates, ops);
  });

  chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  await logActivity({ type: 'sync-tracker', ok: true, note: `stage=${stage} · ${records.length} synced (${created} new, ${upgraded} status changed)` });
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
const SYNC_STARTED_AT_KEY = 'syncStartedAt';
// A sync flag that's been sitting for longer than this is presumed
// crashed — a service-worker restart mid-sync, an unhandled exception
// past our try/finally, a tab being closed while the walker was mid-
// pagination. Callers auto-clear so the user isn't blocked forever
// behind a ghost sync.
const SYNC_STALE_MS = 20 * 60 * 1000;

async function isSyncInFlight() {
  const r = await chrome.storage.session.get([SYNC_IN_FLIGHT_KEY, SYNC_STARTED_AT_KEY]);
  if (!r[SYNC_IN_FLIGHT_KEY]) return false;
  const startedAt = Number(r[SYNC_STARTED_AT_KEY]) || 0;
  if (startedAt && Date.now() - startedAt > SYNC_STALE_MS) {
    // Stale — clear it silently so the caller can start fresh.
    await chrome.storage.session.remove([
      SYNC_IN_FLIGHT_KEY, SYNC_STARTED_AT_KEY, SYNC_CANCELLED_KEY,
    ]);
    return false;
  }
  return true;
}
async function setSyncInFlight(v) {
  if (v) {
    await chrome.storage.session.set({
      [SYNC_IN_FLIGHT_KEY]: true,
      [SYNC_STARTED_AT_KEY]: Date.now(),
    });
  } else {
    await chrome.storage.session.remove([SYNC_IN_FLIGHT_KEY, SYNC_STARTED_AT_KEY]);
  }
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
    return { ok: false, error: `Status "${job.status || 'unknown'}" isn't tracked on LinkedIn: nothing to find.` };
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

      // handleBackfill runs each job through resolveTransition — the
      // stage LinkedIn lists a job under can move its status either way.
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
  if (!diff) return { ok: false, error: 'no reconciliation diff cached: run reconcile first' };
  const missingById = new Map((diff.missingOnLinkedIn || []).map((m) => [String(m.jobId), m]));
  const mismatchById = new Map((diff.statusMismatches || []).map((m) => [String(m.jobId), m]));
  const now = new Date().toISOString();
  let applied = 0, deleted = 0, skipped = 0;
  const changedIds = []; // for the Jawboard's Undo

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
    let append = [];
    if (resolution === 'accept-linkedin') {
      if (mismatch) {
        // Direct status write — user intent overrides upgrade-only.
        patch = {
          status: mismatch.linkedInStatus,
          statusUpdatedAt: now,
          linkedInStage: stageOf(mismatch.linkedInStatus),
          manualLock: false,
        };
        append = [{ at: now, type: 'status-change', from: existing.status || 'analyzed', to: mismatch.linkedInStatus, source: 'reconcile',
          note: `Accepted LinkedIn: ${existing.status || 'analyzed'} → ${mismatch.linkedInStatus}` }];
      } else if (missing) {
        // "Accept" for a missing record = "LinkedIn no longer tracks
        // this" → set to notMovingForward (soft-archive).
        patch = { status: 'notMovingForward', statusUpdatedAt: now };
        append = [{ at: now, type: 'status-change', from: existing.status || 'analyzed', to: 'notMovingForward', source: 'reconcile',
          note: 'Accepted LinkedIn: no longer on any list → notMovingForward' }];
      }
    } else if (resolution === 'keep-local') {
      // No status change — audit trail only.
      const note = mismatch
        ? `Kept local (${existing.status}), LinkedIn shows ${mismatch.linkedInStatus}`
        : `Kept local (${existing.status}), missing from LinkedIn`;
      patch = { timeline: [...(existing.timeline || []), { at: now, type: 'reconcile', note }] };
    }

    if (patch) {
      await upsertJob(id, patch, { appendTimeline: append });
      if (patch.status) changedIds.push(id);
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
  return { ok: true, applied, deleted, skipped, changedIds };
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
    const hasFit = typeof fit?.fitScore === 'number';
    decorations[id] = {
      status: job.status || null,
      statusLabel: job.status ? statusLabel(job.status) : null,
      fitScore: typeof fit?.fitScore === 'number' ? roundFitToTens(fit.fitScore) : null,
      compLow:  comp?.salary?.base?.low  ?? comp?.marketEstimate?.baseLow  ?? null,
      compHigh: comp?.salary?.base?.high ?? comp?.marketEstimate?.baseHigh ?? null,
      compScore: computeCompGaugeScore(comp, compTargets),
      // No fit, no strength: the composite's other parts (comp, network)
      // add up to a number even for a job never analyzed. Null hides it.
      strengthScore: hasFit ? strength.score : null,
      strengthTier: hasFit ? strength.tier : null,
      strengthTierLabel: hasFit ? strength.tierLabel : null,
      strengthTierImage: hasFit ? strength.tierImage : null,
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

const SIGNAL_LABEL = {
  'save': 'LinkedIn Save',
  'unsave': 'LinkedIn Unsave',
  'apply-clicked': 'LinkedIn Apply clicked',
  'apply-confirmed': 'LinkedIn application confirmed',
  'tracker': 'LinkedIn tracker move',
};

// Every status-relevant thing the content script sees on LinkedIn lands
// here: Save/Unsave, Apply click, application confirmed, tracker row
// moved. lib/statuses.js#resolveTransition decides what it means; this
// just persists the result and leaves an audit trail.
//   explicit  true = the user just did it, false = state seen on the page
//   stage     LinkedIn tracker stage, for kind 'tracker'
//   data      { url, posting } from the detail pane, or { url, guess }
//             when the action was on a list card we haven't scraped
async function handleLinkedInSignal({ jobId, kind, explicit = true, stage, data, method }) {
  const id = String(jobId || '');
  if (!/^\d+$/.test(id) || !SIGNAL_LABEL[kind]) return { ok: false, error: 'bad signal' };
  const target = kind === 'tracker' ? normalizeTrackerStage(stage) : undefined;
  if (kind === 'tracker' && !target) return { ok: true, skipped: 'unknown-stage' };

  const existing = await getJob(id);
  // Only a Save or an Apply puts a new job in the archive.
  if (!existing && (kind === 'unsave' || kind === 'tracker')) return { ok: true, skipped: 'not-in-archive' };

  const from = existing ? normalizeStatus(existing.status) : null;
  const next = resolveTransition(existing, { kind, explicit, status: target });
  const changed = next.status !== from;
  // Seeing the same state again (page reload on an already-saved job) is
  // not news — no write, no log line.
  if (!changed && !explicit && existing) return { ok: true, changed: false, status: next.status };

  const now = new Date().toISOString();
  const label = `${SIGNAL_LABEL[kind]}${stage ? ` (${stage})` : ''}`;
  const patch = {
    linkedInStage: next.linkedInStage,
    manualLock: next.manualLock,
    ...(data?.url ? { url: data.url } : {}),
    ...(data?.posting ? { posting: data.posting } : (!existing && data?.guess ? { posting: data.guess } : {})),
    ...(existing ? {} : { captureSource: `${kind}-click` }),
    ...(changed ? { status: next.status, statusUpdatedAt: now } : {}),
  };
  // The facts about HOW and WHEN this application went in — the columns
  // of a job-search spreadsheet, captured at the moment they're true.
  // Only from things the user just did: a page that merely shows
  // "Applied" says nothing about when or how. First value wins, so a
  // second Apply click days later doesn't rewrite history.
  if (explicit && (kind === 'apply-clicked' || kind === 'apply-confirmed')) {
    const posting = data?.posting || existing?.posting || {};
    const prev = existing?.application || {};
    patch.application = {
      method: prev.method || method || null,                 // 'easy-apply' | 'company-site'
      clickedAt: prev.clickedAt || (kind === 'apply-clicked' ? now : null),
      appliedAt: prev.appliedAt || (next.status === 'applied' ? now : null),
      postingAgeDays: prev.postingAgeDays ?? postingAgeDays(posting.postedDate),
      applicants: prev.applicants ?? applicantCount(posting.applicantCount),
      reposted: prev.reposted ?? (posting.isReposted ?? null),
    };
  }
  // Remember which job the user just went to apply for. The company's
  // form opens in another tab with no job of its own; this is how the
  // Fill button and the answer drafter know whose application it is.
  if (explicit && kind === 'apply-clicked') {
    const posting = data?.posting || existing?.posting || data?.guess || {};
    await chrome.storage.local.set({
      'ui.applyClick': { jobId: id, title: posting.title || '', company: posting.company || '', at: Date.now() },
      'ui.activeApplicationJawbId': id,
    });
  }
  const record = await upsertJob(id, patch, {
    appendTimeline: [changed
      ? { at: now, type: 'status-change', from, to: next.status, source: `linkedin:${kind}`, note: `${label} · ${from || 'new'} → ${next.status}` }
      : { at: now, type: 'linkedin-signal', source: `linkedin:${kind}`, note: `${label} · status unchanged (${next.status})` }],
  });
  await logActivity({
    type: 'linkedin-signal', jobId: id, ok: true,
    note: `${kind}${explicit ? '' : ' (observed)'}${stage ? ` ${stage}` : ''} · ${changed ? `${from || 'new'} → ${next.status}` : `unchanged (${next.status})`}`,
  });
  if (changed) chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  return { ok: true, changed, status: next.status, label: statusLabel(next.status), record };
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

// ---------- Named progress steps (lib/progressSteps.js) ----------
//
// Flows with named steps report each one as it starts: a PROGRESS
// message for open pages, and chrome.storage.session 'progress' so a
// Jawbar reopened mid-flow can pick the checklist back up.
const activeFlows = new Map(); // jobId → Set of flows running
let progressWrites = Promise.resolve();

function reportProgress(jobId, flow, stepId) {
  chrome.runtime.sendMessage({ type: 'PROGRESS', jobId, flow, stepId }).catch(() => {});
  progressWrites = progressWrites.then(async () => {
    const all = (await chrome.storage.session.get('progress')).progress || {};
    const job = { ...(all[jobId] || {}) };
    if (stepId) job[flow] = { stepId, at: Date.now() }; else delete job[flow];
    if (Object.keys(job).length) all[jobId] = job; else delete all[jobId];
    await chrome.storage.session.set({ progress: all });
  }).catch(() => {});
}

// The step every running flow of this job that has it is now on.
function step(jobId, stepId) {
  const id = String(jobId);
  for (const flow of activeFlows.get(id) || []) {
    if (FLOW_STEPS[flow].some((s) => s.id === stepId)) reportProgress(id, flow, stepId);
  }
}

async function instrumentAnalysis(action, jobId, fn) {
  const started = performance.now();
  const id = String(jobId || '');
  const stepped = !!FLOW_STEPS[action] && !!id;
  if (stepped) activeFlows.set(id, new Set([...(activeFlows.get(id) || []), action]));
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
  } finally {
    if (stepped) {
      activeFlows.get(id)?.delete(action);
      reportProgress(id, action, null);
    }
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
  step(jobId, 'fit');
  // Fire off the connections-modal walk before the LLM call so the fit
  // prompt sees named contacts if any exist. Non-blocking — if the tab
  // isn't open or modal extraction fails, fit still runs with preview data.
  await enrichWarmthOnDemand(jobId);
  const ctx = await loadContext(jobId);
  const authorization = await getApplicationProfile();
  const userMessage = buildFitUserMessage({
    profile: ctx.profile, masterResume: ctx.resume, job: ctx.job,
    workLocations: ctx.workLocations, workPreferences: ctx.workPreferences,
    authorization,
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

// Requirement map: the model lists the posting's requirements (quoting
// it), then points at the user's own material for each; code checks the
// quotes and decides covered / partial / gap (lib/requirementMatch.js).
async function runRequirements(jobId) {
  const ctx = await loadContext(jobId);
  // loadContext folds the knowledge base into the profile; split it back
  // out so evidence can be attributed to where it really came from.
  const profile = String(ctx.profile || '').split('\n\n----- EXTENDED KNOWLEDGE BASE -----')[0];
  const call = (system, userMessage, maxTokens) => routeCall('fit', {
    local: (model) => callOllamaJson({ model, system, userMessage, maxTokens }),
    cloud: () => callJsonAnthropic({ apiKey: ctx.apiKey, model: ctx.models.fit, system, userMessage, maxTokens }),
  });
  step(jobId, 'extract');
  const ex = await call(EXTRACT_REQUIREMENTS_SYSTEM, buildExtractRequirementsUserMessage({ job: ctx.job }), 2000);
  const posting = String(ctx.job.posting?.descriptionText || '').toLowerCase().replace(/\s+/g, ' ');
  const requirements = (ex.result?.requirements || []).filter((r) => r?.id && r.text).slice(0, 15).map((r) => ({
    ...r,
    // A quote the posting doesn't contain isn't a quote.
    quote: r.quote && posting.includes(String(r.quote).toLowerCase().replace(/\s+/g, ' ')) ? r.quote : null,
  }));
  if (!requirements.length) throw new Error('No requirements found in the posting');
  step(jobId, 'match');
  const mt = await call(MATCH_REQUIREMENTS_SYSTEM, buildMatchRequirementsUserMessage({
    requirements, profile, masterResume: ctx.resume, knowledgeBase: ctx.knowledgeBase,
  }), 3000);
  const result = decideRequirements(requirements, mt.result?.matches, { resume: ctx.resume, profile, knowledge: ctx.knowledgeBase });
  const label = (r) => (r.provider === 'local' ? `local:${r.model}` : r.model);
  await addUsage({ model: label(ex), usage: ex.usage });
  await addUsage({ model: label(mt), usage: mt.usage });
  const s = summarizeRequirements(result);
  const record = {
    result,
    summary: { total: s.total, covered: s.covered, partial: s.partial, gap: s.gap, mustGaps: s.mustGaps.length },
    model: label(mt), provider: mt.provider,
    usage: {
      input_tokens: (ex.usage?.input_tokens || 0) + (mt.usage?.input_tokens || 0),
      output_tokens: (ex.usage?.output_tokens || 0) + (mt.usage?.output_tokens || 0),
    },
    generatedAt: new Date().toISOString(),
    promptVersions: { extract: EXTRACT_REQUIREMENTS_PROMPT_VERSION, match: MATCH_REQUIREMENTS_PROMPT_VERSION },
  };
  await setJobAnalysis(jobId, 'requirements', record);
  return { ok: true, record };
}

async function runComp(jobId) {
  const ctx = await loadContext(jobId);
  const userMessage = buildCompUserMessage({
    compTargets: ctx.comp, job: ctx.job,
    companySiteSalary: usableSalary(ctx.job.companySite?.match),
  });
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
    result: normalizeComp(r.result, { target: ctx.comp?.target }), model: modelLabel, usage: r.usage, retried: r.retried,
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
    throw new Error('Paste your Master Resume first; the Profile generator reads from it.');
  }
  return runFieldGenerator({
    system: PROFILE_SYSTEM,
    userMessage: buildProfileUserMessage({ masterResume, existingProfile, hints }),
    maxTokens: 1500,
  });
}

async function runGenerateKb(masterResume, existingProfile, existingKb, hints = {}) {
  if (!masterResume || masterResume.trim().length < 200) {
    throw new Error('Paste your Master Resume first; the Knowledge Base generator reads from it.');
  }
  return runFieldGenerator({
    system: KB_SYSTEM,
    userMessage: buildKbUserMessage({ masterResume, existingProfile, existingKb, hints }),
    maxTokens: 4000,
  });
}

// ---------- Fact guard ----------
//
// The material a generated document may draw facts from: the user's own
// profile, resume, knowledge base and writing samples, plus the posting.
// extra: other text the output may fairly repeat (the email a reply answers).
function factCorpus(ctx, job = ctx.job, extra = '') {
  const p = job?.posting || {};
  return buildCorpus({
    // The user's own name (Resume header) is a fact about them, e.g. in a sign-off.
    profile: [ctx.profile, ctx.candidateName].filter(Boolean).join('\n'), masterResume: ctx.resume, knowledgeBase: ctx.knowledgeBase,
    writingSamples: ctx.samples, posting: [p.title, p.company, p.descriptionText, extra].filter(Boolean).join('\n'),
  });
}

// Generate a document and fact-guard it. With Strict facts on, the prompt
// is told to use supplied facts only, and if the guard still flags any,
// one regeneration lists them and asks for them to be removed or
// rephrased. Never more than one retry. Usage is recorded per call.
async function generateGuarded({ feature, model, system, userMessage, maxTokens, ctx, textOf }) {
  const strict = await getStrictFacts();
  const sys = strict ? `${system}\n\n${STRICT_FACTS}` : system;
  const call = async (um) => {
    const r = await routeCall(feature, {
      local: (m) => callOllamaJson({ model: m, system: sys, userMessage: um, maxTokens }),
      cloud: () => callJsonAnthropic({ apiKey: ctx.apiKey, model, system: sys, userMessage: um, maxTokens }),
    });
    await addUsage({ model: r.provider === 'local' ? `local:${r.model}` : r.model, usage: r.usage });
    return r;
  };
  const corpus = factCorpus(ctx);
  step(ctx.job.jobId, 'write');
  let r = await call(userMessage);
  step(ctx.job.jobId, 'check');
  let fg = guard(textOf(r.result) || '', corpus);
  let retried = false;
  if (strict && !fg.clean) {
    step(ctx.job.jobId, 'retry');
    const facts = [...new Set(fg.flags.map((f) => f.value))].join(', ');
    const first = r;
    r = await call(`${userMessage}\n\nFACT CHECK: your previous draft stated these facts, which are not in the material or the posting: ${facts}. Write it again without them: remove each one, or rephrase using only facts the material contains.`);
    r.usage = {
      input_tokens: (first.usage?.input_tokens || 0) + (r.usage?.input_tokens || 0),
      output_tokens: (first.usage?.output_tokens || 0) + (r.usage?.output_tokens || 0),
    };
    fg = guard(textOf(r.result) || '', corpus);
    retried = true;
  }
  return { r, factGuard: { ...fg, strict, retried } };
}

async function runLetter(jobId, toneIn) {
  const ctx = await loadContext(jobId);
  // The tone asked for, else this job's last, else Settings → Documents.
  const tone = toneKey(toneIn || ctx.job.letterTone || (await getDocumentSettings()).letterTone);
  const fitResult = ctx.job.analyses?.fit?.result || null;
  const userMessage = buildLetterUserMessage({
    profile: ctx.profile, masterResume: ctx.resume, writingSamples: ctx.samples,
    fitResult, job: ctx.job, tone,
  });
  const { r, factGuard } = await generateGuarded({
    feature: 'coverLetter', model: ctx.models.coverLetter, system: LETTER_SYSTEM, userMessage, maxTokens: 2500,
    ctx, textOf: (res) => joinUnits(letterUnits(res)),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  const units = [...letterUnits(r.result).filter((u) => u.kind !== 'signoff'), signOffUnit(tone, ctx.candidateName)]
    .map((u, i) => ({ ...u, id: `u${i + 1}` }));
  if (!Array.isArray(r.result?.units)) {
    await logActivity({ type: 'units-fallback', jobId, ok: true, note: 'Letter came back as prose; split into paragraphs' });
  }
  const record = {
    result: r.result, tone, model: modelLabel, usage: r.usage, retried: r.retried,
    provider: r.provider, fellback: r.fellback,
    generatedAt: new Date().toISOString(),
    promptVersion: LETTER_PROMPT_VERSION,
    factGuard,
  };
  await upsertJob(jobId, { letterTone: tone, analyses: { coverLetter: record } });
  const saved = await changeDocument(jobId, 'letter', (doc) => writeVersion(doc, units, `${tone} tone`), ctx);
  return { ok: true, record: saved.record };
}

// The letter prompt (v5+) returns paragraphs as units; older or local
// models may still return prose, which is split on blank lines.
function letterUnits(res) {
  if (Array.isArray(res?.units)) {
    return res.units.filter((u) => typeof u?.text === 'string' && u.text.trim())
      .map((u, i) => ({ id: `u${i + 1}`, kind: ['opening', 'body', 'closing', 'greeting', 'signoff'].includes(u.kind) ? u.kind : 'body', text: u.text.trim() }));
  }
  return splitLetter(res?.letter || '');
}

// mustInclude — terms the last draft's keyword check found missing; the
// "Regenerate including these" button passes them back.
// Follow-up on an application that has gone quiet. The model sees only
// what was actually sent (tailored resume and cover letter, or the master
// resume if none was tailored) so the note can't introduce new claims.
async function runApplicationFollowUp(jobId) {
  const ctx = await loadContext(jobId);
  const a = ctx.job.analyses || {};
  const resumeText = a.resume?.result ? JSON.stringify(a.resume.result) : '';
  const submitted = [a.coverLetter?.result?.letter, resumeText].filter(Boolean).join('\n\n') || ctx.resume;
  const q = quietness(ctx.job);
  const appliedAt = ctx.job.application?.appliedAt || ctx.job.statusUpdatedAt;
  const userMessage = buildApplicationFollowUpUserMessage({
    job: ctx.job, submitted, profile: ctx.profile,
    appliedOn: appliedAt ? new Date(appliedAt).toDateString() : null,
    followUpNumber: Math.min((q?.followUps || 0) + 1, 2),
  });
  const r = await routeCall('coverLetter', {
    local: (model) => callOllamaJson({ model, system: APPLICATION_FOLLOWUP_SYSTEM, userMessage, maxTokens: 700 }),
    cloud: () => callJsonAnthropic({
      apiKey: ctx.apiKey, model: ctx.models.coverLetter,
      system: APPLICATION_FOLLOWUP_SYSTEM, userMessage, maxTokens: 700,
    }),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const record = {
    factGuard: guard(r.result?.body || '', factCorpus(ctx)),
    result: r.result, model: modelLabel, usage: r.usage,
    generatedAt: new Date().toISOString(), promptVersion: APPLICATION_FOLLOWUP_PROMPT_VERSION,
  };
  await setJobAnalysis(jobId, 'applicationFollowUp', record);
  return { ok: true, record };
}

// ---------- Undo the last status change ----------
//
// Restores what the newest status entry recorded it replaced (status,
// LinkedIn stage, manual lock) and logs the undo. One step only.
async function undoStatus(jobId) {
  const id = String(jobId || '');
  const job = await getJob(id);
  const t = undoTarget(job?.timeline);
  if (!t) return { ok: false, error: 'Nothing to undo' };
  const now = new Date().toISOString();
  const status = normalizeStatus(t.previousStatus);
  await upsertJob(id, {
    status, statusUpdatedAt: now,
    linkedInStage: t.previousLinkedInStage ?? undefined, manualLock: !!t.previousManualLock,
  }, {
    appendTimeline: [{ at: now, type: 'status-undone', from: job.status, to: status, undoes: t.at,
      note: `Undid ${statusLabel(job.status)}, back to ${statusLabel(status)}` }],
  });
  chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  return { ok: true, status, label: statusLabel(status) };
}

// ---------- Company-site lookup (freehire.me) ----------
//
// Is this LinkedIn job also on the employer's own careers site? Two
// keyless calls — the company by exact name, then its jobs by title — and
// a conservative match (lib/freehire.js). Cached on the job for a day;
// a match the user picked is refreshed by its id, never re-searched.
const SITE_TTL_MS = 24 * 60 * 60_000;
const siteKey = (id) => `companySite.${id}`;

async function freehireGet(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`freehire.me answered ${r.status}`);
  return (await r.json()).data;
}

async function saveSite(id, existing, site) {
  await chrome.storage.session.set({ [siteKey(id)]: site });
  if (existing) await upsertJob(id, { companySite: site });
  return site;
}

async function lookupCompanySite({ jobId, title, company, location, force }) {
  if (!(await getCompanySiteLookupEnabled())) return { ok: true, disabled: true };
  const id = String(jobId || '');
  if (!/^\d+$/.test(id) || !title || !company) return { ok: true, data: null };
  const existing = await getJob(id);
  const cached = existing?.companySite || (await chrome.storage.session.get(siteKey(id)))[siteKey(id)];
  if (cached && !force && Date.now() - Date.parse(cached.checkedAt) < SITE_TTL_MS) {
    // Looked up before the job was saved: keep it with the job now.
    if (existing && !existing.companySite) await upsertJob(id, { companySite: cached });
    return { ok: true, data: cached };
  }
  try {
    if (cached?.chosen) return { ok: true, data: await saveSite(id, existing, await refreshSite(cached)) };
    const c = pickCompany(await freehireGet(companiesUrl(company)), company);
    let site = { status: 'none' };
    if (c) {
      const { match, possible } = pickMatch(await freehireGet(jobsUrl(title, c.slug)), { title, company, location });
      site = match ? { status: 'match', match: summarize(match) }
        : possible.length ? { status: 'possible', possible: possible.map(summarize) } : { status: 'none' };
      site.companySlug = c.slug;
    }
    site.checkedAt = new Date().toISOString();
    return { ok: true, data: await saveSite(id, existing, site) };
  } catch (e) {
    // Service down or rate-limited: show what we had, cache nothing.
    return { ok: true, data: cached || null, error: e.message };
  }
}

// Re-read a matched posting by its id — picks up a close or a repost.
async function refreshSite(site) {
  const j = await freehireGet(jobUrl(site.match.slug));
  return { ...site, match: summarize(j), checkedAt: new Date().toISOString() };
}

// The user picked one of the "possible" postings, or said none of them.
async function chooseCompanySite(jobId, slug) {
  const id = String(jobId || '');
  const existing = await getJob(id);
  const site = slug
    ? { status: 'match', chosen: true, match: summarize(await freehireGet(jobUrl(slug))), checkedAt: new Date().toISOString() }
    : { status: 'none', chosen: true, checkedAt: new Date().toISOString() };
  return { ok: true, data: await saveSite(id, existing, site) };
}

// For applications waiting to hear back: has the employer closed the
// posting on its own site? Run when the Jawboard opens; at most 25 per
// run, each at most once a day.
async function refreshCompanySites() {
  if (!(await getCompanySiteLookupEnabled())) return { ok: true, refreshed: 0 };
  const due = (await listJobs()).filter((j) => (j.status === 'applied' || j.status === 'inProgressClickedApply')
    && j.companySite?.match?.slug && !j.companySite.match.closedAt
    && Date.now() - Date.parse(j.companySite.checkedAt || 0) > SITE_TTL_MS).slice(0, 25);
  let closed = 0;
  for (const j of due) {
    try {
      const site = await refreshSite(j.companySite);
      if (site.match.closedAt) closed++;
      await upsertJob(j.jobId, { companySite: site });
    } catch { break; } // service unavailable — try again next time
  }
  return { ok: true, refreshed: due.length, closed };
}

// Hiring-manager review of the current cover letter. Edits whose "old"
// text isn't in the letter verbatim are dropped — they could not be
// applied, and showing them would invite the user to hunt for text that
// isn't there.
async function runLetterReview(jobId) {
  const ctx = await loadContext(jobId);
  const letter = ctx.job.analyses?.coverLetter?.result?.letter;
  if (!letter) throw new Error('Generate a cover letter first.');
  const userMessage = buildLetterReviewUserMessage({
    letter, profile: ctx.profile, masterResume: ctx.resume, writingSamples: ctx.samples, job: ctx.job,
  });
  const r = await routeCall('coverLetter', {
    local: (model) => callOllamaJson({ model, system: LETTER_REVIEW_SYSTEM, userMessage, maxTokens: 2000 }),
    cloud: () => callJsonAnthropic({
      apiKey: ctx.apiKey, model: ctx.models.coverLetter,
      system: LETTER_REVIEW_SYSTEM, userMessage, maxTokens: 2000,
    }),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const corpus = factCorpus(ctx);
  const edits = (r.result?.edits || [])
    .filter((e) => e?.old && typeof e.new === 'string' && letter.split(e.old).length === 2)
    .map((e) => ({ ...e, flags: guard(e.new, corpus).flags }));
  const record = {
    result: { edits, notes: r.result?.notes || {} },
    reviewedLetter: letter, model: modelLabel, usage: r.usage,
    generatedAt: new Date().toISOString(), promptVersion: LETTER_REVIEW_PROMPT_VERSION,
  };
  await setJobAnalysis(jobId, 'letterReview', record);
  return { ok: true, record };
}

async function runResume(jobId, mustInclude) {
  const ctx = await loadContext(jobId);
  if (!ctx.resume) throw new Error('Master resume not uploaded. Add it in Settings first.');
  const fitResult = ctx.job.analyses?.fit?.result || null;
  const p = ctx.job.posting || {};
  const postingText = `${p.title || ''}\n${p.descriptionText || ''}`;
  // Exact-match terms the posting and master resume share: told to the
  // model up front, then checked in its output below.
  const shared = sharedTerms(postingText, ctx.resume);
  const userMessage = buildResumeUserMessage({
    profile: ctx.profile, masterResume: ctx.resume, fitResult, job: ctx.job, shared,
    mustInclude: Array.isArray(mustInclude) ? mustInclude.filter((t) => typeof t === 'string').slice(0, 40).map((t) => t.slice(0, 80)) : [],
  });
  const { r, factGuard } = await generateGuarded({
    feature: 'resume', model: ctx.models.resume, system: RESUME_SYSTEM, userMessage, maxTokens: 6000,
    ctx, textOf: resumeText,
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  const record = {
    factGuard,
    result: r.result, model: modelLabel, usage: r.usage, retried: r.retried,
    provider: r.provider, fellback: r.fellback,
    generatedAt: new Date().toISOString(),
    promptVersion: RESUME_PROMPT_VERSION,
    shared,
  };
  await setJobAnalysis(jobId, 'resume', record);
  const units = unitsFromResume(r.result);
  const saved = await changeDocument(jobId, 'resume', (doc) => writeVersion(doc, units, Array.isArray(mustInclude) && mustInclude.length ? 'Including left-out terms' : ''), ctx);
  return { ok: true, record: saved.record };
}

// ---------- Documents as units (lib/documentUnits.js, lib/documentHistory.js) ----------
//
// job.documents.{resume,letter} hold the units and their versions. Every
// change is saved through saveDocument, which also writes the joined
// text back into analyses.{resume,coverLetter}.result, so Copy, PDF, the
// keyword check, the letter review and follow-ups read the document as
// it now stands without knowing about units.

const DOC_ANALYSIS = { letter: 'coverLetter', resume: 'resume' };
const DOC_LABEL = { letter: 'cover letter', resume: 'tailored resume' };

const writeVersion = (doc, units, note) => (doc ? commitVersion(doc, units, 'written', note) : newDoc(units, 'written', note));

function withFlags(u, flags) {
  const { flags: _old, ...rest } = u;
  return flags.length ? { ...rest, flags } : rest;
}

function resumeKeywordCheck(ctx, result, shared) {
  const p = ctx.job.posting || {};
  return verifyResume({
    result, posting: `${p.title || ''}\n${p.descriptionText || ''}`, masterResume: ctx.resume, profile: ctx.profile,
    shared: shared || sharedTerms(`${p.title || ''}\n${p.descriptionText || ''}`, ctx.resume || ''),
  });
}

// Every save re-checks every part (regex only, no AI), so an undo or
// restore shows the flags the restored text deserves.
async function saveDocument(ctx, kind, saved) {
  const job = await getJob(ctx.job.jobId);
  const corpus = factCorpus(ctx, job);
  const doc = { ...saved, units: saved.units.map((u) => withFlags(u, guard(u.text, corpus).flags)) };
  const key = DOC_ANALYSIS[kind];
  const rec = job.analyses?.[key] || {};
  const flags = keptUnits(doc.units).flatMap((u) => (u.flags || []).map((f) => ({ ...f, unitId: u.id })));
  const record = { ...rec, editedAt: new Date().toISOString(), factGuard: { ...(rec.factGuard || {}), flags, clean: !flags.length } };
  if (kind === 'letter') {
    const { units: _u, ...result } = rec.result || {};
    record.result = { ...result, letter: joinUnits(doc.units) };
  } else {
    record.result = { ...(rec.result || {}), ...resumeFromUnits(doc.units) };
    record.keywordCheck = resumeKeywordCheck({ ...ctx, job }, record.result, rec.shared);
  }
  await upsertJob(job.jobId, { documents: { ...(job.documents || {}), [kind]: doc }, analyses: { [key]: record } });
  return { ok: true, doc, record };
}

// Load the document (migrating an old one), apply fn, save.
async function changeDocument(jobId, kind, fn, ctx) {
  if (!DOC_ANALYSIS[kind]) throw new Error(`Unknown document: ${kind}`);
  ctx = ctx || await loadContext(String(jobId || ''));
  const job = await getJob(ctx.job.jobId);
  const before = docFromJob(job, kind);
  const doc = fn(before);
  if (!doc) throw new Error(`No ${DOC_LABEL[kind]} yet. Generate one first.`);
  if (doc === before && job.documents?.[kind]) return { ok: true, doc, record: job.analyses?.[DOC_ANALYSIS[kind]], unchanged: true };
  return saveDocument(ctx, kind, doc);
}

// The user's own changes: edit a part's text, remove a part, or put a
// removed part back. changes: [{ id, text?, removed? }].
async function commitDocumentChanges(jobId, kind, changes, cause = 'edited', note = '') {
  const ctx = await loadContext(String(jobId || ''));
  return changeDocument(jobId, kind, (doc) => {
    if (!doc) return null;
    let changed = false;
    const units = doc.units.map((u) => {
      const c = (Array.isArray(changes) ? changes : []).find((x) => x?.id === u.id);
      if (!c) return u;
      const next = { ...u };
      if (typeof c.text === 'string' && c.text.trim() && EDITABLE_KINDS.has(u.kind) && c.text.trim() !== u.text) {
        next.text = c.text.trim().slice(0, 5000);
        changed = true;
      }
      if (typeof c.removed === 'boolean' && c.removed !== !!u.removed && u.kind !== 'header') {
        next.removed = c.removed;
        changed = true;
      }
      return next;
    });
    if (!changed) return doc;
    const ok = ['edited', 'trimmed', 'restored'].includes(cause) ? cause : 'edited';
    return commitVersion(doc, units, ok, String(note || '').slice(0, 300));
  }, ctx);
}

// Rewrite one part. The model sees the whole document and returns only
// the new text, which is fact-checked like everything else it writes.
async function runRegenerateUnit(jobId, kind, unitId, instruction) {
  const ctx = await loadContext(String(jobId || ''));
  const doc = docFromJob(ctx.job, kind);
  const unit = doc?.units.find((u) => u.id === unitId);
  if (!unit || !EDITABLE_KINDS.has(unit.kind)) throw new Error('That part cannot be regenerated.');
  const feature = kind === 'letter' ? 'coverLetter' : 'resume';
  const userMessage = buildRegenerateUnitUserMessage({
    units: doc.units, unit, instruction: typeof instruction === 'string' ? instruction.trim() : '', docLabel: DOC_LABEL[kind],
    profile: ctx.profile, masterResume: ctx.resume, job: ctx.job,
  });
  const r = await routeCall(feature, {
    local: (model) => callOllamaJson({ model, system: REGENERATE_UNIT_SYSTEM, userMessage, maxTokens: 800 }),
    cloud: () => callJsonAnthropic({ apiKey: ctx.apiKey, model: ctx.models[feature], system: REGENERATE_UNIT_SYSTEM, userMessage, maxTokens: 800 }),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const text = typeof r.result?.text === 'string' ? r.result.text.trim() : '';
  if (!text) throw new Error('The model returned no text. Try again.');
  const saved = await changeDocument(jobId, kind, (d) => {
    const units = d.units.map((u) => (u.id === unitId ? { ...u, text } : u));
    return commitVersion(d, units, 'regenerated', instruction ? String(instruction).slice(0, 300) : `Regenerated a ${unit.kind}`, undefined, { promptVersion: REGENERATE_UNIT_PROMPT_VERSION });
  }, ctx);
  return { ...saved, note: r.result?.note || '',
    record: { ...saved.record, model: modelLabel, provider: r.provider, usage: r.usage } };
}

// The Chat tab's "Edit the letter / resume" mode: the request becomes a
// refined version with the request as its note, undoable in one click.
async function runRefineDocument(jobId, kind, request) {
  const ask = typeof request === 'string' ? request.trim() : '';
  if (!ask) throw new Error('Say what to change.');
  const ctx = await loadContext(String(jobId || ''));
  const doc = docFromJob(ctx.job, kind);
  if (!doc) throw new Error(`No ${DOC_LABEL[kind]} yet. Generate one first.`);
  const feature = kind === 'letter' ? 'coverLetter' : 'resume';
  const userMessage = buildRefineDocumentUserMessage({
    units: doc.units, request: ask, docLabel: DOC_LABEL[kind], profile: ctx.profile, masterResume: ctx.resume, job: ctx.job,
  });
  const r = await routeCall(feature, {
    local: (model) => callOllamaJson({ model, system: REFINE_DOCUMENT_SYSTEM, userMessage, maxTokens: 3000 }),
    cloud: () => callJsonAnthropic({ apiKey: ctx.apiKey, model: ctx.models[feature], system: REFINE_DOCUMENT_SYSTEM, userMessage, maxTokens: 3000 }),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  let changed = 0;
  const saved = await changeDocument(jobId, kind, (d) => {
    const { units, touched } = applyRefine(d.units, r.result);
    changed = touched.length;
    return changed ? commitVersion(d, units, 'refined', ask.slice(0, 300), undefined, { promptVersion: REFINE_DOCUMENT_PROMPT_VERSION }) : d;
  }, ctx);
  return { ...saved, changed, note: r.result?.note || (changed ? '' : 'No change was made.'),
    record: { ...saved.record, model: modelLabel, provider: r.provider, usage: r.usage } };
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
  // Auto-promote to Interviewing when a round is added. Uses upgradeStatus
  // so already-interviewing jawbs stay put (idempotent), and terminal
  // states (Scar) are preserved — if the user later realizes they ARE
  // interviewing after all, they can un-scar via the mini-hunt or
  // Recall's status shortcuts. Only appends the timeline note when the
  // status actually moves, so editing an existing round doesn't spam
  // duplicate "promoted to Interviewing" entries.
  const now = new Date().toISOString();
  const newStatus = upgradeStatus(job.status, 'interviewing');
  const statusChanged = newStatus !== job.status;
  const patch = { interviewRounds: rounds };
  if (statusChanged) {
    patch.status = newStatus;
    patch.statusUpdatedAt = now;
    patch.manualLock = true; // tracker sightings don't undo this — see resolveTransition
  }
  const ops = statusChanged ? {
    appendTimeline: [{
      at: now,
      type: 'status-auto',
      note: `Interview round added: status promoted (${job.status || 'new'} → ${newStatus})`,
    }],
  } : {};
  const updated = await upsertJob(jobId, patch, ops);
  if (statusChanged) chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  return { ok: true, record: updated };
}

async function handleDeleteRound(jobId, roundId) {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not in Jawboard`);
  const rounds = (job.interviewRounds || []).filter((r) => r.id !== roundId);
  const updated = await upsertJob(jobId, { interviewRounds: rounds });
  return { ok: true, record: updated };
}

// Draft an answer to an open-ended application question. Called from
// the quick-fill toolbar on ATS pages when the user clicks the "Draft"
// pill above a focused textarea. Grounds the LLM strictly in the
// user's resume + profile + (if a jawb is active) the JD, and logs
// the Q&A to job.applicationAnswers so it can be recalled later when
// the recruiter phones.
async function handleDraftApplicationAnswer({ question, url, jobId, maxChars }) {
  if (typeof question !== 'string' || !question.trim()) {
    return { ok: false, error: 'Question text required' };
  }
  const trimmedQuestion = question.trim().slice(0, 1000);
  // A stated limit, from the field itself or the question's wording
  // ("max 200 words", "up to 500 characters").
  const words = trimmedQuestion.match(/(\d{2,4})\s*words?\b/i)?.[1];
  const chars = Number(maxChars) > 0 ? Number(maxChars) : Number(trimmedQuestion.match(/(\d{2,5})\s*char/i)?.[1]) || null;
  const limit = [words && `${words} words`, chars && `${chars} characters`].filter(Boolean).join(' and ');
  // Resolve which jawb this application belongs to. Explicit arg wins,
  // then the sidepanel's active-jawb hint written on renderJob, else null.
  let effectiveJobId = jobId;
  if (!effectiveJobId) {
    const r = await chrome.storage.local.get('ui.activeApplicationJawbId');
    effectiveJobId = r?.['ui.activeApplicationJawbId'] || null;
  }
  const [profile, resume, samples] = await Promise.all([
    getProfile(), getMasterResume(), getWritingSamples(),
  ]);
  let job = null;
  if (effectiveJobId) {
    try { job = await getJob(effectiveJobId); } catch { /* jawb gone, draft without context */ }
  }
  const systemLines = [
    'You are drafting an answer to a job application question.',
    '',
    'HARD RULES:',
    '- Ground your answer STRICTLY in the resume and profile provided below.',
    '- Never invent employers, dates, years of experience, titles, salary numbers, or specific projects that are not in the source material.',
    '- If the question requires a specific fact you cannot ground in the resume, leave a "[TODO: <what is missing>]" placeholder in your answer instead of making one up.',
    '- Return ONLY the answer text. No preamble ("Here is my answer:"), no meta-commentary, no bullet-point outline unless the question explicitly asks for one.',
    '',
    // Field-type guidance adapted from MadsLorentzen/ai-job-search (MIT).
    'BY QUESTION TYPE:',
    '- Self-introduction / "tell us about yourself": current situation, then the single strongest piece of evidence with its number and scale, then where he wants to go next tied to THIS employer. Lead with the strongest evidence, not chronology.',
    '- Project or experience entries: his role ON THAT PROJECT, which may be narrower than his job title; never upgrade it. Where he contributed rather than owned, say so. Use project dates, not employment dates.',
    '- Short pitches and tight limits: one concrete situation beats adjectives ("passionate", "fast learner", "team player").',
    '- Motivation ("why us"): use only what the job context says about the company; never supply company facts from memory.',
    '',
    HUMAN_STYLE,
    '',
    'VOICE: match the writing samples below if present. Otherwise write first-person, professional-but-warm.',
    '',
    limit
      ? `LENGTH, HARD LIMIT: ${limit}. Count before answering; portals cut longer answers off silently. Aim for about 90% of the limit.`
      : 'LENGTH: default to 150-250 words. Match the implied scope of the question. Short-answer prompts get a couple of sentences; essay-style prompts get 200-300 words.',
    '',
  ];
  if (profile) systemLines.push('=== USER PROFILE ===', profile, '');
  if (resume) systemLines.push('=== RESUME ===', resume, '');
  if (samples) systemLines.push('=== WRITING SAMPLES ===', samples, '');
  if (job?.posting) {
    systemLines.push('=== JOB CONTEXT ===');
    if (job.posting.title) systemLines.push(`Title: ${job.posting.title}`);
    if (job.posting.company) systemLines.push(`Company: ${job.posting.company}`);
    if (job.posting.descriptionText) {
      systemLines.push('Description:');
      systemLines.push(UNTRUSTED_POSTING(String(job.posting.descriptionText).slice(0, 8000)));
    }
    systemLines.push('');
  }
  systemLines.push('=== APPLICATION QUESTION ===');
  systemLines.push(trimmedQuestion);
  const system = systemLines.join('\n');

  const started = performance.now();
  // Through routeCall like every other analysis (local routing applies).
  const r = await routeCall('brief', {
    local: async (model) => {
      const t = await callOllamaText({ model, system, userMessage: 'Please draft this answer now.', maxTokens: 1500 });
      return { text: t.text, usage: t.usage, model: t.model };
    },
    cloud: async () => {
      const c = await callAI({ system, messages: [{ role: 'user', content: 'Please draft this answer now.' }], maxTokens: 1500 });
      return { text: c.text, usage: c.usage || null, model: c.model };
    },
  });
  const durationMs = Math.round(performance.now() - started);
  let answer = (r.text || '').trim();
  if (!answer) return { ok: false, error: 'LLM returned an empty draft' };
  // Over a hard character limit anyway: cut back to the last whole
  // sentence that fits, rather than let the portal chop mid-word.
  if (chars && answer.length > chars) {
    const cut = answer.slice(0, chars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    answer = (end > chars * 0.5 ? cut.slice(0, end + 1) : cut).trim();
  }
  // Facts in the answer that the user's material and the posting don't
  // contain. Returned so the form's toolbar can warn, and stored with it.
  const p = job?.posting || {};
  const factGuard = guard(answer, buildCorpus({
    profile, masterResume: resume, writingSamples: samples,
    posting: [p.title, p.company, p.descriptionText].filter(Boolean).join('\n'),
  }));

  // Persist the Q&A on the jawb record if we have one. Cap the array so
  // a runaway loop can't balloon storage. Timeline gets a short note so
  // the Recall page's voyage log surfaces "drafted answer on X" alongside
  // status changes.
  if (effectiveJobId && job) {
    const now = new Date().toISOString();
    const entry = {
      id: `qa-${Date.now()}`,
      question: trimmedQuestion,
      answer,
      at: now,
      url: typeof url === 'string' ? url.slice(0, 500) : null,
      source: 'ai-drafted',
      model: r.model,
      provider: r.provider,
      factGuard,
    };
    const nextAnswers = [...(job.applicationAnswers || []), entry].slice(-100);
    await upsertJob(effectiveJobId, { applicationAnswers: nextAnswers }, {
      appendTimeline: [{
        at: now,
        type: 'application-answer',
        note: `Drafted answer for: ${trimmedQuestion.length > 80 ? trimmedQuestion.slice(0, 80) + '…' : trimmedQuestion}`,
      }],
    });
    chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  }
  await addUsage({ model: r.model, usage: r.usage || null });
  await logActivity({
    type: 'draft-application-answer',
    jobId: effectiveJobId,
    ok: true,
    model: r.model,
    provider: r.provider,
    inputTokens: r.usage?.input_tokens || 0,
    outputTokens: r.usage?.output_tokens || 0,
    durationMs,
  });
  chrome.runtime.sendMessage({ type: 'usage-updated' }).catch(() => {});
  return { ok: true, answer, jobId: effectiveJobId, flags: factGuard.flags };
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
  const ctx = await loadContext(jobId);
  const job = ctx.job;
  const round = (job.interviewRounds || []).find((r) => r.id === roundId);
  if (!round) throw new Error(`Round ${roundId} not found`);

  const fitResult = job.analyses?.fit?.result || null;
  const userMessage = buildUserMessage({ profile: ctx.profile, masterResume: ctx.resume, fitResult, job, round });
  // Through routeCall like every other analysis, so the chosen provider
  // and local routing apply (this used to call Anthropic directly).
  const r = await routeCall('brief', {
    local: (m) => callOllamaJson({ model: m, system, userMessage, maxTokens }),
    cloud: () => callJsonAnthropic({ apiKey: ctx.apiKey, model, system, userMessage, maxTokens }),
  });
  const usedModel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: usedModel, usage: r.usage });

  const generatedAt = new Date().toISOString();
  const payload = {
    result: r.result, model: usedModel, usage: r.usage, retried: r.retried, provider: r.provider, generatedAt, promptVersion,
    // The follow-up email is sent to a person, so its facts are checked.
    ...(field === 'followUp' ? { factGuard: guard(r.result?.body || '', factCorpus(ctx)) } : {}),
  };
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

// ---------- Inbound email (paste) ----------
//
// The user pastes an email; it is matched to a saved job with no AI call
// (lib/emailMatch.js), then classified on request. The email and its
// classification become an 'email' timeline entry, which also restarts the
// follow-up clock (lib/followups.js counts any dated entry as contact).

const EMAIL_KINDS = new Set(['rejection', 'interview', 'question', 'offer', 'acknowledgement', 'other']);

async function runEmailMatch(text) {
  const email = parseEmail(String(text || '').slice(0, 20000));
  if (!email.body && !email.subject) throw new Error('Paste the email first.');
  const candidates = matchEmail(email, await listJobs()).map(({ job, score, reason }) => ({
    jobId: job.jobId, title: job.posting?.title || '', company: job.posting?.company || '', status: job.status, score, reason,
  }));
  return { ok: true, email, candidates };
}

async function runClassifyEmail(jobId, raw) {
  const email = { from: String(raw?.from || '').slice(0, 300), subject: String(raw?.subject || '').slice(0, 300), body: String(raw?.body || '').slice(0, 8000) };
  const ctx = await loadContext(String(jobId || ''));
  const userMessage = buildClassifyEmailUserMessage({ email, job: ctx.job, today: new Date().toDateString() });
  const r = await routeCall('ask', {
    local: (model) => callOllamaJson({ model, system: CLASSIFY_EMAIL_SYSTEM, userMessage, maxTokens: 800 }),
    cloud: () => callJsonAnthropic({ apiKey: ctx.apiKey, model: ctx.models.fit, system: CLASSIFY_EMAIL_SYSTEM, userMessage, maxTokens: 800 }),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const c = r.result || {};
  const status = c.suggestedStatus && c.suggestedStatus in STATUS && c.suggestedStatus !== 'analyzed' ? c.suggestedStatus : null;
  // A bare date stays a date: as an instant it would be UTC midnight,
  // the day before in the Americas.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(c.interviewAt || '');
  const when = Date.parse(c.interviewAt || '');
  const classification = {
    kind: EMAIL_KINDS.has(c.kind) ? c.kind : 'other',
    summary: String(c.summary || '').slice(0, 600),
    questions: (Array.isArray(c.questions) ? c.questions : []).filter((q) => typeof q === 'string').slice(0, 10).map((q) => q.slice(0, 300)),
    suggestedStatus: status,
    interviewAt: dateOnly ? c.interviewAt : Number.isFinite(when) ? new Date(when).toISOString() : null,
    interviewFormat: ['phone', 'video', 'onsite'].includes(c.interviewFormat) ? c.interviewFormat : null,
    promptVersion: CLASSIFY_EMAIL_PROMPT_VERSION,
  };
  const at = new Date().toISOString();
  await upsertJob(ctx.job.jobId, {}, { appendTimeline: [{
    at, type: 'email', note: `${classification.kind[0].toUpperCase()}${classification.kind.slice(1)} email${email.subject ? `: ${email.subject}` : ''}. ${classification.summary}`.slice(0, 400),
    email, classification,
  }] });
  return { ok: true, at, classification, record: { model: modelLabel, provider: r.provider, usage: r.usage } };
}

async function emailEntry(jobId, at) {
  const job = await getJob(String(jobId || ''));
  const entry = (job?.timeline || []).find((e) => e.type === 'email' && e.at === at);
  if (!entry) throw new Error('That email is no longer on this jawb.');
  return { job, entry };
}

async function runDraftReply(jobId, at) {
  const { entry } = await emailEntry(jobId, at);
  const ctx = await loadContext(String(jobId));
  const userMessage = buildDraftReplyUserMessage({ email: entry.email, classification: entry.classification, job: ctx.job, profile: ctx.profile, writingSamples: ctx.samples });
  const r = await routeCall('coverLetter', {
    local: (model) => callOllamaJson({ model, system: DRAFT_REPLY_SYSTEM, userMessage, maxTokens: 1200 }),
    cloud: () => callJsonAnthropic({ apiKey: ctx.apiKey, model: ctx.models.coverLetter, system: DRAFT_REPLY_SYSTEM, userMessage, maxTokens: 1200 }),
  });
  const modelLabel = r.provider === 'local' ? `local:${r.model}` : r.model;
  await addUsage({ model: modelLabel, usage: r.usage });
  const body = String(r.result?.body || '').slice(0, 6000);
  if (!body) throw new Error('The model returned no reply. Try again.');
  const reply = {
    subject: String(r.result?.subject || '').slice(0, 300), body,
    unanswered: (Array.isArray(r.result?.unanswered) ? r.result.unanswered : []).filter((q) => typeof q === 'string').slice(0, 10),
    factGuard: guard(body, factCorpus(ctx, ctx.job, `${entry.email?.subject || ''}\n${entry.email?.body || ''}`)),
    generatedAt: new Date().toISOString(), promptVersion: DRAFT_REPLY_PROMPT_VERSION,
  };
  // Re-read: the timeline may have moved on while the model ran.
  const fresh = await getJob(String(jobId));
  await upsertJob(fresh.jobId, { timeline: fresh.timeline.map((e) => (e.type === 'email' && e.at === at ? { ...e, reply } : e)) });
  return { ok: true, reply, record: { model: modelLabel, provider: r.provider, usage: r.usage } };
}

// The user clicked "Move to X" on an email. resolveTransition decides
// (lib/statuses.js, kind 'email'): forward only, and a job the user
// closed by hand stays closed.
async function moveStatusFromEmail(jobId, status) {
  const job = await getJob(String(jobId || ''));
  if (!job) throw new Error('Save this jawb first.');
  const next = resolveTransition(job, { kind: 'email', explicit: true, status });
  if (next.status === normalizeStatus(job.status)) {
    return { ok: true, changed: false, status: next.status, label: statusLabel(next.status) };
  }
  const now = new Date().toISOString();
  await upsertJob(job.jobId, { status: next.status, statusUpdatedAt: now, manualLock: next.manualLock }, {
    appendTimeline: [{ at: now, type: 'status-change', to: next.status, source: 'email', note: `From an email: ${statusLabel(job.status)} to ${statusLabel(next.status)}` }],
  });
  chrome.runtime.sendMessage({ type: 'archive-updated' }).catch(() => {});
  return { ok: true, changed: true, status: next.status, label: statusLabel(next.status) };
}

// "Add round" from an interview email: date and time as the email gave
// them, type and topic by position like Recall's Add round.
async function addRoundFromEmail(jobId, at) {
  const { job, entry } = await emailEntry(jobId, at);
  const at0 = entry.classification?.interviewAt || '';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(at0);
  const when = at0 ? new Date(dateOnly ? `${at0}T00:00` : at0) : null;
  const pad = (n) => String(n).padStart(2, '0');
  const type = defaultRoundType((job.interviewRounds || []).length);
  return handleSaveRound(job.jobId, {
    date: when ? `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` : '',
    time: when && !dateOnly ? `${pad(when.getHours())}:${pad(when.getMinutes())}` : '',
    type, topic: defaultTopicFor(type) || (entry.classification?.interviewFormat ? `${entry.classification.interviewFormat} interview` : ''),
  });
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
