import { truncateMiddle } from '../json.js';

export const BOOTSTRAP_PROMPT_VERSION = 'v3';

// Three purpose-specific prompts that Claude uses to fill in the About-me
// settings from the user's pasted resume. Each fills exactly one textarea.
//
// Workflow:
//   1. User pastes raw resume into Master Resume textarea.
//   2. (Optional) Click Generate on Master Resume → Claude reformats.
//   3. Click Generate on Profile → Claude produces short positioning.
//   4. Click Generate on Extended KB → Claude produces per-role detail.
// Every generator returns plain text (no JSON envelope) so it can drop
// straight into a textarea without post-processing.

// ================================================================
// MASTER RESUME — cleanup / normalization only
// ================================================================

export const MASTER_RESUME_SYSTEM = `You are cleaning up a resume that the user pasted from a PDF, doc, or free-form draft. The output goes into the "Master Resume" field of the Jawbs extension, which is quoted directly by downstream tailored-resume and cover-letter generators.

Your job is FORMATTING NORMALIZATION, not rewriting. Return ONLY the cleaned resume text — no preamble, no code fences, no JSON.

## What you SHOULD do

- Normalize section headings (Experience / Professional Experience / Work Experience → pick one consistent form: "# Experience"). Same for Education, Skills, Projects, Certifications, etc.
- Standardize bullet markers to consistent \`- \` (dash + space).
- Fix line breaks that a PDF paste broke mid-sentence (e.g. a single achievement split across 3 lines → single line).
- Trim excessive blank lines (max one blank between blocks).
- Normalize date formats within a section (either "Jan 2020 – Mar 2023" or "01/2020 – 03/2023" — pick whichever the source predominantly uses).
- Make section order sensible if it isn't: Summary → Experience → Education → Skills → Projects → Certifications.
- If titles / companies are inconsistent ("Sr. Dir" one place, "Senior Director" another), normalize to whichever spelling the source uses more.

## What you MUST NOT do

- **Do NOT summarize.** Every bullet stays.
- **Do NOT rewrite bullets** in your own words. Preserve the user's phrasing.
- **Do NOT invent** any metric, employer, date, technology, project, or outcome.
- **Do NOT drop** items you think are redundant. The user decides that.
- **Do NOT reorder** chronology within a section.
- **Do NOT translate** technology names into generic terms ("PHP/Jekyll" stays "PHP/Jekyll", not "web technologies").
- **Do NOT add** a summary, tagline, or fluff. If the resume has one, keep it verbatim. If not, don't add one.

## Formatting output

Use light markdown:
- \`# Section\` for top-level headings
- \`## Role at Company (Dates)\` for job entries
- \`- \` bullets
- Bold for job titles is optional; consistency matters more than syntax

Return ONLY the cleaned resume text. No preamble, no meta-commentary, no explanation of what you changed.`;

export function buildMasterResumeUserMessage({ resumeText }) {
  return `RAW RESUME (source of truth — preserve every specific claim):

${truncateMiddle(resumeText || '', 14000)}

Return ONLY the cleaned resume text. No preamble.`;
}

// ================================================================
// PROFILE — short positioning statement (5-8 sentences)
// ================================================================

export const PROFILE_SYSTEM = `You are writing a short positioning statement for a candidate. This lives in the Jawbs extension "Profile" field and is read by EVERY subsequent job analysis (fit, comp, cover letter, interview prep). It's the model's mental image of the candidate. Must be scan-first and dense with signal.

Return ONLY the profile prose — plain text, no markdown, no preamble, no JSON.

## Structure — 5-8 sentences, in this order

1. **Level + role target.** Level from most recent title (Director / VP / Senior / Staff / Principal / etc.), discipline, and what they're targeting next. If not stated, infer from the most recent title and note "Targeting <level>".
2. **Anchor of current chapter.** Most recent role: company name, scope (team size / budget / P&L / user count), and the ONE outcome they own. Concrete metrics only if they exist in the source.
3. **Anchor of prior chapter.** Prior role: company + scope + one outcome. The second-strongest positioning anchor.
4. **Distinguishing thread.** What runs through their career that a hiring manager should notice? Modernization, scaling, turnarounds, greenfield, regulated industries, specific tech stack, cross-functional leadership — pick the ACTUAL pattern, not a generic label.
5. **Anything worth naming that isn't obvious from the resume title.** Side projects, published writing, certifications, unusual credentials, teaching, patents. One sentence.

## Voice + guard rails

- Reference employers BY NAME. "Led modernization at Malwarebytes" beats "Led modernization at a cybersecurity company".
- Metrics only when they exist in the source. Do NOT round up, expand scope, or invent numbers.
- Use "he/she/they" or first person consistent with the source.

## Delete on sight

Corporate-speak phrases that add zero signal — do not use any of these:
- "passionate about"
- "results-driven"
- "seasoned"
- "proven track record"
- "team player"
- "excellent communicator"
- "in today's fast-paced environment"
- "digital transformation" (unless the source uses it)
- "synergies"
- "thought leader"

## Good vs bad

- BAD: "Led digital transformation initiatives" (0 signal)
- GOOD: "Led PHP-to-React modernization across 8 web properties" (specific)
- BAD: "Deep experience in fintech" (generic)
- GOOD: "Owned fintech infrastructure processing >$100B annually under PCI-DSS at Priority Payment Systems" (specific)

Return ONLY the profile prose. No JSON, no preamble, no explanation.`;

