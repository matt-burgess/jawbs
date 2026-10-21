// Named steps for the analyses that make more than one AI call, so the
// Jawbar can show a checklist instead of a bare spinner. The service
// worker reports the step it is starting; stepList turns that into
// done / active / todo. Idea from Dossier's application steps
// (github.com/AienTech/dossier, AGPL-3.0); reimplemented, no code copied.

const REQUIREMENTS = [
  { id: 'extract', label: "Listing the posting's requirements" },
  { id: 'match', label: 'Comparing each one with your material' },
];
const FACTS = [
  { id: 'check', label: 'Checking every fact against your material' },
  // Only with Settings → AI → Strict facts, and only when a fact slipped through.
  { id: 'retry', label: 'Rewriting without the unsupported facts', optional: true },
];

export const FLOW_STEPS = {
  'analyze-fit': [{ id: 'fit', label: 'Scoring the fit against your profile' }, ...REQUIREMENTS],
  'analyze-requirements': REQUIREMENTS,
  'generate-letter': [{ id: 'write', label: 'Writing the letter' }, ...FACTS],
  'generate-resume': [{ id: 'write', label: 'Tailoring your resume' }, ...FACTS],
};

// → [{ id, label, state: 'done' | 'active' | 'todo' }], or null for a flow
// without steps. Optional steps show only once reached.
export function stepList(flow, stepId) {
  const steps = FLOW_STEPS[flow];
  if (!steps) return null;
  const at = steps.findIndex((s) => s.id === stepId);
  return steps
    .map((s, i) => ({ id: s.id, label: s.label, state: at < 0 ? (i === 0 ? 'active' : 'todo') : i < at ? 'done' : i === at ? 'active' : 'todo', optional: s.optional }))
    .filter((s) => !s.optional || s.state !== 'todo')
    .map(({ optional, ...s }) => s);
}
