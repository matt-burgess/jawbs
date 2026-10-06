import { truncateMiddle } from '../json.js';

export const RESUME_PROMPT_VERSION = 'v2';

// v2 — structured schema designed to render as a professional PDF via
// print.html. Earlier v1 returned nested sections[] with per-bullet
// provenance; the renderer only ever needed name/role/dates/bullets so
// we flattened to a role-first shape and split current vs. earlier
// experience to match the user's target resume design. Name, tagline,
// and contact header are NOT in the LLM output — they come from
// Settings (candidateName, candidateTagline, email, phone, location)
// and are merged in print.js at render time.
export const RESUME_SYSTEM = `You tailor a resume for a specific posting. Your job is emphasis, order, and word choice — never invention.

Return ONLY valid JSON matching this exact structure:

{
  "summary": "<a tailored 2-3 sentence summary near the top of the resume. Reflect the target title's framing without overclaiming. No newlines.>",
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
  "vocabularyMirrored": [ "<phrases from the posting that his actual experience genuinely matches, now surfaced in the tailored resume>" ],
  "flags": [ "<any risk: gap vs. requirement, could look overclaimed, etc.>" ]
}

Section split rules:
- "experience" — the MOST RECENT 3-5 roles. Each gets a full bullet list.
- "earlierExperience" — everything older. One compact entry per role, NO bullets.
- Base this split on dates in the master resume: last ~10-12 years of roles go in experience; prior roles go in earlierExperience.

Content rules:
- EVERY bullet in experience MUST trace to content in the master resume. Rewrite for emphasis, tighten wording, promote a buried point — but never invent metrics, employers, technologies, outcomes, or dates.
- If the posting emphasizes something the master lacks, do NOT fabricate it. Add a flags entry naming the gap.
- Mirror the posting's real vocabulary ONLY where his experience genuinely matches. No keyword stuffing.
- Each bullet: one sentence, 15-30 words. Start with a strong verb. Lead with the outcome or scope, not the activity.
- 4-8 bullets per experience entry — fewer for less-relevant roles, more for highly-relevant ones.

Education rules:
- Do NOT include graduation years. Age-signal avoidance.
- Degrees in the order they appear in the master resume.

Certifications rules:
- One line per certification or award. Keep each entry under 90 chars.
- Include year ONLY when it's a specific award ("Winner, 2024 X Hackathon"), not for degrees or ongoing certifications.

STYLE BANS — these read as machine-written and undercut authenticity:
- NO em-dashes (—). Use a comma, semicolon, parentheses, or split into two sentences. Compound-word hyphens (e.g. "hands-on") are fine.
- NO en-dashes (–) in prose. Date ranges MAY use " – " (an en-dash flanked by spaces) because that's standard resume formatting; use only there.
- Do NOT use the word "intersection" (as in "at the intersection of X and Y") anywhere.`;

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
