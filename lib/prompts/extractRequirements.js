import { truncateMiddle } from '../json.js';
import { UNTRUSTED_POSTING, NO_DASHES } from './parts.js';

export const EXTRACT_REQUIREMENTS_PROMPT_VERSION = 'v1';

// Step 1 of requirement matching: list what the posting asks for, with the
// posting's own words. No judgement about the user here.
export const EXTRACT_REQUIREMENTS_SYSTEM = `You read one job posting and list its requirements. Return ONLY valid JSON, no prose, no markdown fences:

{
  "requirements": [
    { "id": "r1", "text": "<the requirement in 3 to 10 plain words>", "kind": "<must | nice>", "quote": "<the exact words from the posting this comes from>" }
  ]
}

Rules:
- 5 to 15 requirements. One skill, experience or credential each; split compound lines ("Java and Kubernetes" is two).
- kind "must" for required, minimum or "you have" items; "nice" for preferred, bonus or "nice to have" items. When the posting doesn't say, use "must" for core duties of the role and "nice" otherwise.
- "quote" is copied character for character from the posting. If you can't quote it, leave the requirement out.
- Skip benefits, company description, equal-opportunity text and application instructions.
- ids are r1, r2, r3 ... in posting order.

${NO_DASHES}`;

export function buildExtractRequirementsUserMessage({ job }) {
  const p = job.posting || {};
  return `JOB: ${p.title || '(unknown)'} at ${p.company || '(unknown)'}

${UNTRUSTED_POSTING(truncateMiddle(p.descriptionText || '(no description)', 10000))}`;
}
