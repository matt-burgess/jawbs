// How complete the material every analysis reads is: a percent and one
// hint naming the emptiest section. Pure. Idea from Dossier's profile
// strength meter (github.com/AienTech/dossier, AGPL-3.0); reimplemented,
// no code copied.

// weight: share of the score. full: length (characters, or questions)
// at which a section counts as complete.
const SECTIONS = [
  { key: 'profile', weight: 30, full: 1500, hint: 'Write more in your Profile: who you are, what you lead, what you want next. Every analysis starts here.' },
  { key: 'masterResume', weight: 30, full: 3000, hint: 'Add your full master resume. Tailored resumes and the fact check are built from it.' },
  { key: 'knowledgeBase', weight: 15, full: 2000, hint: 'Add a knowledge base: projects, numbers and stories the resume has no room for.' },
  { key: 'writingSamples', weight: 15, full: 1000, hint: 'Paste a few paragraphs you wrote, so letters and replies sound like you.' },
  { key: 'prepQuestions', weight: 10, full: 8, hint: 'List the interview questions you want to practise for prep briefs.' },
];

const size = (v) => (Array.isArray(v) ? v.filter((x) => String(x).trim()).length : String(v || '').trim().length);

// → { percent, hint } (hint null when everything is complete).
export function profileStrength(material = {}) {
  const fills = SECTIONS.map((s) => ({ ...s, fill: Math.min(1, size(material[s.key]) / s.full) }));
  const percent = Math.round(fills.reduce((sum, s) => sum + s.weight * s.fill, 0));
  // Emptiest first; on a tie, the one worth more.
  const weakest = fills.filter((s) => s.fill < 1).sort((a, b) => a.fill - b.fill || b.weight - a.weight)[0];
  return { percent, hint: weakest ? weakest.hint : null, weakest: weakest?.key || null };
}
