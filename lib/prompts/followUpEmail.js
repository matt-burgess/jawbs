import { truncateMiddle } from '../json.js';

export const FOLLOWUP_PROMPT_VERSION = 'v1';

// Draft a post-interview follow-up email tied to a specific round.
// The whole point is to use the notes the candidate captured DURING
// the interview (topics discussed, questions asked, specific commitments,
// personal details worth referencing) so the email reads authentic and
// specific — not a generic template.
export const FOLLOWUP_SYSTEM = `You draft a post-interview follow-up email for a Director/VP-level engineering leader. Return ONLY valid JSON — no prose, no markdown fences:

{
  "subject": "<subject line, 6-10 words, specific to the conversation and role>",
  "body": "<the full email body — plain text, 120-200 words, ready to paste into email>"
}

Rules for the body:
- Open with a specific, warm thank-you tied to something concrete from the notes — a topic discussed, a shared point of view, a question the interviewer asked. Never generic "thanks for your time."
- Reference 1-2 SPECIFIC things from the notes: a technical challenge the interviewer mentioned, a person they named, a value they emphasized, a decision they're wrestling with. This is what makes the email real.
- Reinforce ONE relevant strength from the candidate's profile that maps to what the interviewer prioritized. Do not enumerate — one clean tie-back.
- If the notes mention any commitment (send follow-up material, connect them with someone, answer a lingering question), promise it explicitly.
- Close with a forward-looking line: interest in next steps, or a specific offer (share more on X topic, send a doc, etc.). No emoji, no excessive enthusiasm.
- Tone: warm, professional, senior-peer level — not fawning, not corporate boilerplate.
- Sign off with the candidate's first name only (derive from profile). No signature block.
- Do NOT invent any details not present in the notes, profile, or resume. If notes are thin, keep the email honest and brief.
- Do NOT include a placeholder like "[Name]" or "[Company]" — use the real values from context.`;

export function buildFollowUpUserMessage({ profile, masterResume, fitResult, job, round }) {
  const p = job.posting || {};
  return `CANDIDATE PROFILE:
${profile}

MASTER RESUME:
${masterResume ? truncateMiddle(masterResume, 4000) : '(not uploaded)'}

FIT ANALYSIS (already scored — lead anchors and gaps are here):
${fitResult ? JSON.stringify(fitResult, null, 2) : '(not run)'}

JOB:
Title: ${p.title || '(unknown)'}
Company: ${p.company || '(unknown)'}
Description: ${truncateMiddle(p.descriptionText || '(no description)', 4000)}

INTERVIEW ROUND (the one this follow-up is for):
Date/time: ${round.date || '(unset)'} ${round.time || ''}
Interviewer name: ${round.interviewerName || '(unknown)'}
Interviewer LinkedIn: ${round.interviewerLinkedIn || '(none)'}
Round type: ${round.type || '(unspecified)'}
Round topic: ${round.topic || '(unspecified)'}

NOTES FROM THE INTERVIEW (this is the primary source material — every specific reference in the email should come from here):
${round.notes || '(no notes captured — draft a brief, honest follow-up without specific references)'}`;
}
