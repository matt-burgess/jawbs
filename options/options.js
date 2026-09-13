import {
  getApiKey, setApiKey,
  getModels, setModels,
  getProfile, setProfile,
  getMasterResume, setMasterResume,
  getCompTargets, setCompTargets,
  getWritingSamples, setWritingSamples,
  getAutoAnalyzeEnabled, setAutoAnalyzeEnabled,
  getLinkedInProfileUrl, setLinkedInProfileUrl,
  getContactEmail, setContactEmail,
  getContactPhone, setContactPhone,
  getContactLocation, setContactLocation,
  getWorkLocations, setWorkLocations,
  getWorkPreferences, setWorkPreferences,
  getKnowledgeBase, setKnowledgeBase,
  getLocalModelSettings, setLocalModelSettings,
  getPrepQuestions, setPrepQuestions,
  getNegativeKeywords, setNegativeKeywords,
  getUsage,
  exportAll, importAll, setLastExportAt,
} from '../lib/store.js';
import { attachQuickFill } from '../lib/linkedInFill.js';
import { DEFAULT_PROFILE, DEFAULT_COMP_TARGETS, DEFAULT_PREP_QUESTIONS } from '../lib/defaults.js';
import { DEFAULT_MODELS, MODEL_IDS } from '../lib/models.js';
import { estimateCostUsd, formatUsd, MODEL_PRICING } from '../lib/pricing.js';

const $ = (id) => document.getElementById(id);
const els = new Proxy({}, { get: (_, id) => $(id) });

const flash = (el, text, ms = 2000) => { el.textContent = text; setTimeout(() => (el.textContent = ''), ms); };

// ---------- API key ----------

async function loadKey() {
  els.apiKey.value = await getApiKey();
  // Auto-expand the setup guide when there's no key yet — invisible when
  // the user has one, always available to re-open.
  if (els.anthropicSetup) els.anthropicSetup.open = !els.apiKey.value;
}
els.saveKey.addEventListener('click', async () => {
  await setApiKey(els.apiKey.value.trim());
  flash(els.keyStatus, 'Saved.');
  // Once a key is present, collapse the guide.
  if (els.anthropicSetup && els.apiKey.value) els.anthropicSetup.open = false;
});
els.revealKey.addEventListener('click', () => {
  const isPw = els.apiKey.type === 'password';
  els.apiKey.type = isPw ? 'text' : 'password';
  els.revealKey.textContent = isPw ? 'Hide' : 'Show';
});

// ---------- Tab navigation ----------

const TAB_STORAGE_KEY = 'jobThresher.optionsTab';

function activateTab(name) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.setAttribute('aria-selected', btn.dataset.tab === name ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch {}
  // Clear any previous #anchor so the hidden tab's chip doesn't stay active.
  if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
  syncSubnavActive();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// Restore last-viewed tab on load — URL ?tab=X overrides so sidebar
// quick-launch cards can jump straight to a specific tab.
try {
  const requested = new URLSearchParams(location.search).get('tab');
  const saved = localStorage.getItem(TAB_STORAGE_KEY);
  const target = requested || saved;
  if (target && document.querySelector(`.tab-btn[data-tab="${target}"]`)) {
    activateTab(target);
  }
} catch {}

// ---------- Sub-nav active-state ----------
// Chip anchors use native #hash navigation for scroll; we just paint the
// matching chip so users can see where they are.
function syncSubnavActive() {
  const hash = window.location.hash;
  document.querySelectorAll('[data-subnav]').forEach((a) => {
    a.dataset.active = a.getAttribute('href') === hash ? 'true' : 'false';
  });
}
window.addEventListener('hashchange', syncSubnavActive);
syncSubnavActive();

// ---------- Small helpers ----------

async function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function downloadBlob(filename, content, type = 'text/plain') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Profile ----------

async function loadProfile() {
  els.profile.value = await getProfile();
}
els.saveProfile.addEventListener('click', async () => {
  await setProfile(els.profile.value);
  flash(els.profileStatus, 'Saved.');
});
els.resetProfile.addEventListener('click', async () => {
  if (!confirm('Reset profile to default?')) return;
  await setProfile(DEFAULT_PROFILE);
  els.profile.value = DEFAULT_PROFILE;
  flash(els.profileStatus, 'Reset.');
});
els.loadProfileFile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await readTextFile(file);
    els.profile.value = text;
    await setProfile(text);
    flash(els.profileStatus, `Loaded ${file.name} (${text.length.toLocaleString()} chars).`);
  } catch (err) {
    flash(els.profileStatus, `Failed: ${err.message}`, 4000);
  } finally {
    e.target.value = '';
  }
});

