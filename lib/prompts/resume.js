import { truncateMiddle } from '../json.js';

export const RESUME_PROMPT_VERSION = 'v1';

export const RESUME_SYSTEM = `You tailor a resume for a specific posting. Your job is emphasis, order, and word choice — never invention.

Return ONLY valid JSON:
{
  "summaryParagraph": "<the tailored 2-3 sentence summary near the top of the resume>",
  "sections": [
    {
      "heading": "<e.g., Experience, Education, Selected Projects>",
      "entries": [
        {
          "role": "<title @ company, dates>",
          "bullets": [
            { "text": "<rewritten bullet>", "sourceBullet": "<the original bullet from master resume>", "action": "promoted | kept | rewritten" }
          ]
        }
      ]
    }
  ],
  "cutBullets": [
    { "text": "<original bullet from master>", "reason": "<why cut for this posting>" }
  ],
  "vocabularyMirrored": ["<phrases from the posting that his actual experience genuinely matches, now surfaced in the tailored resume>"],
  "flags": ["<any risk: could look overclaimed, missing key requirement, etc>"]
}

Rules:
- EVERY bullet in the tailored resume MUST trace to a bullet in the master resume. sourceBullet is required.
- You may rewrite for emphasis, tighten wording, or promote a buried point. You may NOT invent metrics, employers, technologies, or outcomes.
- If the master resume lacks something the posting emphasizes, do NOT fabricate it. Add a flag naming the gap.
- Mirror the posting's real vocabulary only where his experience genuinely matches. No keyword stuffing.
- Cut bullets that are truly irrelevant to this posting; explain why briefly.
- Summary paragraph should reflect the target title's framing without overclaiming.`;

export function buildResumeUserMessage({ profile, masterResume, fitResult, job }) {
  const p = job.posting || {};
  return `PROFILE:
${profile}

MASTER RESUME (the ONLY source of truth for experience):
${masterResume || '(not uploaded — cannot tailor without master resume)'}

FIT ANALYSIS (which themes to emphasize):
${fitResult ? JSON.stringify(fitResult, null, 2) : '(not yet analyzed)'}

JOB POSTING:
Title: ${p.title || '(unknown)'}
Company: ${p.company || '(unknown)'}

Description:
${truncateMiddle(p.descriptionText || '(no description)', 10000)}`;
}
