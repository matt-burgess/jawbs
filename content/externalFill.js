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
        url: location.href,
      });
      if (!r?.ok) throw new Error(r?.error || 'Draft failed');
      return r.answer;
    },
  });
})();