// ---------- Extended knowledge base ----------

async function loadKnowledge() {
  const text = await getKnowledgeBase();
  els.knowledgeBase.value = text;
  els.knowledgeLen.textContent = text ? `${text.length.toLocaleString()} chars` : '';
}
els.saveKnowledge.addEventListener('click', async () => {
  await setKnowledgeBase(els.knowledgeBase.value);
  els.knowledgeLen.textContent = `${els.knowledgeBase.value.length.toLocaleString()} chars`;
  flash(els.knowledgeStatus, 'Saved.');
});
els.knowledgeBase.addEventListener('input', () => {
  els.knowledgeLen.textContent = `${els.knowledgeBase.value.length.toLocaleString()} chars`;
});
els.loadKnowledgeFile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await readTextFile(file);
    els.knowledgeBase.value = text;
    await setKnowledgeBase(text);
    els.knowledgeLen.textContent = `${text.length.toLocaleString()} chars`;
    flash(els.knowledgeStatus, `Loaded ${file.name}.`);
  } catch (err) {
    flash(els.knowledgeStatus, `Failed: ${err.message}`, 4000);
  } finally {
    e.target.value = '';
  }
});
els.clearKnowledge.addEventListener('click', async () => {
  if (els.knowledgeBase.value && !confirm('Clear the extended knowledge base?')) return;
  els.knowledgeBase.value = '';
  await setKnowledgeBase('');
  els.knowledgeLen.textContent = '';
  flash(els.knowledgeStatus, 'Cleared.');
});

// ---------- Local model (Ollama) ----------

async function refreshOllamaStatus() {
  const status = els.ollamaStatusDisplay;
  status.textContent = 'Checking…';
  status.dataset.status = 'unknown';
  els.ollamaSetup.hidden = true;
  els.ollamaConfig.hidden = true;

  const r = await chrome.runtime.sendMessage({ type: 'ollama-status' });
  if (!r || !r.reachable) {
    status.textContent = 'Not reachable';
    status.dataset.status = 'down';
    els.ollamaSetup.hidden = false;
    return;
  }

  const modelCount = (r.models || []).length;
  if (modelCount === 0) {
    status.textContent = `Ollama v${r.version} · no models pulled`;
    status.dataset.status = 'partial';
    els.ollamaSetup.hidden = false;
    return;
  }

  status.textContent = `Ollama v${r.version} · ${modelCount} model${modelCount > 1 ? 's' : ''} available`;
  status.dataset.status = 'up';
  els.ollamaConfig.hidden = false;
  populateModelDropdown(r.models);

  const settings = await getLocalModelSettings();
  els.localEnabled.checked = settings.enabled;
  els.localModelSelect.value = settings.model;
  els.localFeatFit.checked = !!settings.features.fit;
  els.localFeatComp.checked = !!settings.features.comp;
  els.localFeatBrief.checked = !!settings.features.brief;
  els.localFeatLetter.checked = !!settings.features.coverLetter;
  els.localFeatResume.checked = !!settings.features.resume;
}

function populateModelDropdown(models) {
  els.localModelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.name;
    const sizeGB = m.size ? (m.size / 1024 / 1024 / 1024).toFixed(1) : '?';
    const bits = [m.name, `${sizeGB} GB`];
    if (m.param_size) bits.push(m.param_size);
    if (m.quant) bits.push(m.quant);
    opt.textContent = bits.join(' · ');
    els.localModelSelect.appendChild(opt);
  }
}

els.recheckOllama.addEventListener('click', refreshOllamaStatus);

els.saveLocalModel.addEventListener('click', async () => {
  await setLocalModelSettings({
    enabled: els.localEnabled.checked,
    model: els.localModelSelect.value,
    features: {
      fit: els.localFeatFit.checked,
      comp: els.localFeatComp.checked,
      brief: els.localFeatBrief.checked,
      coverLetter: els.localFeatLetter.checked,
      resume: els.localFeatResume.checked,
    },
  });
  flash(els.localModelStatus, 'Saved.');
});

