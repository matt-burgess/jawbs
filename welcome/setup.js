// Setup wizard — step-by-step onboarding for new Jawbs users. Sits on
// top of chrome.storage.local via lib/store.js so anything the wizard
// saves is immediately visible to Settings and the Jawbar.
//
// Steps are declarative (see STEPS below). Each step renders into the
// shared #setupStep container and reads / writes via a storage getter/
// setter pair. Text-field steps hook a shared ✨ Get AI prompt button
// into the modal from PROMPTS. The wizard preserves progress in
// chrome.storage.local.setup so a mid-way close resumes at the same
// step.

import {
  getApiKey, setApiKey,
  getOpenAIKey, setOpenAIKey,
  getGeminiKey, setGeminiKey,
  getCloudProvider, setCloudProvider,
  getProfile, setProfile,
  getMasterResume, setMasterResume,
  getWritingSamples, setWritingSamples,
  getPrepQuestions, setPrepQuestions,
  getCompTargets, setCompTargets,
} from '../lib/store.js';
import { PROMPTS } from '../lib/onboardingPrompts.js';
import { DEFAULT_PROFILE, DEFAULT_COMP_TARGETS, DEFAULT_PREP_QUESTIONS } from '../lib/defaults.js';

// ---------- Step definitions ----------
//
// kind values:
//   'intro'    — welcome or done screen; body is HTML, no field
//   'apiKey'   — special: paste + test the Anthropic key
//   'textarea' — free-form Markdown / plain text with AI prompt helper
//   'comp'     — three numeric inputs for comp floor / target / walk-away

const STEPS = [
  {
    key: 'welcome',
    kind: 'intro',
    title: 'Welcome aboard',
    lead: 'Five minutes to get Jawbs set up so it does its best work. You can skip any step and come back later from Settings.',
    body: `
      <figure class="setup-welcome-art">
        <img src="../assets/big-catch-boat.png" alt="A sportfishing boat named Big Catch on calm water at dawn" />
      </figure>
    `,
    optional: false,
    firstButton: 'Start setup',
  },
  {
    key: 'apiKey',
    kind: 'apiKey',
    title: 'Your AI Provider',
    lead: 'Pick an AI (Anthropic Claude, OpenAI, or Google Gemini) and paste your API key.',
    optional: false,
  },
  {
    key: 'comp',
    kind: 'comp',
    title: 'Compensation Target',
    lead: 'Your target base salary is the number you\'re pursuing.',
    getter: getCompTargets,
    setter: setCompTargets,
    optional: false,
  },
  {
    key: 'profile',
    kind: 'textarea',
    title: 'Profile',
    lead: 'Who you are and what you\'re looking for. The Jawbar reads this on every analysis.',
    promptKey: 'profile',
    getter: getProfile,
    setter: setProfile,
    rows: 6,
    placeholder: DEFAULT_PROFILE,
    optional: false,
  },
  {
    key: 'resume',
    kind: 'textarea',
    title: 'Master resume',
    lead: 'Your comprehensive resume used to draft tailored versions.',
    promptKey: 'resume',
    getter: getMasterResume,
    setter: setMasterResume,
    rows: 6,
    placeholder: 'Paste your full master resume as plain text or Markdown…',
    optional: false,
  },
  {
    key: 'samples',
    kind: 'textarea',
    title: 'Writing samples',
    lead: '2–3 paragraphs in your own voice. Without this, cover letters and interview answers read generic. Paste from a LinkedIn post, an email, a Slack message — anything you\'ve actually written.',
    promptKey: 'samples',
    getter: getWritingSamples,
    setter: setWritingSamples,
    rows: 6,
    placeholder: 'Paste 2–3 paragraphs of your own writing — a Slack post, a LinkedIn post, an email…',
    optional: false,
  },
  {
    key: 'prepQuestions',
    kind: 'textarea',
    title: 'Question Prep questions',
    lead: 'One question per line for tailored answers for jobs you hunt.',
    promptKey: 'prepQuestions',
    getter: getPrepQuestions,
    setter: setPrepQuestions,
    rows: 6,
    placeholder: DEFAULT_PREP_QUESTIONS.join('\n'),
    optional: true,
  },
  {
    key: 'done',
    kind: 'done',
    title: 'You\'re set',
    lead: 'Jawbs is ready. Now open LinkedIn and find the BIG ONE!',
    optional: false,
  },
];

// ---------- State + navigation ----------

let currentIdx = 0;
let hasUnsavedInput = false;

