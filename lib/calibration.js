// How the user's past applications turned out, by fit band — the fit
// score checked against reality. Counts only applications that got an
// answer: an interview, or a close (Scar). Computed here, not by the
// model, so the numbers are exact and nothing is extrapolated.
const BANDS = [['75+', 75, 101], ['55–74', 55, 75], ['under 55', 0, 55]];
const MIN_RESOLVED = 3;

function countBands(jobs) {
  const bands = BANDS.map(([label, lo, hi]) => ({ label, lo, hi, interviews: 0, total: 0 }));
  let resolved = 0;
  for (const j of jobs || []) {
    const score = j.analyses?.fit?.result?.fitScore;
    if (typeof score !== 'number' || !(j.application?.appliedAt || /applied/i.test(JSON.stringify(j.timeline || [])))) continue;
    const interviewed = j.status === 'interviewing' || (j.interviewRounds || []).length > 0;
    const closed = j.status === 'notMovingForward' || j.status === 'archived';
    if (!interviewed && !closed) continue;
    resolved++;
    const band = bands.find((b) => score >= b.lo && score < b.hi);
    band.total++;
    if (interviewed) band.interviews++;
  }
  return { bands, resolved };
}

// One line for a given fit score — "Your past 55–74 fits: 2 of 10 got an
// interview." — or null with too little history or none in that band.
export function trackRecordLine(jobs, score) {
  if (typeof score !== 'number') return null;
  const { bands, resolved } = countBands(jobs);
  if (resolved < MIN_RESOLVED) return null;
  const b = bands.find((x) => score >= x.lo && score < x.hi);
  return b?.total ? `Your past ${b.label} fits: ${b.interviews} of ${b.total} got an interview.` : null;
}
