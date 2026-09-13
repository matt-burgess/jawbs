// Shark-fin nudge — runs on every linkedin.com page (broader match than
// scrape.js which only covers /jobs/* /jobs-tracker/* /my-items/*).
// Counts URL visits while the Jawbar (side panel) is closed; on every
// 5th visit, sends a shark fin swimming across the bottom of the screen.
// Click opens the Jawbar.
//
// Isolated from scrape.js so this can run on /feed/, /in/, /messaging/,
// etc. without also loading the whole scrape/enrichment machinery.

(() => {
  const FIN_ID = 'jt-jawbar-fin';
  const KEYFRAMES_ID = 'jt-fin-keyframes';
  const COUNTER_KEY = 'finVisitCounter';
  const INTERVAL = 5; // trigger every Nth visit
  let lastCountedUrl = null;

  async function maybeSwimFin() {
    // Same URL as last count → nothing to do. LinkedIn is a SPA so the
    // URL poller below fires often on the same URL; without this guard
    // the counter would race way past 5.
    if (lastCountedUrl === location.href) return;
    lastCountedUrl = location.href;

    // Skip when the Jawbar is already open. The service worker tracks
    // panel state via heartbeats; if the SW is asleep, message send
    // rejects and we treat panel as closed.
    let panelOpen = false;
    try {
      const r = await chrome.runtime.sendMessage({ type: 'is-panel-open' });
      panelOpen = !!(r && r.data);
    } catch { /* SW asleep — treat as closed */ }
    if (panelOpen) return;

    // Increment persisted counter. Racy across tabs — acceptable, the
    // worst case is the fin appearing one visit early or late.
    let counter = 0;
    try {
      const r = await chrome.storage.local.get(COUNTER_KEY);
      counter = (Number(r?.[COUNTER_KEY]) || 0) + 1;
      await chrome.storage.local.set({ [COUNTER_KEY]: counter });
    } catch { return; }

    if (counter < INTERVAL) return;
    try { await chrome.storage.local.set({ [COUNTER_KEY]: 0 }); } catch {}
    swimFin();
  }

  function swimFin() {
    if (document.getElementById(FIN_ID)) return;
    ensureKeyframes();
    const img = document.createElement('img');
    img.id = FIN_ID;
    img.src = chrome.runtime.getURL('assets/shark-fin-swim.png');
    img.alt = 'Open Jawbar';
    img.title = 'Open Jawbar';
    img.style.cssText = [
      'position: fixed',
      // Negative bottom so the fin's transparent bottom padding
      // clears the viewport edge — the PNG has ~10-20px of empty
      // space below the visible fin outline that would otherwise
      // read as a gap. `display: block` kills the inline-image
      // baseline slop that also contributed to the offset.
      'bottom: -14px',
      'left: -160px',
      'width: 110px', 'height: auto',
      'display: block',
      'z-index: 2147483646',
      'cursor: pointer',
      'pointer-events: auto',
      'filter: drop-shadow(0 3px 6px rgba(0,0,0,0.35))',
      'animation: jtFinSwim 9s linear forwards',
      'user-select: none',
    ].join(';');
    img.onclick = async () => {
      img.style.animationPlayState = 'paused';
      try { await chrome.runtime.sendMessage({ type: 'open-side-panel' }); }
      catch { /* SW asleep — user can still click the toolbar icon */ }
      img.remove();
    };
    img.addEventListener('animationend', () => img.remove());
    (document.body || document.documentElement).appendChild(img);
  }

  function ensureKeyframes() {
    if (document.getElementById(KEYFRAMES_ID)) return;
    const style = document.createElement('style');
    style.id = KEYFRAMES_ID;
    // The fin translates all the way across (100vw plus its own width
    // for a clean off-screen exit) with a subtle vertical bob.
    style.textContent = `
      @keyframes jtFinSwim {
        0%   { transform: translateX(0) translateY(0); }
        20%  { transform: translateX(20vw) translateY(-4px); }
        40%  { transform: translateX(40vw) translateY(2px); }
        60%  { transform: translateX(60vw) translateY(-3px); }
        80%  { transform: translateX(80vw) translateY(3px); }
        100% { transform: translateX(calc(100vw + 200px)) translateY(0); }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // Fire once on initial load, then poll for SPA navigation. LinkedIn
  // is a heavy SPA — `popstate` doesn't fire for pushState transitions,
  // so URL polling is the reliable way to detect all navs.
  maybeSwimFin().catch(() => {});
  setInterval(() => {
    maybeSwimFin().catch(() => {});
  }, 800);
})();
