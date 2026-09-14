import { DEFAULT_MODELS } from './models.js';
import {
  DEFAULT_PROFILE, DEFAULT_COMP_TARGETS,
  DEFAULT_WRITING_SAMPLES, DEFAULT_MASTER_RESUME,
  DEFAULT_WORK_LOCATIONS, DEFAULT_WORK_PREFERENCES,
  DEFAULT_PREP_QUESTIONS,
} from './defaults.js';

const KEY_API = 'settings.apiKey';
const KEY_MODELS = 'settings.models';
// Provider choice + per-provider API keys. Only ONE provider is
// active at a time; the aiRouter reads settings.cloudProvider and
// resolves the corresponding key. Legacy: KEY_API stays as the
// Anthropic key so existing installs don't lose their credential
// during the upgrade.
const KEY_CLOUD_PROVIDER = 'settings.cloudProvider';
const KEY_OPENAI_KEY = 'settings.openaiApiKey';
const KEY_GEMINI_KEY = 'settings.geminiApiKey';
const KEY_PROFILE = 'settings.profile';
const KEY_RESUME = 'settings.masterResume';
const KEY_COMP = 'settings.compTargets';
const KEY_SAMPLES = 'settings.writingSamples';
const KEY_LAST_EXPORT = 'settings.lastExportAt';
const KEY_AUTO_ANALYZE = 'settings.autoAnalyzeHighMatch';
const KEY_LINKEDIN_URL = 'settings.linkedInProfileUrl';
const KEY_EMAIL = 'settings.email';
const KEY_PHONE = 'settings.phone';
const KEY_LOCATION = 'settings.location';
const KEY_WORK_LOCATIONS = 'settings.workLocations';
const KEY_WORK_PREFERENCES = 'settings.workPreferences';
const KEY_KNOWLEDGE_BASE = 'settings.knowledgeBase';
const KEY_LOCAL_MODEL = 'settings.localModel';
const KEY_PREP_QUESTIONS = 'settings.prepQuestions';
const KEY_NEGATIVE_KEYWORDS = 'settings.negativeKeywords';
const KEY_SAVED_SEARCHES = 'settings.savedSearches';
// Recent LinkedIn searches — automatic history separate from the
// user-curated saved list. Populated by the content script whenever a
// /jobs/search page loads with meaningful filters. Capped at 20; dedup
// on canonical URL so revisiting bumps the entry.
const KEY_RECENT_SEARCHES = 'recentSearches';
const RECENT_SEARCHES_MAX = 20;

// Local-LLM feature routing defaults — every feature starts CLOUD (opt-in local).
const DEFAULT_LOCAL_MODEL = {
  enabled: false,
  model: 'qwen2.5:14b-instruct',
  features: {
    fit: false,
    comp: false,
    brief: false,
    coverLetter: false,
    resume: false,
  },
};
const KEY_USAGE = 'usage.lifetime';
const KEY_USAGE_DAILY = 'usage.daily';
const KEY_ACTIVITY = 'log.activity';
const MAX_ACTIVITY = 500;
const DAILY_RETENTION_DAYS = 90;
const KEY_JOB_INDEX = 'jobs.index';
const KEY_JOB_PREFIX = 'job.';

// ---------- Cached context bundle ----------
// Session-stable settings that every analysis reads. Bulk-fetched once, cached
// in memory, and auto-invalidated when any of these keys changes via
// chrome.storage.onChanged. Cuts loadContext() from 9 storage reads to 1 on
// cold and to 0 on subsequent analyses within the same service-worker life.

const CTX_KEYS = [
  'settings.apiKey', 'settings.models', 'settings.profile', 'settings.masterResume',
  'settings.compTargets', 'settings.writingSamples',
  'settings.workLocations', 'settings.workPreferences', 'settings.knowledgeBase',
  'settings.prepQuestions',
];
let _ctxCache = null;

export async function getContextSettings() {
  if (_ctxCache) return _ctxCache;
  const r = await chrome.storage.local.get(CTX_KEYS);
  _ctxCache = {
    apiKey: r['settings.apiKey'] || '',
    models: { ...DEFAULT_MODELS, ...(r['settings.models'] || {}) },
    profile: typeof r['settings.profile'] === 'string' ? r['settings.profile'] : DEFAULT_PROFILE,
    resume: typeof r['settings.masterResume'] === 'string' ? r['settings.masterResume'] : DEFAULT_MASTER_RESUME,
    comp: { ...DEFAULT_COMP_TARGETS, ...(r['settings.compTargets'] || {}) },
    samples: typeof r['settings.writingSamples'] === 'string' ? r['settings.writingSamples'] : DEFAULT_WRITING_SAMPLES,
    workLocations: Array.isArray(r['settings.workLocations']) ? r['settings.workLocations'] : DEFAULT_WORK_LOCATIONS,
    workPreferences: { ...DEFAULT_WORK_PREFERENCES, ...(r['settings.workPreferences'] || {}) },
    knowledgeBase: typeof r['settings.knowledgeBase'] === 'string' ? r['settings.knowledgeBase'] : '',
    prepQuestions: Array.isArray(r['settings.prepQuestions']) ? r['settings.prepQuestions'] : DEFAULT_PREP_QUESTIONS,
  };
  return _ctxCache;
}

// Fires in every context (SW, options, panel) when any context writes storage,
// so an options-page save propagates to the service worker's cache automatically.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (CTX_KEYS.some((k) => k in changes)) _ctxCache = null;
  });
}

// ---------- Settings ----------

