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
