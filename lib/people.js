// Unified "people" view of a job. Merges the two separate sources the
// content-script scraper produces (warmth = user's own network overlap;
// hiringTeam = LinkedIn-designated poster/recruiters/hiring managers)
// into a single list where each person is one entry with every
// relationship flagged.
//
// Downstream renderers (Jawbar people section, Jawboard column, Recall
// panel) all call derivePeople(job, followMap) instead of reading the
// two raw source arrays. This means adding a new relationship anywhere
// (say, "referral from") only requires updating this file — the render
// layer stays generic.
//
// Person entry shape:
//   {
//     name, profileUrl, headline,
//     degree: 1 | 2 | 3 | null,
//     relationships: {
//       hiringManager: boolean,
//       jobPoster: boolean,
//       recruiter: boolean,
//       interviewer: boolean,
//       teamMember: boolean,
//       companyConnection: boolean,   // 1st-degree at company
//       companyAlumni: boolean,        // shared prior employer
//       schoolAlumni: boolean,
//     },
//     messagable: boolean,
//     following: 'most-relevant' | 'all' | false | null,
//     followingRecommended: boolean,  // is this a high-value follow?
//     priorityScore: number,          // higher = more actionable
//     sources: string[],              // debug: where we found this entry
//   }

const REL_KEYS = [
  'hiringManager', 'jobPoster', 'recruiter', 'interviewer', 'teamMember',
  'companyConnection', 'companyAlumni', 'schoolAlumni',
];

function emptyPerson(name, profileUrl) {
  return {
    name: name || '(unnamed)',
    profileUrl: profileUrl || null,
    headline: null,
    degree: null,
    relationships: Object.fromEntries(REL_KEYS.map((k) => [k, false])),
    messagable: false,
    following: null,
    followingRecommended: false,
    priorityScore: 0,
    sources: [],
  };
}

// Merge one raw source entry into the target map (keyed by profileUrl,
// or by lowercased name when profileUrl is missing). Ensures the same
// human appearing across warmth + hiringTeam becomes one merged entry.
function upsertPerson(map, key, patch) {
  let person = map.get(key);
  if (!person) {
    person = emptyPerson(patch.name, patch.profileUrl);
    map.set(key, person);
  }
  // Preserve richest info: prefer non-null values from the incoming patch.
  if (patch.name && (!person.name || person.name === '(unnamed)')) person.name = patch.name;
  if (patch.profileUrl && !person.profileUrl) person.profileUrl = patch.profileUrl;
  if (patch.headline && !person.headline) person.headline = patch.headline;
  if (patch.degree != null && person.degree == null) person.degree = patch.degree;
  if (patch.messagable) person.messagable = true;
  if (Array.isArray(patch.sources)) for (const s of patch.sources) if (!person.sources.includes(s)) person.sources.push(s);
  else if (patch.source && !person.sources.includes(patch.source)) person.sources.push(patch.source);
  if (patch.relationships) {
    for (const [k, v] of Object.entries(patch.relationships)) {
      if (v) person.relationships[k] = true;
    }
  }
  return person;
}

// Priority scoring — higher = more actionable for the job seeker.
//   Hiring manager               +50   the decision-maker
//   Recruiter                    +30   routes applications
//   Job poster (only role)       +20   the account that submitted
//   Interviewer                  +25
//   Team member                  +10
//   1st-degree at company        +40   direct outreach possible
//   2nd-degree                   +15   warm intro possible
//   Company alumni               +10
//   School alumni                +8
//   Already following            +5    (small bump — you're already tracking)
//   Messagable                   +5
function computePriority(person) {
  const r = person.relationships;
  let s = 0;
  if (r.hiringManager) s += 50;
  else if (r.recruiter) s += 30;
  else if (r.interviewer) s += 25;
  else if (r.jobPoster) s += 20;
  else if (r.teamMember) s += 10;
  if (r.companyConnection || person.degree === 1) s += 40;
  else if (person.degree === 2) s += 15;
  if (r.companyAlumni) s += 10;
  if (r.schoolAlumni) s += 8;
  if (person.following) s += 5;
  if (person.messagable) s += 5;
  return s;
}

// Should this person be recommended as a follow?
// True when they carry decision-maker weight OR are a warm intro path AND
// aren't already followed at the highest tier.
function shouldRecommendFollow(person) {
  if (person.following === 'all') return false; // already max signal
  const r = person.relationships;
  return !!(
    r.hiringManager || r.recruiter || r.interviewer || r.jobPoster ||
    (person.degree === 1 && (r.companyConnection || r.hiringManager || r.recruiter))
  );
}