export async function getApiKey() {
  const r = await chrome.storage.local.get(KEY_API);
  return r[KEY_API] || '';
}
export async function setApiKey(key) {
  await chrome.storage.local.set({ [KEY_API]: key });
}

// Cloud provider — 'anthropic' | 'openai' | 'gemini'. Defaults to
// Anthropic so existing installs behave exactly as before until the
// user opens Settings → AI and picks something else.
export async function getCloudProvider() {
  const r = await chrome.storage.local.get(KEY_CLOUD_PROVIDER);
  const v = r[KEY_CLOUD_PROVIDER];
  return (v === 'openai' || v === 'gemini') ? v : 'anthropic';
}
export async function setCloudProvider(provider) {
  const safe = (provider === 'openai' || provider === 'gemini') ? provider : 'anthropic';
  await chrome.storage.local.set({ [KEY_CLOUD_PROVIDER]: safe });
}

export async function getOpenAIKey() {
  const r = await chrome.storage.local.get(KEY_OPENAI_KEY);
  return r[KEY_OPENAI_KEY] || '';
}
export async function setOpenAIKey(key) {
  await chrome.storage.local.set({ [KEY_OPENAI_KEY]: key });
}
export async function getGeminiKey() {
  const r = await chrome.storage.local.get(KEY_GEMINI_KEY);
  return r[KEY_GEMINI_KEY] || '';
}
export async function setGeminiKey(key) {
  await chrome.storage.local.set({ [KEY_GEMINI_KEY]: key });
}

export async function getModels() {
  const r = await chrome.storage.local.get(KEY_MODELS);
  return { ...DEFAULT_MODELS, ...(r[KEY_MODELS] || {}) };
}
export async function setModels(models) {
  await chrome.storage.local.set({ [KEY_MODELS]: models });
}

export async function getProfile() {
  const r = await chrome.storage.local.get(KEY_PROFILE);
  return typeof r[KEY_PROFILE] === 'string' ? r[KEY_PROFILE] : DEFAULT_PROFILE;
}
export async function setProfile(text) {
  await chrome.storage.local.set({ [KEY_PROFILE]: text });
}

export async function getMasterResume() {
  const r = await chrome.storage.local.get(KEY_RESUME);
  return typeof r[KEY_RESUME] === 'string' ? r[KEY_RESUME] : DEFAULT_MASTER_RESUME;
}
export async function setMasterResume(text) {
  await chrome.storage.local.set({ [KEY_RESUME]: text });
}

export async function getCompTargets() {
  const r = await chrome.storage.local.get(KEY_COMP);
  return { ...DEFAULT_COMP_TARGETS, ...(r[KEY_COMP] || {}) };
}
export async function setCompTargets(targets) {
  await chrome.storage.local.set({ [KEY_COMP]: targets });
}

export async function getWritingSamples() {
  const r = await chrome.storage.local.get(KEY_SAMPLES);
  return typeof r[KEY_SAMPLES] === 'string' ? r[KEY_SAMPLES] : DEFAULT_WRITING_SAMPLES;
}
export async function setWritingSamples(text) {
  await chrome.storage.local.set({ [KEY_SAMPLES]: text });
}

export async function getLinkedInProfileUrl() {
  const r = await chrome.storage.local.get(KEY_LINKEDIN_URL);
  return r[KEY_LINKEDIN_URL] || '';
}
export async function setLinkedInProfileUrl(url) {
  await chrome.storage.local.set({ [KEY_LINKEDIN_URL]: url });
}

export async function getContactEmail() {
  const r = await chrome.storage.local.get(KEY_EMAIL);
  return r[KEY_EMAIL] || '';
}
export async function setContactEmail(v) {
  await chrome.storage.local.set({ [KEY_EMAIL]: v });
}

export async function getContactPhone() {
  const r = await chrome.storage.local.get(KEY_PHONE);
  return r[KEY_PHONE] || '';
}
export async function setContactPhone(v) {
  await chrome.storage.local.set({ [KEY_PHONE]: v });
}

export async function getContactLocation() {
  const r = await chrome.storage.local.get(KEY_LOCATION);
  return r[KEY_LOCATION] || '';
}
export async function setContactLocation(v) {
  await chrome.storage.local.set({ [KEY_LOCATION]: v });
}

export async function getWorkLocations() {
  const r = await chrome.storage.local.get(KEY_WORK_LOCATIONS);
  return Array.isArray(r[KEY_WORK_LOCATIONS]) ? r[KEY_WORK_LOCATIONS] : DEFAULT_WORK_LOCATIONS;
}
export async function setWorkLocations(list) {
  await chrome.storage.local.set({ [KEY_WORK_LOCATIONS]: Array.isArray(list) ? list : [] });
}

export async function getKnowledgeBase() {
  const r = await chrome.storage.local.get(KEY_KNOWLEDGE_BASE);
  return typeof r[KEY_KNOWLEDGE_BASE] === 'string' ? r[KEY_KNOWLEDGE_BASE] : '';
}
export async function setKnowledgeBase(text) {
  await chrome.storage.local.set({ [KEY_KNOWLEDGE_BASE]: text || '' });
}

export async function getPrepQuestions() {
  const r = await chrome.storage.local.get(KEY_PREP_QUESTIONS);
  return Array.isArray(r[KEY_PREP_QUESTIONS]) ? r[KEY_PREP_QUESTIONS] : DEFAULT_PREP_QUESTIONS;
}
export async function setPrepQuestions(list) {
  const clean = Array.isArray(list)
    ? list.map((q) => (typeof q === 'string' ? q.trim() : '')).filter(Boolean)
    : [];
  await chrome.storage.local.set({ [KEY_PREP_QUESTIONS]: clean });
}

