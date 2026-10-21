import { truncateMiddle } from '../json.js';
import { UNTRUSTED_POSTING, NO_DASHES, STRICT_FACTS } from './parts.js';
import { HUMAN_STYLE } from './humanStyle.js';

// Edits to one part of a tailored resume or cover letter
// (lib/documentUnits.js). The whole document goes in for context; only
// the named parts come back, and the service worker fact-checks each.
export const REGENERATE_UNIT_PROMPT_VERSION = 'v1';
export const REFINE_DOCUMENT_PROMPT_VERSION = 'v1';

const RULES = `- Use only facts (numbers, dates, employers, titles, names, credentials) that appear in the MATERIAL or the posting. Never invent experience, scope or results. If the request needs a fact the material lacks, leave it out and say so in "note".
- Keep the kind of part it is: a resume bullet stays one bullet (one line, starts with a past-tense verb, no ending period needed), a skill stays a short skill name, a summary stays 2-3 sentences, a letter paragraph stays one paragraph with no line breaks.
- Plain text. No markdown.
${STRICT_FACTS}
${NO_DASHES}

${HUMAN_STYLE}`;

export const REGENERATE_UNIT_SYSTEM = `You rewrite ONE part of a job application document, in the candidate's voice.

Return ONLY valid JSON:
{ "text": "<the new text for that one part>", "note": "<one short line: what you changed, or why a request could not be met>" }

Rules:
- Rewrite only the part marked TARGET. The rest of the document is context, so the new part fits beside it without repeating it.
- Follow the user's instruction when one is given; otherwise make the part stronger for this posting.
${RULES}`;

export const REFINE_DOCUMENT_SYSTEM = `You apply the user's requested change to a job application document, in the candidate's voice.

The document is a list of parts, each shown as [id] (kind) text. Return ONLY valid JSON:
{
  "edits": [ { "id": "<id of an existing part>", "text": "<its new text>" } ],
  "add": [ { "after": "<id of the part the new one goes after>", "kind": "<bullet | skill | body>", "text": "<new part>" } ],
  "remove": [ "<id of a part to drop>" ],
  "note": "<one short line telling the user what you changed, or why you could not>"
}

Rules:
- Change as little as the request needs. Parts you do not list stay exactly as they are.
- Only edit parts whose kind is header, summary, bullet, skill, certification, opening, body or closing. Roles and education are fixed facts.
- A new resume bullet goes after a bullet or role of the role it belongs to.
${RULES}`;

const docLines = (units, targetId) => units.filter((u) => !u.removed)
  .map((u) => `${u.id === targetId ? 'TARGET ' : ''}[${u.id}] (${u.kind}) ${u.text}`).join('\n');

// profile already carries the knowledge base (service-worker loadContext).
function material({ profile, masterResume, job }) {
  const p = job?.posting || {};
  return `MATERIAL (the only source of facts about the candidate):
PROFILE:
${profile || '(none)'}

MASTER RESUME:
${masterResume ? truncateMiddle(masterResume, 8000) : '(none)'}

JOB POSTING: ${p.title || '(unknown)'} at ${p.company || '(unknown)'}
${UNTRUSTED_POSTING(truncateMiddle(p.descriptionText || '(no description)', 6000))}`;
}

export function buildRegenerateUnitUserMessage({ units, unit, instruction, docLabel, ...ctx }) {
  return `${material(ctx)}

${docLabel.toUpperCase()}:
${docLines(units, unit.id)}

TARGET: [${unit.id}] (${unit.kind})
INSTRUCTION FROM THE USER: ${instruction ? instruction.slice(0, 500) : '(none, make it stronger for this posting)'}`;
}

export function buildRefineDocumentUserMessage({ units, request, docLabel, ...ctx }) {
  return `${material(ctx)}

${docLabel.toUpperCase()}:
${docLines(units)}

THE USER'S REQUEST: ${request.slice(0, 1000)}`;
}
