# Jawbs

**A browser-local job-search assistant for LinkedIn.** Analyzes fit, reads compensation, preps interview answers, drafts cover letters, and archives every jawb you save or apply to — all inside the **Jawbar** (Chromium side panel). Nothing leaves your machine except the AI calls you explicitly trigger.

<p align="center">
  <img src="assets/jawb-logo.png" width="96" alt="Jawbs shark-fin logo" />
</p>

<p align="center">
  <em>Chromium extension · Manifest V3 · Anthropic Claude (with optional local Ollama routing)</em>
</p>

<p align="center">
  <a href="#install" title="Install"><img src="assets/icon-download.svg" width="48" height="48" alt="Install" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="#tip-your-captain" title="Tip the captain"><img src="assets/tip-jar.png" width="48" alt="Tip the captain" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="mailto:jawbsthebrowserextension@gmail.com" title="Support"><img src="assets/icon-support.svg" width="48" height="48" alt="Support" /></a>
</p>

<p align="center">
  <a href="#install"><b>Install</b></a> ·
  <a href="#tip-your-captain"><b>Tip Your Captain</b></a> ·
  <a href="mailto:jawbsthebrowserextension@gmail.com"><b>Support</b></a>
</p>

---

## Why

LinkedIn's job UI optimizes for LinkedIn, not for you. Jawbs adds the **Jawbar** — a persistent side panel that reads the posting you're looking at, cross-references it against your own profile / resume / preferences, and answers the questions you actually have:

- Is this a real fit or just a keyword match?
- Is the pay in range, and where did that number come from?
- What should I ask the recruiter?
- What would a tailored resume for this role look like?
- Which of my prior applications is closest to this one?

Everything runs on demand. Nothing is auto-generated. No data leaves your browser except the AI calls you make.

## Features

| | |
|---|---|
| **Career Fit** | Strict, calibrated score (0-100) with alignments, gaps, remote-authenticity check, and outreach guidance. Reasons against your specific positioning anchors — not generic keyword matching. |
| **Compensation** | Reads the posted range first, then research, then a title-benchmark fallback. Always shows the source. Flags postings below your floor. |
| **Connection analysis** | Surfaces 1st-degree contacts at the company plus anyone on the hiring team (recruiter, hiring manager, poster, interviewer). Rolled into the composite Strength score so an in-network role reads visibly stronger. Also fixes LinkedIn's "who to follow" gap with concrete outreach suggestions. |
| **Question Prep** | Configure a list of interview questions in Settings. One "Bait" click generates answers for the specific role in your voice. |
| **Cover Letter & Tailored Resume** | Drafted from your master materials — never invented experience. Copyable, printable to PDF. |
| **Chat with AI** | Freeform ask about this posting with the full context loaded (profile, resume, prior analyses). |
| **Jawboard** | Full-page archive of every saved / applied job. Sort, filter, export CSV/JSON. Boat-gauge instrument-panel analytics for status, fit distribution, salaries, application-to-interview velocity. |
| **Saved LinkedIn searches** | Save any `/jobs/search/*` URL. Suggestion pill nudges you toward high-signal filters (past 24h, in-network) most searches leave off. |
| **Auto-capture on LinkedIn Save/Apply** | Clicking LinkedIn's own Save or Apply button archives the job — no separate "Save to Job Thresher" click. |
| **Recall** | Full-page per-job view for interview rounds, timeline, comp offer form — the stuff that doesn't fit in the Jawbar. |
| **Local vs Cloud routing** | Anthropic Claude by default. Optional Ollama routing per-feature (Fit, Comp, Prep, Letter, Resume) — keeps routine work off your API bill. |
| **Personal-tool disclaimer** | The API key sits in `chrome.storage.local` in plaintext. Appropriate for your own machine. Not appropriate for shared devices or org rollouts. |

## Install

Not on the Chrome Web Store yet. Two ways to get it running.

### 1. Easy path — sideload the packaged zip

Best for anyone who doesn't want to touch `git`. Five minutes end-to-end.