// Negative keywords — case-insensitive substring matches applied to
// LinkedIn search-results job cards. A card that matches ANY keyword
// gets dimmed on the page. Empty list = no filtering.
export async function getNegativeKeywords() {
  const r = await chrome.storage.local.get(KEY_NEGATIVE_KEYWORDS);
  return Array.isArray(r[KEY_NEGATIVE_KEYWORDS]) ? r[KEY_NEGATIVE_KEYWORDS] : [];
}
export async function setNegativeKeywords(list) {
  const clean = Array.isArray(list)
    ? list.map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean)
    : [];
  await chrome.storage.local.set({ [KEY_NEGATIVE_KEYWORDS]: clean });
}

// ---------- Saved LinkedIn searches ----------
// A "saved search" is a full LinkedIn /jobs/search/* URL plus a parsed
// snapshot of its filter params. We keep the URL as source-of-truth so
// LinkedIn URL-schema changes only affect the parser, not stored data.

export async function getSavedSearches() {
  const r = await chrome.storage.local.get(KEY_SAVED_SEARCHES);
  const list = Array.isArray(r[KEY_SAVED_SEARCHES]) ? r[KEY_SAVED_SEARCHES] : [];
  // Self-heal older entries whose URL uses /jobs/search-results/ or
  // LinkedIn's landing-mode params — those don't apply their filters
  // when reopened. Rewrite once, persist, and hand back the fresh
  // list. New entries already flow through runnableSearchUrl on write.
  // A null return from runnableSearchUrl means the stored URL had an
  // unsafe scheme (javascript:, data:, …) — drop the entry entirely so
  // it can never render as an href.
  let dirty = false;
  const fixed = [];
  for (const s of list) {
    if (!s?.url) { fixed.push(s); continue; }
    const clean = runnableSearchUrl(s.url);
    if (!clean) { dirty = true; continue; }
    if (clean === s.url) { fixed.push(s); continue; }
    dirty = true;
    fixed.push({ ...s, url: clean, criteria: parseSearchUrl(clean) });
  }
  if (dirty) await chrome.storage.local.set({ [KEY_SAVED_SEARCHES]: fixed });
  return fixed;
}
export async function addSavedSearch({ name, url }) {
  if (!url) throw new Error('URL required');
  // Normalize on write so the persisted URL always applies its filters
  // when reopened. LinkedIn's /jobs/search-results/ + landing params
  // produce a "chips shown but not applied" state — see runnableSearchUrl.
  const cleanUrl = runnableSearchUrl(url);
  if (!cleanUrl) throw new Error('Only http(s) URLs may be saved as searches.');
  const list = await getSavedSearches();
  const id = `srch_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000).toString(36)}`;
  const entry = {
    id,
    name: (name || '').trim() || defaultSearchName(cleanUrl),
    url: cleanUrl,
    criteria: parseSearchUrl(cleanUrl),
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastResultIds: [],
    lastNewCount: 0,
  };
  list.unshift(entry);
  await chrome.storage.local.set({ [KEY_SAVED_SEARCHES]: list });
  return entry;
}
export async function deleteSavedSearch(id) {
  const list = await getSavedSearches();
  const next = list.filter((s) => s.id !== id);
  await chrome.storage.local.set({ [KEY_SAVED_SEARCHES]: next });
  return { ok: true };
}

// ---------- Recent (unsaved) LinkedIn searches ----------

// Canonical form of a LinkedIn search URL used as the dedup key. Sort
// query params so ?a=1&b=2 and ?b=2&a=1 collapse to one entry, and
// strip session-noise params (`origin`, `refresh`, LinkedIn's `spellCorrectionEnabled`)
// that shouldn't create duplicates.
function canonicalSearchUrl(url) {
  try {
    // Normalize path + strip landing params first so /jobs/search-results/
    // and /jobs/search/ collapse to the same canonical key. Without this
    // pre-pass, a visit to search-results wouldn't be recognized as the
    // same as a stored /jobs/search/ saved search.
    const runnable = runnableSearchUrl(url);
    if (!runnable) return url; // dedup keys are best-effort — unsafe schemes fall back to raw
    const u = new URL(runnable);
    const noise = new Set([
      // LinkedIn-side session noise
      'origin', 'refresh', 'spellCorrectionEnabled', 'position', 'pageNum',
      'trk', 'sortBy', 'originToLandingJobPostings',
      // Google Search session/telemetry noise — these change on every
      // visit and would otherwise defeat dedup. Only `q` and `udm`
      // survive as the real identifying signal.
      'sca_esv', 'sxsrf', 'ei', 'uact', 'oq', 'gs_lp', 'sclient', 'jbr',
      'biw', 'bih', 'source', 'iflsig', 'ved', 'bshm', 'aqs', 'client',
      'safe', 'hl', 'gl', 'gws_rd', 'newwindow',
    ]);
    const params = Array.from(u.searchParams.entries())
      .filter(([k]) => !noise.has(k))
      .sort(([a], [b]) => a.localeCompare(b));
    const qs = params.map(([k, v]) => `${k}=${v}`).join('&');
    return `${u.origin}${u.pathname.replace(/\/$/, '')}${qs ? '?' + qs : ''}`;
  } catch { return url; }
}

