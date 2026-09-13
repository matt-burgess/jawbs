import { truncateMiddle } from '../json.js';

export const COMP_PROMPT_VERSION = 'v4';

// v3 rewrite: single job — what's the salary and WHERE did the number come
// from. No anchor recommendation, no counter-offer, no negotiation copy,
// no probes. Users want the salary with a clear source label; nothing more.
export const COMP_SYSTEM = `You are a compensation analyst. Your ONLY job is to give the salary range for THIS specific job with a clear indication of where the information came from.

Return ONLY valid JSON matching this structure — no prose, no markdown fences:

{
  "salary": {
    "source": "<posting | company-research | title-benchmark | unknown>",
    "sourceLabel": "<human-readable source detail the user will see>",
    "confidence": "<high | medium | low>",
    "base": {
      "low":  <integer USD, or null>,
      "high": <integer USD, or null>,
      "raw":  "<posted range verbatim if source=posting; null otherwise>"
    },
    "bonus": {
      "percent": <integer or null — ONLY if the source explicitly states a bonus target>,
      "note":    "<one line if source mentions bonus, or null>"
    },
    "equity": {
      "note": "<one line if source mentions equity (RSUs, options, grants), or null>"
    }
  },
  "vsTargets": {
    "vsFloor":  "<above | at | below | unknown>",
    "vsTarget": "<above | at | below | unknown>",
    "flag":     "<one-sentence warning if base.low is below the candidate's floor; otherwise null>"
  }
}

Source priority — use in this order, taking the FIRST that yields real data:

1. **posting** — Job description or posted salary field states a range.
   High confidence. This is the ONLY source that populates \`raw\` (the range
   as-written). Bonus and equity here only if the description explicitly
   mentions them.
   sourceLabel example: "Job posting: $220K–$270K"
   MANDATORY: If the input contains a "SALARY MATCHES FOUND IN DESCRIPTION"
   section with ANY entry, the source MUST be "posting". Use the first
   entry as base.raw and parse its low/high. Do NOT fall through to
   research or benchmark. This section is the JS-extracted ground truth —
   trust it over your own reading of the description.

2. **company-research** — You have specific knowledge of THIS company's
   compensation practices (from your training data, akin to Glassdoor /
   levels.fyi). Medium confidence. Cite what you're basing it on.
   sourceLabel example: "Company research: Snap engineering leadership
   typically $260-320K base per public levels.fyi/Glassdoor data"
   Bonus and equity are generally not knowable from this source — leave
   null unless you're highly confident.

3. **title-benchmark** — Neither of the above. Provide a general range for
   the title in the stated location/workplace type. Low confidence.
   sourceLabel example: "General benchmark: Director of Engineering,
   Atlanta metro, ~$220–290K base"
   Bonus and equity: leave null; not knowable from title alone.

4. **unknown** — You cannot produce any reasonable estimate. Rare.

Rules:
- NEVER fabricate bonus percent or equity details. Only include when the
  source explicitly provides them (posting) or you have strong specific
  knowledge (company-research). Otherwise null.
- Compare base.low to the candidate's floor — set vsFloor accordingly.
  Same for target. If floor/target not provided, use "unknown".
- If base.low is below floor, set flag with a specific one-sentence
  warning (name the delta or the risk).
- Do NOT include: anchor recommendations, counter-offer language,
  negotiation copy, "probe these components" lists, opener quotes.
  Users don't want copy suggestions.
- sourceLabel is what the user READS to understand where the number came
  from. Be specific and honest about the source.`;

// Pre-extract dollar ranges from the description so the LLM can't miss them.
// Small LLMs (local qwen etc.) sometimes see "$337,000 - $425,000" in a long
// description and still fall back to a title benchmark. Handing them the
// exact matches as a distinct top-of-prompt block eliminates that discretion.
export function extractSalaryHints(text) {
  if (!text || typeof text !== 'string') return [];
  const patterns = [
    // "$337,000 - $425,000" / "$337,000 to $425,000" / "$150K – $200K"
    /\$\s*\d[\d,]{2,}(?:\.\d+)?(?:\s*[KkMm])?\s*(?:[-–—]|\bto\b)\s*\$?\s*\d[\d,]{2,}(?:\.\d+)?(?:\s*[KkMm])?/g,
    // "USD 150,000 - 200,000"
    /USD\s*\d[\d,]{2,}(?:\s*[-–—]|\bto\b)\s*\d[\d,]{2,}/gi,
    // "$150,000/yr" (single point, still useful signal)
    /\$\s*\d[\d,]{2,}(?:\s*[KkMm])?\s*(?:\/\s*(?:yr|year|hour|hr|month|mo)|\s*(?:per|annually|yearly))/gi,
  ];
  const hits = new Set();
  for (const re of patterns) {
    const matches = text.match(re);
    if (matches) for (const m of matches) hits.add(m.replace(/\s+/g, ' ').trim());
  }
  return Array.from(hits).slice(0, 5);
}

export function buildCompUserMessage({ compTargets, job }) {
  const p = job.posting || {};
  const c = compTargets || {};
  const description = p.descriptionText || '';
  const hits = extractSalaryHints(description);

  // If regex found salary text in the description but postedSalaryRange is
  // empty, promote the first hit into the "Posted salary field" slot too.
  // Belt-and-suspenders for LLMs that trust that field more than the
  // separate matches section.
  const postedField = p.postedSalaryRange || (hits[0] ? `${hits[0]} (extracted from description)` : '(none posted)');

  const matchesSection = hits.length
    ? `\nSALARY MATCHES FOUND IN DESCRIPTION (extracted by regex; treat as ground truth for source=posting):\n${hits.map((h) => `  • ${h}`).join('\n')}\n`
    : '';

  return `CANDIDATE COMP TARGETS:
Floor: ${c.floor != null ? '$' + Number(c.floor).toLocaleString() : '(not set)'}
Target: ${c.target != null ? '$' + Number(c.target).toLocaleString() : '(not set)'}

JOB POSTING:
Title: ${p.title || '(unknown)'}
Company: ${p.company || '(unknown)'}
Location: ${p.location || '(unknown)'} | Workplace: ${p.workplaceType || '(unknown)'}
Posted salary field: ${postedField}
${matchesSection}
Description:
${truncateMiddle(description || '(no description available)', 10000)}`;
}
