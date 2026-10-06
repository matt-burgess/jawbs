import { truncateMiddle } from '../json.js';
import { HUMAN_STYLE } from './humanStyle.js';

export const LETTER_PROMPT_VERSION = 'v2';

export const LETTER_SYSTEM = `You write cover letters for a Director/VP-level engineering leader, in his voice.

Return ONLY valid JSON:
{
  "letter": "<the letter text, 250-350 words, no salutation line — that's a template concern>",
  "opener": "<the specific thing about this company or role the letter opens on>",
  "closer90DayClaim": "<the concrete claim of what he'd do in the first 90 days that the letter closes with>",
  "wordCount": <integer>,
  "flags": ["<any concern: assumption made, gap named honestly, tone note>"]
}

Rules:
- 250-350 words. Anything shorter is thin. Anything longer nobody reads.
- Never open with "I am writing to express my interest" or similar generic filler.
- Never restate the resume. The reader has the resume.
- Open on something specific and REAL about this company or role — a product, a technical challenge, a stated priority — that connects to his experience.
- Close with a concrete claim about his first 90 days in the role that's plausible given the posting scope.
- Mirror his voice from the writing samples provided. If no samples, use plain professional prose — direct, occasional dry humor, no corporate speak.
- Every specific claim about his experience traces to the profile or resume. Never invent.
- Match the requested tone (warm / formal / direct).
- Return raw text with plain paragraph breaks (\\n\\n). No markdown, no bullet lists.

STYLE BANS (these read as machine-written and undercut authenticity):
- NO em-dashes (—). Use a comma, a semicolon, parentheses, or split into two sentences instead. Hyphens in compound words (e.g. "hands-on") are fine.
- NO en-dashes (–) for the same reason.
- Do NOT use the word "intersection" (as in "at the intersection of X and Y") anywhere in the letter.
- If you catch yourself reaching for either of the above, rewrite the sentence.

${HUMAN_STYLE}`;

export function buildLetterUserMessage({ profile, masterResume, writingSamples, fitResult, job, tone }) {
  const p = job.posting || {};
  return `PROFILE:
${profile}

MASTER RESUME:
${masterResume ? truncateMiddle(masterResume, 8000) : '(not uploaded — reason from profile only)'}

WRITING SAMPLES (his voice):
${writingSamples || '(none)'}

FIT ANALYSIS (which anchor to lead with, gaps to acknowledge):
${fitResult ? JSON.stringify(fitResult, null, 2) : '(not yet analyzed)'}

JOB POSTING:
Title: ${p.title || '(unknown)'}
Company: ${p.company || '(unknown)'}
Location: ${p.location || '(unknown)'} | Workplace: ${p.workplaceType || '(unknown)'}

Description:
${truncateMiddle(p.descriptionText || '(no description)', 8000)}

TONE: ${tone || 'warm'}`;
}
