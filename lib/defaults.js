// First-run profile default is intentionally empty. Users draft their
// own via the setup wizard's "Draft in Claude/ChatGPT/Gemini" flow.
// Any analysis prompt that reads the stored profile handles the empty
// case as "no profile provided yet."
export const DEFAULT_PROFILE = '';

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
  'Why are you leaving your current role / why did you leave your last role?',
  'What are you looking for in your next opportunity?',
  'Describe the project you are most proud of.',
  'Walk me through your background in 2-3 minutes.',
  'Describe a difficult decision you made.',
  'Tell me about a time you disagreed with your boss or a peer executive. How did you handle it?',
  'Describe a time you had to deliver bad news to stakeholders or leadership.',
  'How would your peers describe working with you?',
  'How do you approach planning and prioritization?',
  'Tell me about a time you influenced a decision without direct authority.',
  'How are you thinking about AI\'s impact?',
  'Where do you want to be in 3-5 years?',
  'What questions do you have for us?',
];
