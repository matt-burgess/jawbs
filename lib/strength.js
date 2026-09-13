// Strength Score — composite "worth pursuing?" ranking that combines:
//   1. Fit         (LLM-generated 0–100 match score)  — 50% weight
//   2. Compensation (posting vs user's floor/target)  — 30% weight
//   3. Connections  (best actionable person at co.)   — 20% weight
//
// The output is a 0–100 score plus one of six shark tiers, ordered
// strongest → weakest:
//
//   Great White (85–100) — apex; top-priority target
//   Tiger       (70– 84) — voracious; pursue aggressively
//   Bull        (55– 69) — aggressive; solid opportunity
//   Mako        (40– 54) — fast; worth exploring
//   Nurse       (25– 39) — slow; marginal fit
//   Pygmy       ( 0– 24) — smallest; deprioritize
//
// Design notes:
//   * Fit dominates because it's the LLM's holistic read against the
//     user's profile — it's already a synthesis of everything the LLM
//     could see about role scope, level, remote authenticity, red flags.
//   * Comp is bumped to 30% (from 25%) because a posting the user
//     genuinely can't afford should out-weight a moderately-strong tie.
//   * Connections drops to 20% (from 25%) — still meaningful, but not
//     the tiebreaker the previous weighting made it into. Renamed from
//     "network" so the term is unambiguous in tooltips and the Jawbar
//     strength card.
//   * Missing signals score neutral (half-credit) rather than zero so
//     an early-stage jawb without full analysis doesn't get penalized
//     more than a fully-analyzed jawb with mediocre numbers.
//   * The breakdown is returned alongside the score so UIs can show
//     "why" — 82 · fit 42/50 · comp 24/30 · connections 16/20.
import { derivePeople } from './people.js';

// Ordered strongest → weakest. Each tier's `min` is inclusive.
// `image` is a path relative to the extension root — callers on pages
// nested one level deep (archive/, recall/, sidepanel/) need to
// prefix with '../' or use chrome.runtime.getURL().
export const STRENGTH_TIERS = [
  { min: 85, key: 'great-white', label: 'Great White', image: 'assets/shark-great-white.png', description: 'Apex — top-priority target' },
  { min: 70, key: 'tiger',       label: 'Tiger',       image: 'assets/shark-tiger.png',       description: 'Voracious — pursue aggressively' },
  { min: 55, key: 'bull',        label: 'Bull',        image: 'assets/shark-bull.png',        description: 'Aggressive — solid opportunity' },
  { min: 40, key: 'mako',        label: 'Mako',        image: 'assets/shark-mako.png',        description: 'Fast — worth exploring' },
  { min: 25, key: 'nurse',       label: 'Nurse',       image: 'assets/shark-nurse.png',       description: 'Slow — marginal fit' },
  { min:  0, key: 'pygmy',       label: 'Pygmy',       image: 'assets/shark-pygmy.png',       description: 'Weakest — deprioritize' },
];

export function tierForScore(score) {
  const n = Number.isFinite(score) ? score : 0;
  return STRENGTH_TIERS.find((t) => n >= t.min) || STRENGTH_TIERS[STRENGTH_TIERS.length - 1];
}

// Computes the strength score for a job. Callers pass optional
// context so we don't re-fetch storage in tight loops (Jawboard grid
// renders one row per jawb):
//   opts.compTargets — the user's { floor, target } from settings
//   opts.followMap   — profileUrl → { following, mode } (LinkedIn follow state)
export function computeStrengthScore(job, opts = {}) {
  const fit = job?.analyses?.fit?.result;
  const comp = job?.analyses?.comp?.result;
  const compTargets = opts.compTargets || null;

  const fitComponent = scoreFitComponent(fit);
  const compComponent = scoreCompComponent(comp, compTargets);
  const connectionsComponent = scoreConnectionsComponent(job, opts.followMap || {});

  const total = Math.round(fitComponent.score + compComponent.score + connectionsComponent.score);
  const tier = tierForScore(total);

  return {
    score: total,
    tier: tier.key,
    tierLabel: tier.label,
    tierDescription: tier.description,
    tierImage: tier.image,
    breakdown: {
      fit: fitComponent,
      comp: compComponent,
      connections: connectionsComponent,
      // Back-compat alias — some read sites still expect `network`.
      // Points at the same object so a rename can be phased in.
      network: connectionsComponent,
    },
  };
}

// -------- Component scorers --------

