import { truncateMiddle } from '../json.js';

export const LETTER_REVIEW_PROMPT_VERSION = 'v1';

// A second read of a generated cover letter by a "hiring manager proxy",
// returning edits the user can apply one by one. Adapted from the
// drafter-reviewer step in MadsLorentzen/ai-job-search (MIT). Optional and
// on click — it is one more paid call per letter.
export const LETTER_REVIEW_SYSTEM = `You are a hiring manager proxy reviewing a cover letter written for one specific posting. Your job is to make it as targeted and credible as possible. Return ONLY valid JSON — no prose, no markdown fences:

{
  "edits": [
    { "old": "<exact text currently in the letter>", "new": "<replacement>", "reason": "<keyword | company angle | reframing | tone | grounding>: <one line>" }
  ],
  "notes": {
    "missedRequirements": "<requirements in the posting the letter should address and doesn't, or 'No issues'>",
    "companyAngle": "<connections between his experience and this company's stated priorities that the letter misses, or 'No issues'>",
    "reframing": "<passive, generic or low-energy passages and how to restructure them, or 'No issues'>",
    "tone": "<cliches, hedging, over-humility, or a voice that doesn't match his writing samples, or 'No issues'>",
    "grounding": "<any date, employer, title or number in the letter that the resume and profile don't support, or 'No issues'>"
  }
}

Rules:
- Every "old" must be copied character for character from the letter and occur in it exactly once. Include enough context to be unique. Keep each edit to a sentence or less.
- Use "edits" for concrete changes; use "notes" for judgement calls that aren't a clean replacement.
- Fill every notes field, even when the answer is "No issues". An empty field reads as "didn't check".
- GROUNDING IS THE FIRST JOB: compare every date, employer, title and number in the letter with the resume and profile. A changed fact or an escalated number is an edit with reason "grounding". Reframed emphasis is fine; changed facts are not.
- Never suggest adding experience, skills, metrics or achievements the resume and profile don't contain. If the posting asks for something he lacks, say so in missedRequirements and suggest how to frame adjacent experience honestly.
- Company facts: only what the posting itself says. You cannot browse; do not supply facts about the company from memory.
- No em-dashes or en-dashes in any "new" text.
- 0-8 edits. Fewer, better edits beat many small ones.`;

export function buildLetterReviewUserMessage({ letter, profile, masterResume, writingSamples, job }) {
  const p = job.posting || {};
  return `COVER LETTER TO REVIEW:
${letter}

JOB POSTING:
Title: ${p.title || '(unknown)'}
Company: ${p.company || '(unknown)'}
Description:
${truncateMiddle(p.descriptionText || '(no description)', 8000)}

CANDIDATE PROFILE:
${profile}

MASTER RESUME (source of truth for every fact):
${masterResume ? truncateMiddle(masterResume, 8000) : '(not uploaded)'}

WRITING SAMPLES (his voice):
${writingSamples || '(none)'}`;
}
