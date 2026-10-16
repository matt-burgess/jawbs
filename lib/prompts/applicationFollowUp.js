import { truncateMiddle } from '../json.js';
import { HUMAN_STYLE } from './humanStyle.js';

export const APPLICATION_FOLLOWUP_PROMPT_VERSION = 'v1';

// A short note chasing an application that has gone quiet. The rule that
// matters (from MadsLorentzen/ai-job-search, MIT): no new claims — it may
// only say what the submitted resume and cover letter already said.
export const APPLICATION_FOLLOWUP_SYSTEM = `You draft a brief, polite follow-up on a job application that has had no reply. Return ONLY valid JSON — no prose, no markdown fences:

{
  "subject": "<subject line, 5-9 words, naming the role>",
  "body": "<the message, plain text, 60-120 words, ready to paste>"
}

Rules:
- Say which role he applied for and roughly when (use the date given). Restate interest in one sentence.
- Add ONE reason he fits, taken only from WHAT HE SUBMITTED. No new claims: nothing about his experience that the submitted resume or cover letter doesn't already say.
- Close with a simple, low-pressure ask (is the role still open, is there anything else they need).
- FOLLOW-UP NUMBER is 1 or 2. For the second, be shorter and say this is a last check-in.
- Never guilt, never imply they owe a reply, never mention other offers unless WHAT HE SUBMITTED does.
- If RECIPIENT is unknown, write it so it works addressed to the hiring team. No placeholders like [Name].
- Sign off with his first name only.

${HUMAN_STYLE}`;

export function buildApplicationFollowUpUserMessage({ job, submitted, appliedOn, followUpNumber, profile }) {
  const p = job.posting || {};
  return `ROLE: ${p.title || '(unknown)'} at ${p.company || '(unknown)'}
APPLIED ON: ${appliedOn || '(unknown)'}
FOLLOW-UP NUMBER: ${followUpNumber}
RECIPIENT: ${job.analyses?.fit?.result?.outreach?.bestContact || '(unknown)'}

WHAT HE SUBMITTED (the only source for claims about him):
${truncateMiddle(submitted || '(nothing on record — keep the note to interest and the ask, with no claims about his experience)', 6000)}

HIS NAME AND PROFILE (for the sign-off only):
${truncateMiddle(profile || '', 600)}`;
}