// Fit — the LLM's holistic 0-100 match. Direct multiply by 0.5 to hit
// the 50-point cap. Missing fit reads as 0 because Strength is meant
// to help the user rank; an un-analyzed jawb genuinely has less
// signal than an analyzed one, and offering credit for "we don't
// know" would inflate every fresh capture into a decent-looking pill.
function scoreFitComponent(fit) {
  if (!fit || typeof fit.fitScore !== 'number') {
    return { score: 0, max: 50, note: 'No fit analysis yet' };
  }
  const raw = Math.max(0, Math.min(100, fit.fitScore));
  return { score: raw * 0.5, max: 50, note: `${raw}/100 fit` };
}

// Compensation — how the posting stacks up against the user's floor
// and target from settings. Cap is 30 (was 25) per the rebalanced
// weights. Missing comp analysis reads as neutral half-credit rather
// than 0 — comp is a "nice-to-have" signal that shouldn't tank the
// score just because it hasn't run yet.
function scoreCompComponent(comp, targets) {
  if (!comp) return { score: 15, max: 30, note: 'No comp analysis yet' };
  const vsTarget = comp?.vsTargets?.vsTarget;
  const vsFloor = comp?.vsTargets?.vsFloor;
  const confidence = comp?.salary?.confidence || 'medium';

  // Only compare against targets that the user actually set.
  const hasTargets = !!(targets && (targets.target != null || targets.floor != null));

  let raw;
  let note;
  if (!hasTargets) {
    raw = 15;
    note = 'Comp targets not set';
  } else if (vsTarget === 'above') {
    raw = 30; note = 'Above target';
  } else if (vsTarget === 'at') {
    raw = 26; note = 'At target';
  } else if (vsFloor === 'above') {
    raw = 22; note = 'Above floor';
  } else if (vsFloor === 'at') {
    raw = 15; note = 'At floor';
  } else if (vsFloor === 'below' || vsTarget === 'below') {
    raw = 4; note = 'Below floor';
  } else {
    raw = 15; note = 'Comp comparison unknown';
  }
  // Downgrade for low confidence — a "title-benchmark" number is less
  // trustworthy than the posted range verbatim.
  const confidenceMult = confidence === 'low' ? 0.6 : 1;
  const finalScore = raw * confidenceMult;
  if (confidenceMult < 1) note += ` (low confidence)`;
  return { score: finalScore, max: 30, note };
}

// Connections — how well-connected the user is to the company. Uses
// derivePeople's priorityScore for the strongest person — that
// already blends degree × role weight, so we just normalize the top
// score to our 20-point cap (dropped from 25 per the rebalanced
// weights; comp took the 5 points).
//
// derivePeople scoring reminder (see lib/people.js):
//   +50 hiring manager, +30 recruiter, +25 interviewer, +20 poster,
//   +10 team member; +40 1st-degree at company, +15 2nd-degree, +10
//   company alumni, +8 school alumni; +5 following/messagable.
// A 1st-degree recruiter at the company reads ~75; a 2nd-degree
// alumni reads ~15. We map those to the 20-point cap below.
function scoreConnectionsComponent(job, followMap) {
  const people = derivePeople(job, { followMap });
  if (!people.length) {
    return { score: 0, max: 20, note: 'No connections signal' };
  }
  const top = people[0];
  const p = top.priorityScore || 0;
  let raw;
  let note;
  if (p >= 70) { raw = 20; note = `Strong tie: ${top.name}`; }
  else if (p >= 45) { raw = 16; note = `Good tie: ${top.name}`; }
  else if (p >= 25) { raw = 12; note = `Some tie: ${top.name}`; }
  else if (p >= 10) { raw = 6;  note = `Weak tie: ${top.name}`; }
  else if (p > 0)   { raw = 2;  note = `Distant tie`; }
  else              { raw = 0;  note = 'No actionable people'; }

  // Bonus for depth — if 3+ people carry actionable relationships
  // (hiring team OR 1st-degree at company), bump one tier. This
  // captures "the whole team is in your network" which is a
  // materially stronger signal than one strong tie.
  const actionable = people.filter((pn) => {
    const r = pn.relationships;
    return r.hiringManager || r.recruiter || r.interviewer || r.jobPoster || r.teamMember
      || pn.degree === 1 || r.companyConnection;
  }).length;
  if (actionable >= 3 && raw < 20) {
    raw = Math.min(20, raw + 2);
    note += ` (+${actionable - 1} more actionable)`;
  }
  return { score: raw, max: 20, note };
}
