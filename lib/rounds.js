// Defaults for a new interview round, shared by Recall's Add round and
// the round an interview email adds. The first round is the recruiter
// screen, and so on; everything past slot 5 defaults to Final.
const ROUND_TYPE_DEFAULTS = [
  'Recruiter',      // 1st
  'Hiring Manager', // 2nd
  'Technical',      // 3rd
  'Panel',          // 4th
  'Final',          // 5th+
];
export function defaultRoundType(existingCount) {
  return ROUND_TYPE_DEFAULTS[Math.min(existingCount, ROUND_TYPE_DEFAULTS.length - 1)];
}

export function defaultTopicFor(type) {
  return /^recruiter$/i.test(String(type).trim()) ? 'Initial Fit' : '';
}