// Runnable form of a LinkedIn search URL. LinkedIn's `/jobs/search-results/`
// endpoint plus `origin=PREFERENCES_LANDING` + `originToLandingJobPostings`
// puts the page in a "landing" state where the filter chips are
// pre-populated in the UI but NOT applied to the results — the user
// has to open any filter and click "Show results" to trigger a real
// search. Rewriting to `/jobs/search/` and stripping those landing
// params makes the URL actually run its filters when opened.
//
// Preserves genuine params (keywords, geoId, f_*, currentJobId) and
// the original param order so nothing else about the URL changes.
export function runnableSearchUrl(url) {
  try {
    const u = new URL(url);
    // Scheme allowlist — reject `javascript:`, `data:`, `file:`, etc.
    // Without this, an imported backup with a `javascript:` saved-search
    // URL would execute in the extension's origin the first time the
    // user clicked it.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (/\/jobs\/search-results\/?$/.test(u.pathname)) {
      u.pathname = u.pathname.replace('/jobs/search-results/', '/jobs/search/')
        .replace('/jobs/search-results', '/jobs/search');
    }
    // Landing-mode markers that suppress filter application.
    for (const k of ['origin', 'originToLandingJobPostings', 'refresh', 'trk']) {
      u.searchParams.delete(k);
    }
    return u.toString();
  } catch { return null; }
}

// Cheap scheme guard for any URL we're about to hand to an anchor's
// href or window.open(). Returns the URL unchanged if safe, or '#'
// otherwise. Callers should use this on any URL that originated in
// user-editable storage.
export function safeExternalUrl(url) {
  if (!url) return '#';
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') return url;
  } catch { /* fall through */ }
  return '#';
}

export async function getRecentSearches() {
  const r = await chrome.storage.local.get(KEY_RECENT_SEARCHES);
  return Array.isArray(r[KEY_RECENT_SEARCHES]) ? r[KEY_RECENT_SEARCHES] : [];
}

export async function addRecentSearch({ url, name }) {
  if (!url) return;
  // Store the runnable form so clicking a recent entry re-runs the
  // filters instead of landing in LinkedIn's chip-only state. Drop
  // silently when the URL has an unsafe scheme — recent-searches is
  // best-effort background telemetry, not something to error on.
  const cleanUrl = runnableSearchUrl(url);
  if (!cleanUrl) return;
  const canonical = canonicalSearchUrl(cleanUrl);
  const now = new Date().toISOString();
  const entry = {
    canonical,
    url: cleanUrl,
    name: (name || '').trim() || defaultSearchName(cleanUrl),
    criteria: parseSearchUrl(cleanUrl),
    viewedAt: now,
  };
  const list = await getRecentSearches();
  const filtered = list.filter((e) => e.canonical !== canonical);
  filtered.unshift(entry);
  const next = filtered.slice(0, RECENT_SEARCHES_MAX);
  await chrome.storage.local.set({ [KEY_RECENT_SEARCHES]: next });
  return entry;
}

export async function clearRecentSearches() {
  await chrome.storage.local.set({ [KEY_RECENT_SEARCHES]: [] });
}

// Bump lastRunAt on any saved search whose canonical URL matches.
// Called when the user visits a URL that matches a saved search, or
// clicks "Run" from the Searches tab. Used to power the stale-saved
// nudge (24h+ untouched).
export async function markSavedSearchRun(url) {
  if (!url) return;
  const target = canonicalSearchUrl(url);
  const list = await getSavedSearches();
  let touched = false;
  const next = list.map((s) => {
    if (canonicalSearchUrl(s.url) !== target) return s;
    touched = true;
    return { ...s, lastRunAt: new Date().toISOString() };
  });
  if (touched) await chrome.storage.local.set({ [KEY_SAVED_SEARCHES]: next });
}

// Convenience — for the recent-searches tab, we want the list of
// recents WITHOUT any URL that's already in the saved-search list, so
// the two lists don't visually duplicate each other.
export async function getRecentSearchesFiltered() {
  const [recent, saved] = await Promise.all([getRecentSearches(), getSavedSearches()]);
  const savedSet = new Set(saved.map((s) => canonicalSearchUrl(s.url)));
  return recent.filter((r) => !savedSet.has(r.canonical));
}

// Pull the interesting bits out of a LinkedIn /jobs/search/ URL so the UI
// can render human-readable filter chips. All fields are optional.
export function parseSearchUrl(url) {
  try {
    const u = new URL(url);
    const q = u.searchParams;
    // f_TPR maps to time-posted range: r86400 = 24h, r604800 = 7d, r2592000 = 30d
    const tpr = q.get('f_TPR') || '';
    const tprHours = tpr === 'r86400' ? 24 : tpr === 'r604800' ? 168 : tpr === 'r2592000' ? 720 : null;
    return {
      keywords: q.get('keywords') || '',
      geoId: q.get('geoId') || '',
      distance: q.get('distance') || '',
      tprHours,                          // hours since posting
      inNetwork: q.get('f_JIYN') === 'true',
      easyApply: q.get('f_AL') === 'true',
      workplace: q.get('f_WT') || '',    // 1=on-site 2=remote 3=hybrid (comma-list)
      experience: q.get('f_E') || '',    // 1..6 (comma-list)
      jobType: q.get('f_JT') || '',      // F/P/C/T/I/V/O (comma-list)
    };
  } catch {
    return {};
  }
}

// Detect Google Jobs URLs so the name/canonical/parse layers can
// treat them source-appropriately. Google's jobs experience lives at
// google.com/search with udm=8 or the legacy ibp=htl;jobs.
function isGoogleJobsSearchUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname)) return false;
    if (!/^\/search\/?$/.test(u.pathname)) return false;
    if (u.searchParams.get('udm') === '8') return true;
    if (/htl;\s*jobs/i.test(u.searchParams.get('ibp') || '')) return true;
    return false;
  } catch { return false; }
}

