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

  attachQuickFill(document.body, () => cache);
})();