async function loadResumeIdx() {
  try {
    const r = await chrome.storage.local.get('setup');
    const s = r.setup || {};
    return Number.isInteger(s.lastStep) ? Math.min(s.lastStep, STEPS.length - 1) : 0;
  } catch { return 0; }
}
async function saveResumeIdx(i) {
  try {
    const r = await chrome.storage.local.get('setup');
    const s = r.setup || {};
    await chrome.storage.local.set({ setup: { ...s, lastStep: i, completed: i >= STEPS.length - 1 } });
  } catch { /* non-fatal */ }
}

// ---------- Rendering ----------

const $ = (id) => document.getElementById(id);

async function renderStep(idx) {
  currentIdx = Math.max(0, Math.min(idx, STEPS.length - 1));
  hasUnsavedInput = false;
  const step = STEPS[currentIdx];
  const box = $('setupStep');
  box.innerHTML = '';
  renderDots(currentIdx);
  $('setupStepLabel').textContent = `Step ${currentIdx + 1} of ${STEPS.length}`;
  // Hide (not just disable) Previous on the welcome step and Skip on
  // the final "You're set" step so the nav row doesn't show buttons the
  // user can't act on.
  $('setupPrev').hidden = currentIdx === 0;
  $('setupSkip').hidden = !step.optional || step.kind === 'done';
  const nextBtn = $('setupNext');
  if (step.kind === 'intro') nextBtn.textContent = (step.firstButton || 'Next') + ' →';
  else if (step.kind === 'done') nextBtn.textContent = 'Open LinkedIn →';
  else nextBtn.textContent = 'Save & continue →';

  const heading = document.createElement('div');
  heading.className = 'setup-step__head';
  heading.innerHTML = `
    <span class="setup-step__eyebrow">${step.optional ? 'Optional' : 'Required'}</span>
    <h1 class="setup-step__title">${step.title}</h1>
    <p class="setup-step__lead">${step.lead}</p>
  `;
  box.appendChild(heading);

  const content = document.createElement('div');
  content.className = 'setup-step__body';
  // Attach BEFORE the renderers run so document.getElementById in
  // their event-wiring finds the fields they inject via innerHTML.
  // (Renderers on a detached node returned null, and steps 2–6 had
  // input widgets but no wiring — the bug from the first pass.)
  box.appendChild(content);
  if (step.kind === 'intro') {
    content.innerHTML = step.body || '';
  } else if (step.kind === 'apiKey') {
    await renderApiKeyStep(content);
  } else if (step.kind === 'textarea') {
    await renderTextareaStep(content, step);
  } else if (step.kind === 'comp') {
    await renderCompStep(content, step);
  } else if (step.kind === 'done') {
    renderDoneStep(content);
  }
  await saveResumeIdx(currentIdx);
}

function renderDots(active) {
  const wrap = $('setupDots');
  wrap.innerHTML = '';
  STEPS.forEach((s, i) => {
    const li = document.createElement('li');
    li.className = 'setup-dot';
    li.dataset.state = i < active ? 'past' : i === active ? 'now' : 'next';
    li.title = `${i + 1}. ${s.title}`;
    li.textContent = String(i + 1);
    li.addEventListener('click', () => renderStep(i));
    wrap.appendChild(li);
  });
}

