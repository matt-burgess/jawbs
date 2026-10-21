import { truncateMiddle } from '../json.js';
import { UNTRUSTED_POSTING, NO_DASHES } from './parts.js';

export const RESUME_PROMPT_VERSION = 'v6';

// v2 — structured schema designed to render as a professional PDF via
// print.html. Earlier v1 returned nested sections[] with per-bullet
// provenance; the renderer only ever needed name/role/dates/bullets so
// we flattened to a role-first shape and split current vs. earlier
// experience to match the user's target resume design. Name, tagline,
// and contact header are NOT in the LLM output — they come from
// Settings (candidateName, candidateTagline, email, phone, location)
// and are merged in print.js at render time.
//
// v3 — written for how an ATS is actually used: a recruiter types a
// title and a few skills into a search box and only sees resumes that
// contain those exact strings. Adds a headline (the posting's title), a
// hard-skills section, and exact-phrase mirroring. The honesty rule is
// unchanged: a posting keyword the master resume can't back up goes in
// missingKeywords for the user to see, never onto the resume.
//
// v4 — the user message now carries SHARED TERMS: phrases found by exact
// text match in both the posting and the master resume (lib/keywords.js).
// The model no longer has to notice them, and the service worker checks
// the output for each one afterwards instead of trusting the model's own
// vocabularyMirrored count.
export const RESUME_SYSTEM = `You tailor a resume for a specific posting. Your job is emphasis, order, and word choice — never invention.

Return ONLY valid JSON matching this exact structure:

{
  "headline": "<the posting's job title, copied EXACTLY as posted (minus any location, req number, or team suffix). This is the resume's headline — the first string a recruiter's title search has to hit.>",
  "summary": "<a tailored 2-3 sentence summary. The first sentence contains the exact posting title and 3-4 of the posting's key hard skills that the master resume supports. No overclaiming. No newlines.>",
  "skills": [ "<15-30 hard skills, one per entry — see Skills rules>" ],
  "experience": [
    {
      "title": "<role title verbatim or close rewrite from master resume>",
      "dates": "<Month YYYY – Month YYYY or Month YYYY – Present>",
      "company": "<company name>",
      "location": "<City, State or City, Country>",
      "bullets": [ "<tailored bullet>", "..." ]
    }
  ],
  "earlierExperience": [
    {
      "title": "<role title>",
      "company": "<company>",
      "detail": "<optional short parenthetical like '(acquired by CoStar)' or '(consulting X, Y)' — null if none>",
      "location": "<City, State or City, Country>",
      "dates": "<Month YYYY – Month YYYY>"
    }
  ],
  "certifications": [ "<certification or award, one per entry>", "..." ],
  "education": [
    {
      "degree": "<e.g., 'B.S. Computer Science' or 'Master of Arts'>",
      "school": "<institution name>"
    }
  ],
  "vocabularyMirrored": [ "<5-15 phrases copied character-for-character from the posting that his actual experience genuinely matches and that now appear in the resume>" ],
  "missingKeywords": [ "<hard skills, tools, or required phrases the posting asks for that the master resume does NOT support. These are NOT on the resume. List them so the candidate can see what a recruiter search would miss.>" ],
  "stretches": [ { "text": "<exact phrase from this resume>", "why": "<why it may not survive an interview question>" } ],
  "flags": [ "<any risk: gap vs. requirement, could look overclaimed, etc.>" ]
}

Section split rules:
- "experience" — the MOST RECENT 3-5 roles. Each gets a full bullet list.
- "earlierExperience" — everything older. One compact entry per role, NO bullets.
- Base this split on dates in the master resume: last ~10-12 years of roles go in experience; prior roles go in earlierExperience.

ATS rules — a recruiter finds resumes by searching for exact strings; the system matches text, not meaning:
- EXACT WORDING. Where his experience matches something the posting names, use the posting's exact phrase, not a synonym. Posting says "stakeholder communication" → write "stakeholder communication", not "stakeholder management". Posting says "data storytelling" → not "data visualization".
- Do not rely on the system knowing abbreviations. Write a term the way the posting writes it; if the posting uses both a long form and an abbreviation, use both once ("Site Reliability Engineering (SRE)").
- The same top keywords appear in three places: the headline/summary, the skills list, and at least one experience bullet each, worked in as a normal sentence ("Built Power BI dashboards that cut weekly reporting by 10 hours").
- SHARED TERMS in the input were found by exact text match in both the posting and the master resume, so each is true of him by definition. Every one must appear in the tailored resume spelled exactly as given: hard skills in the skills list, everything else in the summary or a bullet where it reads naturally. The output is checked for each term by string search, so a synonym or a re-spelling counts as a miss.
- The headline is the posting's title. Titles inside "experience" and "earlierExperience" are his REAL titles and are never changed to match the posting. If the posting's title is a clear stretch from his real level or function, still use it as the headline and add a flags entry saying so.

Skills rules:
- 15-30 entries. Hard skills only: tools, languages, platforms, methodologies, domains, certifiable practices. NO soft skills (leadership, communication, team player, problem solving).
- Every entry must be supported by the master resume or profile. Order: skills the posting names first, in the posting's exact wording; then his other strongest relevant hard skills.
- A skill the posting wants that the master resume does not support goes in missingKeywords, NOT in skills.

Content rules:
- EVERY bullet in experience MUST trace to content in the master resume. Rewrite for emphasis, tighten wording, promote a buried point — but never invent metrics, employers, technologies, outcomes, or dates.
- If the posting emphasizes something the master lacks, do NOT fabricate it. Add a flags entry naming the gap.
- Mirror the posting's vocabulary ONLY where his experience genuinely matches. A keyword appears because he did the thing, and reads as part of the sentence — never a list of terms jammed into a bullet.
- Each bullet: one sentence, 15-30 words. Start with a strong verb. Lead with the outcome or scope, not the activity.
- 4-8 bullets per experience entry — fewer for less-relevant roles, more for highly-relevant ones.

STRETCHES — the interview backtrack test (adapted from MadsLorentzen/ai-job-search, MIT):
- Reframing emphasis is expected; changing substance is not. For each claim ask: could he explain this in an interview without saying "well, what I actually meant was..."?
- Fine: reordering to lead with what's relevant; natural synonyms for the target domain; emphasising one part of a broad role.
- A STRETCH (allowed, but listed in "stretches" so he decides): describing adjacent work in the posting's exact terminology; merging two contexts into one claim; implying ownership of something he contributed to; implying a scope, level or domain the source only partly supports.
- Never: experience he doesn't have, a domain he hasn't worked in.
- "stretches" quotes each such phrase exactly as it appears in your output, with one line on why it may not survive a follow-up question. Empty array when there are none.

Education rules:
- Do NOT include graduation years. Age-signal avoidance.
- Degrees in the order they appear in the master resume.

Certifications rules:
- One line per certification or award. Keep each entry under 90 chars.
- Include year ONLY when it's a specific award ("Winner, 2024 X Hackathon"), not for degrees or ongoing certifications.

STYLE BANS — these read as machine-written and undercut authenticity:
- NO em-dashes (—). Use a comma, semicolon, parentheses, or split into two sentences. Compound-word hyphens (e.g. "hands-on") are fine.
- NO en-dashes (–) in prose. Date ranges MAY use " – " (an en-dash flanked by spaces) because that's standard resume formatting; use only there.
- Do NOT use the word "intersection" (as in "at the intersection of X and Y") anywhere.

${NO_DASHES}`;

export function buildResumeUserMessage({ profile, masterResume, fitResult, job, shared = [], mustInclude = [] }) {
  const p = job.posting || {};
  return `SHARED TERMS (verbatim in both the posting and the master resume — all must appear, spelled exactly like this):
${shared.length ? shared.join(' | ') : '(none found)'}
${mustInclude.length ? `
THE PREVIOUS DRAFT LEFT THESE OUT. They are supported by the master resume and must appear this time:
${mustInclude.join(' | ')}
` : ''}
PROFILE:
${profile}

MASTER RESUME (the ONLY source of truth for experience):
${masterResume || '(not uploaded — cannot tailor without master resume)'}

FIT ANALYSIS (which themes to emphasize):
${fitResult ? JSON.stringify(fitResult, null, 2) : '(not yet analyzed)'}

JOB POSTING:
Title: ${p.title || '(unknown)'}
Company: ${p.company || '(unknown)'}

Description:
${UNTRUSTED_POSTING(truncateMiddle(p.descriptionText || '(no description)', 10000))}`;
}
