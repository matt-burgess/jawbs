# Cross-device sync — architecture decision record

**Status:** Planned, not implemented. Local-only single-machine storage remains the shipping architecture until this is built.

**Decided:** 2026-08-15

## Decision

- **Sync model:** **(C) Extension-driven scrape, backend-persisted state.** The user's browser extension continues to be the only surface that touches LinkedIn. Every scrape / status change is pushed to a backend the user has authenticated against; other devices running the extension (or the read-only mobile web app) pull the state and stay current.
- **API key strategy:** **BYOK.** Each user brings their own Anthropic API key. It is stored encrypted per-user; the backend never proxies model calls (calls still go direct from the user's browser to `api.anthropic.com`, same as today).

## Rejected alternatives

| Option | Why rejected |
|---|---|
| **(A) Extension-only, no backend** | Cannot sync across devices; mobile is impossible; kills the "kept current from anywhere" property that motivates this work. |
| **(B) Server-side crawler using the user's LinkedIn session** | LinkedIn's ToS explicitly forbids server-side authenticated scraping; detection is aggressive and results in banned user accounts. Requires holding every user's LinkedIn session token — worst-case credential exposure. |
| **Pooled Anthropic API key** | Puts operator on the hook for user token spend, complicates pricing, adds a monitoring burden. Every serious AI dev tool (Cursor, Continue, Aider) is BYOK; users tolerate it. |

## What is NOT being built as part of this plan

- No server-side LinkedIn crawl. Sync of LinkedIn tracker state remains "runs when a desktop with the extension is open." Framing this honestly in the UI is a design requirement, not a limitation to hide.
- No pooled hosted Anthropic key.
- No native iOS/Android app. Mobile is a responsive web view of the backend.
- No LinkedIn OAuth — we don't have LinkedIn API access and shouldn't imply we do.

## Data model (sketch)

Postgres, row-level security scoped to `user_id`. Field names loosely match the existing `chrome.storage.local` keys so migration from local-only records is mechanical.

```
users
  id              uuid pk
  email           text unique
  created_at      timestamptz
  last_seen_at    timestamptz

user_secrets                          # encrypted-at-rest, per-user KEK
  user_id         uuid pk fk
  anthropic_key   bytea               # BYOK, envelope-encrypted
  comp_targets    bytea               # very-high sensitivity → encrypted column
  updated_at      timestamptz

user_profile                          # syncable settings.*
  user_id         uuid pk fk
  profile_md      text
  knowledge_base  text
  resume_md       text
  writing_samples text
  work_locations  jsonb
  work_prefs      jsonb
  models          jsonb                # per-feature model IDs
  updated_at      timestamptz

jobs                                  # one row per job.<id> in the archive
  user_id         uuid fk
  job_id          text                 # LinkedIn jobId (or manual-<ts>)
  status          text                 # canonical vocabulary from lib/statuses.js
  status_updated_at timestamptz
  posting         jsonb                # title, company, location, description…
  analyses        jsonb                # fit / comp / brief / chats / etc.
  timeline        jsonb                # append-only history of user + system events
  tags            text[]
  user_notes      text
  captured_at     timestamptz
  updated_at      timestamptz
  primary key (user_id, job_id)

usage_daily                            # already day-bucketed locally
  user_id         uuid fk
  day             date
  model           text
  input_tokens    bigint
  output_tokens   bigint
  calls           int
  primary key (user_id, day, model)

activity_log                           # ring buffer, TTL prune at 90d
  user_id         uuid fk
  at              timestamptz
  type            text
  job_id          text null
  ok              boolean
  provider        text
  model           text
  meta            jsonb
```

**Encryption:** `user_secrets` columns encrypted with a per-user Key Encryption Key (KEK), unwrapped by a master key held in the backend's secret manager. Rotating the master key rewraps KEKs, not user data. `settings.apiKey` never appears in plaintext at rest; the backend hands the ciphertext to the extension on session start and the extension decrypts locally into `chrome.storage.local` for the current session.

## Sync protocol (sketch)

Last-write-wins per record with a monotonic `updated_at`. Not strong consistency — the surfaces involved (one user's own devices) don't warrant CRDT overhead. If two devices update the same job in the same second, latest `updated_at` wins; the loser sees a conflict banner on next open and can view the timeline to reconcile.

Conceptual endpoints:

```
POST   /v1/session/start          → returns encrypted user_secrets + last-sync cursor
POST   /v1/jobs/upsert            → array of jobs, each with client updated_at
GET    /v1/jobs?since=<cursor>    → jobs updated after cursor
POST   /v1/profile/upsert         → syncable settings
POST   /v1/usage/append           → daily rollup
POST   /v1/activity/append        → activity entries
POST   /v1/secrets/put            → wrapped ciphertext for API key / comp targets
```

Every write returns a fresh cursor. The extension keeps a `lastSyncCursor` in `chrome.storage.local` and pulls-then-pushes on:
- Extension startup
- Sidebar open (throttled to once per 60s)
- After any local write
- On `chrome.alarms` every 15 minutes when a window is focused

## Stack

Boring, cheap to run, easy to hire against:

- **Postgres**: Supabase or Neon (managed, cheap, row-level security built in).
- **API**: Node/TypeScript with Hono or Fastify (same TS ecosystem as the extension).
- **Auth**: Passwordless email link (magic link) via Supabase Auth or Clerk. Optional Google/Apple later.
- **Hosting**: Fly.io or Railway for the API; static hosting (Vercel/Cloudflare Pages) for the mobile web app.
- **Secrets**: Backend's secret manager for the master key (AWS KMS, Fly Secrets, etc.).
- **Observability**: OpenTelemetry to a hosted collector (Baselime, Axiom).

## Mobile surface

**Responsive web app**, same backend. Read the archive; edit status manually; view analyses; run Ask/Answer/Letter against already-scraped jobs (BYOK still applies — the mobile web app calls `api.anthropic.com` directly using the ciphertext-decrypted-in-memory key).

Cannot scrape LinkedIn from mobile. That is a permanent limitation, not a v1 shortcut. The extension is and remains the only surface that ingests LinkedIn data.

## LinkedIn ToS posture

The extension does what a person could do manually in their own browser: reads their own logged-in DOM, records what they see, mirrors what they clicked. This is defensible. Before commercializing:

1. Retain counsel with tech-platform / scraping precedent experience for a formal ToS review.
2. Marketing copy must be explicit: **"For your own job search, on your own account, from your own browser, on your own device."**
3. The extension must never work on someone else's account or send scraped data anywhere except that user's own private archive.
4. Consider a "paste-in-only" fallback mode for users who prefer to hand-feed postings — reduces LinkedIn surface area and gives an out if LinkedIn tightens.

## Open decisions (defer until implementation kickoff)

1. **Auth provider** — Supabase Auth vs. Clerk vs. roll-our-own magic-link. Supabase is one less integration if we're already on Supabase Postgres.
2. **Encryption scheme detail** — libsodium sealed boxes vs. AWS KMS envelope encryption. Depends on hosting choice.
3. **Conflict UX** — for the rare same-second edit collision, do we show a diff view or just silently take the latest?
4. **Free tier vs. paid tier** — is there a paid tier, and if so what does it unlock? (Suggested split: free = single-device + local storage; paid = multi-device sync + mobile web app. Same codebase, backend just refuses to persist for free users.)
5. **Data export / account deletion** — GDPR + CCPA require these. Design the API to make full export a single call and full deletion irreversible-with-grace-period.
6. **Session-key handoff** — how the extension gets its per-session decrypted API key after magic-link auth. Simplest: extension holds a long-lived refresh token, exchanges for a short-lived session token that unlocks the KEK server-side per session.

## Migration from local-only

When a local-only user first authenticates:

1. Extension enumerates all `chrome.storage.local` keys.
2. Uploads via `/v1/jobs/upsert`, `/v1/profile/upsert`, `/v1/secrets/put` etc.
3. Sets `lastSyncCursor` from the response.
4. Local storage becomes a cache from that point forward, no longer authoritative.

Users who never sign in continue to work exactly as they do today — local-only, no backend calls, no accounts.