// ---- API key step ----
const PROVIDER_META = {
  anthropic: { label: 'Anthropic Claude', placeholder: 'sk-ant-…', link: 'https://console.anthropic.com/settings/keys', linkLabel: 'Get an Anthropic key ↗' },
  openai:    { label: 'OpenAI (GPT-4o)',  placeholder: 'sk-…',     link: 'https://platform.openai.com/api-keys',     linkLabel: 'Get an OpenAI key ↗' },
  gemini:    { label: 'Google Gemini',    placeholder: 'AIza…',    link: 'https://aistudio.google.com/apikey',       linkLabel: 'Get a Gemini key ↗' },
};
async function loadKeyForProvider(provider) {
  if (provider === 'openai') return await getOpenAIKey();
  if (provider === 'gemini') return await getGeminiKey();
  return await getApiKey();
}
async function saveKeyForProvider(provider, key) {
  if (provider === 'openai') return await setOpenAIKey(key);
  if (provider === 'gemini') return await setGeminiKey(key);
  return await setApiKey(key);
}
async function renderApiKeyStep(root) {
  const currentProvider = await getCloudProvider();
  root.innerHTML = `
    <div class="setup-field">
      <label class="setup-field__label" for="wProvider">Provider</label>
      <select id="wProvider" class="jc-select">
        <option value="anthropic">Anthropic Claude</option>
        <option value="openai">OpenAI (GPT-4o)</option>
        <option value="gemini">Google Gemini (2.5 Pro)</option>
      </select>
    </div>
    <div class="setup-field">
      <label class="setup-field__label" for="wKey">API key</label>
      <input type="password" id="wKey" class="jc-input" autocomplete="off" spellcheck="false" />
    </div>
    <div class="jc-btn-row">
      <button id="wKeyTest" class="jc-btn" data-size="sm" type="button">Test key</button>
      <a id="wKeyLink" class="jc-btn" data-variant="ghost" data-size="sm" href="#" target="_blank" rel="noopener"></a>
      <span id="wKeyStatus" class="jc-footnote"></span>
    </div>
    <p class="setup-note">Each provider's key is stored in <code>chrome.storage.local</code> on this machine and never uploaded anywhere else.</p>
  `;
  const sel = $('wProvider');
  const input = $('wKey');
  const link = $('wKeyLink');
  const applyProvider = async (provider) => {
    const meta = PROVIDER_META[provider] || PROVIDER_META.anthropic;
    input.placeholder = meta.placeholder;
    link.href = meta.link;
    link.textContent = meta.linkLabel;
    input.value = (await loadKeyForProvider(provider)) || '';
  };
  sel.value = currentProvider;
  await applyProvider(currentProvider);
  sel.addEventListener('change', async () => {
    await setCloudProvider(sel.value);
    await applyProvider(sel.value);
    hasUnsavedInput = false; // provider change is already persisted
  });
  input.addEventListener('input', () => { hasUnsavedInput = true; });
  $('wKeyTest').addEventListener('click', async () => {
    const status = $('wKeyStatus');
    const key = input.value.trim();
    if (!key) { status.textContent = 'Paste a key first.'; return; }
    status.textContent = 'Testing…';
    try {
      await saveKeyForProvider(sel.value, key);
      const r = await chrome.runtime.sendMessage({ type: 'diagnostic' });
      if (r?.ok) { status.textContent = `✓ ${PROVIDER_META[sel.value]?.label || 'Provider'} key works. Saved.`; }
      else { status.textContent = `✗ ${r?.error || 'Test failed'}`; }
    } catch (e) { status.textContent = `✗ ${e.message}`; }
  });
}
async function saveApiKeyStep() {
  const sel = $('wProvider');
  const input = $('wKey');
  if (!input || !sel) return true;
  await setCloudProvider(sel.value);
  const val = input.value.trim();
  if (val) await saveKeyForProvider(sel.value, val);
  return true;
}

// ---- Textarea step ----
async function renderTextareaStep(root, step) {
  const current = (await step.getter()) || '';
  const isPrepList = step.key === 'prepQuestions';
  const raw = isPrepList && Array.isArray(current) ? current.join('\n') : current;
  root.innerHTML = `
    <!-- Prominent AI-helper callout above the textarea so first-time
         users see the "outsource this" option before they see a blank
         box asking them to write. Yellow band + explicit copy makes
         the affordance discoverable. Two-button stack on the right:
         1) copy the AI prompt, 2) load the .md file the AI produces. -->
    <div class="setup-ai-helper">
      <div class="setup-ai-helper__body">
        <h3 class="setup-ai-helper__title">Not sure what to write?</h3>
      </div>
      <div class="setup-ai-helper__actions">
        <button class="jc-btn setup-ai-helper__cta" data-variant="highlight" data-prompt-key="${step.promptKey}" type="button">✨ Get AI prompt →</button>
        <label for="wFieldFile" class="jc-btn setup-ai-helper__load" title="Load the .md file the AI produced.">Then, Click to Load the .MD File</label>
        <input id="wFieldFile" type="file" accept=".md,text/markdown,text/plain" hidden />
      </div>
    </div>

    <div class="setup-field">
      <label class="setup-field__label" for="wField">Paste or write here</label>
      <textarea id="wField" class="jc-textarea" rows="${step.rows || 12}" spellcheck="false" placeholder="${(step.placeholder || '').replace(/"/g, '&quot;').slice(0, 200)}"></textarea>
      <span id="wFieldStatus" class="jc-footnote"></span>
    </div>
  `;
  const ta = $('wField');
  ta.value = raw;
  ta.addEventListener('input', () => { hasUnsavedInput = true; });
  $('wFieldFile').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    ta.value = text;
    hasUnsavedInput = true;
    const status = $('wFieldStatus');
    if (status) status.textContent = `Loaded ${f.name}.`;
  });
}
async function saveTextareaStep(step) {
  const ta = $('wField');
  if (!ta) return true;
  const val = ta.value;
  if (step.key === 'prepQuestions') {
    const lines = val.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length) await step.setter(lines);
  } else if (val.trim()) {
    await step.setter(val);
  }
  return true;
}

