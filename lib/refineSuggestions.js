// Suggestion chips from requirement gaps — no model call. Each gap becomes
// a ready-to-send request for the Chat tab, aimed at the place it helps:
// the cover letter, the resume, or interview prep. Must-have gaps first.

// "Experience with Kubernetes at scale" → "Kubernetes at scale"
const LEADS = /^(?:(?:\d+\+?\s*(?:years?|yrs?)\s*(?:of\s*)?)|(?:strong|proven|solid|deep|demonstrated|hands-on|excellent|extensive|working|good)\s+|(?:experience|expertise|background|familiarity|knowledge|proficiency|understanding)\s+(?:with|in|of)\s+|(?:ability|able)\s+to\s+|(?:track record|history)\s+of\s+)+/i;

export function shortLabel(text, maxWords = 6) {
  const t = String(text || '').trim().replace(/[.;:]+$/, '').replace(LEADS, '').trim();
  const words = t.split(/\s+/);
  return words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}…` : t;
}

// result: decideRequirements() output. Returns [{ target, label, message }]
// target is where the suggestion helps: 'letter' | 'resume' | 'chat'.
export function refineSuggestions(result, max = 6) {
  const gaps = (result || []).filter((r) => r.state !== 'covered');
  gaps.sort((a, b) => (a.kind === 'must' ? 0 : 1) - (b.kind === 'must' ? 0 : 1) || (a.state === 'gap' ? 0 : 1) - (b.state === 'gap' ? 0 : 1));
  const out = [];
  for (const r of gaps) {
    const topic = shortLabel(r.text);
    if (r.state === 'gap') {
      out.push({ target: 'letter', label: `Address the ${topic} gap in the letter`,
        message: `Address this requirement honestly in the letter, in one or two sentences, using only my real experience: "${r.text}". If nothing I have done supports it, change nothing and say so.` });
      out.push({ target: 'chat', label: `Prep for a question on ${topic}`,
        message: `The posting asks for "${r.text}" and my resume doesn't show it. How should I answer if an interviewer asks about it? Use only my real experience.` });
    } else {
      out.push({ target: 'resume', label: `Add a bullet showing ${topic}`,
        message: `My resume only partly shows "${r.text}". Add or sharpen one bullet under the most relevant role to make the strongest honest case from my actual experience. Don't invent anything; if nothing supports it, change nothing and say so.` });
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}
