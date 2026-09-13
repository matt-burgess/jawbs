// First-run placeholder profile. Users overwrite this in Settings → You →
// Profile. Every analysis prompt reads whatever the user has stored, so
// keeping the shipped default GENERIC (no real names, employers, or
// locations) means the repo stays personal-data-free while still giving
// new users a shape to imitate.
export const DEFAULT_PROFILE = `[Replace this with your own profile before running any analysis.]

Two-sentence positioning: what level you're targeting, what geography you can work from, what work modes you accept.

3–4 sentences on your most recent role: company, team size, scope, the outcomes you owned. Concrete metrics if you have them.

3–4 sentences on the prior chapter: what you built or led, and the anchor story that carries into your current search.

Anything else worth naming: side projects, certifications, writing, teaching, unusual credentials.`;

export const DEFAULT_COMP_TARGETS = {
  floor: null,
  target: null,
  walkAway: null,
  currentBenchmark: null,
};

export const DEFAULT_WRITING_SAMPLES = '';
export const DEFAULT_MASTER_RESUME = '';

// Where the user can actually work from. Empty by default — the user
// configures this in Settings → You → Work locations. Fit analysis uses
// the stored list to flag postings labeled "Remote" that actually
// restrict to a region the user doesn't live in.
export const DEFAULT_WORK_LOCATIONS = [];

export const DEFAULT_WORK_PREFERENCES = {
  remote: true,
  hybrid: true,
  onsite: false,
};

// Interview prep questions rendered by the Question Prep card. Users can overwrite
// this list in Settings — the extension reads whatever's stored (which may be
// a longer or shorter list) and asks the model to answer each in order.
export const DEFAULT_PREP_QUESTIONS = [
  'Why are you interested in this role?',
  'Why are you interested in this company?',
  'Describe a time you scaled a team.',
  'Describe a time you led a significant technical modernization.',
  'How do you balance shipping velocity with reliability?',
  'How do you approach hiring senior engineers?',
  'Describe a difficult decision you made as a leader.',
  'What is your leadership style?',
  'How do you handle underperformance?',
  'Where do you want to be in 3-5 years?',
];