// Primary export. Takes a job record + optional { followMap } from the
// service worker's peopleFollowing map, returns the unified people list
// sorted by priorityScore descending.
export function derivePeople(job, opts = {}) {
  const followMap = opts.followMap || {};
  const map = new Map();

  const keyOf = (p) => p.profileUrl || `name:${(p.name || '').toLowerCase()}`;

  // ---- Warmth buckets (user's own network overlap) ----
  const detail = job?.warmth?.detail || {};
  for (const c of detail.firstDegree || []) {
    upsertPerson(map, keyOf(c), {
      name: c.name, profileUrl: c.profileUrl, headline: c.headline,
      degree: c.degree ?? 1,
      messagable: !!c.messagable,
      relationships: { companyConnection: true },
      source: 'warmth:firstDegree',
    });
  }
  for (const c of detail.alumniShared || []) {
    upsertPerson(map, keyOf(c), {
      name: c.name, profileUrl: c.profileUrl, headline: c.headline,
      degree: c.degree ?? null,
      relationships: { companyAlumni: true },
      source: 'warmth:alumni',
    });
  }
  for (const c of detail.schoolAlumni || []) {
    upsertPerson(map, keyOf(c), {
      name: c.name, profileUrl: c.profileUrl, headline: c.headline,
      degree: c.degree ?? null,
      relationships: { schoolAlumni: true },
      source: 'warmth:school',
    });
  }

  // ---- Hiring team (LinkedIn-designated people for this posting) ----
  for (const p of job?.hiringTeam || []) {
    const rel = {};
    if (p.role === 'hiring-manager') rel.hiringManager = true;
    if (p.role === 'recruiter') rel.recruiter = true;
    if (p.role === 'interviewer') rel.interviewer = true;
    if (p.role === 'team') rel.teamMember = true;
    if (p.role === 'job-poster') rel.jobPoster = true;
    upsertPerson(map, keyOf(p), {
      name: p.name, profileUrl: p.profileUrl, headline: p.headline,
      relationships: rel,
      sources: (p.sources || []).map((s) => `hiring:${s}`),
    });
  }

  // ---- Apply follow-state + compute derived fields ----
  const people = [];
  for (const person of map.values()) {
    if (person.profileUrl && followMap[person.profileUrl]?.following) {
      person.following = followMap[person.profileUrl].mode || true;
    }
    person.followingRecommended = shouldRecommendFollow(person);
    person.priorityScore = computePriority(person);
    people.push(person);
  }
  people.sort((a, b) => b.priorityScore - a.priorityScore);
  return people;
}

// Human-readable label for the strongest relationship a person has.
// Used for compact display when there's only room for one tag.
export function primaryRelationshipLabel(person) {
  const r = person.relationships;
  if (r.hiringManager) return 'Hiring Mgr';
  if (r.recruiter) return 'Recruiter';
  if (r.interviewer) return 'Interviewer';
  if (r.jobPoster) return 'Poster';
  if (r.teamMember) return 'Team';
  if (person.degree === 1 || r.companyConnection) return '1st at co.';
  if (person.degree === 2) return '2nd at co.';
  if (r.companyAlumni) return 'Alumni';
  if (r.schoolAlumni) return 'School';
  return null;
}

// Compact multi-tag list — the two or three most relevant labels.
export function relationshipTags(person) {
  const tags = [];
  const r = person.relationships;
  if (r.hiringManager) tags.push('Hiring Mgr');
  if (r.recruiter) tags.push('Recruiter');
  if (r.interviewer) tags.push('Interviewer');
  if (r.jobPoster && !r.recruiter && !r.hiringManager) tags.push('Poster');
  if (r.teamMember && !r.hiringManager && !r.recruiter && !r.interviewer) tags.push('Team');
  if (r.companyConnection || person.degree === 1) tags.push('1st');
  else if (person.degree === 2) tags.push('2nd');
  if (r.companyAlumni) tags.push('Alumni');
  if (r.schoolAlumni) tags.push('School');
  return tags;
}

// Tone for the primary relationship badge in UI. Aligned with existing
// jc-badge tones (pos / info / caution / neg / neutral).
export function relationshipTone(person) {
  const r = person.relationships;
  if (r.hiringManager) return 'pos';
  if (r.recruiter || r.interviewer) return 'info';
  if (person.degree === 1 || r.companyConnection) return 'pos';
  if (r.jobPoster) return 'info';
  if (r.companyAlumni || r.schoolAlumni) return 'caution';
  return 'neutral';
}
