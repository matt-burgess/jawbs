import { truncateMiddle } from '../json.js';

export const ROUND_PROMPT_VERSION = 'v1';

export const ROUND_SYSTEM = `You prepare a Director/VP-level engineering leader for a specific interview round. Return ONLY valid JSON — no prose, no markdown fences:

{
  "openerNote": "<one to two sentences on the specific opening move for this round — what to say/ask in the first two minutes, tied to the round's topic and the interviewer if known>",
  "likelyQuestions": [
    { "question": "<question they will likely ask>", "answerAngle": "<the anchor to lead with and 2-3 sentence draft answer, grounded in his actual experience>" }
  ],
  "questionsToAsk": [
    { "question": "<question he should ask them>", "why": "<what signal it gets>" }
  ],
  "storyBank": [
    { "situation": "<short label>", "anchor": "<which of his positioning anchors this maps to>", "beats": ["<situation>", "<task>", "<action>", "<result>"] }
  ],
  "watchouts": ["<risks specific to this round: what not to volunteer, what could sink it>"],
  "afterCall": "<one sentence: the follow-up move within 24 hours>"
}

Rules:
- Tailor every element to the round's topic. A technical deep-dive round is not the same as an exec conversation.
- If interviewer background is given (LinkedIn URL or notes), tune tone and topic accordingly. If not, be generic but not vague.
- Every specific claim about the candidate's experience must trace to his profile or master resume. Never invent.
- 4-6 likely questions, 3-5 questions to ask back, 2-4 story bank entries.
- Story bank: STAR structure, 1-2 sentences per beat.`;

export function buildRoundUserMessage({ profile, masterResume, fitResult, job, round }) {
  const p = job.posting || {};
  return `PROFILE:
${profile}

MASTER RESUME:
${masterResume ? truncateMiddle(masterResume, 6000) : '(not uploaded)'}

FIT ANALYSIS (already scored — lead anchors and gaps are here):
${fitResult ? JSON.stringify(fitResult, null, 2) : '(not run)'}

JOB:
Title: ${p.title || '(unknown)'}
Company: ${p.company || '(unknown)'}
Description: ${truncateMiddle(p.descriptionText || '(no description)', 6000)}

INTERVIEW ROUND:
Date/time: ${round.date || '(unset)'} ${round.time || ''}
Interviewer: ${round.interviewerName || '(unknown)'}
Interviewer LinkedIn: ${round.interviewerLinkedIn || '(none provided)'}
Round topic: ${round.topic || '(unspecified — assume mixed)'}
His notes: ${round.notes || '(none)'}`;
}