async function downloadSetupScript(filename) {
  const url = chrome.runtime.getURL(`assets/setup/${filename}`);
  const response = await fetch(url);
  const text = await response.text();
  downloadBlob(filename, text, 'text/plain');
}
els.dlSetupMac.addEventListener('click', () => downloadSetupScript('setup-ollama-mac.sh'));
els.dlSetupWin.addEventListener('click', () => downloadSetupScript('setup-ollama-win.ps1'));
els.dlSetupLinux.addEventListener('click', () => downloadSetupScript('setup-ollama-linux.sh'));

// ---------- Resume ----------

async function loadResume() {
  const r = await getMasterResume();
  els.resume.value = r;
  els.resumeLen.textContent = `${r.length.toLocaleString()} chars`;
}
els.saveResume.addEventListener('click', async () => {
  await setMasterResume(els.resume.value);
  els.resumeLen.textContent = `${els.resume.value.length.toLocaleString()} chars`;
  flash(els.resumeStatus, 'Saved.');
});
els.resume.addEventListener('input', () => {
  els.resumeLen.textContent = `${els.resume.value.length.toLocaleString()} chars`;
});

// ---------- Comp ----------

async function loadComp() {
  const c = await getCompTargets();
  els.compFloor.value = c.floor ?? '';
  els.compTarget.value = c.target ?? '';
  els.compWalkAway.value = c.walkAway ?? '';
  els.compCurrent.value = c.currentBenchmark ?? '';
}
els.saveComp.addEventListener('click', async () => {
  const parse = (v) => (v === '' || v == null) ? null : Number(v);
  await setCompTargets({
    floor: parse(els.compFloor.value),
    target: parse(els.compTarget.value),
    walkAway: parse(els.compWalkAway.value),
    currentBenchmark: parse(els.compCurrent.value),
  });
  flash(els.compStatus, 'Saved.');
});

// ---------- Writing samples ----------

async function loadSamples() { els.samples.value = await getWritingSamples(); }
els.saveSamples.addEventListener('click', async () => {
  await setWritingSamples(els.samples.value);
  flash(els.samplesStatus, 'Saved.');
});

// ---------- Question Prep questions ----------
// Stored as an array of strings but edited here as newline-separated text —
// most natural way to reorder / edit / add / remove without a custom list UI.

function parsePrepQuestions(text) {
  return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
}
function renderPrepQuestionCount() {
  const n = parsePrepQuestions(els.prepQuestions.value).length;
  els.prepQuestionsCount.textContent = `${n} question${n === 1 ? '' : 's'}`;
}
async function loadPrepQuestions() {
  const list = await getPrepQuestions();
  els.prepQuestions.value = list.join('\n');
  renderPrepQuestionCount();
}
els.prepQuestions.addEventListener('input', renderPrepQuestionCount);
els.savePrepQuestions.addEventListener('click', async () => {
  const list = parsePrepQuestions(els.prepQuestions.value);
  await setPrepQuestions(list);
  renderPrepQuestionCount();
  flash(els.prepQuestionsStatus, 'Saved.');
});
els.resetPrepQuestions.addEventListener('click', async () => {
  els.prepQuestions.value = DEFAULT_PREP_QUESTIONS.join('\n');
  renderPrepQuestionCount();
  await setPrepQuestions(DEFAULT_PREP_QUESTIONS);
  flash(els.prepQuestionsStatus, 'Reset to defaults.');
});

// ---------- Negative keywords ----------
// One per line, case-insensitive substrings. Content script hides matching
// LinkedIn cards on /jobs/search/*.

function parseNegativeKeywords(text) {
  return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
}
function renderNegativeKeywordCount() {
  const n = parseNegativeKeywords(els.negativeKeywords.value).length;
  els.negativeKeywordsCount.textContent = n ? `${n} keyword${n === 1 ? '' : 's'}` : '';
}
async function loadNegativeKeywords() {
  const list = await getNegativeKeywords();
  els.negativeKeywords.value = list.join('\n');
  renderNegativeKeywordCount();
}
els.negativeKeywords.addEventListener('input', renderNegativeKeywordCount);
els.saveNegativeKeywords.addEventListener('click', async () => {
  const list = parseNegativeKeywords(els.negativeKeywords.value);
  await setNegativeKeywords(list);
  renderNegativeKeywordCount();
  flash(els.negativeKeywordsStatus, 'Saved.');
});

// Re-open the install-time welcome page. No side effects on onboarding.done
// so users can re-open as many times as they like.
els.openWelcome?.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome/welcome.html') });
});

