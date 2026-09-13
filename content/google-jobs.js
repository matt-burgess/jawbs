// Google Jobs source adapter — the second hunting ground.
//
// Google Search embeds a jobs experience at /search?udm=8 (list) with
// a detail pane that populates in-place on card selection (URL hash
// mutates, no page load). This content script:
//   1. Detects the Google Jobs context (URL match + detail-pane
//      presence).
//   2. Observes SPA mutations so card selection is caught in real time.
//   3. Extracts fields from the currently-selected detail pane with
//      per-field fallback strategies and null-safe returns.
//   4. Injects a "Bait" button in the detail pane that captures the
//      job into the same Jawboard pipeline the LinkedIn adapter uses.
//      Re-injects on DOM churn.
//   5. Emits `job-detected` messages on new selections so the Jawbar
//      (side panel) can react like it does on LinkedIn.
//
// Class names in Google Search are obfuscated and rotated frequently.
// EVERY selector below anchors on stable signals first (aria-*, roles,
// semantic structure, canonical text like "Apply", "via", posted-age
// patterns) and falls back through 2–3 strategies. Enable DEBUG below
// to log which strategy fired for each field so breakage is diagnosable
// from the console.

(() => {
  const DEBUG = false;
  const log = (...args) => { if (DEBUG) console.info('[Google Jobs adapter]', ...args); };

  // ---------- Detection ----------

  const isGoogleJobsUrl = () => {
    try {
      const u = new URL(location.href);
      if (!/(^|\.)google\.[a-z.]+$/i.test(u.hostname)) return false;
      if (!/^\/search\/?$/.test(u.pathname)) return false;
      if (u.searchParams.get('udm') === '8') return true;
      const ibp = u.searchParams.get('ibp') || '';
      if (/htl;\s*jobs/i.test(ibp)) return true;
      return false;
    } catch { return false; }
  };

  // Detail pane detection — Google renders a large right-side region
  // when a card is selected. We look for a container that has:
  //   - a heading that's not part of the search header (H2/H3 tagged
  //     as a job title anchor), OR
  //   - the "Apply" section which only exists in the detail pane
  function findDetailPane() {
    // Strategy A: role="main" or role="region" holding an Apply anchor
    const applyAnchor = Array.from(document.querySelectorAll('a[href], button'))
      .find((el) => /^(apply|apply on|apply now)/i.test((el.innerText || '').trim()));
    if (applyAnchor) {
      const region = applyAnchor.closest('[role="region"], [role="main"], [aria-label]');
      if (region) { log('detail pane via apply anchor'); return region; }
    }
    // Strategy B: a large panel with a jobs-specific aria-label
    const labelled = document.querySelector('[aria-label*="job" i][role]');
    if (labelled) { log('detail pane via aria-label'); return labelled; }
    // Strategy C: any container that has both a heading and an "Apply"
    // button descendant.
    for (const container of document.querySelectorAll('div[jscontroller], div[role="main"], div[role="region"]')) {
      if (container.querySelector('h1, h2, h3') &&
          Array.from(container.querySelectorAll('a, button')).some((el) => /^apply/i.test((el.innerText || '').trim()))) {
        log('detail pane via container heuristic');
        return container;
      }
    }
    return null;
  }

  // ---------- Field extractors ----------
  //
  // Each helper receives the detail-pane root and returns a value or
  // null. Never throw — a failed strategy just falls to the next.

  function extractTitle(root) {
    // Strategy A: the largest H2/H1 inside the detail pane
    const heads = Array.from(root.querySelectorAll('h1, h2'));
    if (heads.length) {
      const largest = heads
        .filter((h) => (h.innerText || '').trim().length > 3)
        .sort((a, b) => (b.getBoundingClientRect().height || 0) - (a.getBoundingClientRect().height || 0))[0];
      if (largest) { log('title via largest heading'); return (largest.innerText || '').trim(); }
    }
    // Strategy B: any element with role="heading"
    const roled = root.querySelector('[role="heading"]');
    if (roled) { log('title via role=heading'); return (roled.innerText || '').trim(); }
    // Strategy C: document.title — Google encodes "Title — company · location — Google Search"
    const dt = (document.title || '').split(/[—–\-|]/)[0].trim();
    if (dt && !/google/i.test(dt)) { log('title via document.title'); return dt; }
    return null;
  }

  function extractCompany(root, title) {
    // Strategy A: element immediately after the title heading in the DOM
    if (title) {
      const heads = Array.from(root.querySelectorAll('h1, h2, [role="heading"]'));
      const titleEl = heads.find((h) => (h.innerText || '').trim() === title.trim());
      if (titleEl) {
        let sib = titleEl.nextElementSibling;
        // Skip empty or purely decorative siblings.
        while (sib && !(sib.innerText || '').trim()) sib = sib.nextElementSibling;
        if (sib) {
          const first = (sib.innerText || '').split('\n')[0].trim();
          if (first && first.length < 120) { log('company via title sibling'); return first; }
        }
      }
    }
    // Strategy B: aria-label containing "at [company]"
    const labelled = root.querySelector('[aria-label*=" at " i]');
    if (labelled) {
      const m = (labelled.getAttribute('aria-label') || '').match(/\bat\s+(.+?)(?:\s+in\b|$)/i);
      if (m) { log('company via aria-label'); return m[1].trim(); }
    }
    // Strategy C: link to /company/ or /about/ — company site links
    const companyLink = Array.from(root.querySelectorAll('a[href]'))
      .find((a) => /\/(company|about|careers)\/?/i.test(a.getAttribute('href') || ''));
    if (companyLink) {
      const t = (companyLink.innerText || '').trim();
      if (t && t.length < 120) { log('company via careers link'); return t; }
    }
    return null;
  }

  function extractLocation(root) {
    // Strategy A: look for the classic "City, ST" / "Remote" chip near
    // the top of the pane. Match on text pattern.
    const patterns = [
      /^remote\b/i,
      /^anywhere\b/i,
      /^[\w .-]+,\s*[A-Z]{2}\b/,       // "Austin, TX"
      /^[\w .-]+,\s*[\w .-]+,\s*[A-Z]{2}/, // "Downtown, Austin, TX"
    ];
    const spans = Array.from(root.querySelectorAll('span, div'))
      .slice(0, 200); // first ~200 elements — location cluster is always near the top
    for (const el of spans) {
      const t = ((el.innerText || '').split('\n')[0] || '').trim();
      if (t && t.length < 80 && patterns.some((p) => p.test(t))) {
        log('location via text pattern');
        return t;
      }
    }
    return null;
  }

  // Convert Google's relative posted-age string ("3 days ago",
  // "10 hours ago", "1 month ago", "just posted") into an absolute
  // ISO date. Returns null when no age string is found.
  function extractPostedDate(root) {
    const agoRe = /(\d+)\+?\s*(minute|hour|day|week|month|year)s?\s+ago/i;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue || '').trim();
      if (!text) continue;
      if (/just\s+posted/i.test(text)) {
        log('posted date: just posted');
        return new Date().toISOString().slice(0, 10);
      }
      const m = text.match(agoRe);
      if (m) {
        const n = parseInt(m[1], 10);
        const unit = m[2].toLowerCase();
        const ms = { minute: 60_000, hour: 3_600_000, day: 86_400_000,
                     week: 604_800_000, month: 2_592_000_000, year: 31_536_000_000 }[unit];
        if (Number.isFinite(n) && ms) {
          const iso = new Date(Date.now() - n * ms).toISOString().slice(0, 10);
          log(`posted date: ${n} ${unit}(s) ago → ${iso}`);
          return iso;
        }
      }
    }
    return null;
  }

  function extractSalary(root) {
    // Match common Google formats: "$150K–$200K a year", "$45 an hour",
    // "$120,000 - $150,000 per year".
    const salaryRe = /\$\s?[\d,]+(?:\.\d+)?\s?[Kk]?(?:\s*[-–—to]+\s*\$\s?[\d,]+(?:\.\d+)?\s?[Kk]?)?\s*(?:a|per|\/)?\s*(?:year|yr|hour|hr|month|mo|week|wk)?/;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue || '').trim();
      const m = text.match(salaryRe);
      if (m && /\$/.test(m[0])) { log(`salary: ${m[0]}`); return m[0].trim(); }
    }
    return null;
  }

  function extractEmploymentType(root) {
    const types = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Internship', 'Volunteer'];
    const bodyText = (root.innerText || '').slice(0, 4000);
    for (const t of types) {
      const re = new RegExp(`\\b${t.replace('-', '[- ]')}\\b`, 'i');
      if (re.test(bodyText)) { log(`employment type: ${t}`); return t; }
    }
    return null;
  }

  // Collect every non-Google outbound link that reads as an apply target.
  // Return them ranked: company site > LinkedIn > everything else.
  function extractApplyLinks(root) {
    const seen = new Set();
    const links = [];
    // Strategy A: any anchor whose text starts with "Apply"
    for (const a of root.querySelectorAll('a[href]')) {
      const text = ((a.innerText || '').split('\n')[0] || '').trim();
      const href = a.getAttribute('href') || '';
      if (!/^https?:\/\//.test(href)) continue;
      if (!/^apply\b/i.test(text)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      links.push({ url: href, label: text, host: safeHostname(href) });
    }
    // Strategy B: apply section is often a list of external site names
    // ("via LinkedIn", "via Greenhouse") — grab those too when strategy
    // A didn't produce enough.
    if (links.length === 0) {
      for (const a of root.querySelectorAll('a[href^="http"]')) {
        const href = a.getAttribute('href') || '';
        if (/google\./i.test(safeHostname(href))) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        links.push({ url: href, label: (a.innerText || '').trim() || safeHostname(href), host: safeHostname(href) });
      }
    }
    // Rank: company site (no known job-board host) first, then
    // LinkedIn, then everything else in original order.
    const jobBoards = /linkedin|greenhouse|lever\.co|ashbyhq|workday|myworkdayjobs|jobvite|smartrecruiters|indeed|glassdoor|ziprecruiter|monster/i;
    links.sort((a, b) => {
      const aBoard = jobBoards.test(a.host), bBoard = jobBoards.test(b.host);
      if (aBoard !== bBoard) return aBoard ? 1 : -1;
      if (aBoard && bBoard) {
        const aLi = /linkedin/i.test(a.host), bLi = /linkedin/i.test(b.host);
        if (aLi !== bLi) return aLi ? -1 : 1;
      }
      return 0;
    });
    log(`apply links: ${links.length} (primary host: ${links[0]?.host})`);
    return links;
  }

  function safeHostname(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }

  // "via LinkedIn", "via Greenhouse" — Google-attributed source badge.
  function extractVia(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const m = (node.nodeValue || '').match(/\bvia\s+([A-Z][\w. ]{1,30})/);
      if (m) { log(`via: ${m[1].trim()}`); return m[1].trim(); }
    }
    return null;
  }

  function extractDescription(root) {
    // Strategy A: a jobDescription-shaped region — largest text block
    // that isn't the header/apply cluster.
    const blocks = Array.from(root.querySelectorAll('div, section, article'))
      .map((el) => ({ el, text: (el.innerText || '').trim() }))
      .filter((x) => x.text.length > 400)
      .sort((a, b) => b.text.length - a.text.length);
    if (blocks[0]) { log('description via largest text block'); return blocks[0].text.slice(0, 20000); }
    // Strategy B: root innerText minus header — coarse fallback.
    const full = (root.innerText || '').trim();
    if (full.length > 200) { log('description via full root text'); return full.slice(0, 20000); }
    return null;
  }

  // ---------- Compose full JobDraft ----------

  function extractJobDraft() {
    const root = findDetailPane();
    if (!root) { log('no detail pane found'); return null; }
    const title = extractTitle(root);
    const company = extractCompany(root, title);
    // A capture is only useful with a title AND at least one identifier
    // beyond the title itself (company or an apply URL). This avoids
    // capturing the search-header state as if it were a job.
    if (!title) return null;
    const applyLinks = extractApplyLinks(root);
    const primaryApply = applyLinks[0]?.url || null;
    if (!company && !primaryApply) return null;

    // Stable jobId — derive from the primary apply URL (or fall back to
    // a hash of title+company). Sharing an ID across sessions lets a
    // job re-selected later match its own record.
    const jobId = stableJobId({ primaryApply, title, company });

    const posting = {
      title,
      company: company || null,
      location: extractLocation(root),
      postedDate: extractPostedDate(root),
      postedSalaryRange: extractSalary(root),
      employmentType: extractEmploymentType(root),
      descriptionText: extractDescription(root),
    };
    const via = extractVia(root);

    return {
      jobId,
      source: 'google_jobs',
      url: primaryApply || location.href, // durable link, not the #sv= blob
      googleSearchUrl: location.href,      // preserved for reference
      via,
      applyLinks,
      posting,
      cardText: null,
      capturedAt: new Date().toISOString(),
    };
  }

  // Deterministic ID so re-selecting the same job doesn't create dupes
  // in the recent-jobs list. Prefix with 'gj_' so the ID space can never
  // collide with LinkedIn's numeric IDs.
  function stableJobId({ primaryApply, title, company }) {
    const seed = primaryApply
      ? new URL(primaryApply).origin + new URL(primaryApply).pathname
      : `${(title || '').toLowerCase()}|${(company || '').toLowerCase()}`;
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
    return `gj_${Math.abs(h).toString(36)}`;
  }

  // ---------- Spawn button + capture ----------

  const SPAWN_BTN_ID = 'jt-gj-spawn';

  function injectSpawnButton() {
    const root = findDetailPane();
    if (!root) return;
    if (root.querySelector(`#${SPAWN_BTN_ID}`)) return;
    const draft = extractJobDraft();
    if (!draft) return;

    const btn = document.createElement('button');
    btn.id = SPAWN_BTN_ID;
    btn.type = 'button';
    btn.title = 'Capture this jawb into your Jawboard';
    btn.setAttribute('data-jt-jobid', draft.jobId);
    btn.style.cssText = [
      'display: inline-flex', 'align-items: center', 'gap: 8px',
      'padding: 8px 14px', 'margin: 8px 0',
      'background: #F59320', 'color: #1a1f2e',
      'border: 1px solid #b7691a', 'border-radius: 6px',
      'font: 700 12px/1 system-ui, -apple-system, sans-serif',
      'letter-spacing: 0.06em', 'text-transform: uppercase',
      'cursor: pointer',
      'box-shadow: 0 2px 6px rgba(0,0,0,0.25)',
    ].join(';');
    // Leading logo — Jawbs extension icon. Kept as an <img>
    // (not a background) so setSpawnLabel() can wipe/restore text
    // without losing the icon.
    const logo = document.createElement('img');
    logo.src = chrome.runtime.getURL('assets/icon-48.png');
    logo.alt = '';
    logo.style.cssText = 'width:16px;height:16px;flex:none;display:block;';
    const label = document.createElement('span');
    label.textContent = 'Bait to Jawboard';
    btn.append(logo, label);
    btn.onmouseover = () => { btn.style.filter = 'brightness(1.08)'; };
    btn.onmouseout = () => { btn.style.filter = ''; };
    btn.onclick = () => spawnCapture(btn);

    // Anchor near the top of the pane. Prefer inserting right after
    // the first heading; fall back to prepending the root.
    const heading = root.querySelector('h1, h2, [role="heading"]');
    if (heading?.parentElement) {
      heading.parentElement.insertBefore(btn, heading.nextSibling);
    } else {
      root.insertBefore(btn, root.firstChild);
    }
    log('spawn button injected');
  }

  async function spawnCapture(btn) {
    // Label lives in the last <span> so we can update text without
    // wiping the leading logo <img>.
    const labelEl = btn.querySelector('span');
    const setLabel = (t) => { if (labelEl) labelEl.textContent = t; };
    const original = labelEl?.textContent || 'Bait to Jawboard';
    const draft = extractJobDraft();
    if (!draft) {
      flashBtn(btn, '⚠ Could not extract', '#c62d2d');
      return;
    }
    btn.disabled = true;
    setLabel('Baiting…');

    // Dedup check — same title+company already captured?
    try {
      const dup = await chrome.runtime.sendMessage({
        type: 'check-duplicate',
        title: draft.posting.title, company: draft.posting.company,
      });
      if (dup?.ok && dup.data?.match) {
        const j = dup.data.match;
        const when = j.capturedAt ? new Date(j.capturedAt).toLocaleDateString() : 'earlier';
        const via = jobSourceLabel(j.source);
        const msg = `Already circling this one — captured from ${via} on ${when}. Bait anyway?`;
        if (!confirm(msg)) {
          btn.disabled = false;
          setLabel(original);
          return;
        }
      }
    } catch { /* dedup best-effort */ }

    try {
      const r = await chrome.runtime.sendMessage({
        type: 'save-to-archive',
        data: draft,
      });
      if (r?.ok) flashBtn(btn, '✓ Baited', '#3aa66a');
      else flashBtn(btn, `⚠ ${r?.error || 'failed'}`, '#c62d2d');
    } catch (e) {
      flashBtn(btn, `⚠ ${e.message}`, '#c62d2d');
    } finally {
      setTimeout(() => { btn.disabled = false; setLabel(original); }, 1800);
    }
  }

  function jobSourceLabel(source) {
    if (source === 'google_jobs') return 'Google Jobs';
    return 'LinkedIn';
  }

  function flashBtn(btn, text, color) {
    const labelEl = btn.querySelector('span');
    if (labelEl) labelEl.textContent = text;
    btn.style.background = color;
    btn.style.color = '#fff';
    setTimeout(() => {
      btn.style.background = '#F59320';
      btn.style.color = '#1a1f2e';
    }, 1600);
  }

  // ---------- SPA observation ----------
  //
  // Google Jobs mutates the URL fragment and detail pane in place. We
  // hook hashchange + popstate + a debounced MutationObserver on
  // document.body. Every trigger re-runs recognition + injection.

  // Guard for search-detected reporting — Google Jobs uses hash-based
  // navigation so the poller/observer will fire many times per URL.
  let lastReportedSearchUrl = null;
  function reportSearch() {
    if (!isGoogleJobsUrl()) return;
    // Strip the #sv= detail-pane state so a list-page URL and a
    // detail-selected URL don't count as two different searches.
    const url = location.origin + location.pathname + location.search;
    if (url === lastReportedSearchUrl) return;
    lastReportedSearchUrl = url;
    chrome.runtime.sendMessage({ type: 'search-detected', url }).catch(() => {});
    log('search-detected:', url);
  }

  let lastDetailKey = '';
  function recognize() {
    if (!isGoogleJobsUrl()) return;
    // Every URL visit → record as a recent search regardless of whether
    // a detail pane is populated. Handled before the detail-pane guard
    // below so list-only pages still count.
    reportSearch();
    const root = findDetailPane();
    if (!root) return;
    const draft = extractJobDraft();
    if (!draft) return;
    const key = `${draft.jobId}::${draft.posting.title}`;
    if (key === lastDetailKey) {
      // Same job selected — just re-inject the button in case the
      // DOM churn removed it.
      injectSpawnButton();
      return;
    }
    lastDetailKey = key;
    log('new selection:', draft.posting.title);
    // Report to SW so the Jawbar sidebar can populate.
    chrome.runtime.sendMessage({
      type: 'job-detected',
      data: draft,
      isNew: true,
    }).catch(() => {});
    injectSpawnButton();
  }

  // Debounce so a burst of mutations only runs recognize once.
  let recognizeTimer = null;
  function scheduleRecognize(delay = 300) {
    clearTimeout(recognizeTimer);
    recognizeTimer = setTimeout(() => recognize(), delay);
  }

  const obs = new MutationObserver(() => scheduleRecognize(300));
  obs.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('hashchange', () => scheduleRecognize(200));
  window.addEventListener('popstate', () => scheduleRecognize(200));

  // Patch pushState/replaceState — Google uses them to switch cards
  // without firing hashchange/popstate.
  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method];
    history[method] = function (...args) {
      const r = orig.apply(this, args);
      scheduleRecognize(200);
      return r;
    };
  }

  // Initial pass after page settles.
  scheduleRecognize(1500);
})();
