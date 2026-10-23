// Hosts the flyout (lib/flyoutView.js) on the right edge of the LinkedIn
// page, which is just left of the side panel. Chrome allows one side
// panel, so the detail view is an overlay on the page instead. The side
// panel drives it with messages:
//   { type: 'jawbar:flyout', step, payload }  show or refresh a step
//   { type: 'jawbar:flyout-close' }           close it
// and gets { type: 'jawbar:flyout-action', action, step } and
// { type: 'jawbar:flyout-closed' } back.

(() => {
  if (window.__jawbarFlyout) return;
  window.__jawbarFlyout = true;

  let flyout = null;

  // @font-face inside a shadow root does not register, so the fonts load
  // on the page itself. If LinkedIn's CSP blocks it the fallbacks apply.
  function loadFonts() {
    if (document.getElementById('jawbar-flyout-fonts')) return;
    const link = document.createElement('link');
    link.id = 'jawbar-flyout-fonts';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;600;700&family=Barlow+Condensed:wght@600;700&family=JetBrains+Mono:wght@500;700&display=swap';
    document.head.append(link);
  }

  async function get() {
    if (flyout) return flyout;
    const { createFlyout } = await import(chrome.runtime.getURL('lib/flyoutView.js'));
    loadFonts();
    flyout = createFlyout({
      mode: 'page',
      onAction: (action, data) => chrome.runtime.sendMessage({ type: 'jawbar:flyout-action', action, ...data }).catch(() => {}),
      onClose: () => chrome.runtime.sendMessage({ type: 'jawbar:flyout-closed' }).catch(() => {}),
    });
    return flyout;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.type === 'jawbar:flyout') {
      get().then((f) => { f.show(msg.step, msg.payload); sendResponse({ ok: true }); })
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    }
    if (msg?.type === 'jawbar:flyout-close') {
      flyout?.close({ silent: true });
      sendResponse({ ok: true });
    }
    return false;
  });
})();
