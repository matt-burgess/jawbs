import { truncateMiddle } from '../json.js';

export const QUESTION_PROMPT_VERSION = 'v2';

// ----- Question Prep — answers to configured interview questions -----
//
// The user configures a list of questions in Settings → Interview prep.
// Sidebar has no textbox; a single "Bait" button hands the whole list to
// the model, which returns a markdown doc with each question answered
// against his actual profile, resume, and the specific posting.

export const BRIEF_SYSTEM = `You draft interview-prep answers for a Director/VP-level engineering leader. The user has configured a list of questions he expects to be asked — answer each one in his voice, grounded in his actual profile, resume, and the specific posting.

Output plain markdown, in this exact structure:

# Role snapshot
[2-3 sentences: company, level, scope, the one theme he should lead with]

# Answers

## <question 1, verbatim>
[The answer — see rules below.]

## <question 2, verbatim>
[The answer.]

... repeat for every configured question, in the order given.

Rules for each answer:
- Length: 120-250 words. Story questions ("describe a time when…") use STAR (Situation, Task, Action, Result); direct questions ("what is your leadership style?") answer directly. Motivation questions ("why this role / company?") reference specific things from the posting.
- Voice: mirror the writing samples when available. Otherwise plain professional prose with occasional dry wit — never corporate-speak, never "I am passionate about", never "in today's fast-paced".
- Grounding: every specific claim (metric, employer, project, tech) must trace to something in his profile, resume, or writing samples. NEVER invent employers, metrics, dates, or scope numbers.
- Posting-anchored: where the question invites it, reference the specific role / company / description in the answer. Don't write generic answers that would apply to any job.
- If you cannot answer a question honestly from his actual history, replace the answer with a one-line note: "*(No supporting material — add [what's needed] to profile/resume to answer well.)*"

General rules:
- No preamble. Start with the first heading.
- Copy each question verbatim into the H2 heading — don't paraphrase.
- Skip any question that is blank / whitespace-only.
- Keep the whole document scannable — the user copies from it before an interview.`;

export function buildBriefUserMessage({ profile, masterResume, writingSamples, fitResult, prepQuestions, job }) {
  const p = job.posting || {};
  const questions = Array.isArray(prepQuestions) ? prepQuestions.filter((q) => typeof q === 'string' && q.trim()) : [];
  const questionsBlock = questions.length
    ? questions.map((q, i) => `${i + 1}. ${q.trim()}`).join('\n')
    : '(no questions configured — output only the Role snapshot section and note that Settings → Question Prep questions is empty)';

  return `PROFILE:
${profile}

MASTER RESUME:
${masterResume ? truncateMiddle(masterResume, 6000) : '(not uploaded)'}

WRITING SAMPLES (his actual voice — mirror this when drafting):
${writingSamples || '(none — use plain professional prose)'}

FIT ANALYSIS (JSON, for context on where he stands on this posting):
${fitResult ? JSON.stringify(fitResult, null, 2) : '(not yet analyzed)'}

JOB POSTING:
Title: ${p.title || '(unknown)'}
Company: ${p.company || '(unknown)'}
Location: ${p.location || '(unknown)'} | Workplace: ${p.workplaceType || '(unknown)'}
Posted salary: ${p.postedSalaryRange || '(none)'}

Description:
${truncateMiddle(p.descriptionText || '(no description)', 10000)}

QUESTIONS TO ANSWER (in this order):
${questionsBlock}`;
}