// ---------- Tip prompts toggle ----------
//
// Reads/writes chrome.storage.local.tip.enabled, which panel.js's
// evaluateTipNudge() checks before showing the CTA. Default = true so
// users who never touch this setting keep the built-in behavior.
// The reset button clears dismiss/share/tipped stamps so the next
// eligible check re-shows the CTA — useful for testing.
async function loadTipToggle() {
  const el = document.getElementById('tipPromptsToggle');
  if (!el) return;
  const s = (await chrome.storage.local.get('tip')).tip || {};
  el.checked = s.enabled !== false; // undefined defaults to on
}
document.getElementById('tipPromptsToggle')?.addEventListener('change', async (e) => {
  const enabled = !!e.target.checked;
  const s = (await chrome.storage.local.get('tip')).tip || {};
  await chrome.storage.local.set({ tip: { ...s, enabled } });
});
document.getElementById('tipResetState')?.addEventListener('click', async () => {
  const s = (await chrome.storage.local.get('tip')).tip || {};
  const kept = { enabled: s.enabled !== false, installedAt: s.installedAt };
  await chrome.storage.local.set({ tip: kept });
  const status = document.getElementById('tipStateStatus');
  if (status) {
    status.textContent = 'Dismiss state cleared — next eligible check will re-show the CTA.';
    setTimeout(() => { status.textContent = ''; }, 4000);
  }
});
// Force the tip prompt to appear the next time the Jawbar loads —
// bypasses the milestone eligibility check and the dismiss/share/
// tipped guards. Consumed and cleared by evaluateTipNudge in panel.js.
document.getElementById('tipForceShow')?.addEventListener('click', async () => {
  const s = (await chrome.storage.local.get('tip')).tip || {};
  await chrome.storage.local.set({
    tip: { ...s, enabled: true, forceShow: true },
  });
  const status = document.getElementById('tipStateStatus');
  if (status) {
    status.textContent = 'Tip prompt queued — open (or re-open) the Jawbar to see it.';
    setTimeout(() => { status.textContent = ''; }, 5000);
  }
});
loadTipToggle().catch(() => {});

// ---------- Per-field Generate buttons ----------
// Each of Master Resume / Profile / Extended KB has its own Generate
// button. Each sends a purpose-specific preconfigured prompt to
// Anthropic. All three source from what the user has ON SCREEN in the
// Master Resume textarea — saved or not — so a paste-then-generate
// workflow doesn't require an explicit Save step between them.

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('No response from service worker');
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response;
}

