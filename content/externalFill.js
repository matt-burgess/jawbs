// Content script loaded on common ATS / job-application sites. Surfaces a
// floating quick-fill toolbar above focused text inputs with pills for the
// user's stored email, phone, LinkedIn URL, and "city, state" (Options →
// Shortcuts). Purely defensive: only listens for focus events, injects a
// button row, does no network calls, sends no messages to the service
// worker.
(async () => {
  const { attachQuickFill } = await import(chrome.runtime.getURL('lib/linkedInFill.js'));

  const KEYS = {
    email: 'settings.email',
    phone: 'settings.phone',
    linkedInUrl: 'settings.linkedInProfileUrl',
    location: 'settings.location',
  };
  const cache = { email: '', phone: '', linkedInUrl: '', location: '' };

  try {
    const r = await chrome.storage.local.get(Object.values(KEYS));
    for (const [k, storageKey] of Object.entries(KEYS)) cache[k] = r[storageKey] || '';
  } catch { /* ignore */ }

  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, storageKey] of Object.entries(KEYS)) {
      if (changes[storageKey]) cache[k] = changes[storageKey].newValue || '';
    }
  });

  // Best-effort question extraction — tries the DOM anchors that ATS
  // vendors reliably ship (aria labels, <label for> pairs, ancestor
  // <label>, prior sibling text). Returns null when nothing looks like
  // a question so the caller can surface an error to the user rather
  // than sending an empty prompt to the LLM.
  function extractQuestionFor(el) {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria.slice(0, 500);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const src = document.getElementById(labelledBy);
      const t = clean(src?.textContent);
      if (t) return t.slice(0, 500);
    }
    if (el.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const t = clean(label?.textContent);
        if (t) return t.slice(0, 500);
      } catch { /* invalid selector — skip */ }
    }
    const parentLabel = el.closest('label');
    if (parentLabel) {
      const raw = clean(parentLabel.textContent);
      // Strip the current value (in case the label wraps the field) so we
      // don't feed the user's own draft-in-progress back to the LLM.
      const t = el.value ? raw.replace(clean(el.value), '').trim() : raw;
      if (t) return t.slice(0, 500);
    }
    // Walk up the ancestor chain up to 4 levels looking for a leading
    // sibling that carries meaningful text — most ATS forms wrap each
    // question in a card whose first child is the question text.
    let node = el;
    for (let depth = 0; depth < 4 && node; depth++) {
      let prev = node.previousElementSibling;
      while (prev) {
        const t = clean(prev.textContent);
        if (t && t.length >= 4 && t.length < 500) return t;
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    const placeholder = clean(el.getAttribute('placeholder'));
    if (placeholder) return placeholder.slice(0, 500);
    return null;
  }

  attachQuickFill(document.body, () => cache, {
    onDraftAi: async ({ target }) => {
      const question = extractQuestionFor(target);
      if (!question) throw new Error('Couldn\'t identify the question for this field');
      const r = await chrome.runtime.sendMessage({
        type: 'draft-application-answer',
        question,
        // The field's own hard limit, if it has one. Portals often cut
        // longer answers off silently.
        maxChars: target.maxLength > 0 ? target.maxLength : null,
        url: location.href,
      });
      if (!r?.ok) throw new Error(r?.error || 'Draft failed');
      // Facts the answer states that aren't in the user's material or the
      // posting (lib/factGuard.js). Pasted anyway; flagged to check.
      if (r.flags?.length) {
        note(`Check before submitting: ${[...new Set(r.flags.map((f) => f.value))].join(', ')} ${r.flags.length === 1 ? 'is' : 'are'} not in your resume, profile or the posting.`);
      }
      return r.answer;
    },
  });

  // ---------- One-click application autofill ----------
  //
  // A "Fill application" button appears when the page has fields we
  // recognise (lib/applicationFill.js). One click fills every recognised
  // field that is still empty, from Options → Shortcuts. It never
  // overwrites what's already typed and never submits — the user reviews
  // and sends. Not on LinkedIn: Jawbs doesn't act on LinkedIn for the user.
  if (/(^|\.)linkedin\.com$/.test(location.hostname)) return;
  const { fieldKey, yesNoKey, buildValues, pickOption } = await import(chrome.runtime.getURL('lib/applicationFill.js'));
  const FILL_ID = 'jc-fill-application';
  const visible = (el) => el.getClientRects().length > 0;
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const hintOf = (el) => `${el.name || ''} ${el.id || ''} ${el.getAttribute('data-automation-id') || ''}`;

  // The question a radio group is answering: its <legend>, its
  // radiogroup label, or the nearest text above the block of options.
  function groupQuestion(radios) {
    const first = radios[0];
    const legend = first.closest('fieldset')?.querySelector('legend');
    if (clean(legend?.textContent)) return clean(legend.textContent);
    const rg = first.closest('[role="radiogroup"]');
    const rgLabel = clean(rg?.getAttribute('aria-label')) || clean(document.getElementById(rg?.getAttribute('aria-labelledby') || '')?.textContent);
    if (rgLabel) return rgLabel;
    let box = first.parentElement;
    while (box && !radios.every((r) => box.contains(r))) box = box.parentElement;
    for (let d = 0; box && d < 3; d++, box = box.parentElement) {
      for (let prev = box.previousElementSibling; prev; prev = prev.previousElementSibling) {
        const t = clean(prev.textContent);
        if (t.length >= 4 && t.length < 500) return t;
      }
    }
    return '';
  }
  const optionLabel = (radio) => clean(document.querySelector(`label[for="${CSS.escape(radio.id || ' ')}"]`)?.textContent)
    || clean(radio.closest('label')?.textContent) || clean(radio.getAttribute('aria-label')) || radio.value;

  // Everything on the page we could fill right now: [{ el, apply() }].
  // Empty fields only; a field the user (or the ATS's own resume parser)
  // already filled is theirs.
  async function plan() {
    const r = await chrome.storage.local.get([...Object.values(KEYS), 'settings.candidateName', 'settings.applicationProfile', 'ui.kit', 'ui.applyClick', 'ui.activeApplicationJawbId']);
    // The pay answer from Comp, if it is for the job being applied to:
    // the one just opened from LinkedIn or the Jawbar, else the one on screen.
    const pa = r['ui.kit']?.pay ? { ...r['ui.kit'].pay, jobId: r['ui.kit'].jobId } : null;
    const click = r['ui.applyClick'];
    const recent = click && Date.now() - click.at < 6 * 60 * 60_000 ? String(click.jobId) : null;
    const pay = pa && [recent, r['ui.activeApplicationJawbId']].filter(Boolean).includes(String(pa.jobId)) ? pa : null;
    const values = buildValues({
      pay,
      name: r['settings.candidateName'], email: r[KEYS.email], phone: r[KEYS.phone],
      location: r[KEYS.location], linkedInUrl: r[KEYS.linkedInUrl],
      profile: r['settings.applicationProfile'] || {},
    });
    const todo = [];

    for (const el of document.querySelectorAll('input, select')) {
      if (el.disabled || el.readOnly || !visible(el)) continue;
      const label = extractQuestionFor(el) || '';
      if (el instanceof HTMLSelectElement) {
        if (el.selectedIndex > 0) continue;
        const want = values[fieldKey({ label, hint: hintOf(el), autocomplete: el.autocomplete }) || yesNoKey(label)];
        const i = pickOption([...el.options].map((o) => ({ text: o.textContent, value: o.value })), want);
        if (i >= 0) todo.push({ el, apply: () => { el.selectedIndex = i; } });
        continue;
      }
      if (!['text', 'email', 'tel', 'url', ''].includes((el.getAttribute('type') || '').toLowerCase())) continue;
      // Type-ahead pickers need a real selection from their list; typing a
      // value in would leave them looking filled but invalid.
      if (el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-autocomplete') || el.hasAttribute('list')) continue;
      if (el.value) continue;
      const value = values[fieldKey({ label, hint: hintOf(el), autocomplete: el.autocomplete })];
      // The native setter, not `el.value =`: React-controlled inputs ignore
      // the latter and snap back to empty on the next render.
      if (value) todo.push({ el, apply: () => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value) });
    }

    // A pay question asked as a paragraph gets the short answer.
    for (const el of document.querySelectorAll('textarea')) {
      if (el.disabled || el.readOnly || el.value || !visible(el) || !values.salaryShort) continue;
      const label = extractQuestionFor(el) || '';
      if (fieldKey({ label, hint: hintOf(el) }) === 'salaryExpectation') {
        todo.push({ el, apply: () => Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, values.salaryShort) });
      }
    }

    const groups = new Map();
    for (const radio of document.querySelectorAll('input[type="radio"]')) {
      if (!radio.name || radio.disabled || !visible(radio.closest('label') || radio.parentElement || radio)) continue;
      if (!groups.has(radio.name)) groups.set(radio.name, []);
      groups.get(radio.name).push(radio);
    }
    for (const radios of groups.values()) {
      if (radios.some((x) => x.checked)) continue;
      const want = values[yesNoKey(groupQuestion(radios))];
      const i = pickOption(radios.map((x) => ({ text: optionLabel(x), value: x.value })), want);
      if (i >= 0) todo.push({ el: radios[i].closest('label') || radios[i], apply: () => radios[i].click() });
    }
    return todo;
  }

  function note(text) {
    const n = document.createElement('div');
    n.setAttribute('role', 'status');
    n.textContent = text;
    n.style.cssText = 'position:fixed;right:20px;bottom:72px;z-index:2147483647;max-width:320px;padding:10px 14px;'
      + 'background:#161E2A;color:#E6EDF5;border:1px solid #3B4B61;border-left:3px solid #E8303A;border-radius:6px;'
      + 'font:500 13px/1.4 system-ui,-apple-system,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25)';
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 7000);
  }

  async function fill() {
    const todo = await plan();
    for (const { el, apply } of todo) {
      apply();
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Mark what we touched so the review the user owes it is easy.
      const was = el.style.outline;
      el.style.outline = '2px solid #FFB020';
      setTimeout(() => { el.style.outline = was; }, 8000);
    }
    note(todo.length
      ? `Jawbs filled ${todo.length} field${todo.length === 1 ? '' : 's'} (outlined in gold). Check each one: nothing has been submitted.`
      : 'Jawbs found nothing left to fill here.');
    if (todo.length) chrome.runtime.sendMessage({ type: 'application-filled', count: todo.length }).catch(() => {});
    refresh();
  }

  // Show the button only while there is something to fill. Forms hydrate
  // late and multi-step ATSs swap pages in place, so re-check on mutation.
  let refreshTimer = null;
  async function refresh() {
    const n = (await plan()).length;
    let btn = document.getElementById(FILL_ID);
    if (n < 2) { btn?.remove(); return; }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = FILL_ID;
      btn.type = 'button';
      btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:10px 16px;cursor:pointer;'
        + 'background:#22CCEE;color:#041119;border:1px solid #22CCEE;border-radius:3px;'
        + 'font:700 13px/1.2 system-ui,-apple-system,sans-serif;letter-spacing:.02em;box-shadow:0 4px 14px rgba(0,0,0,.3)';
      btn.addEventListener('click', fill);
      document.body.appendChild(btn);
    }
    // Name the job when this tab followed an Apply click on LinkedIn, so
    // it's clear whose application Jawbs thinks this is.
    const c = (await chrome.storage.local.get('ui.applyClick'))['ui.applyClick'];
    const forJob = c && Date.now() - c.at < 60 * 60_000 && c.company ? ` · ${c.company}` : '';
    // Only touch the label when it changes — writing it re-triggers the
    // observer below, which would otherwise re-run this every 600ms.
    const text = `Fill application (${n} fields)${forJob}`;
    if (btn.textContent !== text) btn.textContent = text;
    btn.title = 'Jawbs fills the empty fields it recognises from Settings → Shortcuts. It never submits.';
  }
  new MutationObserver(() => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 600); })
    .observe(document.body, { childList: true, subtree: true });
  refresh();
})();