// Compose a human-readable name from parsed criteria. Exported so the
// content-script pill can pre-fill the Save prompt without duplicating
// the mapping logic. Falls back to a generic label if the URL has no
// meaningful filters.
export function defaultSearchName(url) {
  // Google Jobs uses a different param scheme (`q` for keywords, no
  // f_* filters). Derive from `q` and tag as Google Jobs so mixed-
  // source lists disambiguate at a glance.
  if (isGoogleJobsSearchUrl(url)) {
    try {
      const u = new URL(url);
      const q = (u.searchParams.get('q') || '').trim();
      const label = q ? condenseKeywords(q) : 'Google Jobs search';
      return `${label} · Google Jobs`;
    } catch { return 'Google Jobs search'; }
  }
  const c = parseSearchUrl(url);
  const bits = [];
  if (c.keywords) bits.push(condenseKeywords(c.keywords));
  if (c.experience) {
    const map = { 1: 'Intern', 2: 'Entry', 3: 'Associate', 4: 'Mid/Sr', 5: 'Director', 6: 'Exec' };
    const labels = String(c.experience).split(',').map((e) => map[e.trim()]).filter(Boolean);
    if (labels.length) bits.push(labels.join('/'));
  }
  if (c.workplace) {
    const map = { 1: 'On-site', 2: 'Remote', 3: 'Hybrid' };
    const labels = String(c.workplace).split(',').map((w) => map[w.trim()]).filter(Boolean);
    if (labels.length) bits.push(labels.join('/'));
  }
  if (c.tprHours != null) bits.push(c.tprHours <= 24 ? 'Past 24h' : c.tprHours <= 168 ? 'Past 7d' : 'Past 30d');
  if (c.inNetwork) bits.push('In-network');
  if (c.easyApply) bits.push('Easy Apply');
  return bits.join(' · ') || 'Saved search';
}

// Condense a LinkedIn keywords string into a short, scannable label.
// Users often stuff long "OR" chains ("Vice President of Software
// Engineering or Senior Director of Engineering or …") into the keyword
// box. Left raw, the resulting saved-search name runs 150+ chars.
//
// Steps:
//   1. Strip employment-type prefix (LinkedIn has structured f_JT filter).
//   2. Drop the "on-site or hybrid or remote" clause when all 3 modes
//      are listed — that's no filter at all.
//   3. Split by " or " into segments; abbreviate common leadership terms
//      (Vice President → VP, Senior → Sr, Director → Dir, etc.); join
//      with " / " for scan-ability.
//
// Content-script + sidebar mirrors of this exist and must stay in sync
// (they can't sync-import from lib/).
export function condenseKeywords(kw) {
  if (!kw) return '';
  let s = String(kw).trim();

  // 1. Strip employment-type prefixes.
  s = s.replace(/^(full[-\s]?time|part[-\s]?time|contract|temporary)\s+/i, '');

  // 2. If the string mentions all three work modes, drop that clause.
  const modeSet = new Set(
    (s.match(/\b(on[-\s]?site|hybrid|remote)\b/gi) || [])
      .map((m) => m.toLowerCase().replace(/[-\s]/g, ''))
  );
  if (modeSet.size >= 3) {
    // Chomp any comma-prefixed "on-site or hybrid or remote" tail.
    s = s.replace(
      /[,;]?\s*(on[-\s]?site|hybrid|remote)(\s+or\s+(on[-\s]?site|hybrid|remote))+\s*/gi,
      ''
    ).trim();
    // Also handle trailing standalone tokens without an "or" chain.
    s = s.replace(/,\s*(on[-\s]?site|hybrid|remote)\s*$/i, '').trim();
    s = s.replace(/[,;]\s*$/, '').trim();
  }

  // 3. Split into "or" segments, abbreviate each, join with slash.
  const parts = s.split(/\s+or\s+/i).map((p) => p.trim()).filter(Boolean);
  const abbreviated = parts.map(abbreviateTitle);
  const out = abbreviated.length > 1 ? abbreviated.join(' / ') : (abbreviated[0] || s);
  return out;
}

