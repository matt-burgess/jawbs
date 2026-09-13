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
  archived:               { rank: 10, label: 'Archived',            terminal: true },
  notMovingForward:       { rank: 10, label: 'Not Moving Forward',  terminal: true },
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
// across its JobTracker UI ("In Progress", "Not moving forward", etc.); this
// normalizes whatever the scraper hands us into our canonical vocabulary.
export function normalizeTrackerStage(stage) {
  if (!stage) return 'saved';
  const s = String(stage).toLowerCase().replace(/[\s_-]+/g, '');
  if (s === 'applied') return 'applied';
  if (s === 'saved' || s === 'save') return 'saved';
  if (s === 'archived' || s === 'archive') return 'archived';
  if (s === 'interviewing' || s === 'interview' || s === 'interviews' || s === 'inter') return 'interviewing';
  if (s === 'draft' || s === 'inprogressdraft') return 'inProgressDraft';
  if (s === 'clickedapply' || s === 'inprogressclickedapply' || s === 'clickapply') return 'inProgressClickedApply';
  if (s === 'inprogress' || s === 'progress') return 'inProgressClickedApply'; // best guess when sub-stage is missing
  if (s === 'notmovingforward' || s === 'passed' || s === 'rejected') return 'notMovingForward';
  return 'saved';
}
