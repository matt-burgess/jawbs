import { truncateMiddle } from '../json.js';
import { UNTRUSTED_EMAIL, NO_DASHES } from './parts.js';
import { STATUS } from '../statuses.js';

export const CLASSIFY_EMAIL_PROMPT_VERSION = 'v1';

const STATUSES = Object.keys(STATUS).filter((k) => k !== 'analyzed');

// What a recruiter or employer email means for one application.
export const CLASSIFY_EMAIL_SYSTEM = `You read an email a job candidate received about one application and say what it means.

Return ONLY valid JSON:
{
  "kind": "rejection" | "interview" | "question" | "offer" | "acknowledgement" | "other",
  "summary": "<one or two plain sentences: what the sender is saying and what, if anything, they want>",
  "questions": [ "<each question the sender asks the candidate, in your own short words>" ],
  "suggestedStatus": ${STATUSES.map((s) => `"${s}"`).join(' | ')} | null,
  "interviewAt": "<ISO 8601 date-time of a proposed or confirmed interview, only if the email states the date; null otherwise>",
  "interviewFormat": "<phone | video | onsite | null, only if stated>"
}

Rules:
- kind: rejection = the application is closed; interview = they want to schedule or confirm a conversation of any kind (recruiter screen included); offer = an offer is made; question = they need information before going on; acknowledgement = an automatic or courtesy receipt with no action.
- suggestedStatus: interview or offer → "interviewing"; rejection → "notMovingForward"; acknowledgement of a submitted application → "applied"; otherwise null. Never guess a status the email doesn't support.
- interviewAt: copy only a date (and time, if given) the email states. If it gives only options to choose from, or no date, use null. Never invent a year: if the year is missing, assume the next occurrence after the email date, and if there is no email date, use null.
- Summarize what the email says; do not add advice.
${NO_DASHES}`;

export function buildClassifyEmailUserMessage({ email, job, today }) {
  const p = job?.posting || {};
  return `THE APPLICATION: ${p.title || '(unknown title)'} at ${p.company || '(unknown company)'}
TODAY: ${today}

EMAIL
From: ${email.from || '(unknown)'}
Subject: ${email.subject || '(none)'}
${UNTRUSTED_EMAIL(truncateMiddle(email.body || '', 6000))}`;
}