function abbreviateTitle(t) {
  return t
    .replace(/\bVice President\b/gi, 'VP')
    .replace(/\bSenior\b/gi, 'Sr')
    .replace(/\bJunior\b/gi, 'Jr')
    .replace(/\bDirector\b/gi, 'Dir')
    .replace(/\bManager\b/gi, 'Mgr')
    .replace(/\bEngineering\b/gi, 'Eng')
    .replace(/\bTechnology\b/gi, 'Tech')
    .replace(/\bSoftware\b/gi, 'SW')
    .replace(/\bProduct\b/gi, 'Prod')
    .replace(/\bOperations\b/gi, 'Ops')
    .replace(/\bAdministrator\b/gi, 'Admin')
    .replace(/\bAdministration\b/gi, 'Admin')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getLocalModelSettings() {
  const r = await chrome.storage.local.get(KEY_LOCAL_MODEL);
  const stored = r[KEY_LOCAL_MODEL] || {};
  return {
    enabled: !!stored.enabled,
    model: stored.model || DEFAULT_LOCAL_MODEL.model,
    features: { ...DEFAULT_LOCAL_MODEL.features, ...(stored.features || {}) },
  };
}
export async function setLocalModelSettings(patch) {
  const current = await getLocalModelSettings();
  const next = {
    enabled: patch.enabled ?? current.enabled,
    model: patch.model ?? current.model,
    features: { ...current.features, ...(patch.features || {}) },
  };
  await chrome.storage.local.set({ [KEY_LOCAL_MODEL]: next });
  return next;
}

export async function getWorkPreferences() {
  const r = await chrome.storage.local.get(KEY_WORK_PREFERENCES);
  return { ...DEFAULT_WORK_PREFERENCES, ...(r[KEY_WORK_PREFERENCES] || {}) };
}
export async function setWorkPreferences(prefs) {
  await chrome.storage.local.set({ [KEY_WORK_PREFERENCES]: { ...DEFAULT_WORK_PREFERENCES, ...(prefs || {}) } });
}

export async function getAutoAnalyzeEnabled() {
  const r = await chrome.storage.local.get(KEY_AUTO_ANALYZE);
  return r[KEY_AUTO_ANALYZE] !== false; // default true
}
export async function setAutoAnalyzeEnabled(enabled) {
  await chrome.storage.local.set({ [KEY_AUTO_ANALYZE]: !!enabled });
}

export async function getLastExportAt() {
  const r = await chrome.storage.local.get(KEY_LAST_EXPORT);
  return r[KEY_LAST_EXPORT] || null;
}
export async function setLastExportAt(iso) {
  await chrome.storage.local.set({ [KEY_LAST_EXPORT]: iso });
}

// ---------- Usage tracking ----------

export async function addUsage({ model, usage }) {
  if (!usage) return;
  const today = new Date().toISOString().slice(0, 10);
  const r = await chrome.storage.local.get([KEY_USAGE, KEY_USAGE_DAILY]);

  // Lifetime totals
  const lifetime = r[KEY_USAGE] || { calls: 0, inputTokens: 0, outputTokens: 0, byModel: {} };
  lifetime.calls += 1;
  lifetime.inputTokens += usage.input_tokens || 0;
  lifetime.outputTokens += usage.output_tokens || 0;
  const m = lifetime.byModel[model] || { calls: 0, inputTokens: 0, outputTokens: 0 };
  m.calls += 1;
  m.inputTokens += usage.input_tokens || 0;
  m.outputTokens += usage.output_tokens || 0;
  lifetime.byModel[model] = m;

  // Daily buckets — tokens only, cost computed on read via pricing
  const daily = r[KEY_USAGE_DAILY] || {};
  const day = daily[today] || { calls: 0, byModel: {} };
  day.calls += 1;
  const dm = day.byModel[model] || { calls: 0, inputTokens: 0, outputTokens: 0 };
  dm.calls += 1;
  dm.inputTokens += usage.input_tokens || 0;
  dm.outputTokens += usage.output_tokens || 0;
  day.byModel[model] = dm;
  daily[today] = day;

  // Trim to last DAILY_RETENTION_DAYS
  const cutoff = new Date(Date.now() - DAILY_RETENTION_DAYS * 86400_000).toISOString().slice(0, 10);
  for (const d of Object.keys(daily)) if (d < cutoff) delete daily[d];

  await chrome.storage.local.set({ [KEY_USAGE]: lifetime, [KEY_USAGE_DAILY]: daily });
}

export async function getUsage() {
  const r = await chrome.storage.local.get(KEY_USAGE);
  return r[KEY_USAGE] || { calls: 0, inputTokens: 0, outputTokens: 0, byModel: {} };
}

// Returns an array of the last `days` days, oldest → newest, with tokens
// grouped by model per day. Cost is computed by the caller using pricing.
export async function getDailyUsage(days = 30) {
  const r = await chrome.storage.local.get(KEY_USAGE_DAILY);
  const daily = r[KEY_USAGE_DAILY] || {};
  const today = new Date();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const entry = daily[key];
    out.push({
      date: key,
      calls: entry?.calls || 0,
      byModel: entry?.byModel || {},
    });
  }
  return out;
}

// ---------- Activity log (ring buffer, last 500) ----------

// Cap the length of any string field written to the activity log.
// Anthropic error messages can carry the request body (which may
// include partial header/key fragments in exotic failure paths), and
// scraper failures can carry HTML dumps. Keep it small; the log is
// meant for pipeline diagnosis, not full forensics.
const ACTIVITY_STRING_CAP = 500;
function capActivityStrings(entry) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    out[k] = typeof v === 'string' && v.length > ACTIVITY_STRING_CAP
      ? v.slice(0, ACTIVITY_STRING_CAP) + '… (truncated)'
      : v;
  }
  return out;
}

export async function logActivity(entry) {
  const r = await chrome.storage.local.get(KEY_ACTIVITY);
  const log = r[KEY_ACTIVITY] || [];
  log.push({ at: new Date().toISOString(), ...capActivityStrings(entry) });
  if (log.length > MAX_ACTIVITY) log.splice(0, log.length - MAX_ACTIVITY);
  await chrome.storage.local.set({ [KEY_ACTIVITY]: log });
}

export async function getActivity({ limit = MAX_ACTIVITY } = {}) {
  const r = await chrome.storage.local.get(KEY_ACTIVITY);
  return (r[KEY_ACTIVITY] || []).slice(-limit).reverse();
}

export async function clearActivity() {
  await chrome.storage.local.remove(KEY_ACTIVITY);
}

// ---------- Job archive ----------
// Records keyed as `job.<jobId>`, with `jobs.index` holding jobIds for fast enumeration.

async function getJobIndex() {
  const r = await chrome.storage.local.get(KEY_JOB_INDEX);
  return r[KEY_JOB_INDEX] || [];
}
async function setJobIndex(ids) {
  await chrome.storage.local.set({ [KEY_JOB_INDEX]: ids });
}

