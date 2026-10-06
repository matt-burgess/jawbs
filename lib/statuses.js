// Canonical job-status vocabulary, aligned with LinkedIn's own JobTracker
// stages. Internal codes are camelCase; the `label` fields are the strings
// LinkedIn shows the user, so anywhere the UI displays a status it should
// call statusLabel(code) rather than titlecasing the code itself.
//
// Ranks decide who wins in upgradeStatus() when a job receives a new signal
// (Save-click, Apply-click, tracker-sync). Terminal states beat any active
// state because they represent user-authoritative decisions ("this is done").

export const STATUS = {
  // Internal-only fallback for records the user opened / analyzed but never
  // acted on in LinkedIn. Not shown in dropdowns tied to LinkedIn's tracker.
  analyzed:               { rank: 0,  label: 'Analyzed',                    internal: true },
  saved:                  { rank: 1,  label: 'Saved' },
  inProgressDraft:        { rank: 2,  label: 'In Progress - Draft' },
  inProgressClickedApply: { rank: 3,  label: 'In Progress - Clicked Apply' },
  applied:                { rank: 4,  label: 'Applied' },
  interviewing:           { rank: 5,  label: 'Interviewing' },
  // Both terminal states read as "Scar" to the user — LinkedIn's
  // Archived and Not Moving Forward stages are semantically the same
  // ("pursuit closed") so we don't burden the user with the distinction.
  // Internal codes stay separate to preserve LinkedIn sync fidelity.
  archived:               { rank: 10, label: 'Scar',                terminal: true },
  notMovingForward:       { rank: 10, label: 'Scar',                terminal: true },
};

// Legacy → new mapping. Applied on read so existing archive records display
// correctly without a one-time data migration. Add here whenever we retire
// or rename a status code so old records keep rendering.
const LEGACY_MAP = {
  screening: 'interviewing',
  offer: 'interviewing',   // LinkedIn keeps offer under Interviewing; we do too.
  closed: 'notMovingForward',
  passed: 'notMovingForward',
};

export function normalizeStatus(s) {
  if (!s) return 'analyzed';
  if (LEGACY_MAP[s]) return LEGACY_MAP[s];
  return (s in STATUS) ? s : 'analyzed';
}

export function statusLabel(s) {
  const n = normalizeStatus(s);
  return STATUS[n]?.label || n;
}

export function statusRank(s) {
  const n = normalizeStatus(s);
  return STATUS[n]?.rank ?? 0;
}


// Terminal states always win. Otherwise, higher rank wins.
export function upgradeStatus(oldStatus, candidate) {
  const oldN = normalizeStatus(oldStatus);
  const candN = normalizeStatus(candidate);
  if (STATUS[candN]?.terminal) return candN;
  if (STATUS[oldN]?.terminal) return oldN;
  return statusRank(candN) > statusRank(oldN) ? candN : oldN;
}

// Ordered list for UI dropdowns and archive sort ordering. `analyzed` is
// listed first (dropdown default) but internal — callers can filter it out.
export const STATUS_ORDER = [
  'analyzed',
  'saved',
  'inProgressDraft',
  'inProgressClickedApply',
  'applied',
  'interviewing',
  'archived',
  'notMovingForward',
];

// Tracker-page → internal-code mapping. LinkedIn uses various spellings
// across its JobTracker UI ("In Progress", "Not moving forward", etc.) and
// URL params (`stage=clicked_apply`, `cardType=IN_PROGRESS`); this
// normalizes whatever the scraper hands us into our canonical vocabulary.
// Returns null for anything unrecognized — callers must skip, not guess.
export function normalizeTrackerStage(stage) {
  if (!stage) return null;
  const s = String(stage).toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'applied') return 'applied';
  if (s === 'saved' || s === 'save') return 'saved';
  if (s === 'archived' || s === 'archive') return 'archived';
  if (s === 'interviewing' || s === 'interview' || s === 'interviews' || s === 'inter') return 'interviewing';
  if (s === 'draft' || s === 'inprogressdraft') return 'inProgressDraft';
  if (s === 'clickedapply' || s === 'inprogressclickedapply' || s === 'clickapply') return 'inProgressClickedApply';
  if (s === 'inprogress' || s === 'progress') return 'inProgressClickedApply'; // best guess when sub-stage is missing
  if (s === 'notmovingforward' || s === 'passed' || s === 'rejected') return 'notMovingForward';
  return null;
}

// LinkedIn's tracker has one "In Progress" tab for both of our in-progress
// codes; every other status is its own tab. `analyzed` isn't on LinkedIn.
export function stageOf(status) {
  const n = normalizeStatus(status);
  if (n === 'analyzed') return null;
  return n.startsWith('inProgress') ? 'inProgress' : n;
}

// The single place a LinkedIn signal becomes a status. Pure.
//
//   record: existing job record or null. Reads status, linkedInStage (the
//           tracker tab we last saw the job in) and manualLock (status was
//           last set inside Jawbs).
//   signal: { kind, explicit, status }
//     kind      'save' | 'unsave' | 'apply-clicked' | 'apply-confirmed' | 'tracker'
//     explicit  true = the user just did this; false = state seen on the page
//     status    'tracker' only — canonical status of the tab/target stage
//
// Explicit actions are honored exactly, including out of a terminal state.
// Observed state only fills in what we're missing — except the tracker,
// which is LinkedIn's own record and wins in both directions. Two
// carve-outs keep that from trampling the user: the first time we see a
// job on the tracker we never demote (pre-existing records have no
// provenance), and a status set in Jawbs sticks until the job moves to a
// different tab on LinkedIn.
export function resolveTransition(record, signal) {
  const cur = normalizeStatus(record?.status);
  const terminal = !!STATUS[cur].terminal;
  const rank = STATUS[cur].rank;
  const out = { status: cur, linkedInStage: record?.linkedInStage, manualLock: !!record?.manualLock };
  const set = (status) => { out.status = status; out.manualLock = false; };
  const { kind, explicit } = signal;

  if (kind === 'save') {
    if (explicit ? (terminal || rank < STATUS.saved.rank) : cur === 'analyzed') set('saved');
  } else if (kind === 'unsave') {
    if (cur === 'saved') set('analyzed');
  } else if (kind === 'apply-clicked') {
    if (terminal || rank < STATUS.inProgressClickedApply.rank) set('inProgressClickedApply');
  } else if (kind === 'apply-confirmed') {
    // An archived job that was applied to still shows "Applied" on its
    // page, so only an explicit confirmation may leave a terminal state.
    if (explicit ? cur !== 'interviewing' : (!terminal && rank < STATUS.applied.rank)) set('applied');
  } else if (kind === 'tracker') {
    const target = normalizeStatus(signal.status);
    const stage = stageOf(target);
    const prev = out.linkedInStage;
    out.linkedInStage = stage;
    if (stageOf(cur) === stage) {
      if (prev !== stage) out.manualLock = false;
    } else if (explicit) {
      set(target);
    } else if (prev === undefined) {
      if (!out.manualLock && upgradeStatus(cur, target) === target) set(target);
    } else if (prev !== stage || !out.manualLock) {
      set(target);
    }
  }
  return out;
}
