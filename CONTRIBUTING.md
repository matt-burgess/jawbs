# Contributing to Jawbs

Thanks for taking a look. Jawbs is a personal-scale extension built to make my own job search less miserable. PRs and issues are welcome — no SLAs.

## Filing an issue

- **One issue per bug or idea.**
- **Bugs**: include your OS + Chrome (or Chromium fork) version, a screenshot if it's visual, and the DevTools console output for the Jawbar sidepanel and (if relevant) the service worker.
  - Sidepanel console: right-click the sidepanel → **Inspect** → **Console**
  - Service-worker console: `chrome://extensions` → Jawbs → **Inspect views: service worker**
  - Content-script console: DevTools on any linkedin.com tab → **Console**, filter for `[Jawbs]`
- **Feature ideas**: tell me the workflow it fits into. I'd rather understand the itch than the exact scratch you have in mind.

## Submitting a PR

- **Branch off `main`.** Match the existing code style.
- **Keep PRs focused.** Bug fix and refactor should be separate PRs.
- **No new dependencies without discussion.** The project has zero runtime dependencies and no build step — I'd like to keep it that way.
- **Touched the UI?** Include a before/after screenshot in the PR description.
- **Verify by hand.** No test suite. Load the unpacked extension in Chrome, exercise both a LinkedIn job page and the standalone Jawboard.
- **Syntax check** any changed JS files with `node --check <file>` before pushing — the extension has no bundler to catch parse errors for you.

## Local dev

1. `git clone https://github.com/matt-burgess/jawbs.git`
2. Chrome → `chrome://extensions` → toggle **Developer mode** → **Load unpacked** → pick this folder.
3. Edit files → reload the extension (arrow-circle button on the card) → refresh any open LinkedIn tabs so the content scripts re-inject.
4. See [README.md](./README.md) → *Development* section for debug consoles and syntax-check commands.

## Code style

- **No emojis** in code, comments, or commit messages unless they're part of the actual UI copy.
- **Comments explain WHY, not what** — well-named identifiers already describe what. Comments are load-bearing here because this is a solo project and future-me forgets things.
- **`.jc-*` class prefix** for shared design-system rules (`styles/job-copilot.css`). Page-specific rules live in the page's own CSS.
- **`chrome.storage.local`** is the single source of truth. No LocalStorage, no cookies, no `sessionStorage` (with the small exception of `chrome.storage.session` for per-tab job state).
- **ES modules, no bundler.** `manifest.json` uses `"type": "module"` for the service worker; content scripts use dynamic import for shared modules.
- **No telemetry, no auto-network-calls.** Every network call is either an explicit AI request or an explicit user action (LinkedIn scrape, Ollama probe).

## Support / questions before you spend hours

Not sure if something's a bug or a design choice? Email me at **jawbsthebrowserextension@gmail.com** before you sink real time into a PR.