async function runFieldGenerator({ handler, payload = {}, textarea, statusEl, button, label }) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '✨ Generating…';
  statusEl.textContent = 'Calling Anthropic — this takes 10-20s.';
  try {
    const r = await send(handler, payload);
    const text = r.data?.text || '';
    if (!text) throw new Error('Empty response.');
    textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const inTok = r.data?.usage?.input_tokens || 0;
    const outTok = r.data?.usage?.output_tokens || 0;
    statusEl.textContent = `${label} generated · ${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out tokens · click Save to keep it`;
    setTimeout(() => { statusEl.textContent = ''; }, 6000);
  } catch (e) {
    statusEl.textContent = `Failed: ${e.message}`;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

// Master Resume — clean-up / formatting normalization on the pasted text
// in this textarea. Preserves every specific claim; standardizes bullets,
// headings, and line breaks.
els.generateResumeField?.addEventListener('click', () => {
  runFieldGenerator({
    handler: 'generate-master-resume-field',
    payload: { resumeText: els.resume.value },
    textarea: els.resume,
    statusEl: els.resumeStatus,
    button: els.generateResumeField,
    label: 'Master resume',
  });
});

// Profile — 5-8 sentence positioning statement derived from the current
// Master Resume textarea contents. Uses existing Profile as consistency
// hint but doesn't require it.
els.generateProfile?.addEventListener('click', () => {
  runFieldGenerator({
    handler: 'generate-profile-field',
    payload: { masterResume: els.resume.value, existingProfile: els.profile.value },
    textarea: els.profile,
    statusEl: els.profileStatus,
    button: els.generateProfile,
    label: 'Profile',
  });
});

// Extended KB — deep per-role markdown from the current Master Resume
// textarea contents. Uses current Profile + KB as consistency hints.
els.generateKnowledge?.addEventListener('click', () => {
  runFieldGenerator({
    handler: 'generate-kb-field',
    payload: {
      masterResume: els.resume.value,
      existingProfile: els.profile.value,
      existingKb: els.knowledgeBase.value,
    },
    textarea: els.knowledgeBase,
    statusEl: els.knowledgeStatus,
    button: els.generateKnowledge,
    label: 'Knowledge base',
  });
});

// ---------- Contact shortcuts (email, phone, LinkedIn URL, city/state) ----------

const cachedFill = { email: '', phone: '', linkedInUrl: '', location: '' };
async function loadShortcuts() {
  const [email, phone, linkedInUrl, location] = await Promise.all([
    getContactEmail(), getContactPhone(), getLinkedInProfileUrl(), getContactLocation(),
  ]);
  Object.assign(cachedFill, { email, phone, linkedInUrl, location });
  els.linkedInUrl.value = linkedInUrl;
  if (els.contactEmail) els.contactEmail.value = email;
  if (els.contactPhone) els.contactPhone.value = phone;
  if (els.contactLocation) els.contactLocation.value = location;
}
els.saveLinkedIn.addEventListener('click', async () => {
  const url = els.linkedInUrl.value.trim();
  await setLinkedInProfileUrl(url);
  cachedFill.linkedInUrl = url;
  flash(els.linkedInStatus, 'Saved.');
});
if (els.saveContactEmail) {
  els.saveContactEmail.addEventListener('click', async () => {
    const v = els.contactEmail.value.trim();
    await setContactEmail(v);
    cachedFill.email = v;
    flash(els.contactEmailStatus, 'Saved.');
  });
}
if (els.saveContactPhone) {
  els.saveContactPhone.addEventListener('click', async () => {
    const v = els.contactPhone.value.trim();
    await setContactPhone(v);
    cachedFill.phone = v;
    flash(els.contactPhoneStatus, 'Saved.');
  });
}
if (els.saveContactLocation) {
  els.saveContactLocation.addEventListener('click', async () => {
    const v = els.contactLocation.value.trim();
    await setContactLocation(v);
    cachedFill.location = v;
    flash(els.contactLocationStatus, 'Saved.');
  });
}

// Wire the floating quick-fill toolbar over any focused input on this page too.
attachQuickFill(document.body, () => cachedFill);

// ---------- Work locations & preferences ----------

let cachedLocations = [];
async function loadWorkLocations() {
  cachedLocations = await getWorkLocations();
  renderLocationsList();
  const prefs = await getWorkPreferences();
  els.prefRemote.checked = !!prefs.remote;
  els.prefHybrid.checked = !!prefs.hybrid;
  els.prefOnsite.checked = !!prefs.onsite;
}
function renderLocationsList() {
  els.workLocationsList.innerHTML = '';
  if (!cachedLocations.length) {
    const li = document.createElement('li');
    li.className = 'location-empty';
    li.textContent = 'No locations yet — add at least one so analysis can flag postings that don\'t match.';
    els.workLocationsList.appendChild(li);
    return;
  }
  for (let i = 0; i < cachedLocations.length; i++) {
    const loc = cachedLocations[i];
    const li = document.createElement('li');
    li.className = 'location-item';
    const name = document.createElement('span');
    name.textContent = loc;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'location-remove';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.addEventListener('click', async () => {
      cachedLocations.splice(i, 1);
      await setWorkLocations(cachedLocations);
      renderLocationsList();
    });
    li.append(name, rm);
    els.workLocationsList.appendChild(li);
  }
}
els.addLocation.addEventListener('click', async () => {
  const val = els.newLocation.value.trim();
  if (!val) return;
  cachedLocations.push(val);
  await setWorkLocations(cachedLocations);
  els.newLocation.value = '';
  renderLocationsList();
});
els.newLocation.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); els.addLocation.click(); }
});
els.savePreferences.addEventListener('click', async () => {
  await setWorkPreferences({
    remote: els.prefRemote.checked,
    hybrid: els.prefHybrid.checked,
    onsite: els.prefOnsite.checked,
  });
  flash(els.workLocStatus, 'Saved.');
});

// ---------- Auto-analyze toggle ----------

async function loadAutoAnalyze() {
  els.autoAnalyzeHighMatch.checked = await getAutoAnalyzeEnabled();
}
els.saveAutoAnalyze.addEventListener('click', async () => {
  await setAutoAnalyzeEnabled(els.autoAnalyzeHighMatch.checked);
  flash(els.autoAnalyzeStatus, 'Saved.');
});