// ---- Comp step ----
async function renderCompStep(root, step) {
  const current = (await step.getter()) || { ...DEFAULT_COMP_TARGETS };
  root.innerHTML = `
    <label class="setup-field setup-field--single">
      <span class="setup-field__label">Target salary (USD, base)</span>
      <span class="setup-field__hint">The number you're pursuing — where you'd be genuinely excited to negotiate. Jawbs's Comp gauge is tinted based on where each posting's range lands vs this.</span>
      <input id="wCompTarget" type="number" min="0" step="1000" class="jc-input setup-comp-input" placeholder="For example, $123,456" />
    </label>
    <p class="setup-note">Optional advanced anchors (Floor, Walk-away, Current benchmark) live in Settings → You → Search parameters.</p>
  `;
  const el = $('wCompTarget');
  if (current.target != null) el.value = String(current.target);
  el.addEventListener('input', () => { hasUnsavedInput = true; });
}
async function saveCompStep(step) {
  const n = Number($('wCompTarget')?.value);
  if (Number.isFinite(n) && n > 0) {
    const existing = (await step.getter()) || { ...DEFAULT_COMP_TARGETS };
    await step.setter({ ...existing, target: n });
  }
  return true;
}

// ---- Done step ----
//
// Captain portrait + big tip-jar CTA. The wizard's primary Next button
// (relabeled "Open LinkedIn →" for the done step by renderStep) still
// takes the user into a LinkedIn job search — that's their next action.
// This step's body is reserved for the tip ask.
function renderDoneStep(root) {
  root.innerHTML = `
    <figure class="setup-tip">
      <img src="../assets/jawb-captain.png" alt="Your captain" class="setup-tip__captain" />
      <figcaption class="setup-tip__copy">
        <span class="setup-tip__eyebrow">Bon voyage</span>
        <h2 class="setup-tip__title">Remember to tip your captain</h2>
        <p class="setup-tip__desc">Jawbs is a one-person show. If it enhanced your job search, a few bucks in the jar keeps the boat afloat.</p>
        <a class="jc-btn setup-tip__cta" data-variant="highlight" href="https://buymeacoffee.com/mattburgess" target="_blank" rel="noopener">
          <img src="../assets/tip-jar.png" width="44" height="44" alt="" class="setup-tip__jar" />
          <span>Tip your captain</span>
        </a>
      </figcaption>
    </figure>
  `;
}

// ---------- Save + navigate ----------

async function saveCurrent() {
  const step = STEPS[currentIdx];
  try {
    if (step.kind === 'apiKey') return await saveApiKeyStep();
    if (step.kind === 'textarea') return await saveTextareaStep(step);
    if (step.kind === 'comp') return await saveCompStep(step);
    return true;
  } catch (e) {
    console.error('[Jawbs setup] save failed:', e);
    alert(`Save failed: ${e.message}`);
    return false;
  }
}

async function advance() {
  const step = STEPS[currentIdx];
  if (step.kind !== 'intro' && step.kind !== 'done') {
    const ok = await saveCurrent();
    if (!ok) return;
  }
  if (step.kind === 'done') {
    // Same click that opens LinkedIn also marks the wizard completed.
    await saveResumeIdx(STEPS.length - 1);
    window.open('https://www.linkedin.com/jobs/search/', '_blank', 'noopener');
    return;
  }
  await renderStep(currentIdx + 1);
}
async function goBack() { if (currentIdx > 0) await renderStep(currentIdx - 1); }
async function skip() { await renderStep(currentIdx + 1); }

// ---------- Prompt modal ----------

function openPromptModal(key) {
  const preset = PROMPTS[key];
  if (!preset) return;
  const modal = $('promptModal');
  $('promptModalTitle').textContent = preset.title;
  $('promptModalIntro').textContent = preset.intro;
  const body = $('promptModalBody');
  body.value = preset.body;
  $('promptCopyStatus').textContent = '';
  modal.hidden = false;
  setTimeout(() => { body.focus(); body.select(); }, 30);
}
function closePromptModal() { $('promptModal').hidden = true; }

document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-prompt-key]');
  if (trigger) { openPromptModal(trigger.dataset.promptKey); return; }
  if (e.target.closest('[data-modal-close]')) closePromptModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePromptModal();
});
$('promptCopy')?.addEventListener('click', async () => {
  const body = $('promptModalBody');
  const status = $('promptCopyStatus');
  try {
    await navigator.clipboard.writeText(body.value);
    status.textContent = 'Copied — paste into your AI.';
    setTimeout(() => { status.textContent = ''; }, 4000);
  } catch {
    body.focus(); body.select();
    status.textContent = 'Press ⌘/Ctrl+C to copy.';
  }
});

// ---------- Wire ----------

$('setupNext').addEventListener('click', advance);
$('setupPrev').addEventListener('click', goBack);
$('setupSkip').addEventListener('click', skip);

// ---------- Init ----------
(async () => {
  const resumeIdx = await loadResumeIdx();
  await renderStep(resumeIdx);
})();