**Step 1 — Download the release zip.** Head to
[github.com/matt-burgess/jawbs/releases/latest](https://github.com/matt-burgess/jawbs/releases/latest)
and click `jawbs-<version>.zip` under **Assets**.

<p align="center">
  <img src="docs/install/step-1-download.svg" width="640" alt="Screenshot: GitHub Releases page with the jawbs-*.zip asset highlighted" />
</p>

**Step 2 — Unzip it somewhere permanent.** Documents, ~/Applications,
wherever — just don't move the folder afterwards or the extension will
break.

<p align="center">
  <img src="docs/install/step-2-unzip.svg" width="480" alt="Screenshot: unzipped jawbs folder shown in Finder / File Explorer" />
</p>

**Step 3 — Open the extensions page.** Paste `chrome://extensions` into
your address bar (works in Chrome, Edge, Brave, and other Chromium
browsers).

<p align="center">
  <img src="docs/install/step-3-extensions-url.svg" width="640" alt="Screenshot: chrome://extensions typed in the address bar" />
</p>

**Step 4 — Turn on Developer mode.** Flip the toggle in the top-right
corner. Two new buttons appear on the left (**Load unpacked**, **Pack
extension**, **Update**).

<p align="center">
  <img src="docs/install/step-4-developer-mode.svg" width="640" alt="Screenshot: Developer mode toggle highlighted in the top-right of chrome://extensions" />
</p>

**Step 5 — Load unpacked → pick your unzipped folder.** Click **Load
unpacked**, then in the folder picker choose the folder you unzipped
in Step 2. The Jawbs card appears immediately.

<p align="center">
  <img src="docs/install/step-5-load-unpacked.svg" width="640" alt="Screenshot: Load unpacked button and the folder picker dialog" />
</p>

**Step 6 — Pin it and open the side panel.** Click the puzzle-piece icon
in the browser toolbar, find **Jawbs**, and click the pin so its icon
stays visible. Click the pinned icon to open the Jawbar side panel —
the welcome tab loads automatically and walks you through the 3-step
setup.

<p align="center">
  <img src="docs/install/step-6-pin-and-open.svg" width="640" alt="Screenshot: puzzle-piece extensions menu with the Jawbs pin toggled on" />
</p>

**You'll also need** an Anthropic API key from
[console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).
Optional: run [Ollama](https://ollama.com) locally to route routine analyses off
the paid API — see the **Local model (Ollama)** section below.

### 2. From source

For hacking or contributing:

```bash
git clone https://github.com/matt-burgess/jawbs.git
cd jawbs
```

Then load the folder as an unpacked extension using steps 3–6 above. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for dev workflow.

## First-run setup

The install triggers `welcome/welcome.html` which walks you through:

1. **Add your Anthropic API key** — Options → AI Settings
2. **Fill your profile and master resume** — Options → You Settings
3. **Open a LinkedIn job posting** and hit *Analyze* on Career Fit

Extras worth doing early:
- **Work locations & preferences** — enables the fit analysis to flag postings labeled "Remote" that actually restrict to a region you can't work from
- **Compensation targets** — floor / target / walk-away; feeds the comp analysis
- **Writing samples** — 2-3 paragraphs in your voice, so drafted letters and prep answers sound like you
- **Question Prep list** — the questions you actually get asked, so each Bait returns tailored answers

## Privacy & data

- **All data is local.** `chrome.storage.local` on your machine.
- **API key is plaintext**, per Chrome extension convention. Not for shared devices.
- **No telemetry.** Nothing is logged, phoned home, or sent to any server other than the AI provider (`api.anthropic.com` or your local Ollama at `localhost:11434`).
- **Manual export/import**. `Jawboard → Export JSON` gives you a portable dump minus the API key. Import restores it.
- **Cost tracking is local** — token counts and cost estimates live in the Jawbar footer. Numbers are approximate; verify against your Anthropic console for billing.

## Architecture

**MV3 Chromium extension**, no build step, no bundler. Everything is native ES modules loaded straight by Chrome.

```
manifest.json          MV3 manifest — permissions, side panel, content scripts
service-worker.js      All API calls, storage writes, cross-context messaging
sidepanel/             The Jawbar — persistent side panel
  panel.html/.css/.js
options/               Full-page settings screen
archive/               Jawboard — searchable archive + analytics dashboard
recall/                Per-job full-page view (interview rounds, timeline, comp)
welcome/               First-run onboarding
content/               LinkedIn scraper + ATS form-fill helpers
  scrape.js            Main content script — job detection, save/apply watchers
  externalFill.js      Fill helpers for common ATS sites
  selectors.js         Selector maps used by scrape.js
lib/
  anthropic.js         Anthropic API client (browser-direct with dangerous header)
  json.js              JSON-response helper with retry
  ollamaClient.js      Local model client (Ollama)
  store.js             chrome.storage.local wrapper — settings + Jawboard + usage
  models.js            Model IDs + defaults
  pricing.js           Per-token cost calculation
  defaults.js          Placeholder profile / questions
  statuses.js          Canonical status vocabulary (LinkedIn-aligned)
  search.js            Fuzzy search across the Jawboard
  linkedInFill.js      Shared LinkedIn URL fill helper
  enrich.js            Fetch full posting via JSON-LD when scrape falls back
  prompts/             System prompts + user-message builders
    fit.js
    comp.js
    questionPrep.js
    coverLetter.js
    resume.js
    ask.js
    interviewRound.js
assets/                Icons, PNGs
styles/
  job-copilot.css      Shared design tokens + component styles
docs/                  Architecture notes
```

### Design choices worth knowing

- **Every API call is user-initiated.** No auto-analysis on scrape, tab focus, or panel open. Exception: LinkedIn Premium's "high match" postings can trigger auto-fit if enabled.
- **Capture is LinkedIn-driven.** No "Save to Jawboard" button. The content script watches for clicks on LinkedIn's own Save and Apply buttons.
- **Per-tab job state.** Each browser tab has its own current job in `chrome.storage.session`; multi-window LinkedIn use doesn't cross-contaminate.
- **Prompt versioning.** Every prompt module exports a `*_PROMPT_VERSION` constant. Analysis records store the version they were generated under, so re-running on a stored job is auditable.
- **Local ↔ cloud fallback.** If Ollama is enabled for a feature and fails or times out, the SW silently falls back to the cloud caller. Log entry marks it as `fellback: true`.
- **No build step.** Everything is native ES modules. `manifest.json` `"type": "module"` for the SW; content scripts use dynamic import for shared modules.

### Not in the box

- No test suite. This is a personal tool that ships to production every reload.
- No i18n. English only. LinkedIn URL matching assumes `www.linkedin.com/*`.
- No cross-device sync. Deliberate — the API key is one of the reasons.

## Development

No install / build. Iterate directly on the files:

```bash
# 1. Make changes
# 2. chrome://extensions → Reload
# 3. Refresh any open LinkedIn tabs (content scripts don't re-inject silently)
```

Debug consoles:
- **Jawbar / options / Jawboard**: right-click the page → Inspect
- **Service worker**: `chrome://extensions` → Jawbs → *Inspect views: service worker*
- **Content script**: DevTools on any linkedin.com tab → Console; filter for `[Jawbs]`

Syntax check before reload (all files are Node-parseable ES modules):

```bash
node --check service-worker.js sidepanel/panel.js archive/archive.js content/scrape.js
```

## Local model (Ollama) — optional

Route routine analyses (Fit, Comp, Question Prep) to a local model instead of paying for cloud tokens.

1. Install [Ollama](https://ollama.ai/)
2. Pull a capable model. Recommended: `qwen2.5:14b-instruct` (works well for Fit and Prep on a 32GB Mac)
3. Set `OLLAMA_ORIGINS="chrome-extension://*"` so the extension can reach the local API
4. In Options → AI Settings → Local (Ollama), enable it and check the features you want routed locally

Cloud remains the fallback on any local failure. Cover Letter and Tailored Resume stay cloud-only by default — they need the stronger model.

## Contributing

This started as, and remains, a personal-use tool. PRs welcome but expect an opinionated maintainer. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the small print. In short:

- Keep to the "no build step" constraint
- No test suite → no need to add one; use `node --check` for syntax
- Match the existing code style (native ES modules, no bundler, no framework)
- Don't add telemetry, remote logging, or any auto-network-call outside the explicit AI provider path

## Tip your captain

<p align="center">
  <a href="https://buymeacoffee.com/mattburgess" title="Tip the captain">
    <img src="assets/jawb-captain.png" width="260" alt="Your captain — Matt" />
  </a>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/mattburgess" title="Buy me a coffee">
    <img src="assets/tip-jar.png" width="72" alt="Tip jar" />
  </a>
</p>

<h3 align="center">
  <a href="https://buymeacoffee.com/mattburgess">Buy the captain a drink →</a>
</h3>

<p align="center">
  Jawbs is a one-person show. If it enhanced your job search, a few
  bucks in the jar keeps my boat afloat. Every tip is genuinely
  appreciated.
</p>

## Support

Questions, bug reports, or feature ideas → **jawbsthebrowserextension@gmail.com**

Prefer a channel with a paper trail? [Open a GitHub issue](https://github.com/matt-burgess/jawbs/issues).

## License

[MIT](./LICENSE) © 2026 Matt Burgess. Anton and Archivo (Google Fonts, Open Font License) power the brand type; shark-fin / captain / jawboard icons are original assets covered by this repo's license.

## Credits

Built by your captain, [Matt Burgess](https://www.linkedin.com/in/mattburgess/).