// ---------- Models ----------

const MODEL_OPTIONS = [MODEL_IDS.opus, MODEL_IDS.sonnet, MODEL_IDS.haiku];

async function loadModels() {
  const m = await getModels();
  els.modelGrid.innerHTML = '';
  for (const [feature, model] of Object.entries(m)) {
    const label = document.createElement('label');
    const span = document.createElement('span');
    span.textContent = feature;
    const select = document.createElement('select');
    select.dataset.feature = feature;
    for (const opt of MODEL_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (opt === model) o.selected = true;
      select.appendChild(o);
    }
    label.append(span, select);
    els.modelGrid.appendChild(label);
  }
}
els.saveModels.addEventListener('click', async () => {
  const models = {};
  els.modelGrid.querySelectorAll('select[data-feature]').forEach((s) => {
    models[s.dataset.feature] = s.value;
  });
  await setModels(models);
  flash(els.modelStatus, 'Saved.');
});
els.resetModels.addEventListener('click', async () => {
  if (!confirm('Reset all feature models to defaults?')) return;
  await setModels(DEFAULT_MODELS);
  await loadModels();
  flash(els.modelStatus, 'Reset.');
});

// ---------- Diagnostic ----------

els.diagnostic.addEventListener('click', async () => {
  els.diagnostic.disabled = true;
  els.diagnosticOutput.textContent = 'Contacting api.anthropic.com…';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'diagnostic' });
    if (response?.ok) {
      const lines = [
        `OK — round-trip ${response.elapsedMs}ms`,
        `Model:  ${response.model}`,
        `Reply:  ${response.text}`,
      ];
      if (response.usage) {
        lines.push(`Usage:  input=${response.usage.input_tokens} output=${response.usage.output_tokens}`);
      }
      els.diagnosticOutput.textContent = lines.join('\n');
    } else {
      const status = response?.status ? ` (HTTP ${response.status})` : '';
      els.diagnosticOutput.textContent = `FAIL${status}\n${response?.error || 'Unknown error'}`;
    }
    await loadUsage();
  } catch (e) {
    els.diagnosticOutput.textContent = `FAIL — service worker unreachable\n${e.message}`;
  } finally {
    els.diagnostic.disabled = false;
  }
});

// ---------- Usage ----------

async function loadUsage() {
  const u = await getUsage();
  const totalUsd = Object.entries(u.byModel || {}).reduce((sum, [model, x]) => {
    const cost = estimateCostUsd(model, { input_tokens: x.inputTokens, output_tokens: x.outputTokens });
    return sum + (cost || 0);
  }, 0);
  const lines = [
    `Lifetime calls:  ${u.calls}`,
    `Input tokens:    ${u.inputTokens.toLocaleString()}`,
    `Output tokens:   ${u.outputTokens.toLocaleString()}`,
    `Estimated cost:  ${formatUsd(totalUsd)}  (approximate — verify in Anthropic console)`,
    '',
    'By model:',
    ...Object.entries(u.byModel || {}).map(([model, x]) => {
      const c = estimateCostUsd(model, { input_tokens: x.inputTokens, output_tokens: x.outputTokens });
      return `  ${model}: ${x.calls} calls · in ${x.inputTokens.toLocaleString()} · out ${x.outputTokens.toLocaleString()} · ${formatUsd(c)}`;
    }),
    '',
    'Prices used (per M tokens, approximate):',
    ...Object.entries(MODEL_PRICING).map(([m, p]) => `  ${m}: input $${p.input.toFixed(2)} / output $${p.output.toFixed(2)}`),
  ];
  els.usageOutput.textContent = lines.join('\n');
}

// ---------- Activity log ----------

let allActivity = [];

async function loadActivity() {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'get-activity', limit: 500 });
    allActivity = r?.entries || [];
    renderActivity();
  } catch (e) {
    els.activityList.innerHTML = `<p class="jc-footnote">Failed to load activity: ${e.message}</p>`;
  }
}

function renderActivity() {
  const filter = els.activityFilter.value;
  const filtered = filter ? allActivity.filter((e) => e.type === filter) : allActivity;
  els.activityCount.textContent = `${filtered.length} of ${allActivity.length} entries`;
  if (!filtered.length) {
    els.activityList.innerHTML = '<p class="jc-footnote" style="padding:var(--jc-4)">No activity yet.</p>';
    return;
  }
  els.activityList.innerHTML = filtered.map((e) => renderActivityRow(e)).join('');
}

