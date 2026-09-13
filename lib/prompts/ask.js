import { truncateMiddle } from '../json.js';

export const ASK_PROMPT_VERSION = 'v1';

// Freeform "ask the model about this job" system prompt.
// Output: plain markdown text (NOT JSON). This is the escape hatch for
// anything the structured analyses (Fit / Comp / Brief / Answer) don't cover
// — negotiation strategy, gap coaching, questions to ask the recruiter, etc.
export const ASK_SYSTEM = `You are a career-search sounding board for the user (typically a senior engineering leader). They ask you questions about a specific job posting they are considering.

You have full context on:
- Their profile and background
- Their master resume
- Their writing samples (their actual voice)
- The specific job posting
- Any prior analyses they have already run on this job (fit / comp / brief)

Rules:
- Answer their question directly and conversationally. Plain markdown, no JSON.
- Ground specifics in their actual profile/resume/samples. NEVER invent employers, titles, dates, metrics, or experience they don't have.
- If a question requires facts you don't have (e.g. "what did I earn at X?"), say so plainly and ask them to add it to their profile.
- Match their voice from the writing samples where the question calls for drafted prose. For strategy/coaching answers, use plain professional prose.
- No corporate speak. No "I am passionate about". No "in today's fast-paced".
- Prefer short structured answers (bulleted lists, small tables) over long paragraphs when the question is factual or comparative.
- If the question is ambiguous, answer the most likely interpretation and note the alternative in one line.`;

export function buildAskUserMessage({ profile, masterResume, writingSamples, job, priorAnalyses, prompt }) {
  const p = job.posting || {};
  // Prior analyses are summarized compactly — the point is context, not
  // dumping every past JSON blob into the prompt (that would bloat tokens).
  const priors = [];
  if (priorAnalyses?.fit?.result) {
    const f = priorAnalyses.fit.result;
    const bits = [`FIT score=${f.fitScore ?? '?'} verdict=${f.verdict?.recommendation ?? '?'}`];
    if (f.alignments?.length) bits.push(`alignments: ${f.alignments.slice(0, 4).join('; ')}`);
    if (f.gaps?.length) bits.push(`gaps: ${f.gaps.slice(0, 4).join('; ')}`);
    priors.push(bits.join(' · '));
  }
  if (priorAnalyses?.comp?.result) {
    const c = priorAnalyses.comp.result;
    priors.push(`COMP: ${JSON.stringify(c).slice(0, 400)}`);
  }
  if (priorAnalyses?.brief?.brief) {
    priors.push(`PREP BRIEF (excerpt):\n${priorAnalyses.brief.brief.slice(0, 600)}`);
  }

  return `PROFILE:
${profile}

MASTER RESUME:
${masterResume ? truncateMiddle(masterResume, 6000) : '(not uploaded)'}

WRITING SAMPLES (his actual voice):
${writingSamples || '(none — use plain professional prose)'}

JOB POSTING:
Title: ${p.title || '(unknown)'} at ${p.company || '(unknown)'}
Location: ${p.location || '(unknown)'} | Workplace: ${p.workplaceType || '(unknown)'}
Posted salary: ${p.postedSalaryRange || '(none)'}

Description:
${truncateMiddle(p.descriptionText || '(no description)', 8000)}

${priors.length ? `PRIOR ANALYSES ON THIS JOB:\n${priors.join('\n\n')}\n\n` : ''}HIS QUESTION:
${prompt}`;
}
