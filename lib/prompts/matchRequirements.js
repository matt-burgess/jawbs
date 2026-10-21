import { truncateMiddle } from '../json.js';
import { NO_DASHES } from './parts.js';

export const MATCH_REQUIREMENTS_PROMPT_VERSION = 'v1';

// Step 2 of requirement matching: for each requirement, point at the
// user's own material that shows it. Code (lib/requirementMatch.js) then
// checks the quotes exist and decides covered / partial / gap, so the
// model's job is only to find, never to judge or invent.
export const MATCH_REQUIREMENTS_SYSTEM = `You match job requirements to a candidate's own material. Return ONLY valid JSON, no prose, no markdown fences:

{
  "matches": [
    { "requirementId": "r1", "evidence": [ { "source": "<resume | profile | knowledge>", "text": "<exact excerpt>" } ], "confidence": "<high | medium | low | none>" }
  ]
}

Rules:
- One entry per requirement, using its id.
- "text" is copied character for character from RESUME, PROFILE or KNOWLEDGE BASE below, 4 to 25 words. Do not paraphrase, summarise, correct or combine. Any text that does not appear verbatim is thrown away.
- You may not invent evidence. If nothing in the material shows the requirement, return an empty evidence array and confidence "none".
- confidence: "high" when the excerpt shows the requirement directly; "medium" when it shows something close or partial (a related tool, a smaller scale, an adjacent domain); "low" when it is only a weak hint.
- At most 2 excerpts per requirement; pick the strongest.

${NO_DASHES}`;

export function buildMatchRequirementsUserMessage({ requirements, profile, masterResume, knowledgeBase }) {
  return `REQUIREMENTS:
${requirements.map((r) => `${r.id} [${r.kind}] ${r.text}`).join('\n')}

RESUME:
${masterResume ? truncateMiddle(masterResume, 8000) : '(not uploaded)'}

PROFILE:
${profile ? truncateMiddle(profile, 3000) : '(empty)'}

KNOWLEDGE BASE:
${knowledgeBase ? truncateMiddle(knowledgeBase, 4000) : '(empty)'}`;
}
