// Welcome page — shown once on install. Buttons deep-link into the Options
// tabs (?tab=you|ai|system) and mark onboarding complete when the user
// clicks either footer button.

const OPTIONS_URL = (tab) => chrome.runtime.getURL(
  `options/options.html${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`
);

document.querySelectorAll('[data-open-tab]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    await markOnboardingDone();
    chrome.tabs.create({ url: OPTIONS_URL(btn.dataset.openTab) });
  });
});

document.getElementById('wOpenLinkedIn')?.addEventListener('click', async () => {
  await markOnboardingDone();
  chrome.tabs.create({ url: 'https://www.linkedin.com/jobs/' });
});

// Both the hero "Take me to Settings" and the footer copy trigger the
// same routing — go to Options → AI Settings and mark onboarding done.
for (const id of ['wDone', 'wDone2']) {
  document.getElementById(id)?.addEventListener('click', async () => {
    await markOnboardingDone();
    chrome.tabs.create({ url: OPTIONS_URL('ai') });
  });
}
for (const id of ['wLater', 'wLater2']) {
  document.getElementById(id)?.addEventListener('click', async () => {
    await markOnboardingDone();
    window.close();
  });
}

async function markOnboardingDone() {
  try { await chrome.storage.local.set({ 'onboarding.done': true }); } catch {}
}
