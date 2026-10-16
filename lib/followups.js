// Which submitted applications have gone quiet. Defaults follow standard
// practice as written up in MadsLorentzen/ai-job-search (MIT): a polite
// follow-up after about 10 days, at most two; after 60 days of silence,
// offer to close it out.
export const FOLLOW_UP_AFTER_DAYS = 10;
export const MAX_FOLLOW_UPS = 2;
export const STALE_AFTER_DAYS = 60;

const DAY = 86_400_000;

// { daysQuiet, followUps, lastAt } for a job waiting to hear back, or
// null when it isn't. Waiting = status Applied. Anything dated on the
// timeline counts as contact: a logged email, a follow-up, a status move.
export function quietness(job, now = Date.now()) {
  if (job?.status !== 'applied') return null;
  const times = [job.application?.appliedAt, job.statusUpdatedAt, ...(job.timeline || []).map((e) => e.at)]
    .map((t) => Date.parse(t || '')).filter(Number.isFinite);
  if (!times.length) return null;
  const lastAt = Math.max(...times);
  return {
    daysQuiet: Math.floor((now - lastAt) / DAY),
    followUps: (job.timeline || []).filter((e) => e.type === 'followup').length,
    lastAt: new Date(lastAt).toISOString(),
  };
}

export const followUpDue = (q) => !!q && q.daysQuiet >= FOLLOW_UP_AFTER_DAYS && q.followUps < MAX_FOLLOW_UPS;
export const isStale = (q) => !!q && q.daysQuiet >= STALE_AFTER_DAYS;