function renderActivityRow(e) {
  const when = new Date(e.at);
  const time = when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

  // LinkedIn jobIds are numeric — build a click-through to the canonical
  // /jobs/view/ URL. Reject non-numeric IDs defensively.
  let jobLinkHtml = '';
  if (e.jobId != null) {
    const idStr = String(e.jobId);
    if (/^\d+$/.test(idStr)) {
      const url = `https://www.linkedin.com/jobs/view/${idStr}/`;
      jobLinkHtml = `<a class="activity-joblink" href="${url}" target="_blank" rel="noopener noreferrer" title="Open on LinkedIn">job ${idStr} ↗</a>`;
    } else {
      jobLinkHtml = `job ${escapeHtml(idStr)}`;
    }
  }

  const bits = [];
  if (e.model) bits.push(e.model);
  if (e.durationMs) bits.push(`${e.durationMs}ms`);
  if (e.inputTokens || e.outputTokens) bits.push(`in ${e.inputTokens} · out ${e.outputTokens}`);
  if (e.note) bits.push(e.note);
  const metaText = bits.join(' · ');
  const status = e.ok ? 'ok' : 'err';

  // Prominent provider pill: local (jade) vs cloud (info), with a "→ cloud"
  // callout when the record represents a local→cloud fallback.
  let pill = '';
  if (e.provider === 'local') pill = `<span class="activity-pill" data-tone="pos">local</span>`;
  else if (e.provider === 'cloud' && e.fellback) pill = `<span class="activity-pill" data-tone="caution" title="Local was attempted but failed, so cloud handled it">local→cloud</span>`;
  else if (e.provider === 'cloud') pill = `<span class="activity-pill" data-tone="info">cloud</span>`;

  // Link + monospace meta joined by an interpunct separator; link is not
  // passed through escapeHtml (it's a trusted, validated URL fragment).
  const metaHtml = [jobLinkHtml, metaText ? escapeHtml(metaText) : ''].filter(Boolean).join(' · ');

  return `
    <div class="activity-row" data-status="${status}">
      <span class="activity-time">${escapeHtml(time)}</span>
      <span class="activity-type">${escapeHtml(e.type)}</span>
      <span class="activity-status" data-status="${status}">${e.ok ? '✓' : '✗'}</span>
      ${pill}
      <span class="activity-meta">${metaHtml}</span>
      ${e.error ? `<div class="activity-error">${escapeHtml(e.error)}</div>` : ''}
    </div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

els.refreshActivity?.addEventListener('click', loadActivity);
els.activityFilter?.addEventListener('change', renderActivity);
els.clearActivity?.addEventListener('click', async () => {
  if (!confirm('Clear the entire activity log?')) return;
  await chrome.runtime.sendMessage({ type: 'clear-activity' });
  await loadActivity();
});

// ---------- Backup ----------

els.exportBackup.addEventListener('click', async () => {
  const r = await chrome.runtime.sendMessage({ type: 'export-all' });
  const data = r?.data;
  if (!data) return flash(els.backupStatus, 'Export failed.');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jawb-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  await setLastExportAt(new Date().toISOString());
  flash(els.backupStatus, 'Exported.');
});

els.importBackup.addEventListener('change', async () => {
  const file = els.importBackup.files?.[0];
  if (!file) return;
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); }
  catch (e) { flash(els.backupStatus, `Invalid JSON: ${e.message}`, 4000); return; }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'import-all', data });
    if (!r?.ok) throw new Error(r?.error || 'Import failed');
    flash(els.backupStatus, `Imported ${r.data?.imported ?? 0} jobs.`, 4000);
    await loadProfile(); await loadResume(); await loadComp(); await loadSamples(); await loadModels();
  } catch (e) {
    flash(els.backupStatus, `Failed: ${e.message}`, 4000);
  }
});

// ---------- Init ----------

(async () => {
  await Promise.all([loadKey(), loadProfile(), loadResume(), loadComp(), loadSamples(), loadPrepQuestions(), loadNegativeKeywords(), loadWorkLocations(), loadKnowledge(), loadAutoAnalyze(), loadShortcuts(), loadModels(), loadUsage(), loadActivity()]);
  refreshOllamaStatus();
})();