export async function getJob(jobId) {
  const key = KEY_JOB_PREFIX + jobId;
  const r = await chrome.storage.local.get(key);
  return r[key] || null;
}

// Pure merge — no I/O. Takes existing record (or null) and returns the next
// record to persist. Used by both upsertJob (single-item path) and bulk
// paths like handleBackfill (many jobs, one storage roundtrip).
// Find a probable duplicate of a candidate capture. Used by Google
// Jobs (which aggregates LinkedIn + other boards) to detect that the
// same role was already captured from a different source. Match rule:
// normalized title equal AND normalized company equal — case-insensitive,
// punctuation stripped, common corporate suffixes removed. Optional
// excludeJobId lets a caller skip a specific record.
function normalizeForDedup(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co\.?|limited|gmbh|s\.?a\.?)\.?\b/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
export async function findProbableDuplicate({ title, company, excludeJobId }) {
  const nt = normalizeForDedup(title);
  const nc = normalizeForDedup(company);
  if (!nt || !nc) return null;
  const jobs = await listJobs();
  for (const j of jobs) {
    if (excludeJobId && j.jobId === excludeJobId) continue;
    const jt = normalizeForDedup(j.posting?.title);
    const jc = normalizeForDedup(j.posting?.company);
    if (jt === nt && jc === nc) return j;
  }
  return null;
}

export function mergeJobRecord(jobId, existing, updates = {}, ops = {}) {
  const now = new Date().toISOString();
  let record;
  if (existing) {
    record = {
      ...existing,
      ...updates,
      jobId,
      updatedAt: now,
      // Lazy source backfill — pre-source-field records inherit
      // 'linkedin' on their next write, so filters and badges work
      // without a one-shot migration.
      source: updates.source || existing.source || 'linkedin',
      posting: { ...(existing.posting || {}), ...(updates.posting || {}) },
      timeline: updates.timeline || existing.timeline || [],
      panel: updates.panel || existing.panel || [],
      tags: updates.tags || existing.tags || [],
      analyses: { ...(existing.analyses || {}), ...(updates.analyses || {}) },
    };
  } else {
    // New records default to `analyzed` — meaning "we looked at this job"
    // (opened Recall, ran an analysis, offer form saved). Status only upgrades
    // to `saved` on LinkedIn's Save click, or `applied` on Apply / Easy Apply.
    record = {
      jobId,
      capturedAt: now, updatedAt: now,
      status: 'analyzed', statusUpdatedAt: now,
      captureSource: 'auto-scrape', postingArchived: false,
      source: 'linkedin', // overwritten by updates.source when passed
      userNotes: '', tags: [],
      timeline: [{ at: now, type: 'captured', note: 'First capture' }],
      panel: [], analyses: {}, posting: {},
      ...updates,
    };
  }
  // Append operations happen after the base merge so callers can express
  // "add one timeline entry" without pre-reading the existing timeline.
  if (ops.appendTimeline?.length) {
    record.timeline = [...(record.timeline || []), ...ops.appendTimeline];
  }
  return record;
}

export async function upsertJob(jobId, updates = {}, ops = {}) {
  const key = KEY_JOB_PREFIX + jobId;
  // Single roundtrip: fetch the job and the index together.
  const r = await chrome.storage.local.get([key, KEY_JOB_INDEX]);
  const existing = r[key];
  const index = r[KEY_JOB_INDEX] || [];
  const record = mergeJobRecord(jobId, existing, updates, ops);
  const patch = { [key]: record };
  if (!index.includes(jobId)) patch[KEY_JOB_INDEX] = [...index, jobId];
  // Single write: job and (optionally) index in one atomic set.
  await chrome.storage.local.set(patch);
  return record;
}

export async function setJobAnalysis(jobId, feature, data) {
  // upsertJob's own merge handles nested analyses spread; no pre-read needed.
  return upsertJob(jobId, { analyses: { [feature]: data } });
}

export async function updateJobStatus(jobId, newStatus, note) {
  const now = new Date().toISOString();
  return upsertJob(
    jobId,
    { status: newStatus, statusUpdatedAt: now },
    { appendTimeline: [{ at: now, type: 'status-change', note: note || `Status → ${newStatus}` }] },
  );
}

export async function addTimelineEntry(jobId, type, note) {
  const now = new Date().toISOString();
  return upsertJob(jobId, {}, { appendTimeline: [{ at: now, type, note }] });
}

// Bulk upsert with a per-item builder. One storage get, one storage set, no
// matter how many jobs. Used by tracker-sync backfill where the old loop did
// ~3 storage reads per job.
//   jobIds: array of jobIds to touch
//   buildRecord: (jobId, existing|null) => next record (or null/undefined to skip)
// Returns array of persisted records (skipped entries omitted).
export async function bulkUpsertJobsWith(jobIds, buildRecord) {
  if (!Array.isArray(jobIds) || !jobIds.length) return [];
  const jobKeys = jobIds.map((id) => KEY_JOB_PREFIX + id);
  const r = await chrome.storage.local.get([...jobKeys, KEY_JOB_INDEX]);
  const index = r[KEY_JOB_INDEX] || [];
  const indexSet = new Set(index);
  const patch = {};
  const records = [];
  for (const id of jobIds) {
    const key = KEY_JOB_PREFIX + id;
    const record = buildRecord(id, r[key] || null);
    if (!record) continue;
    patch[key] = record;
    records.push(record);
    if (!indexSet.has(id)) { indexSet.add(id); index.push(id); }
  }
  if (!records.length) return [];
  patch[KEY_JOB_INDEX] = index;
  await chrome.storage.local.set(patch);
  return records;
}

