# Decisions

Short, dated notes on product and data-model calls made while building, in
the spirit of `sync-architecture.md`. Newest last.

## 2026-10-21 · Undo and furthest stage live in `mergeJobRecord`

**Decided:** the "before" values an Undo needs (`previousStatus`,
`previousLinkedInStage`, `previousManualLock`) and `job.furthestStage` are
written in `lib/store.js#mergeJobRecord`, not in `resolveTransition`.

**Why:** status changes come from eight places (LinkedIn signals, passive
tracker sightings, full sync, reconcile, manual changes, round auto-promote,
the 60-day close-out, undo itself). `resolveTransition` only sees the
LinkedIn ones. `mergeJobRecord` sees every write, so one rule covers all of
them and nothing can change status without leaving an undoable record.
`resolveTransition` stays a pure status decision. `lib/statuses.js` holds the
two pure rules (`furthestStageAfter`, `undoTarget`), tested.

**Scope:** Undo is one step: the newest status change, no redo. Older
timeline entries written before this change have no "before" values and are
not undoable.

## 2026-10-21 · Documents are units; the analysis record mirrors them

**Decided:** `job.documents.{resume,letter}` hold the units and up to 25
versions (`lib/documentUnits.js`, `lib/documentHistory.js`). Every change is
saved through one function in the service worker (`saveDocument`), which
also writes the joined document back into `analyses.{resume,coverLetter}.result`
and recomputes the resume keyword check.

**Why:** Copy, PDF (`print/`), the keyword check, the hiring-manager review,
application follow-ups and the Recall readout all read `analyses.*.result`.
Mirroring keeps every one of them correct, and removed units out of what
gets sent, without teaching each about units. The cost is that the same text
is stored twice per job, which `unlimitedStorage` absorbs.

**Resume prompt unchanged:** the plan asked for both prompts to return units.
The resume prompt already returns its parts as structured JSON (headline,
summary, skills, roles with bullets, education), so `unitsFromResume` maps it
to units in code and the prompt stays at v6. The letter prompt moved to v5
(paragraphs as units), with prose split on blank lines as the fallback
(`units-fallback` in the Activity log).

**Migration:** on read. `docFromJob` builds units from an older analysis
(string letter, v1 or v2 resume) as version 1, cause `written`, carrying any
fact-guard flags onto the unit that contains the flagged sentence. Nothing is
written until the first change.

**Not editable in place:** role and education units carry structured fields
the PDF lays out, so they can be removed or put back but not reworded.

## 2026-10-21 · Pasted emails move status forward only

**Decided:** a status suggested by a pasted email goes through
`resolveTransition` as a new `email` signal, applied only when the user
clicks "Move to ...". It moves a jawb forward or closes it on a rejection,
never demotes, and reopens a closed jawb only if the user did not close it
by hand (`manualLock`). The result is locked like any status set in Jawbs.

**Why:** emails arrive out of order and get pasted late; an old
acknowledgement pasted after an interview invite must not knock the jawb
back to Applied. A deliberate close by the user outranks an employer email.

**Matching** is code, not a model: sender domain against domains the jawb
has shown (apply links, careers site), then the domain named like the
company, then the company name in the sender or subject, then the title in
the opening. Freemail and shared ATS domains (Greenhouse, Lever, Workday and
the like) never match by domain. This replaced the unused `inbound-match`
handler and `lib/search.js#matchInbound`.

## 2026-10-21 · Opt-in usage ping: deferred

**Decided:** not built. The Dossier-inspired batch proposed an opt-in,
anonymous usage ping; Jawbs has no server to receive one, and every byte it
sends today goes to a provider the user chose or to freehire.me.

**Follow-up:** revisit alongside `sync-architecture.md`. If a sync backend is
built, a ping can ride the same endpoint, opt-in and off by default, with the
exact payload shown in Settings before it is turned on.

## 2026-10-21 · Letter tone presets and the sign-off

**Decided:** Warm, Direct and Formal are named presets (`lib/tones.js`), each
a voice note in the prompt and a sign-off line. The sign-off is added by code
as the letter's last unit, with the name from Settings → Resume header, not
written by the model. The tone is kept per jawb (`job.letterTone`, set when
picked or generated) with a default in Settings → You → Documents.

**Why code, not model, for the sign-off:** it is fixed text per preset, so a
model call could only get it wrong, and the user's name is the one fact that
must never vary.
