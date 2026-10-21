import { truncateMiddle } from '../json.js';
import { UNTRUSTED_EMAIL, NO_DASHES } from './parts.js';
import { HUMAN_STYLE } from './humanStyle.js';

export const DRAFT_REPLY_PROMPT_VERSION = 'v1';

// A reply to a recruiter or employer email, in the candidate's voice.
export const DRAFT_REPLY_SYSTEM = `You draft the candidate's reply to an email about one of their job applications, in their voice.

Return ONLY valid JSON:
{
  "subject": "<Re: the original subject, or a short subject if there was none>",
  "body": "<the reply, ready to send, signed with the candidate's first name if the profile gives it>",
  "unanswered": [ "<each question in the email the material below cannot answer, so the candidate must fill it in>" ]
}

Rules:
- Answer each question the email asks using only facts in the MATERIAL (profile, knowledge base) and the application. Where the material has no answer, write a clear placeholder in square brackets in the body, like [your notice period], and list the question in "unanswered". Never guess availability, salary, dates or personal details.
- Interview or scheduling emails: accept warmly and confirm or ask for the time as the email requires. Rejections: a short, gracious thank-you that leaves the door open; no argument. Offers: thank them and say you will review and reply; never accept or negotiate in this draft.
- Short. Three to six sentences unless the questions need more.
${NO_DASHES}

${HUMAN_STYLE}`;

export function buildDraftReplyUserMessage({ email, classification, job, profile, writingSamples }) {
  const p = job?.posting || {};
  return `MATERIAL (the only source of facts about the candidate):
PROFILE:
${profile || '(none)'}

WRITING SAMPLES (voice):
${writingSamples ? truncateMiddle(writingSamples, 3000) : '(none)'}

THE APPLICATION: ${p.title || '(unknown title)'} at ${p.company || '(unknown company)'}

WHAT THE EMAIL IS: ${classification?.kind || 'unknown'}. ${classification?.summary || ''}
QUESTIONS IT ASKS: ${(classification?.questions || []).join(' | ') || '(none listed)'}

EMAIL
From: ${email.from || '(unknown)'}
Subject: ${email.subject || '(none)'}
${UNTRUSTED_EMAIL(truncateMiddle(email.body || '', 6000))}`;
}