export async function deleteJob(jobId) {
  const key = KEY_JOB_PREFIX + jobId;
  await chrome.storage.local.remove(key);
  const index = await getJobIndex();
  await setJobIndex(index.filter((id) => id !== jobId));
}

export async function listJobs() {
  const index = await getJobIndex();
  if (!index.length) return [];
  const keys = index.map((id) => KEY_JOB_PREFIX + id);
  const r = await chrome.storage.local.get(keys);
  return index.map((id) => r[KEY_JOB_PREFIX + id]).filter(Boolean);
}

// Batch fetch a specific set of jobs by id. Single storage roundtrip;
// caller sees a { jobId → record } map with missing/unknown ids
// omitted. Used by the LinkedIn-listing decoration path (scan the
// visible cards, ask for the matching records in one go).
export async function bulkGetJobsByIds(jobIds) {
  const uniq = [...new Set((jobIds || []).map(String))].filter(Boolean);
  if (!uniq.length) return {};
  const keys = uniq.map((id) => KEY_JOB_PREFIX + id);
  const r = await chrome.storage.local.get(keys);
  const out = {};
  for (const id of uniq) {
    const rec = r[KEY_JOB_PREFIX + id];
    if (rec) out[id] = rec;
  }
  return out;
}

export async function countJobs() {
  return (await getJobIndex()).length;
}

// ---------- Export / import ----------

export async function exportAll() {
  const jobs = await listJobs();
  const [profile, resume, comp, samples, models, usage] = await Promise.all([
    getProfile(), getMasterResume(), getCompTargets(), getWritingSamples(), getModels(), getUsage(),
  ]);
  return {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    settings: { profile, masterResume: resume, compTargets: comp, writingSamples: samples, models },
    usage,
    jobs,
    // Note: apiKey deliberately excluded.
  };
}

// Whitelist of top-level fields that an imported job record is
// allowed to bring in. Anything else the attacker adds to a backup
// gets dropped rather than being persisted verbatim. Keep in sync
// with mergeJobRecord's known field set.
const IMPORT_JOB_FIELDS = new Set([
  'jobId', 'url', 'capturedAt', 'updatedAt', 'status', 'statusUpdatedAt',
  'captureSource', 'source', 'via', 'applyLinks', 'googleSearchUrl',
  'postingArchived', 'userNotes', 'tags', 'timeline', 'panel', 'analyses',
  'posting', 'warmth', 'hiringTeam', 'offerDetails', 'interviewRounds',
  'cardText',
]);
const IMPORT_POSTING_FIELDS = new Set([
  'title', 'company', 'location', 'workplaceType', 'postedDate',
  'postedSalaryRange', 'employmentType', 'descriptionText',
  'applicantCount', 'isReposted', 'recruiter', 'descriptionSource',
]);
const IMPORT_JOB_HARD_CAP = 5000;
const IMPORT_STRING_HARD_CAP = 30000;   // description text can be long
const IMPORT_ARRAY_HARD_CAP = 500;

// Recursively cap string lengths and array sizes on an imported value
// so a crafted backup can't OOM the extension. Passes objects through
// while pruning obviously abusive entries.
function capValue(v) {
  if (typeof v === 'string') return v.length > IMPORT_STRING_HARD_CAP ? v.slice(0, IMPORT_STRING_HARD_CAP) : v;
  if (Array.isArray(v)) return v.slice(0, IMPORT_ARRAY_HARD_CAP).map(capValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = capValue(v[k]);
    return out;
  }
  return v;
}

function sanitizeImportedJob(job) {
  if (!job || typeof job !== 'object') return null;
  const idRaw = job.jobId;
  if (typeof idRaw !== 'string' && typeof idRaw !== 'number') return null;
  const jobId = String(idRaw);
  if (!/^[a-z0-9_.\-]{1,64}$/i.test(jobId)) return null;
  const clean = { jobId };
  for (const k of Object.keys(job)) {
    if (!IMPORT_JOB_FIELDS.has(k)) continue;
    clean[k] = capValue(job[k]);
  }
  if (clean.posting && typeof clean.posting === 'object') {
    const p = clean.posting;
    const cleanP = {};
    for (const k of Object.keys(p)) {
      if (!IMPORT_POSTING_FIELDS.has(k)) continue;
      cleanP[k] = capValue(p[k]);
    }
    clean.posting = cleanP;
  }
  return clean;
}

export async function importAll(data) {
  if (!data || data.exportVersion !== 1) throw new Error('Unsupported export version');
  const s = data.settings || {};
  if (typeof s.profile === 'string') await setProfile(s.profile);
  if (typeof s.masterResume === 'string') await setMasterResume(s.masterResume);
  if (s.compTargets && typeof s.compTargets === 'object') await setCompTargets(s.compTargets);
  if (typeof s.writingSamples === 'string') await setWritingSamples(s.writingSamples);
  if (s.models && typeof s.models === 'object') await setModels(s.models);
  let imported = 0, skipped = 0;
  const jobList = Array.isArray(data.jobs) ? data.jobs.slice(0, IMPORT_JOB_HARD_CAP) : [];
  for (const raw of jobList) {
    const job = sanitizeImportedJob(raw);
    if (!job) { skipped++; continue; }
    await upsertJob(job.jobId, job);
    imported++;
  }
  return { imported, skipped };
}
