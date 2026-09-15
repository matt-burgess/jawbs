(async () => {
  const { SELECTORS, extractJobId } = await import(chrome.runtime.getURL('content/selectors.js'));

  // Auto-open the side panel on the FIRST user gesture on any LinkedIn page.
  // MV3 requires user activation for sidePanel.open(); a navigation/tab-
  // activation event does not qualify. Piggybacking on any pointerdown /
  // keydown DOES, and the click bubble through sendMessage → SW.open() is
  // treated as inside the gesture. Guarded to fire once per page load so
  // we don't spam open() on every scroll or click.
  let sidePanelOpenRequested = false;
  function requestSidePanelOpen() {
    if (sidePanelOpenRequested) return;
    sidePanelOpenRequested = true;
    try { chrome.runtime.sendMessage({ type: 'open-side-panel' }); } catch {}
  }
  window.addEventListener('pointerdown', requestSidePanelOpen, { capture: true, once: true });
  window.addEventListener('keydown', requestSidePanelOpen, { capture: true, once: true });

  const BACKFILL_BUTTON_ID = 'jc-backfill-btn';
  const TOAST_ID = 'jc-toast';
  const DEBOUNCE_MS = 400;
  const DESC_MAX = 20000;
  const FALLBACK_DESC_WARN = 8000;

  let lastJobId = null;
  let lastTrackerFingerprint = '';
  // Guards the search-detected message so the 500ms URL poller
  // doesn't fire duplicate reports on every tick of the same page.
  let lastReportedSearchUrl = null;
  let extractTimer = null;
  const observedButtons = new WeakSet(); // save/apply buttons we already attached a MutationObserver to
  const firedThisSession = new Set();    // per-jobId keys like 'save:12345' to avoid re-firing

  const isJobDetailUrl = (url) => /\/jobs\/(view|search|collections|search-results)/.test(url);
  const isTrackerUrl = (url) => /\/(jobs-tracker|my-items)/.test(url);
  // A "search results" page has query params like keywords/f_TPR — the
  // path is the same as /jobs/search/ which also serves the empty search
  // form. Requiring at least one meaningful filter avoids showing the
  // save pill on the blank landing page.
  const isSearchResultsUrl = (url) => {
    if (!/\/jobs\/search\/?(\?|$)/.test(url) && !/\/jobs\/search-results\/?(\?|$)/.test(url)) return false;
    try {
      const u = new URL(url);
      const hasFilter = ['keywords','f_TPR','f_WT','f_E','f_JT','f_JIYN','f_AL','geoId'].some((k) => u.searchParams.get(k));
      return hasFilter;
    } catch { return false; }
  };

  // ---------- Detail extraction ----------

  function firstMatch(selectors, root = document) {
    for (const s of selectors) {
      let el;
      try { el = root.querySelector(s); } catch { continue; }
      if (el) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text) return { text, matchedBy: s, el };
      }
    }
    return null;
  }

  function extractJsonLdJobPosting() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item && item['@type'] === 'JobPosting') return item;
        }
      } catch {}
    }
    return null;
  }

  function parseDocumentTitle(docTitle) {
    if (!docTitle) return null;
    const t = docTitle.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
    const hiring = t.match(/^(.+?)\s+hiring\s+(.+?)(?:\s+in\s+(.+))?$/i);
    if (hiring) return { company: hiring[1].trim(), title: hiring[2].trim(), location: hiring[3]?.trim() || null };
    const pipe = t.split(/\s*\|\s*/);
    // 2 parts → the classic "Title | Company" LinkedIn header.
    // 3+ parts → the job title itself contained a pipe (e.g.
    // "Senior Engineer | Data Platform | BigCo"). The last segment is
    // still the company; everything before it joined by " | " is the
    // title. Falling through to the dash matcher used to silently drop
    // the extraction in this case.
    if (pipe.length >= 2 && pipe[0] && pipe[pipe.length - 1]) {
      const company = pipe[pipe.length - 1].trim();
      const title = pipe.slice(0, -1).map((s) => s.trim()).filter(Boolean).join(' | ');
      if (title && company) return { title, company, location: null };
    }
    const dash = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (dash) return { title: dash[1].trim(), company: dash[2].trim(), location: null };
    return null;
  }

  function metaContent(prop) {
    return document.querySelector(`meta[property="${prop}"]`)?.content
        || document.querySelector(`meta[name="${prop}"]`)?.content
        || null;
  }

  function htmlToText(html) {
    if (!html) return null;
    const div = document.createElement('div');
    div.innerHTML = html;
    return (div.innerText || div.textContent || '').trim();
  }

  function formatSalary(baseSalary) {
    if (!baseSalary) return null;
    const value = baseSalary.value || baseSalary;
    const unit = (value.unitText || 'YEAR').toLowerCase();
    const currency = baseSalary.currency || 'USD';
    if (value.minValue != null && value.maxValue != null) {
      return `${currency} ${Number(value.minValue).toLocaleString()}–${Number(value.maxValue).toLocaleString()} / ${unit}`;
    }
    if (value.value != null) return `${currency} ${Number(value.value).toLocaleString()} / ${unit}`;
    return null;
  }

  function formatJsonLdLocation(loc) {
    if (!loc) return null;
    const items = Array.isArray(loc) ? loc : [loc];
    const parts = items[0]?.address;
    if (!parts) return null;
    return [parts.addressLocality, parts.addressRegion, parts.addressCountry].filter(Boolean).join(', ');
  }

  function inferJobPane() {
    const h1 = document.querySelector('main h1, section h1, h1');
    if (!h1) return null;
    let node = h1.parentElement;
    let best = null;
    while (node && node.tagName !== 'BODY') {
      const len = (node.innerText || '').length;
      if (len > 800 && len < 15000) {
        if (!best || len > best.len) best = { node, len };
      }
      node = node.parentElement;
    }
    return best?.node || null;
  }

  function extractDetail() {
    const jobId = extractJobId(location.href);
    if (!jobId) return null;

    const jsonLd = extractJsonLdJobPosting();
    const docParts = parseDocumentTitle(document.title);

    const dTitle = firstMatch(SELECTORS.title);
    const dCompany = firstMatch(SELECTORS.company);
    const dLocation = firstMatch(SELECTORS.location);
    const dWorkplace = firstMatch(SELECTORS.workplaceType);
    const dPosted = firstMatch(SELECTORS.postedDate);
    const dApplicants = firstMatch(SELECTORS.applicantCount);
    const dSalary = firstMatch(SELECTORS.salary);
    const dDescription = firstMatch(SELECTORS.description);
    const dRecruiter = firstMatch(SELECTORS.recruiter);

    const source = {};
    const pick = (field, candidates) => {
      for (const [name, value] of candidates) {
        if (value) { source[field] = name; return value; }
      }
      source[field] = null;
      return null;
    };

    const title = pick('title', [
      ['dom', dTitle?.text],
      ['jsonld', jsonLd?.title],
      ['docTitle', docParts?.title],
      ['og', metaContent('og:title')],
    ]);
    const company = pick('company', [
      ['dom', dCompany?.text],
      ['jsonld', jsonLd?.hiringOrganization?.name],
      ['docTitle', docParts?.company],
    ]);
    const jobLocation = pick('location', [
      ['dom', dLocation?.text],
      ['jsonld', formatJsonLdLocation(jsonLd?.jobLocation)],
      ['docTitle', docParts?.location],
    ]);
    const workplaceType = pick('workplaceType', [['dom', dWorkplace?.text]]);
    const postedDate = pick('postedDate', [
      ['dom', dPosted?.text],
      ['jsonld', jsonLd?.datePosted],
    ]);
    const applicantCount = pick('applicantCount', [['dom', dApplicants?.text]]);
    const salary = pick('salary', [
      ['dom', dSalary?.text],
      ['jsonld', formatSalary(jsonLd?.baseSalary)],
    ]);
    const recruiter = pick('recruiter', [['dom', dRecruiter?.text]]);

    let descriptionText = null;
    let descriptionSource = null;
    if (dDescription?.text) {
      descriptionText = dDescription.text;
      descriptionSource = 'primary';
    } else if (jsonLd?.description) {
      descriptionText = htmlToText(jsonLd.description);
      descriptionSource = 'jsonld';
    } else {
      const inferred = inferJobPane();
      if (inferred) {
        descriptionText = (inferred.innerText || '').trim().slice(0, DESC_MAX);
        descriptionSource = 'h1-inferred';
      } else {
        const container = firstMatch(SELECTORS.container);
        if (container?.text) {
          descriptionText = container.text.slice(0, DESC_MAX);
          descriptionSource = 'container-fallback';
        }
      }
    }
    source.description = descriptionSource;

    const descLength = descriptionText?.length || 0;
    const fallbackNoise = (descriptionSource === 'container-fallback' && descLength > FALLBACK_DESC_WARN)
                       || (descriptionSource === 'h1-inferred' && descLength > 12000);

    const primaryHits = [title, company, descriptionText].filter(Boolean).length;
    let confidence;
    if (primaryHits === 3 && descriptionSource === 'primary') confidence = 'high';
    else if (primaryHits === 3 && !fallbackNoise) confidence = 'medium';
    else if (primaryHits >= 2) confidence = 'low';
    else confidence = 'none';

    const isReposted = detectReposted();
    const hiringTeam = scrapeHiringTeam();
    return {
      jobId,
      // Always canonical /jobs/view/{id}/ — never the search-results or
      // collections URL the user happened to be on when scraped. That URL
      // opens straight to the posting from any surface (archive, activity
      // log, mobile share) and is what the modal-walk tab matcher expects.
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
      capturedAt: new Date().toISOString(),
      posting: {
        title, company, location: jobLocation,
        workplaceType, postedDate, applicantCount,
        postedSalaryRange: salary,
        descriptionText, descriptionSource,
        recruiter,
        isReposted,
      },
      // Silent preview scrape — reads whatever LinkedIn shows above the fold
      // without opening any modals. Full named-contact extraction happens
      // separately when the user runs Analyze Fit (walkConnectionsModal).
      warmth: scrapeConnectionsPreview(),
      hiringTeam,
      confidence, sources: source, fallbackNoise,
    };
  }

  // Meet the hiring team — structured entries for every LinkedIn-listed
  // person representing the company on this posting. Distinct from
  // `warmth` (which is the user's own network overlap).
  //
  // LinkedIn structures the posting's people in two conceptually distinct
  // slots:
  //
  //   1. Job POSTER — the account that actually submitted the listing.
  //      Rendered near "Posted by <Name>" text or in a `.jobs-poster*`
  //      region. Usually a recruiter or coordinator, not the decision-maker.
  //
  //   2. HIRING TEAM — one or more people surfaced in "Meet the hiring
  //      team" section. LinkedIn tags each with a role pill (Recruiter /
  //      Hiring manager / Interviewer). Read that pill first — it's the
  //      answer LinkedIn is giving us. Fall back to headline heuristic
  //      only when no pill exists.
  //
  // Returns: [{ name, profileUrl, headline, role, source }]
  //   role   ∈ 'hiring-manager' | 'recruiter' | 'interviewer' | 'team' | 'job-poster'
  //   source ∈ 'hiring-team' | 'poster' — where in the DOM we found them
  function scrapeHiringTeam() {
    const out = [];
    const seen = new Map(); // profileUrl → index in out

    const addOrMerge = (person) => {
      if (!person.profileUrl) return;
      if (seen.has(person.profileUrl)) {
        // Merge — richer role wins (poster < team < interviewer < recruiter < hiring-manager).
        const existing = out[seen.get(person.profileUrl)];
        if (roleRank(person.role) > roleRank(existing.role)) {
          existing.role = person.role;
        }
        // Preserve source hints from both sightings.
        if (person.source && !existing.sources.includes(person.source)) {
          existing.sources.push(person.source);
        }
        if (person.headline && !existing.headline) existing.headline = person.headline;
      } else {
        seen.set(person.profileUrl, out.length);
        out.push({
          name: person.name,
          profileUrl: person.profileUrl,
          headline: person.headline || null,
          role: person.role,
          sources: [person.source || 'hiring-team'],
        });
      }
    };

    // ---- Slot 1: dedicated hiring-team roots ----
    const hiringTeamRoots = [];
    for (const sel of [
      '.job-details-people-who-can-help__section',
      '.jobs-details-top-card__hiring-team',
      '[class*="job-details-people"]',
    ]) {
      try { hiringTeamRoots.push(...document.querySelectorAll(sel)); } catch {}
    }
    for (const root of hiringTeamRoots) {
      for (const p of extractPeopleFromRoot(root, 'hiring-team')) addOrMerge(p);
    }

    // ---- Slot 2: poster-specific roots ----
    const posterRoots = [];
    for (const sel of [
      '.jobs-poster-card',
      '.hirer-card__hirer-information',
      '[class*="hirer-card"]',
      '[class*="jobs-poster"]',
    ]) {
      try { posterRoots.push(...document.querySelectorAll(sel)); } catch {}
    }
    for (const root of posterRoots) {
      for (const p of extractPeopleFromRoot(root, 'poster')) {
        // Anyone found in a poster region is the poster unless we've
        // already found them elsewhere with a stronger role.
        if (!seen.has(p.profileUrl) || out[seen.get(p.profileUrl)].role === 'team') {
          p.role = 'job-poster';
        }
        addOrMerge(p);
      }
    }

    return out;
  }

  // Pull structured person entries out of a hiring-team / poster root.
  // Uses LinkedIn's own role pills (aria-label / tag text) first — falls
  // back to headline keyword matching only when no pill is present.
  function extractPeopleFromRoot(root, sourceLabel) {
    const results = [];
    const links = root.querySelectorAll('a[href*="/in/"]');
    for (const link of links) {
      const name = (link.innerText || link.textContent || '').trim();
      if (!name || name.length < 2 || name.length > 80) continue;
      if (/^(show|see|view|more|connect|message|follow)/i.test(name)) continue;
      const profileUrl = normalizeProfileUrl(link.getAttribute('href'));
      if (!profileUrl) continue;

      const container = link.closest('li, article, [class*="card"], [class*="entity"], [class*="hirer"], [class*="poster"]') || link.parentElement;
      const cText = (container?.innerText || container?.textContent || '');

      // Headline: text following the name, before Message/Connect/Follow.
      let headline = null;
      const idx = cText.indexOf(name);
      if (idx >= 0) {
        const after = cText.slice(idx + name.length).trim();
        const lines = after.split(/\n+/).map((s) => s.trim()).filter(Boolean);
        const hl = [];
        for (const line of lines) {
          if (/^(Message|Connect|Follow|View profile|Send InMail)$/i.test(line)) break;
          if (/^(show all|see all|view all)/i.test(line)) break;
          if (line === name) continue;
          hl.push(line);
          if (hl.length >= 2) break;
        }
        headline = hl.join(' ').trim() || null;
      }

      // Role: prefer LinkedIn's own pill. LinkedIn tags hiring-team
      // members with a small badge — text like "Recruiter", "Hiring
      // manager", "Interviewer", "Talent partner". Search the container
      // for these before falling back to headline keywords.
      const role = detectPersonRole(container, headline);
      results.push({ name, profileUrl, headline, role, source: sourceLabel });
    }
    return results;
  }

  // LinkedIn role pill detection. Looks for badge/tag/aria-label patterns
  // that match one of LinkedIn's canonical roles. Falls back to headline
  // keyword heuristic only when no explicit pill is present.
  function detectPersonRole(container, headline) {
    if (!container) return 'team';
    // Search for small text badges near the person entry — usually a
    // <span> or <div> with class containing "pill", "badge", "tag",
    // "chip", or LinkedIn's role-specific classes.
    const badgeEls = container.querySelectorAll(
      '[class*="pill"], [class*="badge"], [class*="tag"], [class*="chip"], [class*="role"], [aria-label*="role" i]'
    );
    for (const b of badgeEls) {
      const t = (b.innerText || b.textContent || '').trim().toLowerCase();
      if (!t || t.length > 40) continue;
      const role = normalizeRoleText(t);
      if (role) return role;
    }
    // Full container text scan as fallback — LinkedIn sometimes prints
    // the role inline in the entry without a distinct badge element.
    const cText = (container.innerText || container.textContent || '').toLowerCase();
    if (/\bhiring manager\b/.test(cText)) return 'hiring-manager';
    if (/\binterviewer\b/.test(cText)) return 'interviewer';
    if (/\b(recruiter|talent (acquisition|partner)|sourc(er|ing))\b/.test(cText)) return 'recruiter';
    // Headline-based inference — treat director/VP/manager as likely
    // hiring manager when they're in the hiring-team section AND we
    // saw no explicit label. Weaker signal, worth marking as such.
    const hText = (headline || '').toLowerCase();
    if (/\b(manager|director|head of|vp|vice president|chief|founder|lead)\b/.test(hText)) {
      return 'hiring-manager';
    }
    return 'team';
  }

  function normalizeRoleText(t) {
    if (/^hiring manager$/i.test(t)) return 'hiring-manager';
    if (/^interviewer$/i.test(t)) return 'interviewer';
    if (/^(recruiter|talent partner|sourcer)$/i.test(t)) return 'recruiter';
    if (/^(team member|team)$/i.test(t)) return 'team';
    return null;
  }

  function roleRank(role) {
    return {
      'hiring-manager': 5,
      'recruiter': 4,
      'interviewer': 3,
      'team': 2,
      'job-poster': 1,
    }[role] ?? 0;
  }

  // ---------- Reposted detection ----------
  // LinkedIn stamps recycled listings with "Reposted N ago". Recycled
  // roles are often long-open positions with weak signal for the
  // candidate. Text-scan the visible top-of-page — the label appears
  // near the posted-date meta line.
  function detectReposted() {
    const scope = document.querySelector(
      'main, [role="main"], .jobs-unified-top-card, .job-details-jobs-unified-top-card__container--two-pane, body'
    );
    if (!scope) return false;
    // Confine to the first ~1500 chars to avoid matching the word
    // "reposted" that might appear inside the full job description.
    const text = (scope.innerText || scope.textContent || '').slice(0, 1500);
    return /\breposted\b/i.test(text);
  }

  // ---------- Connections at company ----------
  // LinkedIn shows a "People you can reach out to" section on job-view pages
  // when the user has any network overlap with the company. The section
  // includes a "Show all" link that opens a modal with three sub-sections:
  //   1. Connections who work at [Company]              (1st degree)
  //   2. Company alumni who work at [Company]           (usually 2nd)
  //   3. School alumni who work at [Company]            (2nd/3rd)
  //
  // We do two-tier extraction:
  //   - Silent preview (this function) runs on every job-view scrape
  //   - Full modal walk runs on demand (see walkConnectionsModal below)

  // Returns the "People you can reach out to" heading element (h2/h3/etc),
  // NOT a wrapper container. All connections-related queries are then
  // scoped to the heading + its subsequent sibling range via the helpers
  // below. Previous "find heading, walk up to a container with profile
  // links" approach kept over-scoping because LinkedIn puts sibling sections
  // (AI features, skills insights) inside shared parents that also contain
  // profile links (recruiter, team members, etc.) — those unrelated links
  // made every walk-up match too wide.
  function findConnectionsSection() {
    const HEADING_RE = /^people you can reach out to$/i;
    for (const h of document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) {
      if (HEADING_RE.test((h.textContent || '').trim())) return h;
    }
    return null;
  }

  // Given the heading, return the sibling elements that come AFTER it under
  // the same parent, stopping at the next heading (indicates the start of
  // a different section). This is the natural DOM boundary for "everything
  // that belongs to this section, and nothing else."
  function getConnectionsSiblings(heading) {
    const parent = heading?.parentElement;
    if (!parent) return [];
    const kids = Array.from(parent.children);
    const idx = kids.indexOf(heading);
    if (idx < 0) return [];
    const NEXT_HEADING = /^H[1-6]$/;
    const siblings = [];
    for (let i = idx + 1; i < kids.length; i++) {
      const sib = kids[i];
      if (NEXT_HEADING.test(sib.tagName)) break;
      if (sib.getAttribute && sib.getAttribute('role') === 'heading') break;
      siblings.push(sib);
    }
    return siblings;
  }

  function findShowAllForHeading(heading) {
    for (const sib of getConnectionsSiblings(heading)) {
      const inner = Array.from(sib.querySelectorAll('a, button'));
      if (['A', 'BUTTON'].includes(sib.tagName)) inner.push(sib);
      const btn = inner.find((el) => /^(show all|see all|view all)$/i.test((el.textContent || '').trim()));
      if (btn) return btn;
    }
    return null;
  }

  function findProfileLinksForHeading(heading) {
    const links = [];
    for (const sib of getConnectionsSiblings(heading)) {
      if (sib.tagName === 'A' && sib.getAttribute('href')?.includes('/in/')) links.push(sib);
      for (const link of sib.querySelectorAll('a[href*="/in/"]')) links.push(link);
    }
    return links;
  }

  // Normalize a LinkedIn profile URL to its canonical /in/<handle>/ form.
  // Handles both relative and absolute hrefs; strips tracking params and
  // trailing subpaths (overlay/, recent-activity/, etc.). Returns null if
  // the URL doesn't look like a profile link.
  function normalizeProfileUrl(href) {
    if (!href) return null;
    let u;
    try { u = new URL(href, 'https://www.linkedin.com'); }
    catch { return null; }
    const m = u.pathname.match(/^\/in\/([^/]+)/);
    if (!m) return null;
    return `https://www.linkedin.com/in/${m[1]}/`;
  }

  // Concatenated innerText of the heading and its section siblings only.
  // Never includes unrelated sibling sections above or below.
  function getConnectionsSectionText(heading) {
    const parts = [(heading?.innerText || '').trim()];
    for (const sib of getConnectionsSiblings(heading)) {
      parts.push((sib.innerText || '').trim());
    }
    return parts.filter(Boolean).join('\n');
  }

  // Nudge LinkedIn to hydrate the connections section, which usually lives
  // below the fold. Without this, Analyze Fit clicked before the user
  // scrolls returns an empty section. Scrolls in stages, watching for the
  // section to gain profile links; restores the user's original scroll
  // position when done so the UI doesn't jump.
  async function ensureConnectionsSectionLoaded() {
    // "Loaded" means: heading exists AND its sibling range has at least one
    // profile link. Scroll in stages until both conditions hold.
    const hydrated = (h) => h && findProfileLinksForHeading(h).length > 0;
    if (hydrated(findConnectionsSection())) return;
    const originalY = window.scrollY;
    const steps = [0.25, 0.5, 0.75, 1.0];
    for (const frac of steps) {
      window.scrollTo({ top: document.documentElement.scrollHeight * frac, behavior: 'auto' });
      await new Promise((r) => setTimeout(r, 500));
      if (hydrated(findConnectionsSection())) break;
    }
    window.scrollTo({ top: originalY, behavior: 'auto' });
    await new Promise((r) => setTimeout(r, 200));
  }

  function scrapeConnectionsPreview() {
    const heading = findConnectionsSection();
    if (!heading) return { tier: 'cold', preview: null, updatedAt: new Date().toISOString(), detail: null };
    const text = getConnectionsSectionText(heading).replace(/\s+/g, ' ').trim();
    // Strip the heading text so the "preview" is just the connection line.
    const preview = text
      .replace(/people you can reach out to/i, '')
      .replace(/show all.*$/i, '')
      .trim() || null;
    // Preview alone doesn't tell us degree — we assume any presence means at
    // least weak; the modal walker will upgrade to `warm` if it finds any 1st.
    return { tier: 'weak', preview, updatedAt: new Date().toISOString(), detail: null };
  }

  async function walkConnectionsModal(timeoutMs = 8000) {
    // Force lazy-load: the "People you can reach out to" section usually
    // sits below the fold, and if the user hits Analyze Fit before scrolling
    // there, the section DOM doesn't exist yet.
    await ensureConnectionsSectionLoaded();
    const heading = findConnectionsSection();
    if (!heading) {
      return {
        tier: 'cold', preview: null, updatedAt: new Date().toISOString(),
        detail: { firstDegree: [], alumniShared: [], schoolAlumni: [], _diagnostic: 'section not found after lazy-load scroll' },
      };
    }
    // Preview text scoped to this section only (no sibling AI-features etc.)
    const sectionText = getConnectionsSectionText(heading).replace(/\s+/g, ' ').trim();

    // First: parse whatever's already visible in the section. LinkedIn often
    // lists 1–3 connections inline (with names + degree pills) and only
    // shows a "Show all" modal when there are more. Without this pass, jobs
    // with 1–2 connections come back as tier=weak, 1st=0.
    const detail = { firstDegree: [], alumniShared: [], schoolAlumni: [] };
    parseInlineConnections(heading, detail);
    // Stashed for the diagnostic — tells us whether the inline pass ever
    // saw first-degree names or if the section preview is empty of them.
    detail._preInlineFirst = detail.firstDegree.length;

    // Then: if a "Show all" button exists, open the modal and merge in the
    // richer results. Missing button just means we already have everything.
    // Scoped to heading siblings only — no more picking up unrelated
    // "Show all requirements" or "Show all skills" buttons.
    const showAll = findShowAllForHeading(heading);

    let showAllStatus = showAll ? 'found' : 'absent';
    let btnInfo = '';
    if (showAll) {
      btnInfo = `<${showAll.tagName.toLowerCase()}${showAll.href ? ` href="${showAll.href.slice(0, 40)}"` : ''}${showAll.disabled ? ' disabled' : ''}>`;
      forcefulClick(showAll);
      const modal = await waitForModal(timeoutMs);
      if (modal) {
        showAllStatus = 'opened';
        const modalDetail = extractFromConnectionsModal(modal);
        mergeConnectionDetails(detail, modalDetail);
        const closeBtn = modal.querySelector('button[aria-label*="Dismiss" i], button[aria-label*="Close" i], .artdeco-modal__dismiss');
        if (closeBtn) forcefulClick(closeBtn);
        else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else {
        showAllStatus = 'modal-timeout';
      }
    }
    // Stash for outer diagnostic — tells us what button we clicked.
    if (btnInfo) detail._btnInfo = btnInfo;

    // Section exists → never downgrade to `cold` regardless of extraction outcome.
    const tier = detail.firstDegree.length ? 'warm' : 'weak';
    // Attach diagnostic whenever 1st-degree extraction returned zero. Merges
    // the outer context (what the section preview looked like, whether the
    // modal opened, whether inline parse found anything before the walk)
    // with the inner _diagnostic extractFromConnectionsModal produced. This
    // single note tells us which of the three strategies fell short and why.
    if (!detail.firstDegree.length) {
      const btn = detail._btnInfo ? ` btn=${detail._btnInfo}` : '';
      const outerContext = `showAll=${showAllStatus} inline1st=${(detail._preInlineFirst ?? 0)}${btn} sectionPreview="${sectionText.slice(0, 120)}"`;
      detail._diagnostic = detail._diagnostic
        ? `${outerContext} · ${detail._diagnostic}`
        : outerContext;
    }
    delete detail._preInlineFirst;
    delete detail._btnInfo;
    return { tier, preview: sectionText || null, updatedAt: new Date().toISOString(), detail };
  }

  // Parse connection entries that LinkedIn renders directly in the section
  // (not inside the modal). Two paths run in sequence:
  //   1. Profile-link based — the common case when LinkedIn renders the
  //      person's name as `<a href="/in/username/">Name</a>`.
  //   2. Text-based fallback — some previews show the person as plain text
  //      (name, degree, headline) with NO profile link, OR the section has
  //      /in/ links that don't correspond to the actual connections (avatar
  //      thumbnails, recruiter links, mutual-connection stubs). Whenever
  //      the link path yields zero real entries, fall back to text parsing.
  function parseInlineConnections(heading, detail) {
    const countBefore = detail.firstDegree.length + detail.alumniShared.length + detail.schoolAlumni.length;
    const profileLinks = findProfileLinksForHeading(heading);
    for (const link of profileLinks) {
      const name = (link.innerText || link.textContent || '').trim();
      if (!name || name.length < 2 || name.length > 80) continue;
      // Skip generic UI text that could sneak in as link content.
      if (/^(show all|see all|view all|and others|connect|message|follow|see more)$/i.test(name)) continue;

      // Look at the entry container for degree + headline.
      const container = link.closest('li, [class*="person"], [class*="entity"], [class*="member"]') || link.parentElement;
      const containerText = (container?.innerText || container?.textContent || '');

      const degMatch = containerText.match(/[•·]\s*(1st|2nd|3rd\+?)/i);
      let degree;
      if (degMatch) {
        const d = degMatch[1].toLowerCase();
        degree = d.startsWith('1') ? 1 : d.startsWith('2') ? 2 : 3;
      } else {
        // The "People you can reach out to" section on LinkedIn only lists
        // 1st-degree connections inline (2nd/3rd only show in the modal),
        // so assume 1st when no explicit degree marker is present.
        degree = 1;
      }

      // Headline: text after the name in the container. LinkedIn renders
      // this variously as "Name\n• 1st\nHeadline" (line-separated) or as
      // "Name • 1st Headline" (all one line). Strip any leading degree
      // marker first, then take up to 2 headline lines. Skip section-footer
      // strings that are not part of the entry itself.
      let headline = null;
      const idx = containerText.indexOf(name);
      if (idx >= 0) {
        // Strip a leading "• 1st" / "•1st" / "1st" prefix (with or without bullet).
        const after = containerText.slice(idx + name.length)
          .replace(/^[\s•·]*(1st|2nd|3rd\+?)\s*/i, '')
          .trim();
        const lines = after.split(/\n+/).map((s) => s.trim()).filter(Boolean);
        const headlineLines = [];
        for (const line of lines) {
          if (/^(Message|Connect|Follow)$/i.test(line)) break;
          // Section footers that aren't part of the person's entry:
          if (/^(people in your network|show all|see all|view all)/i.test(line)) break;
          // A subsequent entry's degree indicator — don't grab their headline.
          if (/^[•·]\s*(1st|2nd|3rd)/i.test(line)) continue;
          if (line === name) continue;
          headlineLines.push(line);
          if (headlineLines.length >= 2) break;
        }
        headline = headlineLines.join(' ').trim() || null;
      }

      const bucket = degree === 1 ? detail.firstDegree : detail.alumniShared;
      if (!bucket.some((e) => e.name === name)) {
        const entry = { name, degree, headline };
        const profileUrl = normalizeProfileUrl(link.getAttribute('href'));
        if (profileUrl) entry.profileUrl = profileUrl;
        if (degree === 1 && /message/i.test(containerText)) entry.messagable = true;
        bucket.push(entry);
      }
    }
    // If the link path yielded no entries, the profile links we found were
    // unrelated stubs (avatars, mutual-connections, recruiter links) and the
    // actual named connection lives in the section text. Fall back.
    const countAfter = detail.firstDegree.length + detail.alumniShared.length + detail.schoolAlumni.length;
    if (countAfter === countBefore) {
      parseInlineTextFallback(heading, detail);
    }
  }

  // Text-based fallback for the inline preview case: LinkedIn sometimes shows
  // a named connection with degree marker + headline but WITHOUT a profile
  // link (e.g. when there's only one visible connection and no "Show all").
  // Uses the same text-parse logic as the modal path, then routes by degree.
  function parseInlineTextFallback(heading, detail) {
    const rawText = getConnectionsSectionText(heading);
    if (!rawText) return;
    // Strip the section heading so the first entry's beforeText starts with a name.
    const contentText = rawText.replace(/^people you can reach out to\s*/i, '').trim();
    if (!contentText) return;
    const tempBucket = [];
    parseEntriesFromText(contentText, tempBucket);
    for (const entry of tempBucket) {
      const target = entry.degree === 1 ? detail.firstDegree : detail.alumniShared;
      if (!target.some((e) => e.name === entry.name)) target.push(entry);
    }
  }

  function mergeConnectionDetails(base, incoming) {
    for (const bucket of ['firstDegree', 'alumniShared', 'schoolAlumni']) {
      for (const entry of incoming[bucket] || []) {
        if (!entry?.name) continue;
        if (!base[bucket].some((e) => e.name === entry.name)) base[bucket].push(entry);
      }
    }
    // Preserve diagnostic breadcrumbs — extractFromConnectionsModal populates
    // this field when firstDegree extraction returns zero; without this
    // propagation the diagnostic gets dropped and we lose visibility.
    if (incoming._diagnostic && !base._diagnostic) base._diagnostic = incoming._diagnostic;
  }

  // Try to open the target element in the most React-friendly way possible.
  // Some LinkedIn buttons don't respond to plain el.click() because their
  // handlers are attached via synthetic-event delegation on pointer events.
  // Fires the full pointer→mouse→click sequence.
  function forcefulClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('click', opts)); } catch {}
    // Belt-and-suspenders — DOM click() sometimes triggers different
    // handlers than the synthetic sequence above.
    try { el.click?.(); } catch {}
  }

  function detectModalCandidate() {
    const candidates = document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], div.artdeco-modal, .artdeco-modal-overlay, [class*="Modal"]'
    );
    for (const c of candidates) {
      // Skip hidden/detached candidates.
      if (c.offsetParent === null && c.getClientRects().length === 0) continue;
      const hasProfileLinks = c.querySelector('a[href*="/in/"]');
      const text = (c.innerText || '').trim();
      const hasDegreeText = /[•·]\s*(1st|2nd|3rd)/i.test(text);
      const hasEnoughText = text.length > 80;
      if (hasProfileLinks || hasDegreeText || hasEnoughText) return c;
    }
    return null;
  }

  // MutationObserver-based wait: catches the modal the instant its DOM node
  // is added, no polling latency. Timer handles the timeout case.
  function waitForModal(timeoutMs) {
    return new Promise((resolve) => {
      const existing = detectModalCandidate();
      if (existing) return resolve(existing);
      let done = false;
      const observer = new MutationObserver(() => {
        if (done) return;
        const m = detectModalCandidate();
        if (m) {
          done = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(m);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  function extractFromConnectionsModal(modal) {
    const detail = { firstDegree: [], alumniShared: [], schoolAlumni: [] };
    const text = (modal.innerText || modal.textContent || '').replace(/\r/g, '').trim();
    if (!text) return detail;

    // Strategy A: DOM-order walk — track "current bucket" as we encounter
    // heading text in document order; every profile link goes into whatever
    // bucket is active. Most resilient to LinkedIn using <div> instead of <h>
    // for headings, and handles the case where 1st-degree entries come
    // BEFORE any heading (they land in firstDegree by default).
    strategyDomOrderWalk(modal, detail);

    // Strategy B: Text-based heading slicing (previous approach). Add any
    // entries this strategy finds that aren't already in the detail buckets.
    const detailB = { firstDegree: [], alumniShared: [], schoolAlumni: [] };
    strategyTextHeadingSlice(text, detailB);
    mergeConnectionDetails(detail, detailB);

    // Strategy C: fallback — every profile link in the modal becomes a
    // 1st-degree entry if it isn't already captured. Prevents total misses
    // when both A and B fail due to unexpected DOM structure.
    if (!detail.firstDegree.length && !detail.alumniShared.length && !detail.schoolAlumni.length) {
      const detailC = { firstDegree: [], alumniShared: [], schoolAlumni: [] };
      strategyAllProfileLinks(modal, detailC);
      mergeConnectionDetails(detail, detailC);
    }

    // Cross-bucket dedup: firstDegree wins.
    const inFirst = new Set(detail.firstDegree.map((e) => e.name));
    detail.alumniShared = detail.alumniShared.filter((e) => !inFirst.has(e.name));
    detail.schoolAlumni = detail.schoolAlumni.filter((e) => !inFirst.has(e.name));

    // Rich diagnostic — fires whenever 1st-degree is zero. Captures enough
    // to distinguish "no 1st-degree exists" from "1st-degree exists but my
    // parser can't extract" and pinpoint which stage is failing.
    if (!detail.firstDegree.length) {
      const linksInModal = modal.querySelectorAll('a[href*="/in/"]').length;
      const firstMarkers = (text.match(/[•·]\s*1st/gi) || []).length;
      const secondMarkers = (text.match(/[•·]\s*2nd/gi) || []).length;
      const thirdMarkers = (text.match(/[•·]\s*3rd/gi) || []).length;
      const headingsFound = [
        /connections who work at/i.test(text) ? 'CW' : '',
        /company alumni/i.test(text) ? 'CA' : '',
        /school alumni/i.test(text) ? 'SA' : '',
      ].filter(Boolean).join(',') || 'none';
      const htmlHead = (modal.innerHTML || '').replace(/\s+/g, ' ').slice(0, 250);
      detail._diagnostic = `links=${linksInModal} deg1=${firstMarkers} deg2=${secondMarkers} deg3=${thirdMarkers} headings=[${headingsFound}] textHead="${text.slice(0, 200)}" htmlHead="${htmlHead}"`;
    }
    return detail;
  }

  // Strategy A: walk the modal in document order, tracking the current
  // bucket via heading transitions. Uses direct-text-content check for
  // heading detection so nested elements' aggregate text doesn't false-match.
  function strategyDomOrderWalk(modal, detail) {
    let currentBucket = 'firstDegree'; // default until a heading switches it
    const walker = document.createTreeWalker(modal, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      // Read this element's direct text (its own text nodes, not descendants).
      let directText = '';
      for (const child of node.childNodes) {
        if (child.nodeType === 3) directText += child.textContent;
      }
      directText = directText.trim();
      if (directText) {
        if (/^connections who work at/i.test(directText)) { currentBucket = 'firstDegree'; continue; }
        if (/^company alumni who work at/i.test(directText)) { currentBucket = 'alumniShared'; continue; }
        if (/^school alumni who work at/i.test(directText)) { currentBucket = 'schoolAlumni'; continue; }
      }
      // Profile link → an entry in the current bucket.
      if (node.tagName === 'A' && node.getAttribute('href')?.includes('/in/')) {
        const name = (node.innerText || node.textContent || '').trim();
        if (!name || name.length < 2 || name.length > 80) continue;
        if (/^(show all|see all|view all|and others|connect|message|follow|see more)$/i.test(name)) continue;

        const container = node.closest('li, [role="listitem"], [class*="person"], [class*="entity"], [class*="member"]') || node.parentElement;
        const cText = (container?.innerText || container?.textContent || '');

        // Degree from container text. If the pill isn't parseable, infer
        // from bucket context — the "Connections who work at" section is
        // 1st-degree by definition; alumni buckets typically mix 2nd/3rd
        // but LinkedIn doesn't always print pills so we leave those null
        // rather than guess wrong.
        const degMatch = cText.match(/[•·]\s*(1st|2nd|3rd\+?)/i);
        let degree = null;
        if (degMatch) {
          const d = degMatch[1].toLowerCase();
          degree = d.startsWith('1') ? 1 : d.startsWith('2') ? 2 : 3;
        } else if (currentBucket === 'firstDegree') {
          degree = 1;
        }
        // Headline: strip leading degree marker, take up to 2 lines before
        // Message/Connect/Follow or a next-entry degree marker.
        const idx = cText.indexOf(name);
        let headline = null;
        if (idx >= 0) {
          const after = cText.slice(idx + name.length)
            .replace(/^[\s•·]*(1st|2nd|3rd\+?)\s*/i, '')
            .trim();
          const lines = after.split(/\n+/).map((s) => s.trim()).filter(Boolean);
          const hl = [];
          for (const line of lines) {
            if (/^(Message|Connect|Follow)$/i.test(line)) break;
            if (/^(people in your network|show all|see all|view all)/i.test(line)) break;
            if (/^[•·]\s*(1st|2nd|3rd)/i.test(line)) continue;
            if (line === name) continue;
            hl.push(line);
            if (hl.length >= 2) break;
          }
          headline = hl.join(' ').trim() || null;
        }

        const bucket = detail[currentBucket];
        if (!bucket.some((e) => e.name === name)) {
          const entry = { name, degree, headline };
          const profileUrl = normalizeProfileUrl(node.getAttribute('href'));
          if (profileUrl) entry.profileUrl = profileUrl;
          if (currentBucket === 'firstDegree' && /message/i.test(cText)) entry.messagable = true;
          bucket.push(entry);
        }
      }
    }
  }

  // Strategy B: text-based heading slicing (previous logic). Kept as a
  // secondary strategy because it's more forgiving of DOM structures where
  // heading text is nested deep or split across elements.
  function strategyTextHeadingSlice(text, detail) {
    const HEADINGS = [
      { re: /Connections who work at[^\n]*/i, bucket: 'firstDegree' },
      { re: /Company alumni who work at[^\n]*/i, bucket: 'alumniShared' },
      { re: /School alumni who work at[^\n]*/i, bucket: 'schoolAlumni' },
    ];
    const sections = [];
    for (const h of HEADINGS) {
      const m = text.match(h.re);
      if (m) sections.push({ bucket: h.bucket, headingStart: m.index, contentStart: m.index + m[0].length });
    }
    sections.sort((a, b) => a.headingStart - b.headingStart);
    if (sections.length === 0) {
      parseEntriesFromText(text, detail.firstDegree);
    } else {
      const preText = text.slice(0, sections[0].headingStart);
      if (preText.trim()) parseEntriesFromText(preText, detail.firstDegree);
      for (let i = 0; i < sections.length; i++) {
        const start = sections[i].contentStart;
        const end = i + 1 < sections.length ? sections[i + 1].headingStart : text.length;
        parseEntriesFromText(text.slice(start, end), detail[sections[i].bucket]);
      }
    }
  }

  // Strategy C: last-resort — treat every profile link as a 1st-degree entry.
  // Ugly, but a partial answer beats an empty one.
  function strategyAllProfileLinks(modal, detail) {
    const links = modal.querySelectorAll('a[href*="/in/"]');
    for (const link of links) {
      const name = (link.innerText || link.textContent || '').trim();
      if (!name || name.length < 2 || name.length > 80) continue;
      if (/^(show all|see all|view all|and others|connect|message|follow|see more)$/i.test(name)) continue;
      if (!detail.firstDegree.some((e) => e.name === name)) {
        detail.firstDegree.push({ name, degree: 1, headline: null });
      }
    }
  }

  // Parse individual entries from a section of modal text. Each entry looks like:
  //   Name\n\n• 1st\n\nHeadline text…\n\nMessage
  // Some sections are preceded by context lines: "Used to work at X" or "Attended Y".
  function parseEntriesFromText(sectionText, bucket) {
    if (!sectionText) return;
    const DEGREE_RE = /[•·]\s*(1st|2nd|3rd\+?)/gi;
    const matches = [...sectionText.matchAll(DEGREE_RE)];
    if (!matches.length) return;

    let currentContext = null;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const degreeStr = m[1].toLowerCase();
      const degree = degreeStr.startsWith('1') ? 1 : degreeStr.startsWith('2') ? 2 : 3;

      const prevEnd = i > 0 ? matches[i - 1].index + matches[i - 1][0].length : 0;
      const beforeText = sectionText.slice(prevEnd, m.index).trim();
      const nextStart = i + 1 < matches.length ? matches[i + 1].index : sectionText.length;
      const afterText = sectionText.slice(m.index + m[0].length, nextStart).trim();

      // Any "Used to work at X" / "Attended Y" line applies as sharedContext
      // for subsequent entries until overwritten.
      const contextMatch = beforeText.match(/(Used to work at|Attended)\s+([^\n]+)/i);
      if (contextMatch) currentContext = contextMatch[2].trim();

      // Name is the last non-empty, non-context line before the degree marker.
      const beforeLines = beforeText.split(/\n+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((l) => !/^(Used to work at|Attended)/i.test(l));
      const name = beforeLines.pop() || null;
      if (!name) continue;

      // Headline: everything up to the first Message/Connect/Follow button.
      const afterLines = afterText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const messagable = afterLines.some((l) => /^Message$/i.test(l));
      const headlineLines = [];
      for (const line of afterLines) {
        if (/^(Message|Connect|Follow)$/i.test(line)) break;
        headlineLines.push(line);
      }
      const headline = headlineLines.join(' ').trim() || null;

      if (bucket.some((e) => e.name === name)) continue;
      const entry = { name, headline, degree };
      if (currentContext) entry.sharedContext = currentContext;
      if (messagable) entry.messagable = true;
      bucket.push(entry);
    }
  }

  // ---------- Tracker list extraction ----------
  // Robust across LinkedIn redesigns by walking hrefs, not class names.

  // Strip our own injected elements from a card clone before we extract text.
  // Otherwise "↗ Careers site", "↗ Open in Jawbs", "Sync N jobs …", etc.
  // land in card.innerText and can win the shortest-title heuristic.
  const INJECTED_SELECTOR = [
    '.jc-careers-btn', '.jc-fill-btn', '.jc-decorate-badge',
    '#jc-launch-btn', '#jc-backfill-btn', '#jc-toast',
  ].join(', ');
  function stripInjections(card) {
    const clone = card.cloneNode(true);
    clone.querySelectorAll(INJECTED_SELECTOR).forEach((el) => el.remove());
    return clone;
  }

  // Remove every pill/button this content script has added anywhere on the
  // page. Used at the start of a full LinkedIn sync so the walker sees the
  // vanilla LinkedIn UI, not our decorated version.
  function removeAllInjections() {
    document.querySelectorAll(INJECTED_SELECTOR).forEach((el) => el.remove());
  }

  function scrapeTrackerList() {
    // Collect jobId anchors from multiple LinkedIn surface conventions.
    // Historically the tracker rendered plain `<a href="/jobs/view/NNN">`
    // wrappers, but later layouts use `data-job-id` on the card element
    // itself or embed the ID in an `entity-urn` string. Merging these
    // catches every layout LinkedIn has shipped so a UI refresh doesn't
    // silently break the scraper.
    const byId = new Map();
    const anchors = new Map(); // jobId -> anchor element to use for card lookup

    const noteAnchor = (jobId, el) => {
      if (!jobId || !/^\d+$/.test(jobId)) return;
      if (!anchors.has(jobId)) anchors.set(jobId, el);
    };

    // 1. Raw job view links (the classic path).
    for (const link of document.querySelectorAll('a[href*="/jobs/view/"]')) {
      const m = link.href.match(/\/jobs\/view\/(\d+)/);
      if (m) noteAnchor(m[1], link);
    }
    // 2. Elements with data-job-id (new tracker layout).
    for (const el of document.querySelectorAll('[data-job-id]')) {
      noteAnchor(el.getAttribute('data-job-id'), el);
    }
    // 3. Entity-URN attributes (e.g. "urn:li:fsd_jobPosting:1234567890").
    for (const el of document.querySelectorAll('[data-entity-urn*="jobPosting"], [data-urn*="jobPosting"]')) {
      const raw = el.getAttribute('data-entity-urn') || el.getAttribute('data-urn') || '';
      const m = raw.match(/jobPosting[:\-](\d+)/i);
      if (m) noteAnchor(m[1], el);
    }
    // 4. Fallback: links to /jobs/collections/*?currentJobId=NNN (used
    // by LinkedIn's tracker for internal navigation between cards).
    for (const link of document.querySelectorAll('a[href*="currentJobId"]')) {
      const m = link.href.match(/currentJobId=(\d+)/);
      if (m) noteAnchor(m[1], link);
    }

    for (const [jobId, link] of anchors) {

      const rawCard = link.closest('li, article, [role="listitem"], [componentkey]') || link.parentElement;
      if (!rawCard) continue;
      const card = stripInjections(rawCard);

      // Title extraction, most-specific → most-generic. cleanFirstLine strips
      // trailing `· location · reposted` chatter. We try several DOM sources
      // in priority order and pick the shortest reasonable result — the
      // shortest wins because a wrapper anchor's aggregated innerText will
      // always be longer than the actual title element's text.
      const titleCandidates = [];
      const push = (t) => {
        const cleaned = cleanFirstLine(t);
        if (cleaned && cleaned.length >= 4 && cleaned.length <= 140) titleCandidates.push(cleaned);
      };
      const heading = card.querySelector('h3, h2, h1, strong, [class*="title"], [class*="Title"]');
      if (heading) push(heading.innerText || heading.textContent);
      const ariaTitle = link.getAttribute('aria-label');
      if (ariaTitle) push(ariaTitle.replace(/,?\s+(save this job|apply now|easy apply|view job).*$/i, ''));
      for (const child of link.children) {
        push(child.innerText || child.textContent);
      }
      push(link.innerText || link.textContent);
      // Last resort: first card line
      const cardLines = (card.innerText || '').split(/\n+/).map(cleanFirstLine).filter(Boolean);
      if (cardLines[0]) push(cardLines[0]);
      // Prefer candidates that look like clean titles: no `· ago`, no
      // "Applied"/"Reposted" markers. Then pick the shortest.
      const clean = titleCandidates.filter((t) =>
        !/\b(ago|applied|saved|easy apply|reposted|promoted)\b/i.test(t)
        && !/^↗\s/.test(t)             // any of our injected arrow-prefixed pill labels
        && !/^(Sync|Import|Open in Jawbs|Careers site|Fill my LinkedIn)/i.test(t)
      );
      const pool = clean.length ? clean : titleCandidates;
      let title = pool.sort((a, b) => a.length - b.length)[0] || null;

      // Company extraction, priority order:
      //   1. Explicit /company/ link inside the card (most reliable).
      //   2. A card line that neither IS the title nor STARTS with the title.
      //   3. If a line starts with the title (LinkedIn's tracker jams title +
      //      company + location on one physical line), take what comes AFTER
      //      the title as the company.
      const companyLink = card.querySelector('a[href*="/company/"]');
      let company = cleanFirstLine(companyLink?.innerText || companyLink?.textContent);

      if (!company) {
        const cardLines = (card.innerText || '').split(/\n+/).map(cleanFirstLine).filter(Boolean);
        const isJunk = (l) => !l
          || /^\d/.test(l)
          || /\bago\b/i.test(l)
          || /^(applied|saved|easy apply|reposted|promoted)/i.test(l);

        // Try a distinct line that isn't the title and doesn't start with it.
        company = cardLines.find((l) =>
          l && l !== title && !(title && l.startsWith(title))
          && l.length < 80 && !isJunk(l)
        ) || null;

        // Fall back to the suffix of a title-prefixed line ("Title Company")
        if (!company && title) {
          const titleLine = cardLines.find((l) => l && l.startsWith(title) && l.length > title.length);
          if (titleLine) {
            const suffix = titleLine.slice(title.length).replace(/^[\s·,-]+/, '').trim();
            if (suffix && suffix.length < 80 && !isJunk(suffix)) company = suffix;
          }
        }
      }

      // Prefer the entry with a title *and* a company; otherwise keep the
      // first non-empty pick. Never let an earlier empty-title link block
      // a later link that resolved cleanly.
      const existing = byId.get(jobId);
      const scoreOf = (t, c) => (t ? 2 : 0) + (c ? 1 : 0);
      if (!existing || scoreOf(title, company) > scoreOf(existing.titleGuess, existing.companyGuess)) {
        byId.set(jobId, {
          jobId,
          url: `https://www.linkedin.com/jobs/view/${jobId}/`,
          titleGuess: title,
          companyGuess: company,
          cardText: (card.innerText || '').trim().slice(0, 600),
        });
      }
    }

    return Array.from(byId.values());
  }

  function detectTrackerStage() {
    try {
      const u = new URL(location.href);
      const stage = u.searchParams.get('stage');
      if (stage) return stage;
      // LinkedIn's /jobs-tracker/ root URL (no query param) shows the
      // Saved list by default. Treat it the same as ?stage=saved so syncs
      // from the root land jobs in the correct status.
      if (/^\/jobs-tracker\/?$/.test(u.pathname)) return 'saved';
      return 'unknown';
    } catch { return 'unknown'; }
  }

  // Per-card "Careers →" button that opens a Google search for
  // `[company] [title] careers`. Injected on jobs-tracker and my-items pages
  // so the user can jump directly to the company's own careers site to check for
  // duplicate/live postings.
  function cleanFirstLine(text) {
    // Take only the first line and strip common LinkedIn suffixes like
    // " · Verified", " · Follow", "·1st", etc.
    return (text || '')
      .split('\n')[0]
      .split(' · ')[0]
      .replace(/\s+/g, ' ')
      .trim();
  }

  function injectCareersButtons() {
    const links = document.querySelectorAll('a[href*="/jobs/view/"]');
    let processed = 0, injected = 0, skippedNoCard = 0, skippedNoText = 0, skippedDupe = 0;
    for (const link of links) {
      const m = link.href.match(/\/jobs\/view\/(\d+)/);
      if (!m) continue;
      processed++;
      const jobId = m[1];

      // Dedupe: skip only if an existing button is actually visible (>0×0).
      // If a stale one exists but is hidden (a prior version buried it in an
      // invisible container), drop it and re-inject fresh.
      const existing = document.querySelector(`.jc-careers-btn[data-jobid="${jobId}"]`);
      if (existing) {
        const r = existing.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { skippedDupe++; continue; }
        existing.remove();
      }

      const card = link.closest('li, article, [role="listitem"], [componentkey]') || link.parentElement;
      if (!card) { skippedNoCard++; continue; }

      let title = cleanFirstLine(link.innerText || link.textContent);
      if (!title) {
        const heading = card.querySelector('h3, h2, h1, [class*="title"], [class*="Title"]');
        title = cleanFirstLine(heading?.innerText || heading?.textContent);
      }
      if (!title) {
        const cardFirstLine = (card.innerText || '').split(/\n+/).map(cleanFirstLine).find(Boolean);
        title = cardFirstLine || '';
      }

      const companyLink = card.querySelector('a[href*="/company/"]');
      let company = cleanFirstLine(companyLink?.innerText || companyLink?.textContent);
      if (!company) {
        const lines = (card.innerText || '')
          .split(/\n+/)
          .map((s) => cleanFirstLine(s))
          .filter(Boolean);
        company = lines.find((l) => l && l !== title && l.length < 80 && !/^\d/.test(l)) || '';
      }
      if (!title && !company) { skippedNoText++; continue; }

      // Query contains only: [company] [title] Careers — nothing else.
      const q = encodeURIComponent(`${company} ${title} Careers`.replace(/\s+/g, ' ').trim());
      const btn = document.createElement('a');
      btn.className = 'jc-careers-btn';
      btn.dataset.jobid = jobId;
      btn.href = `https://www.google.com/search?q=${q}`;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
      btn.textContent = '↗ Careers site';
      btn.title = `Google: ${company} ${title} Careers`;
      // Absolute-position in the card's top-right corner so it's always
      // visible regardless of what nested containers LinkedIn wraps around
      // its own content. Force the card to be a positioned ancestor.
      if (getComputedStyle(card).position === 'static') {
        card.style.position = 'relative';
      }
      btn.style.cssText = [
        'position: absolute',
        'top: 8px',
        'right: 8px',
        'display: inline-flex',
        'align-items: center',
        'padding: 5px 10px',
        'background: #F59320',
        'color: #FFFFFF',
        'font: 600 11px/1 system-ui, -apple-system, sans-serif',
        'border: 1px solid #F59320',
        'border-radius: 4px',
        'text-decoration: none',
        'cursor: pointer',
        'pointer-events: auto',
        'z-index: 500',
        'box-shadow: 0 2px 6px rgba(0,0,0,0.15)',
        'white-space: nowrap',
      ].join(';');
      btn.onclick = (ev) => { ev.stopPropagation(); };

      card.appendChild(btn);
      injected++;
    }
    if (processed > 0) {
      console.info(
        '[Jawbs] injectCareersButtons:',
        `${processed} links processed, ${injected} buttons injected,`,
        `${skippedDupe} dupes, ${skippedNoCard} no-card, ${skippedNoText} no-text`
      );
    }
  }

  // ---------- Button injection ----------
  // (Legacy backfill/sync pill and its makePill/ensurePulseKeyframes
  // helpers deleted — the Jawboard's "Thresh" button is the sole entry
  // point for tracker syncs now. Stale-DOM cleanup for old pills lives
  // in the URL dispatcher below.)

  // ---------- Save / Apply auto-capture ----------
  //
  // Spec: "Watch for the button state change rather than intercepting the click,
  // so nothing breaks if their handler changes." We locate the Save and Apply
  // buttons in LinkedIn's top card, attach a MutationObserver watching aria-*
  // attributes, and fire once when the state transitions to saved/applied.
  // Toast confirms non-blockingly.

  function findSaveButton() {
    // Common patterns on the redesigned top card. Filter to visible buttons in
    // the main content area (avoid the same button on similar-jobs cards).
    const candidates = document.querySelectorAll('button[aria-label]');
    for (const b of candidates) {
      if (!b.offsetParent) continue; // not visible
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      if (!/\b(save|saved|unsave)\b/.test(label)) continue;
      // Reject buttons that look like they're inside a list card (aria-label
      // usually then references a job title). Prefer generic Save-like labels.
      if (/^(save|saved|unsave)(\s+this\s+job)?$/i.test(label)) return b;
      // Otherwise accept if it's inside the top card region (h1 sibling area)
      const h1 = document.querySelector('main h1, h1');
      if (h1 && b.closest('*')?.contains(h1) === false) {
        // Button is not in the h1's ancestry tree; check inverse
        const container = h1.closest('[componentkey], [id]') || h1.parentElement?.parentElement;
        if (container && container.contains(b)) return b;
      }
    }
    return null;
  }

  function findApplyButton() {
    const candidates = document.querySelectorAll('button, a[role="button"]');
    for (const b of candidates) {
      if (!b.offsetParent) continue;
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      const text = (b.innerText || '').trim().toLowerCase();
      if (/^(easy apply|apply)(\s|$)/.test(label) || /^(easy apply|apply)$/.test(text)) {
        return b;
      }
    }
    return null;
  }

  function isSaved(btn) {
    if (!btn) return false;
    if (btn.getAttribute('aria-pressed') === 'true') return true;
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (/^unsave/.test(label) || /\bsaved\b/.test(label)) return true;
    const text = (btn.innerText || '').trim().toLowerCase();
    if (text === 'saved') return true;
    return false;
  }

  function isApplied() {
    // "Applied" indicator in the top-card area. LinkedIn's phrasings observed:
    //   "Applied · 5 minutes ago" / "Applied · 2w ago"
    //   "Applied on Jan 5"
    //   "Applied to this job"
    //   "You applied to this job"
    //   Standalone "Applied" pill/label
    //   "Application submitted"
    const h1 = document.querySelector('main h1, h1');
    if (!h1) return false;
    const topContainer = h1.closest('[componentkey], section, div');
    if (!topContainer) return false;
    const scoped = (topContainer.innerText || '').toLowerCase();
    if (scoped.length > 5000) return false;
    if (/\bapplied\b\s*(·|\||—|-|\.|,)/.test(scoped)) return true;
    if (/\bapplied\s+(on|to|\d+|ago|now|just|about|earlier|today|yesterday|last)/i.test(scoped)) return true;
    if (/you\s+applied\b/i.test(scoped)) return true;
    if (/application\s+(submitted|sent|received)/i.test(scoped)) return true;
    // Standalone "Applied" as its own line — LinkedIn sometimes uses a pill
    // that renders as just the word on its own visual row.
    const lines = scoped.split(/\n+/).map((l) => l.trim());
    if (lines.some((l) => l === 'applied' || l === '✓ applied')) return true;
    return false;
  }

  function showToast(text) {
    const existing = document.getElementById(TOAST_ID);
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.id = TOAST_ID;
    t.textContent = text;
    t.style.cssText = [
      'position: fixed', 'top: 60px', 'right: 20px', 'z-index: 2147483647',
      'padding: 10px 16px', 'background: #F59320', 'color: #ffffff',
      'font: 500 13px/1.4 system-ui, -apple-system, sans-serif',
      'border-radius: 6px', 'box-shadow: 0 4px 14px rgba(0,0,0,0.25)',
      'opacity: 0', 'transition: opacity 250ms ease-out',
      'pointer-events: none',
    ].join(';');
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 400);
    }, 2500);
  }

  function fireSave({ silent }) {
    const data = extractDetail();
    if (!data) return;
    const key = `save:${data.jobId}`;
    if (firedThisSession.has(key)) return;
    firedThisSession.add(key);
    chrome.runtime.sendMessage({ type: 'save-clicked', data }).catch(() => {});
    if (!silent) showToast('✓ Saved to Jawbs Jawboard');
  }

  function fireApply({ silent }) {
    const data = extractDetail();
    if (!data) return;
    const key = `apply:${data.jobId}`;
    if (firedThisSession.has(key)) {
      console.info('[Jawbs] Apply fire skipped (already fired this session for', data.jobId, ')');
      return;
    }
    firedThisSession.add(key);
    firedThisSession.add(`save:${data.jobId}`);
    console.info('[Jawbs] Apply fire for', data.jobId, silent ? '(silent)' : '(with toast)');
    chrome.runtime.sendMessage({ type: 'apply-clicked', data }).catch((e) => console.warn('[Jawbs] apply-clicked send failed:', e));
    if (!silent) showToast('✓ Applied — logged to Jawbs Jawboard');
  }

  // Fire when the user unsaves a job on LinkedIn while viewing its
  // detail page. We don't downgrade status — an unsave is not the
  // same as "abandon this pursuit" (user may have applied elsewhere,
  // still interviewing, etc.). Instead we log it in the timeline and
  // surface it through the Reconcile flow so the user can decide.
  function fireUnsave() {
    const data = extractDetail();
    if (!data?.jobId) return;
    const key = `unsave:${data.jobId}`;
    if (firedThisSession.has(key)) return;
    firedThisSession.add(key);
    // Allow re-firing a save later if the user toggles it back on.
    firedThisSession.delete(`save:${data.jobId}`);
    chrome.runtime.sendMessage({
      type: 'linkedin-status-changed',
      jobId: data.jobId, action: 'unsave',
    }).catch(() => {});
    showToast('· Unsaved on LinkedIn — logged for reconcile');
  }

  function attachSaveWatcher() {
    const btn = findSaveButton();
    if (!btn || observedButtons.has(btn)) return;
    observedButtons.add(btn);
    let lastState = isSaved(btn);
    if (lastState) fireSave({ silent: true }); // already saved on page load → capture retroactively, no toast
    const obs = new MutationObserver(() => {
      const nowState = isSaved(btn);
      if (nowState && !lastState) fireSave({ silent: false }); // user clicked Save during session
      else if (!nowState && lastState) fireUnsave();           // user clicked Unsave during session
      lastState = nowState;
    });
    obs.observe(btn, { attributes: true, attributeFilter: ['aria-label', 'aria-pressed', 'class'] });
  }

  function checkAppliedState() {
    // Every time this runs (page load, DOM mutations, URL changes), check the
    // top-card text for an "Applied" indicator. This is the main path — the
    // Easy Apply modal completes and LinkedIn updates the top card, then our
    // page-level MutationObserver retriggers this.
    if (isApplied()) {
      console.info('[Jawbs] isApplied() returned true — attempting to fire apply capture');
      fireApply({ silent: false });
    }

    // Also observe the Apply button directly, for the case where the button
    // changes state in-place before the top-card re-renders.
    const btn = findApplyButton();
    if (!btn || observedButtons.has(btn)) return;
    observedButtons.add(btn);
    let lastState = isApplyButtonInAppliedState(btn);
    if (lastState) fireApply({ silent: true });
    const obs = new MutationObserver(() => {
      const nowState = isApplyButtonInAppliedState(btn) || isApplied();
      if (nowState && !lastState) {
        console.info('[Jawbs] Apply button state transitioned to applied');
        fireApply({ silent: false });
      }
      lastState = nowState;
    });
    obs.observe(btn, {
      attributes: true, subtree: true, characterData: true, childList: true,
      attributeFilter: ['aria-label', 'disabled', 'class'],
    });
  }

  // ---------- LinkedIn Premium "high match" auto-trigger ----------
  //
  // When Premium shows phrasing like "Job match is high" in the top card, the
  // signal is strong enough that Jawbs runs fit analysis
  // automatically. Detection is text-based (LinkedIn's classnames are hashed)
  // but strictly scoped to the h1-inferred pane so it doesn't pick up match
  // language from other jobs on the page. Only "high" — never medium/low.

  const HIGH_MATCH_PATTERNS = [
    /job match is high/i,
    /\bhigh match\b/i,
    /\btop match\b/i,
    /you.{0,3}d be a top applicant/i,
    /excellent match/i,
    /strong match/i,
  ];

  function detectPremiumHighMatch() {
    const scope = inferJobPane();
    if (!scope) return false;
    const text = scope.innerText || '';
    if (text.length > 15000) return false; // scope too broad, probably includes sidebar
    return HIGH_MATCH_PATTERNS.some((re) => re.test(text));
  }

  function fireAutoAnalyze() {
    const data = extractDetail();
    if (!data) return;
    const key = `automatch:${data.jobId}`;
    if (firedThisSession.has(key)) return;
    firedThisSession.add(key);
    chrome.runtime
      .sendMessage({ type: 'auto-analyze-fit', data })
      .then((response) => {
        if (response?.analyzed) showToast('✓ Auto-analyzed · LinkedIn high match');
        else if (response?.skipped === 'already-analyzed') { /* silent */ }
        else if (response?.skipped === 'disabled') { /* silent */ }
        else if (response?.error) showToast(`Auto-analysis failed: ${response.error}`);
      })
      .catch(() => {});
    // Show interim toast so the user knows something is happening — the API
    // call can take a few seconds, and silence would be confusing.
    showToast('Analyzing · LinkedIn flagged this as a high match');
  }

  function isApplyButtonInAppliedState(btn) {
    if (!btn) return false;
    if (btn.disabled) return true;
    const label = (btn.getAttribute('aria-label') || '').toLowerCase();
    const text = (btn.innerText || '').trim().toLowerCase();
    return /applied/.test(label) || /^applied$/.test(text);
  }

  // Fin-swim nudge lives in content/fin.js — it runs on every
  // linkedin.com page so counting isn't limited to /jobs/*. Clean up
  // any leftover pill DOM from earlier extension versions.
  const stalePill = document.getElementById('jt-jawbar-pill');
  if (stalePill) stalePill.remove();

  // ---------- LinkedIn profile-page follow-state detection ----------
  //
  // When the user visits linkedin.com/in/<handle>, sniff the profile's
  // Follow button state and report it to the SW. The SW maintains a
  // profileUrl → { following, mode } map that the Recall / Jawboard
  // people lists cross-reference at render time.
  //
  // LinkedIn shows two follow modes: "Most relevant" (default) and
  // "All" (opt-in for high signal-to-noise contacts). We try to detect
  // which one by inspecting the follow dropdown when it's rendered on
  // the page.

  async function detectAndReportFollowState() {
    if (!/\/in\/[^/]+/.test(location.pathname)) return;
    const profileUrl = normalizeProfileUrl(location.href);
    if (!profileUrl) return;

    // Follow-vs-Following state — the follow button lives in the top-card
    // action bar. We look for exact aria-label / text matches.
    let following = null; // null = couldn't determine; leave stale value alone
    let mode = null;

    const followBtn = document.querySelector(
      'button[aria-label^="Follow"], button[aria-label^="Following"], button[aria-label*="Unfollow"]'
    );
    if (followBtn) {
      const label = (followBtn.getAttribute('aria-label') || '').trim();
      const text = (followBtn.innerText || followBtn.textContent || '').trim();
      if (/^unfollow\b/i.test(label) || /^following\b/i.test(label) || /^following\b/i.test(text)) {
        following = true;
      } else if (/^follow\b/i.test(label) || /^follow\b/i.test(text)) {
        following = false;
      }
    }

    // Mode detection: LinkedIn shows the current mode in the follow
    // settings popover — usually "Most relevant" or "All". If the user
    // has opened the popover we can read it; otherwise scan for common
    // label-carrying elements. This is best-effort.
    if (following === true) {
      const modeText = Array.from(
        document.querySelectorAll(
          '[role="menuitem"][aria-checked="true"], [aria-pressed="true"], .artdeco-dropdown__item--is-selected'
        )
      )
        .map((el) => (el.innerText || el.textContent || '').trim())
        .find((t) => /^(most relevant|all)$/i.test(t));
      if (modeText) mode = /^most relevant$/i.test(modeText) ? 'most-relevant' : 'all';
    }

    if (following == null) return;
    try {
      await chrome.runtime.sendMessage({
        type: 'update-follow-state',
        profileUrl,
        following,
        mode,
      });
    } catch { /* SW asleep — will retry on next mutation */ }
  }

  if (/linkedin\.com$/.test(location.hostname) || /linkedin\.com$/.test(location.hostname.replace(/^www\./, ''))) {
    // Initial detection + a couple of re-checks to catch the follow button
    // once LinkedIn's React tree finishes rendering.
    setTimeout(() => detectAndReportFollowState().catch(() => {}), 1500);
    setTimeout(() => detectAndReportFollowState().catch(() => {}), 4000);
    // Re-check whenever the URL changes (SPA navigation between profiles).
    let lastProfileUrl = location.href;
    setInterval(() => {
      if (location.href !== lastProfileUrl) {
        lastProfileUrl = location.href;
        setTimeout(() => detectAndReportFollowState().catch(() => {}), 1200);
      }
    }, 800);
  }

  // ---------- Negative-keyword filter (dim matching job cards) ----------

  // Cache the keyword list per page load — refreshed on every scrape tick
  // if the storage changed. Keeps the SW roundtrip off the hot path.
  let cachedNegativeKeywords = null;
  let cachedNegativeKeywordsAt = 0;
  const NEG_KEYWORD_CACHE_MS = 30_000;

  async function getCachedNegativeKeywords() {
    if (cachedNegativeKeywords && Date.now() - cachedNegativeKeywordsAt < NEG_KEYWORD_CACHE_MS) {
      return cachedNegativeKeywords;
    }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'get-negative-keywords' });
      cachedNegativeKeywords = Array.isArray(r?.data) ? r.data : [];
    } catch {
      cachedNegativeKeywords = [];
    }
    cachedNegativeKeywordsAt = Date.now();
    return cachedNegativeKeywords;
  }

  // Storage listener — bust the cache immediately when the user saves a
  // new keyword list, so the filter reacts without waiting for the TTL.
  chrome.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === 'local' && changes['settings.negativeKeywords']) {
      cachedNegativeKeywords = null;
    }
  });

  const FILTER_MARK = 'data-jt-filtered';

  // LinkedIn's card container has changed shape several times; try the
  // stable data attribute first, then fall back to observed class patterns.
  function findJobCards() {
    const seen = new Set();
    const selectors = [
      '[data-job-id]',
      'div[data-view-name="job-search-job-card"]',
      'div.job-card-list__entity-lockup',
      'li.jobs-search-results__list-item',
      'div.scaffold-layout__list-item',
    ];
    for (const s of selectors) {
      let list;
      try { list = document.querySelectorAll(s); } catch { continue; }
      for (const el of list) {
        // Prefer the outermost list-item wrapper — that's what should get
        // dimmed. If we already saw an ancestor for this element, skip.
        const li = el.closest('li') || el;
        if (!seen.has(li)) seen.add(li);
      }
    }
    return [...seen];
  }

  async function applyNegativeKeywordFilter() {
    const keywords = await getCachedNegativeKeywords();
    // Empty list → unfilter everything from a prior run.
    if (!keywords.length) {
      for (const el of document.querySelectorAll(`[${FILTER_MARK}]`)) {
        clearFilterMark(el);
      }
      return;
    }
    const lowered = keywords.map((k) => k.toLowerCase());
    const cards = findJobCards();
    for (const card of cards) {
      const text = (card.innerText || card.textContent || '').toLowerCase();
      if (!text) continue;
      const hit = lowered.find((k) => text.includes(k));
      const already = card.getAttribute(FILTER_MARK);
      if (hit && !already) markFiltered(card, hit);
      else if (!hit && already) clearFilterMark(card);
    }
  }

  function markFiltered(card, keyword) {
    card.setAttribute(FILTER_MARK, keyword);
    // Direct styles rather than injected CSS — cheaper and immune to
    // LinkedIn's own overrides.
    card.style.opacity = '0.35';
    card.style.filter = 'grayscale(0.7)';
    card.style.transition = 'opacity 150ms ease';
    card.title = `Hidden by Jawbs · matched "${keyword}"`;
  }
  function clearFilterMark(card) {
    card.removeAttribute(FILTER_MARK);
    card.style.opacity = '';
    card.style.filter = '';
    card.style.transition = '';
    card.title = '';
  }

  // ---------- Snapshot helper (unchanged shape) ----------

  function captureDomSnapshot() {
    const metas = {};
    document.querySelectorAll('meta[property], meta[name]').forEach((m) => {
      const k = m.getAttribute('property') || m.getAttribute('name');
      if (k && (k.startsWith('og:') || k.startsWith('twitter:') || k === 'description')) metas[k] = m.content;
    });
    const jsonLdShapes = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const data = JSON.parse(s.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          jsonLdShapes.push({ type: item?.['@type'] || '(none)', keys: item && typeof item === 'object' ? Object.keys(item) : [] });
        }
      } catch { jsonLdShapes.push({ error: 'parse failed' }); }
    });
    const componentKeys = [...new Set(
      [...document.querySelectorAll('[componentkey]')].map((e) => e.getAttribute('componentkey')).filter(Boolean)
    )].slice(0, 60);
    const withAncestry = (el) => ({
      text: (el.innerText || el.textContent || '').slice(0, 120).trim(),
      tag: el.tagName,
      classes: (el.className || '').slice(0, 100),
      componentKey: el.closest('[componentkey]')?.getAttribute('componentkey') || null,
      nearestId: el.closest('[id]')?.id || null,
    });
    return {
      url: location.href,
      docTitle: document.title,
      metas, jsonLdShapes, componentKeys,
      h1s: [...document.querySelectorAll('h1')].slice(0, 5).map(withAncestry),
      companyLinks: [...document.querySelectorAll('a[href*="/company/"]')].slice(0, 5).map(withAncestry),
      viewLinks: [...document.querySelectorAll('a[href*="/jobs/view/"]')].slice(0, 5).map((a) => ({
        href: a.href.slice(0, 200), text: (a.innerText || '').slice(0, 100),
      })),
    };
  }

  // ---------- Dispatcher ----------

  // ---------- Listing decorations ----------
  //
  // For every LinkedIn job card that we already have data on in the
  // Jawboard, inject a compact pill in the card's bottom-left corner
  // showing: status · fit · comp range · strength. Purely informational;
  // helps the user scan a results page without opening each card. Runs
  // on every scrape tick so late-loading and virtualized rows get
  // decorated. Deduped by data-jobid on the badge element so mutation
  // observers don't spam duplicates.
  const STATUS_COLORS = {
    saved:                  { bg: '#F59320', fg: '#1B0703' },
    inProgressDraft:        { bg: '#8B6D2F', fg: '#FFFFFF' },
    inProgressClickedApply: { bg: '#8B6D2F', fg: '#FFFFFF' },
    applied:                { bg: '#0A66C2', fg: '#FFFFFF' },
    interviewing:           { bg: '#6D28D9', fg: '#FFFFFF' },
    archived:               { bg: '#6B7280', fg: '#FFFFFF' },
    notMovingForward:       { bg: '#7F1D1D', fg: '#FFFFFF' },
    analyzed:               { bg: '#374151', fg: '#FFFFFF' },
  };
  const STRENGTH_TIER_COLORS = {
    'great-white': '#F59320',
    'tiger':       '#FCA311',
    'bull':        '#EAB308',
    'mako':        '#A3A3A3',
    'nurse':       '#6B7280',
    'pygmy':       '#4B5563',
  };
  const fitTierColor = (score) => {
    if (score == null) return '#6B7280';
    if (score >= 70) return '#059669';
    if (score >= 40) return '#D97706';
    return '#B91C1C';
  };
  const fmtMoneyShort = (n) => {
    if (n == null || Number.isNaN(n)) return null;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `$${Math.round(n / 1000)}K`;
    return `$${Math.round(n)}`;
  };
  const compRangeText = (low, high) => {
    if (low == null && high == null) return null;
    const l = fmtMoneyShort(low);
    const h = fmtMoneyShort(high);
    if (l && h) return `${l}–${h}`;
    return l || h;
  };
  // Weak / fair / strong band palette — same tokens the Jawbar meta
  // strip uses, so the mini gauges in LinkedIn cards read identically
  // to the ones in the sidepanel.
  const BAND_PALETTE = {
    weak:   { stroke: '#D85A30', track: '#FAECE7', text: '#993C1D' },
    fair:   { stroke: '#BA7517', track: '#FAEEDA', text: '#854F0B' },
    strong: { stroke: '#1D9E75', track: '#E1F5EE', text: '#085041' },
  };
  const scoreBand = (score) => {
    const n = Number.isFinite(score) ? score : 0;
    if (n >= 70) return 'strong';
    if (n >= 40) return 'fair';
    return 'weak';
  };
  // Circumference for r=7: 2·π·7 ≈ 43.98. Kept as a constant so the
  // dasharray math stays consistent across gauge sizes.
  const MINI_GAUGE_CIRC = 43.98;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function miniGauge(score, tooltip) {
    if (score == null) return null;
    const n = Math.max(0, Math.min(100, Number(score) || 0));
    const dash = (n / 100) * MINI_GAUGE_CIRC;
    const band = scoreBand(n);
    const palette = BAND_PALETTE[band];
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    svg.setAttribute('viewBox', '0 0 22 22');
    svg.setAttribute('role', 'img');
    if (tooltip) {
      svg.setAttribute('aria-label', tooltip);
      const t = document.createElementNS(SVG_NS, 'title');
      t.textContent = tooltip;
      svg.appendChild(t);
    }
    svg.style.cssText = 'flex-shrink: 0; display: block';
    const track = document.createElementNS(SVG_NS, 'circle');
    track.setAttribute('cx', '11'); track.setAttribute('cy', '11'); track.setAttribute('r', '7');
    track.setAttribute('fill', 'none');
    track.setAttribute('stroke', palette.track);
    track.setAttribute('stroke-width', '3');
    svg.appendChild(track);
    const fill = document.createElementNS(SVG_NS, 'circle');
    fill.setAttribute('cx', '11'); fill.setAttribute('cy', '11'); fill.setAttribute('r', '7');
    fill.setAttribute('fill', 'none');
    fill.setAttribute('stroke', palette.stroke);
    fill.setAttribute('stroke-width', '3');
    fill.setAttribute('stroke-linecap', 'round');
    fill.setAttribute('transform', 'rotate(-90 11 11)');
    fill.setAttribute('stroke-dasharray', `${dash.toFixed(2)} ${MINI_GAUGE_CIRC}`);
    svg.appendChild(fill);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '11'); text.setAttribute('y', '14');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', palette.text);
    text.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
    text.setAttribute('font-size', '9');
    text.setAttribute('font-weight', '600');
    text.textContent = String(Math.round(n));
    svg.appendChild(text);
    return svg;
  }

  function buildDecorationBadge(jobId, data) {
    const wrap = document.createElement('div');
    wrap.className = 'jc-decorate-badge';
    wrap.dataset.jobid = jobId;
    wrap.style.cssText = [
      'position: absolute',
      // Positioned into the empty space to the right of the company
      // logo — clear of the title, company · location line, and the
      // "Posted Xh ago" line stacked under it.
      'bottom: -14px',
      'left: 826px',
      'display: inline-flex',
      'gap: 5px',
      'align-items: center',
      'padding: 3px 6px',
      'background: rgba(255,255,255,0.96)',
      'border: 1px solid rgba(0,0,0,0.15)',
      'border-radius: 6px',
      'z-index: 500',
      'font: 600 10px/1 system-ui, -apple-system, sans-serif',
      'box-shadow: 0 1px 4px rgba(0,0,0,0.12)',
      'pointer-events: auto',
    ].join(';');
    // Clicks on the badge itself shouldn't propagate to the card (which
    // would open LinkedIn's job drawer).
    wrap.onclick = (ev) => ev.stopPropagation();

    const chip = (text, bg, fg, title) => {
      const el = document.createElement('span');
      el.textContent = text;
      el.style.cssText = [
        'padding: 3px 6px',
        `background: ${bg}`,
        `color: ${fg}`,
        'border-radius: 3px',
        'letter-spacing: 0.02em',
        'white-space: nowrap',
      ].join(';');
      if (title) el.title = title;
      return el;
    };

    // Left cluster — big strength number followed by the raw shark
    // portrait. The tier-tinted halo used to sit behind the shark;
    // it was hiding most shark art (red bg on red shark, green on
    // green) so it's gone. The big score now carries the tier signal
    // via its text color; the shark reads as itself. Both are hidden
    // when the record has no strength yet, since the number is the
    // whole point.
    const STRENGTH_TIER_FG = {
      'pygmy':       '#991B1B',
      'nurse':       '#B45309',
      'mako':        '#B45309',
      'bull':        '#166534',
      'tiger':       '#166534',
      'great-white': '#065F46',
    };
    if (data.strengthScore != null) {
      const strengthNum = document.createElement('span');
      strengthNum.textContent = String(Math.round(data.strengthScore));
      strengthNum.style.cssText = [
        'font: 800 18px/1 system-ui, -apple-system, sans-serif',
        `color: ${STRENGTH_TIER_FG[data.strengthTier] || '#0F172A'}`,
        'font-variant-numeric: tabular-nums',
        'padding: 0 2px 0 0',
      ].join(';');
      strengthNum.title = `Strength: ${data.strengthScore}/100 (${data.strengthTierLabel || data.strengthTier || 'tier'})`;
      wrap.appendChild(strengthNum);

      const sharkPath = data.strengthTierImage || 'assets/icon-48.png';
      const logo = document.createElement('img');
      logo.src = chrome.runtime.getURL(sharkPath);
      logo.alt = data.strengthTierLabel ? `${data.strengthTierLabel} shark` : '';
      logo.style.cssText = [
        'width: 22px',
        'height: 22px',
        'display: block',
        'object-fit: contain',
        'flex-shrink: 0',
      ].join(';');
      if (data.strengthTierLabel) logo.title = `${data.strengthTierLabel} shark`;
      wrap.appendChild(logo);
    }

    // Fit / Connections / Comp mini gauges — same weak/fair/strong
    // band palette + arc geometry as the Jawbar's meta strip. The
    // strength composite has been promoted to the big number on the
    // left, so it drops out of the gauge trio; connections takes its
    // slot to expose the third strength component visually.
    const fitG = miniGauge(data.fitScore, data.fitScore != null ? `Fit: ${data.fitScore}/100` : null);
    if (fitG) wrap.appendChild(fitG);
    const connG = miniGauge(
      data.connectionsScore,
      data.connectionsScore != null ? `Connections: ${data.connectionsScore}/100` : null,
    );
    if (connG) wrap.appendChild(connG);
    const compG = miniGauge(data.compScore, data.compScore != null ? `Comp vs target: ${data.compScore}/100` : null);
    if (compG) wrap.appendChild(compG);

    // Status pill. Skip when the record is only 'analyzed' — that state
    // means we glanced at it but no LinkedIn action; nothing worth
    // shouting about. `data.status` is the raw internal code; the
    // service worker also sends `statusLabel` for display.
    if (data.status && data.status !== 'analyzed') {
      const c = STATUS_COLORS[data.status] || STATUS_COLORS.analyzed;
      wrap.appendChild(chip(
        (data.statusLabel || data.status).toUpperCase(),
        c.bg, c.fg,
        `Status: ${data.statusLabel || data.status}`,
      ));
    }

    // If only the logo was appended (no data chips at all), drop the
    // badge — a lone icon with nothing else doesn't help the user.
    return wrap.children.length > 1 ? wrap : null;
  }
  // Best-effort card-container lookup. LinkedIn uses different
  // wrappers on tracker (`li`), my-items (`article`), search results
  // (`div[data-occludable-job-id]` and other div-based containers),
  // and collections. The generic `.closest()` list catches all of
  // those; the div selectors handle current search-results markup;
  // last-resort we walk up until we find any block-level ancestor
  // that isn't the anchor itself.
  function findCardContainer(el) {
    return el.closest(
      'li, article, [role="listitem"], [componentkey],'
      + ' div[data-occludable-job-id],'
      + ' div[data-job-id],'
      + ' div.job-card-container,'
      + ' div[class*="job-card"],'
      + ' div[class*="jobs-search-results__list-item"]'
    ) || el.closest('div');
  }
  async function injectListingDecorations() {
    // Collect EVERY (container, jobId) pair on the page. LinkedIn's
    // tracker renders each job in two DOM containers (an expanded card
    // view and a table-row view), and both are often visible at once —
    // decorating every container yielded two badges per row. Below we
    // collect all candidates, then pick ONE visible container per jobId
    // (first with non-zero layout box wins).
    const pairs = []; // [container, jobId] pairs, deduped by container
    const seenContainers = new WeakSet();
    const noteCard = (jobId, card) => {
      if (!jobId || !/^\d+$/.test(jobId)) return;
      if (!card) return;
      if (seenContainers.has(card)) return;
      seenContainers.add(card);
      pairs.push([card, jobId]);
    };
    for (const anchor of document.querySelectorAll('a[href*="/jobs/view/"]')) {
      const m = anchor.href.match(/\/jobs\/view\/(\d+)/);
      if (!m) continue;
      noteCard(m[1], findCardContainer(anchor));
    }
    for (const el of document.querySelectorAll('[data-job-id]')) {
      const id = el.getAttribute('data-job-id');
      noteCard(id, findCardContainer(el) || el);
    }
    for (const el of document.querySelectorAll('[data-occludable-job-id]')) {
      const id = el.getAttribute('data-occludable-job-id');
      noteCard(id, findCardContainer(el) || el);
    }
    for (const el of document.querySelectorAll('[data-entity-urn*="jobPosting"], [data-urn*="jobPosting"]')) {
      const raw = el.getAttribute('data-entity-urn') || el.getAttribute('data-urn') || '';
      const m = raw.match(/jobPosting[:\-](\d+)/i);
      if (!m) continue;
      noteCard(m[1], findCardContainer(el) || el);
    }
    if (!pairs.length) return;

    // Pick a single container per jobId. Prefer the first candidate
    // whose bounding box is non-zero (i.e. actually laid out); fall
    // back to the first candidate otherwise so virtualized-but-known
    // rows still get a badge queued for when they scroll into view.
    const chosen = new Map(); // jobId → container
    const isLaidOut = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    for (const [card, jobId] of pairs) {
      if (chosen.has(jobId)) {
        const cur = chosen.get(jobId);
        if (!isLaidOut(cur) && isLaidOut(card)) chosen.set(jobId, card);
        continue;
      }
      chosen.set(jobId, card);
    }
    const jobIds = new Set(chosen.keys());

    // Filter to containers that don't already have a badge for that
    // jobId. Also strip any stray sibling badges for the same jobId
    // that live on the OTHER container (the one we didn't pick) so we
    // never end up with two badges per row.
    const needs = [];
    for (const [jobId, card] of chosen) {
      // Remove badges anywhere else in the document that carry this
      // jobId — leftover from an earlier tick that decorated both
      // containers before this dedup pass existed.
      for (const stray of document.querySelectorAll(`.jc-decorate-badge[data-jobid="${jobId}"]`)) {
        if (!card.contains(stray)) stray.remove();
      }
      const existing = card.querySelector(`.jc-decorate-badge[data-jobid="${jobId}"]`);
      if (!existing) { needs.push([card, jobId]); continue; }
      // Guard against LinkedIn virtualization moving DOM out from under
      // an existing badge — re-inject fresh if it's detached.
      if (existing.parentElement === card || card.contains(existing)) continue;
      existing.remove();
      needs.push([card, jobId]);
    }
    if (!needs.length) return;

    let payload;
    try {
      payload = await chrome.runtime.sendMessage({
        type: 'get-listing-decorations',
        jobIds: Array.from(jobIds),
      });
    } catch (e) {
      console.warn('[Jawbs decorate] SW call failed:', e.message);
      return;
    }
    const decorations = payload?.decorations || {};
    let injected = 0;
    for (const [card, jobId] of needs) {
      const data = decorations[jobId];
      if (!data) continue;
      const badge = buildDecorationBadge(jobId, data);
      if (!badge) continue;
      if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
      card.appendChild(badge);
      injected++;
    }
    console.info('[Jawbs decorate]', {
      containersSeen: pairs.length,
      chosenContainers: chosen.size,
      uniqueJobIds: jobIds.size,
      knownInArchive: Object.keys(decorations).length,
      injected,
    });
  }

  function runNow() {
    const url = location.href;
    // During a full LinkedIn sync we still want the scrape to run (so the
    // walker gets fresh job lists) but we DO want to skip DOM injections —
    // pills flying in mid-walk are visual noise for the user watching the
    // tab, and they can interfere with pagination. `window.__JT_SYNCING__`
    // is set by the walk-tracker-full handler below.
    const suppressInjections = !!window.__JT_SYNCING__;
    // (Fin-swim nudge moved to content/fin.js — runs on every
    // linkedin.com URL, not just /jobs/*.)

    // Apply negative-keyword filter on search-results pages. Runs every
    // scrape tick so late-loading cards get evaluated too. Skipped on
    // non-search URLs so we don't touch feed / profile / etc.
    if (!suppressInjections && isSearchResultsUrl(url)) {
      applyNegativeKeywordFilter().catch(() => {});
      // Report the search to the SW for the recent-searches list —
      // guarded per-URL by lastReportedSearchUrl so the 500ms poller
      // doesn't spam duplicates on the same page.
      if (lastReportedSearchUrl !== url) {
        lastReportedSearchUrl = url;
        chrome.runtime.sendMessage({ type: 'search-detected', url }).catch(() => {});
      }
    }

    // Decorate any recognized job cards with a status/fit/comp/strength
    // badge before touching the URL-specific branches — the detail
    // branch below early-returns on a search-results URL where
    // extractDetail can't pin down a focused job, and the decoration
    // pass needs to keep running for the visible list on that URL.
    // Skipped during a full sync (the walker's own tab shouldn't be
    // decorated mid-flight). Async fire-and-forget; failures are
    // swallowed inside the injector.
    if (!suppressInjections) {
      injectListingDecorations().catch(() => {});
    }

    if (isJobDetailUrl(url)) {
      const data = extractDetail();
      if (!data) return;
      const isNew = data.jobId !== lastJobId;
      lastJobId = data.jobId;
      chrome.runtime.sendMessage({ type: 'job-detected', data, isNew }).catch(() => {});
      if (!suppressInjections) {
        // Clean up any leftover launch-button from earlier extension
        // versions that used to inject a floating "Open in Jawb
        // Thresher" bubble. The Details button in the Jawbar covers
        // the same intent now.
        const stale = document.getElementById('jc-launch-btn');
        if (stale) stale.remove();
        attachSaveWatcher();
        checkAppliedState();
        if (detectPremiumHighMatch()) fireAutoAnalyze();
      }
    } else if (isTrackerUrl(url)) {
      const jobs = scrapeTrackerList();
      // Fingerprint by the exact set of jobIds — catches pagination even
      // when the count stays the same across pages.
      const fingerprint = jobs.map((j) => j.jobId).sort().join(',');
      if (fingerprint !== lastTrackerFingerprint) {
        lastTrackerFingerprint = fingerprint;
        const stage = detectTrackerStage();
        chrome.runtime.sendMessage({ type: 'tracker-list', jobs, url, stage }).catch(() => {});
      }
      if (!suppressInjections) {
        // Backfill sync pill removed — use the Jawboard's "Thresh" button
        // instead. Tracker-list detection still fires so the SW can update
        // tracker state, but no on-page button is injected. Belt-and-
        // suspenders: strip a stale pill left by an older content script,
        // and strip any Careers Site buttons injected by prior versions.
        document.getElementById(BACKFILL_BUTTON_ID)?.remove();
        document.querySelectorAll('.jc-careers-btn').forEach((el) => el.remove());
      }
    }
  }

  // Debounce with a MAX-WAIT ceiling. Plain trailing-edge debounce breaks
  // on LinkedIn because the SPA never stops mutating the DOM (live signals,
  // tracking pixels, lazy-loaded chrome) — the timer keeps sliding forward
  // and runNow never fires for a newly-opened job. The max-wait ensures a
  // scrape happens within MAX_WAIT_MS of the first scheduleWork call
  // regardless of continued mutations.
  const MAX_WAIT_MS = 2000;
  let maxWaitTimer = null;

  function scheduleWork() {
    clearTimeout(extractTimer);
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null;
        clearTimeout(extractTimer);
        runNow();
      }, MAX_WAIT_MS);
    }
    extractTimer = setTimeout(() => {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
      runNow();
    }, DEBOUNCE_MS);
  }

  // Fast-path for URL changes — bypass the debounce entirely so a fresh job
  // gets a scrape attempt within ~50ms, and schedule follow-up scrapes to
  // catch late-loading DOM content.
  function scheduleWorkImmediate() {
    clearTimeout(extractTimer);
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
    extractTimer = setTimeout(runNow, 50);
    // Two follow-up passes: 800ms catches most first-render, 2000ms catches
    // slow API responses (recruiter block, applicant count etc.).
    setTimeout(runNow, 800);
    setTimeout(runNow, 2000);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'rescrape') {
      lastJobId = null;
      lastTrackerFingerprint = '';
      scheduleWork();
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'capture-dom-snapshot') {
      try { sendResponse({ ok: true, snapshot: captureDomSnapshot() }); }
      catch (e) { sendResponse({ ok: false, error: e.message }); }
      return false;
    }
    if (msg?.type === 'get-tracker-list') {
      sendResponse({ ok: true, jobs: scrapeTrackerList(), stage: detectTrackerStage(), url: location.href });
      return false;
    }
    if (msg?.type === 'walk-connections-modal') {
      // Runs the on-demand full extraction: click "Show all" → wait → scrape
      // three sub-sections → close modal. Returns { tier, preview, detail }.
      (async () => {
        try {
          const warmth = await walkConnectionsModal();
          sendResponse({ ok: true, warmth });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }
    if (msg?.type === 'find-tracker-row') {
      // "Find on LinkedIn" flow — the user's on the Jawboard, clicks the
      // magnifier for a job, and this handler walks the current tracker
      // stage until it finds the job's row, then scrolls to it and flashes
      // a highlight ring. Tries `hintPage` first (the page the walker
      // recorded the job on during the last sync); on a miss, restarts from
      // page 1 and walks forward.
      (async () => {
        window.__JT_SYNCING__ = true;
        removeAllInjections();
        try {
          const r = await findTrackerRow(String(msg.jobId), Number(msg.hintPage) || 0);
          sendResponse({ ok: true, ...r });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        } finally {
          window.__JT_SYNCING__ = false;
        }
      })();
      return true;
    }
    if (msg?.type === 'walk-tracker-full') {
      // Async: scrape → scroll/load-more → repeat until no new jobs.
      // Works for both LinkedIn's infinite-scroll and "Show more" button
      // layouts. Bounded by maxIters as a safety.
      (async () => {
        window.__JT_SYNCING__ = true;
        // Remove any already-injected pills so the sync visually looks like
        // a clean walk of LinkedIn's real UI, not our decorated version.
        removeAllInjections();
        try {
          const jobs = await walkTrackerFull(msg.maxIters || 20, msg.waitMs || 1200);
          // Peel the diagnostic array off before responding — arrays
          // don't carry custom props through structured-cloning.
          const diagnostic = jobs._diagnostic || [];
          delete jobs._diagnostic;
          // Grab the per-stage counts LinkedIn shows in its tab bar
          // (e.g. "Saved · 47", "Applied · 123"). Same on every stage
          // page — sending them with every walk lets the SW pick up
          // the most-recent snapshot for verification.
          const stageCounts = scrapeStageCounts();
          // Fold scraper diagnostics into the walk diagnostic array so
          // they cross the sendResponse boundary (custom props on plain
          // objects don't survive structured-clone).
          if (stageCounts._diag?.length) diagnostic.push(...stageCounts._diag);
          const cleanCounts = { ...stageCounts };
          sendResponse({ ok: true, jobs: [...jobs], stage: detectTrackerStage(), url: location.href, diagnostic, stageCounts: cleanCounts });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        } finally {
          window.__JT_SYNCING__ = false;
          // Let the next natural mutation observer tick re-inject the pills;
          // no explicit re-add here so we don't race with LinkedIn's own
          // post-scroll DOM churn.
        }
      })();
      return true;
    }
    return false;
  });

  // Tracker walker — tries every reasonable pagination strategy per
  // iteration and always logs so we can see what happened when it fails.
  //
  // Strategies attempted, in order per iteration:
  //   1. Scroll every scrollable container (window + inner overflow:auto
  //      divs) to their bottom — infinite-scroll views load new cards
  //      that way, and inner containers are common in LinkedIn's layout.
  //   2. Click any "Show more" / "Load more" / "See more" button.
  //   3. Click the pagination Next control (button or anchor) using a
  //      full pointer-event sequence — React handlers on LinkedIn's
  //      newer controls ignore a naive .click().
  //   4. If a Next anchor exists with href, also fire pushState — some
  //      LinkedIn views drive nav that way.
  //
  // Progress is verified by comparing the visible-jobId fingerprint
  // before vs after the wait; if nothing changed, we still count the
  // iteration as "attempted" but bail after two flat ones in a row.
  // When we give up without finding all jobs, dump the pagination
  // region's outerHTML to the console so we can name the actual
  // control and add its selector next iteration.
  async function walkTrackerFull(maxIters, waitMs) {
    // Walk every page of a LinkedIn tracker stage by clicking the
    // Next button until it goes away.
    //
    // LinkedIn's tracker paginator (as of this rev) uses <button>
    // elements with obfuscated class names but stable `data-testid`
    // attributes. Anchors are not used — there are no hrefs to
    // harvest, so URL-based pagination is impossible. Click-based
    // navigation IS the only option.
    //
    // Stable selectors (from live DOM inspection):
    //   [data-testid="pagination-controls-next-button-visible"] — Next present
    //   [data-testid="pagination-controls-next-button-hidden"]  — last page
    //   [data-testid="pagination-controls-list"]                — the <ul>
    //   [data-testid="pagination-indicator-N"]                  — page N (0-idx)
    //   [aria-current="true"]                                    — current page
    //
    // Click uses a full pointer-event sequence (simulateClick) — a
    // bare .click() no-ops on LinkedIn's React buttons.
    const diagnostic = [];
    const log = (...args) => {
      const line = args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      diagnostic.push(line);
      console.info('[Jawbs walker]', ...args);
    };
    log(`walking ${location.href}`);

    const seen = new Map(); // jobId → job
    let currentPage = 1; // walker's 1-indexed page counter; captureVisible stamps this
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Scrape whatever rows are currently in the DOM, deduped into
    // `seen`, tagged with the tracker page they were first spotted
    // on. The page hint feeds the "Find on LinkedIn" lookup path so a
    // subsequent search can jump straight to that page instead of
    // walking every stage. Returns count added this call.
    const captureVisible = () => {
      let added = 0;
      for (const j of scrapeTrackerList()) {
        const id = String(j.jobId);
        if (seen.has(id)) continue;
        seen.set(id, { ...j, pageIndex: currentPage });
        added++;
      }
      return added;
    };
    // LinkedIn's tracker list is virtualized — only rows in the
    // current viewport are in the DOM. Rows that scroll out of view
    // get UNMOUNTED. A single scroll-to-bottom then scrape strategy
    // misses everything that scrolled off the top.
    //
    // Correct approach: incrementally scroll from top to bottom, calling
    // captureVisible() at every step so the accumulated `seen` map
    // contains rows from every viewport window. Loop the full pass
    // until it adds nothing (list fully collected).
    const hydrateAndCollect = async () => {
      const containers = findScrollableContainers();
      const scrollAll = (y) => {
        for (const el of containers) el.scrollTop = y === Infinity ? el.scrollHeight : y;
        window.scrollTo({ top: y === Infinity ? document.documentElement.scrollHeight : y, behavior: 'auto' });
      };
      const stepEl = containers[0] || document.scrollingElement || document.documentElement;
      const viewport = stepEl.clientHeight || window.innerHeight || 600;
      const stepPx = Math.max(300, viewport - 120);
      log(`hydrateAndCollect: ${containers.length} scroll container(s), stepEl.scrollHeight=${stepEl.scrollHeight}, viewport=${viewport}`);
      // Up to 5 full passes; break early when a pass adds nothing.
      // Bounded so an unresponsive page can't spin forever.
      for (let pass = 0; pass < 5; pass++) {
        let addedThisPass = 0;
        scrollAll(0);
        await sleep(200);
        addedThisPass += captureVisible();
        // Re-read scrollHeight per iteration — virtualized lists can
        // grow as we scroll (dynamic height insertions).
        for (let y = stepPx; y < stepEl.scrollHeight + viewport; y += stepPx) {
          scrollAll(y);
          await sleep(180);
          addedThisPass += captureVisible();
        }
        scrollAll(Infinity);
        await sleep(280);
        addedThisPass += captureVisible();
        log(`hydrateAndCollect: pass=${pass} added=${addedThisPass} seen=${seen.size}`);
        if (addedThisPass === 0) break;
      }
    };

    for (let page = 1; page <= maxIters; page++) {
      currentPage = page;
      // Wait for the list to stop growing before scraping. On slower
      // pages the DOM still hydrates rows after nav completes;
      // scraping too early drops rows silently.
      await waitForListStable(waitMs);
      const beforeCount = seen.size;
      await hydrateAndCollect();
      const added = seen.size - beforeCount;
      const s = { count: added, added, fingerprint: '' };
      log(`page ${page}: new=${added}, total=${seen.size}`);

      // Find the Next button — the stable data-testid is the only
      // reliable selector, but keep our older selectors as fallback
      // in case LinkedIn changes the testid.
      const next = findNextPagerButton();
      if (!next) {
        log(`no Next button found; stopping at page ${page}`);
        // Only dump diagnostic when we truly failed to find pagination
        // on a page that has jobs (implying pagination should exist).
        if (page === 1 && s.count >= 25) dumpPaginationArea(log);
        break;
      }
      log(`clicking Next: ${outer(next)}`);
      const beforeCurrent = getCurrentPageIndex();
      // Some layouts require the button to be scrolled into view before
      // it accepts events.
      try { next.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch {}
      simulateClick(next);
      // Wait for LinkedIn's OWN page indicator to change — the
      // aria-current="true" pagination-indicator button flips to the
      // new page number when the transition completes. This is way
      // more reliable than watching the job list fingerprint, which
      // flickers through loading-skeleton states mid-transition.
      const advanced = await waitForPageIndexChange(beforeCurrent, waitMs);
      if (!advanced) {
        log(`Next click did not advance the page indicator (was ${beforeCurrent}) within ${waitMs}ms — stopping`);
        break;
      }
      // After the indicator flips, wait for the list to STABILIZE —
      // same jobId fingerprint for two consecutive polls — so we don't
      // scrape mid-render skeletons on the next iteration.
      await waitForListStable(waitMs);
      log(`page indicator advanced from ${beforeCurrent} → ${getCurrentPageIndex()}`);
    }

    const all = Array.from(seen.values());
    log(`walk complete: ${all.length} total jobIds captured`);
    all._diagnostic = diagnostic;
    return all;
  }

  // Locate a single job row inside the current tracker stage. If
  // `hintPage` is > 1 we try that page first (hint recorded during
  // the last sync). On a miss we walk forward from the current page
  // one Next-click at a time until the row is found or Next runs
  // out. When found, scrolls the row into view and flashes an
  // outline so the user's eye lands on it.
  async function findTrackerRow(jobId, hintPage) {
    const diagnostic = [];
    const log = (...args) => {
      const line = args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      diagnostic.push(line);
      console.info('[Jawbs find]', ...args);
    };
    log(`finding jobId=${jobId} hintPage=${hintPage} on ${location.href}`);

    const MAX_PAGES = 60;
    const WAIT_MS = 8000;

    const findRowEl = () => {
      // The scraper accepts multiple layouts (view links, data-job-id,
      // entity-urn). Mirror those here so we can locate the row's
      // container element regardless of which layout is live.
      const q = [
        `a[href*="/jobs/view/${jobId}"]`,
        `[data-job-id="${jobId}"]`,
        `[data-entity-urn*="jobPosting:${jobId}"]`,
        `[data-entity-urn*="jobPosting-${jobId}"]`,
        `[data-urn*="jobPosting:${jobId}"]`,
        `a[href*="currentJobId=${jobId}"]`,
      ];
      for (const sel of q) {
        const hit = document.querySelector(sel);
        if (!hit) continue;
        const row = hit.closest('li, article, [role="listitem"], [componentkey]') || hit;
        return row;
      }
      return null;
    };

    const scanCurrentPage = async () => {
      // Reuse the same virtualization-defeating scroll pattern as the
      // sync walker: incremental scroll passes, checking after each.
      const containers = findScrollableContainers();
      const scrollAll = (y) => {
        for (const el of containers) el.scrollTop = y === Infinity ? el.scrollHeight : y;
        window.scrollTo({ top: y === Infinity ? document.documentElement.scrollHeight : y, behavior: 'auto' });
      };
      const stepEl = containers[0] || document.scrollingElement || document.documentElement;
      const viewport = stepEl.clientHeight || window.innerHeight || 600;
      const stepPx = Math.max(300, viewport - 120);
      for (let pass = 0; pass < 3; pass++) {
        scrollAll(0);
        await new Promise((r) => setTimeout(r, 200));
        if (findRowEl()) return findRowEl();
        for (let y = stepPx; y < stepEl.scrollHeight + viewport; y += stepPx) {
          scrollAll(y);
          await new Promise((r) => setTimeout(r, 180));
          const row = findRowEl();
          if (row) return row;
        }
        scrollAll(Infinity);
        await new Promise((r) => setTimeout(r, 260));
        const last = findRowEl();
        if (last) return last;
      }
      return null;
    };

    const jumpToPage = async (targetPage) => {
      // Prefer the numbered pagination-indicator when it's visible —
      // one click, no repeated Next presses. Fallback is a bounded
      // series of Next-clicks (works when the target page is beyond
      // the visible indicator window).
      const zeroIdx = targetPage - 1;
      const indicator = document.querySelector(`button[data-testid="pagination-indicator-${zeroIdx}"]`);
      if (indicator) {
        const before = getCurrentPageIndex();
        try { indicator.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch {}
        simulateClick(indicator);
        await waitForPageIndexChange(before, WAIT_MS);
        await waitForListStable(WAIT_MS);
        return getCurrentPageIndex() === zeroIdx;
      }
      // No visible indicator for targetPage — click Next until we
      // reach it, or Next disappears.
      let safety = MAX_PAGES;
      while (getCurrentPageIndex() < zeroIdx && safety-- > 0) {
        const next = findNextPagerButton();
        if (!next) return false;
        const before = getCurrentPageIndex();
        try { next.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch {}
        simulateClick(next);
        const ok = await waitForPageIndexChange(before, WAIT_MS);
        if (!ok) return false;
        await waitForListStable(WAIT_MS);
      }
      return getCurrentPageIndex() === zeroIdx;
    };

    // Try the hint page first.
    if (hintPage && hintPage > 1) {
      log(`trying hint page ${hintPage}`);
      const ok = await jumpToPage(hintPage);
      if (ok) {
        const row = await scanCurrentPage();
        if (row) {
          highlightRow(row);
          return { found: true, page: hintPage, viaHint: true, diagnostic };
        }
        log(`hint miss on page ${hintPage} — falling back to walk from page 1`);
      } else {
        log(`could not reach hint page ${hintPage} — falling back to walk from page 1`);
      }
    }

    // Walk from page 1 forward.
    await jumpToPage(1);
    for (let page = 1; page <= MAX_PAGES; page++) {
      await waitForListStable(WAIT_MS);
      const row = await scanCurrentPage();
      if (row) {
        highlightRow(row);
        return { found: true, page, viaHint: false, diagnostic };
      }
      const next = findNextPagerButton();
      if (!next) {
        log(`no Next button on page ${page} — job not found`);
        return { found: false, pagesScanned: page, diagnostic };
      }
      const before = getCurrentPageIndex();
      try { next.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch {}
      simulateClick(next);
      const advanced = await waitForPageIndexChange(before, WAIT_MS);
      if (!advanced) {
        log(`Next click did not advance on page ${page} — stopping`);
        return { found: false, pagesScanned: page, diagnostic };
      }
    }
    return { found: false, pagesScanned: MAX_PAGES, diagnostic };
  }

  // Scroll a found row into view and flash a coloured outline so the
  // user's eye lands on it. Uses the Web Animations API — no
  // stylesheet injection needed, animation cleans up after itself.
  function highlightRow(row) {
    try { row.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
    try {
      row.animate([
        { boxShadow: '0 0 0 0 rgba(245,147,32,0.0)', outline: '3px solid rgba(245,147,32,0.0)' },
        { boxShadow: '0 0 0 6px rgba(245,147,32,0.55)', outline: '3px solid rgba(245,147,32,0.95)' },
        { boxShadow: '0 0 0 0 rgba(245,147,32,0.0)', outline: '3px solid rgba(245,147,32,0.0)' },
        { boxShadow: '0 0 0 6px rgba(245,147,32,0.55)', outline: '3px solid rgba(245,147,32,0.95)' },
        { boxShadow: '0 0 0 0 rgba(245,147,32,0.0)', outline: '3px solid rgba(245,147,32,0.0)' },
      ], { duration: 3200, iterations: 1, easing: 'ease-out' });
    } catch {
      // Fallback if animate() isn't supported.
      row.style.outline = '3px solid #F59320';
      setTimeout(() => { try { row.style.outline = ''; } catch {} }, 3200);
    }
  }

  // Which pagination page number is currently selected? LinkedIn
  // flips aria-current="true" on the numbered pagination-indicator-N
  // button when the transition to that page has committed. Reading
  // this is more reliable than fingerprint-based detection because
  // the indicator flips ONCE at the end of the transition, not mid-
  // render like the job list DOM does.
  function getCurrentPageIndex() {
    const el = document.querySelector('button[data-testid^="pagination-indicator-"][aria-current="true"]');
    if (el) {
      const t = el.getAttribute('data-testid') || '';
      const m = t.match(/-(\d+)$/);
      if (m) return parseInt(m[1], 10);
    }
    return -1;
  }

  // Wait until the current-page indicator changes from `beforeIdx`
  // (indicating LinkedIn finished the transition to a new page).
  // Polls every 150ms up to `maxMs`.
  async function waitForPageIndexChange(beforeIdx, maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 150));
      if (getCurrentPageIndex() !== beforeIdx) return true;
    }
    return false;
  }

  // Wait until the job list DOM stops changing — same jobId
  // fingerprint on two consecutive polls. Ceiling `maxMs` regardless.
  // Prevents scraping mid-render skeletons on the next iteration.
  async function waitForListStable(maxMs) {
    const start = Date.now();
    let last = '';
    let stableTicks = 0;
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 250));
      const now = scrapeTrackerList().map((j) => j.jobId).sort().join(',');
      if (now === last && now !== '') {
        stableTicks++;
        if (stableTicks >= 2) return;
      } else {
        stableTicks = 0;
        last = now;
      }
    }
  }

  // Next-button lookup — data-testid first (LinkedIn's stable hook),
  // then aria-label/class fallbacks in case a layout changes.
  function findNextPagerButton() {
    const selectors = [
      'button[data-testid="pagination-controls-next-button-visible"]',
      'button[data-testid*="next-button-visible"]',
      'button[data-testid*="pagination"][data-testid*="next"]:not([data-testid*="hidden"])',
      'button.artdeco-pagination__button--next:not([disabled]):not([aria-disabled="true"])',
      'button[aria-label*="Next page" i]:not([disabled]):not([aria-disabled="true"])',
    ];
    for (const s of selectors) {
      let el;
      try { el = document.querySelector(s); } catch { continue; }
      if (!el) continue;
      if (el.disabled) continue;
      if (el.getAttribute('aria-disabled') === 'true') continue;
      // The "hidden" variant of the testid means we're on the last
      // page — treat as absent.
      const t = el.getAttribute('data-testid') || '';
      if (/hidden$/i.test(t)) continue;
      return el;
    }
    return null;
  }

  // Try every advancement strategy. Returns true if any control was
  // engaged (even if it didn't produce new content — verification
  // happens in the caller).
  async function tryAdvance(log) {
    // 1. Scroll every scrollable container to its bottom. Also scroll
    //    the window — many LinkedIn layouts have both.
    const scrollables = findScrollableContainers();
    for (const el of scrollables) {
      el.scrollTop = el.scrollHeight;
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    // Brief pause so any resulting hydration renders before we look for
    // pagination controls.
    await new Promise((r) => setTimeout(r, 300));

    // 2. Show-more / Load-more.
    const showMore = findShowMoreButton();
    if (showMore && !showMore.disabled) {
      log('clicking Show/Load more:', outer(showMore));
      simulateClick(showMore);
      return true;
    }

    // 3. Numbered pagination — try Next anchor first (nav is reliable),
    //    then Next button.
    const nextAnchor = findNextPageAnchor();
    if (nextAnchor) {
      log('advancing via <a>:', nextAnchor.href);
      try { nextAnchor.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch {}
      // Full click sequence + pushState fallback.
      simulateClick(nextAnchor);
      try {
        history.pushState({}, '', nextAnchor.href);
        window.dispatchEvent(new PopStateEvent('popstate'));
      } catch {}
      return true;
    }
    const nextBtn = findNextPageButton();
    if (nextBtn) {
      log('clicking Next button:', outer(nextBtn));
      try { nextBtn.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch {}
      simulateClick(nextBtn);
      return true;
    }

    return false;
  }

  // Compact outerHTML sample for logs — cap at 240 chars.
  function outer(el) {
    const s = el?.outerHTML || '';
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  }

  // Find every scrollable descendant. LinkedIn frequently puts the
  // job list in a `overflow-y: auto` container instead of on the
  // window; scrolling the window in those layouts does nothing.
  function findScrollableContainers() {
    const out = [];
    // Prefer likely candidates first to keep this cheap.
    const candidates = document.querySelectorAll(
      'main, [role="main"], .scaffold-finite-scroll, ul, div[class*="list" i], div[class*="scroll" i]'
    );
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      const canScroll = (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll');
      if (!canScroll) continue;
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      out.push(el);
    }
    return out;
  }

  // Full pointer-event sequence so React/synthetic-event handlers fire.
  // A bare .click() often no-ops on LinkedIn's newer controls because
  // their handlers subscribe to pointerdown/pointerup, not click.
  //
  // Important: dispatch the synthetic click OR call el.click() — never
  // both. On LinkedIn's tracker paginator, both delivering the click
  // caused a double-advance per call (the walker was hitting only
  // odd-numbered pages: 1 → 3 → 5 → …), missing every even page.
  function simulateClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0, pointerType: 'mouse',
      pointerId: 1, isPrimary: true,
    };
    try { el.dispatchEvent(new PointerEvent('pointerover', opts)); } catch {}
    try { el.dispatchEvent(new PointerEvent('pointerenter', opts)); } catch {}
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('click', opts)); } catch {}
  }

  function findNextPageAnchor() {
    const selectors = [
      'a.artdeco-pagination__button--next',
      'a[aria-label="View next page"]',
      'a[aria-label*="Next page" i]',
      'a[aria-label*="Next" i][href*="jobs-tracker"]',
      'a[href*="jobs-tracker"][aria-current="false"]',
    ];
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el && el.getAttribute('aria-disabled') !== 'true' && el.href) return el;
    }
    return null;
  }

  function findNextPageButton() {
    const selectors = [
      'button.artdeco-pagination__button--next',
      'button.jobs-search-pagination__button--next',
      'button[aria-label="View next page"]',
      'button[aria-label*="Next page" i]',
      'button[aria-label*="Next" i]',
      '[data-test-pagination-page-btn][aria-label*="next" i]',
      // Icon-only pagination — LinkedIn sometimes uses this pattern.
      'button[type="button"]:has(svg[aria-label*="Next" i])',
    ];
    for (const s of selectors) {
      let btn;
      try { btn = document.querySelector(s); } catch { continue; }
      if (!btn) continue;
      if (btn.disabled) continue;
      if (btn.getAttribute('aria-disabled') === 'true') continue;
      return btn;
    }
    return null;
  }

  // Harvest every anchor href on the page that looks like a
  // pagination sibling of the current URL. LinkedIn's tracker
  // presents pages as `<a href="…">1 2 3 Next</a>` under the job
  // list; whatever URL scheme they use (`start=N`, `page=N`, opaque
  // params, whatever), the anchor href itself is the canonical
  // destination. Extract them all and let the SW navigate through.
  //
  // Rules:
  //   - Anchor must live in the same site path family (jobs-tracker,
  //     jobs/search, my-items, etc.).
  //   - Must differ from location.href.
  //   - If the current URL has a `stage` param, only match anchors
  //     with the same stage — pagination is per-stage.
  //   - Deduped, ordered by their numeric page indicator when we can
  //     extract one; alphabetical fallback.
  function discoverPaginationUrls() {
    const here = new URL(location.href);
    const currentStage = here.searchParams.get('stage');
    const currentPathBase = here.pathname.replace(/\/$/, '');
    const seen = new Set([here.toString()]);
    const found = [];

    // Params LinkedIn uses (across older/newer views) as pagination
    // offsets. Presence of any one of these on a same-path anchor is
    // treated as a positive pagination signal.
    const PAGE_PARAMS = ['start', 'page', 'pageNum', 'position', 'offset', 'currentPage'];

    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try { u = new URL(a.href, location.origin); } catch { continue; }
      if (u.origin !== here.origin) continue;

      // Accept exact-path OR nested paginated variants like
      // /jobs-tracker/page/2/. Trim trailing slash for the compare.
      const otherPathBase = u.pathname.replace(/\/$/, '');
      const samePath = otherPathBase === currentPathBase
        || otherPathBase.startsWith(currentPathBase + '/page/');
      if (!samePath) continue;

      // Stage lock — pagination is per-stage.
      if (currentStage && u.searchParams.get('stage') !== currentStage) continue;

      const canonical = u.toString();
      if (seen.has(canonical)) continue;

      // POSITIVE signal required — anchor must look like pagination.
      const order = extractPageOrder(u, a, PAGE_PARAMS);
      if (order == null) continue;

      seen.add(canonical);
      found.push({ url: canonical, order });
    }
    // Numeric order — page 2 before page 3, etc.
    found.sort((a, b) => a.order - b.order);
    return found.map((f) => f.url);
  }

  // Numeric ordering AND the pagination-signal gate rolled into one.
  // Returns null when the anchor doesn't look like pagination.
  function extractPageOrder(u, a, pageParams) {
    // Query-string offset params — most reliable signal.
    for (const k of pageParams) {
      const v = u.searchParams.get(k);
      if (v && /^\d+$/.test(v)) {
        // Treat `start=N` (LinkedIn's offset scheme) directly; treat
        // `page=N` (1-indexed) as N*25 for ordering only.
        const n = parseInt(v, 10);
        return (k === 'page' || k === 'pageNum' || k === 'currentPage') ? n * 25 : n;
      }
    }
    // Path segment: /page/2/
    const pathM = u.pathname.match(/\/page\/(\d+)/);
    if (pathM) return parseInt(pathM[1], 10) * 25;
    // aria-label like "Page 3" or "Next page"
    const label = (a.getAttribute('aria-label') || '').toLowerCase();
    const labelM = label.match(/\bpage\s+(\d+)/i);
    if (labelM) return parseInt(labelM[1], 10) * 25;
    // Anchor text — LinkedIn often wraps the number in a span; use
    // the innermost text and strip whitespace.
    const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
    if (/^\d+$/.test(text)) return parseInt(text, 10) * 25;
    // "Next" text or aria — order it at the end (Infinity - 1 so it
    // still comes before URLs we couldn't order at all).
    if (label.includes('next') || /^next$/i.test(text)) return Number.MAX_SAFE_INTEGER;
    return null;
  }

  // Scrape the per-stage job counts LinkedIn shows in its tab bar
  // above the tracker list. Same tab bar on every stage page, so
  // whichever stage the walker landed on works.
  //
  // The tab bar renders each stage as an anchor whose href is the
  // stage-only URL (`/jobs-tracker/?stage=saved`) — NOT the paginated
  // form (`?stage=saved&page=2`) that also matches `stage=`. We had a
  // bug where pagination anchors won the "first anchor for this
  // stage" race and we'd record their page number ("2") as the stage
  // count. Guard by skipping any href with `page=` or `start=` — those
  // are always pagination, never tab-bar links.
  //
  // The count itself may live in a child badge (`<span class="…badge">`
  // or `<span aria-label="47 jobs">`) rather than the anchor's text.
  // We try structured attribute lookups first, fall back to the largest
  // integer in the anchor's text (largest — not first — because "Saved"
  // sometimes wraps as "Saved\n2\n1" where "1" is a nested icon count).
  //
  // Returns { saved: 47, clicked_apply: 3, applied: 123, ... } — keys
  // match SYNC_STAGES.key. Also returns `_diag` with per-stage debug
  // strings the SW logs to console when a count is missing or looks
  // suspicious (< 0, > 9999, etc).
  // Scrape LinkedIn's per-stage totals. As of this rev, the tracker
  // stage filter is rendered as `role="radio"` chips (NOT anchor tabs)
  // wrapping a <label> that reads e.g. "Applied · 130". The stage= URL
  // param is not present on the chip itself — we map LinkedIn's
  // display labels to our internal stage keys.
  //
  // Labels (LinkedIn) → keys (SYNC_STAGES.key):
  //   "Saved"              → saved
  //   "In Progress"        → clicked_apply
  //   "Applied"            → applied
  //   "Interview"          → interview
  //   "Archived"           → archived
  //   "Not Moving Forward" → not-moving-forward
  const STAGE_LABEL_TO_KEY = {
    'saved': 'saved',
    'in progress': 'clicked_apply',
    'applied': 'applied',
    'interview': 'interview',
    'interviewing': 'interview',
    'archived': 'archived',
    'not moving forward': 'not-moving-forward',
  };
  function scrapeStageCounts() {
    const counts = {};
    const diag = ['[scrapeStageCounts] scanning role=radio chips…'];

    // Every stage chip is a role="radio" wrapping a <label>. Grab all
    // radios and match the label text against known stage labels.
    const radios = document.querySelectorAll('[role="radio"]');
    for (const chip of radios) {
      const label = chip.querySelector('label');
      const text = ((label || chip).textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      // Format: "Applied · 130" — split on the middle dot (·, U+00B7)
      // or common alternatives (·, ·, |, -, —, ()).
      const m = text.match(/^(.+?)\s*[·|\-·–—(]\s*(\d{1,5})\)?$/);
      if (!m) {
        diag.push(`  chip text="${text}" — no "Label · N" pattern`);
        continue;
      }
      const rawLabel = m[1].trim().toLowerCase();
      const n = parseInt(m[2], 10);
      const key = STAGE_LABEL_TO_KEY[rawLabel];
      if (!key) {
        diag.push(`  chip label="${rawLabel}" count=${n} — unknown stage label`);
        continue;
      }
      diag.push(`  chip label="${rawLabel}" → key="${key}" count=${n}`);
      counts[key] = n;
    }

    diag.push(`[scrapeStageCounts] result: ${JSON.stringify(counts)}`);
    Object.defineProperty(counts, '_diag', { value: diag, enumerable: false });
    return counts;
  }

  function findShowMoreButton() {
    return document.querySelector(
      'button.scaffold-finite-scroll__load-button, ' +
      'button[aria-label*="Show more" i], ' +
      'button[aria-label*="Load more" i], ' +
      'button[aria-label*="See more" i]'
    );
  }

  // When the walker gives up, dump the pagination-area DOM so the
  // user (or a future debugging session) can identify LinkedIn's
  // actual pagination controls and add their selectors here.
  function dumpPaginationArea(log) {
    // Look for likely paginator containers, then log outerHTML.
    const candidates = document.querySelectorAll(
      '[class*="pagination" i], nav[aria-label*="pagination" i], ' +
      '[class*="paginator" i], [class*="page-list" i]'
    );
    if (!candidates.length) {
      log('DIAGNOSTIC: no pagination container found in DOM. Sample of bottom-of-list controls:');
      // Log all bottom-region buttons/anchors so we can see what's actually there.
      const all = Array.from(document.querySelectorAll('button, a'));
      const bottom = all.filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top > window.innerHeight * 0.5;
      }).slice(-20);
      for (const el of bottom) log(' ·', outer(el));
      return;
    }
    log(`DIAGNOSTIC: found ${candidates.length} pagination-like container(s):`);
    for (const c of candidates) log(outer(c));
  }

  // Poll URL every 500ms — LinkedIn's SPA nav sometimes doesn't fire
  // popstate; polling catches every case. Halved from 1000ms for snappier
  // detection when the user clicks a job in a list.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastTrackerFingerprint = '';
      lastJobId = null; // force a re-emit even if jobId matches a stale value
      scheduleWorkImmediate();
    }
  }, 500);

  const observer = new MutationObserver(() => scheduleWork());
  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('popstate', () => scheduleWorkImmediate());

  scheduleWorkImmediate();
})();