export function buildProfileUserMessage({ masterResume, existingProfile, hints }) {
  const bits = [
    `MASTER RESUME (source of truth — every specific claim in your output must trace to this):\n\n${truncateMiddle(masterResume || '', 12000)}`,
  ];
  if (existingProfile) {
    bits.push(`\n\nEXISTING PROFILE (previous version — feel free to improve, don't feel bound):\n\n${existingProfile}`);
  }
  if (hints?.targetRole) bits.push(`\n\nUSER-SUPPLIED TARGET ROLE: ${hints.targetRole}`);
  if (hints?.workLocations) bits.push(`\n\nUSER-SUPPLIED WORK LOCATIONS: ${hints.workLocations}`);
  bits.push('\n\nReturn ONLY the profile prose. No preamble, no markdown fences.');
  return bits.join('');
}

// ================================================================
// EXTENDED KNOWLEDGE BASE — per-role detail markdown (700-1500 words)
// ================================================================

export const KB_SYSTEM = `You are writing a longer knowledge-base document for a candidate. This lives in the Jawbs extension "Extended knowledge base" field and feeds cover letters, tailored resumes, and interview prep. It's the source of specific stories, metrics, and anchors the model reaches for when it needs detail. Depth matters here.

Return ONLY the knowledge-base markdown text — no preamble, no code fences, no JSON.

## Structure — markdown document, 700-1500 words

# Positioning
[2-3 sentences: level, current-role scope, target. This anchors every downstream prompt.]

# Current role — [Company, Title, Dates]
- Concrete accomplishment 1 (with metric if the resume has one)
- Concrete accomplishment 2
- ... 4-6 bullets total
- Note the ONE story from this role that would come up in interviews

# Prior role — [Company, Title, Dates]
[Same structure, 3-5 bullets]

... continue for every significant role ...

# Education / credentials
- Degrees, certifications, notable programs

# Side projects / writing / other signal
[Anything the resume flags that isn't a full-time job]

## Rules

- Every bullet MUST trace to a specific claim in the source resume. If a role is thin in the resume, keep that section thin. Better an 800-word KB with real signal than a 1500-word KB with padding.
- Preserve specific technology, tool, framework, and methodology names VERBATIM. Do NOT translate "PHP/Jekyll" into "web technologies" or "AWS" into "cloud infrastructure". Downstream analyses need the exact terms to match against posting requirements.
- Preserve acronyms exactly (DORA, PCI-DSS, OKR, SOC2, HIPAA, etc.).
- Do NOT include jobs older than ~15 years unless the resume itself keeps them.

## Anti-hallucination guard rails (CRITICAL)

Downstream analyses will confidently quote whatever you write here.

- If the resume doesn't state a metric, DO NOT invent one.
- If the resume doesn't name a specific technology, don't add plausible-sounding ones.
- If two claims in the resume conflict, keep the source's version.
- Soft-skill claims like "excellent communicator" add zero signal — omit them.

## Common failure modes to avoid

- Padded bullets that summarize without adding specifics
- Rounded-up numbers ("~30" when source says "roughly 25")
- Invented rationale (why an outcome happened, when the resume doesn't say)
- Generic labels replacing specific technologies

Return ONLY the markdown knowledge base. No preamble.`;

export function buildKbUserMessage({ masterResume, existingProfile, existingKb, hints }) {
  const bits = [
    `MASTER RESUME (source of truth — every specific claim in your output must trace to this):\n\n${truncateMiddle(masterResume || '', 12000)}`,
  ];
  if (existingProfile) {
    bits.push(`\n\nEXISTING PROFILE (for consistency — expand on this, don't contradict it):\n\n${existingProfile}`);
  }
  if (existingKb) {
    bits.push(`\n\nEXISTING KNOWLEDGE BASE (previous version — feel free to improve on it):\n\n${truncateMiddle(existingKb, 4000)}`);
  }
  if (hints?.targetRole) bits.push(`\n\nUSER-SUPPLIED TARGET ROLE: ${hints.targetRole}`);
  bits.push('\n\nReturn ONLY the markdown knowledge base. No preamble, no code fences.');
  return bits.join('');
}
