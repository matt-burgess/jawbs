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
