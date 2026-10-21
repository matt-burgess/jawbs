// Fact-guard marks for any page that shows a generated document. A
// flagged sentence or bullet (lib/factGuard.js#guard) is wrapped in
// <mark class="jc-flagged"> with the reason on hover. Safe inside an
// editable element: innerText of the result is the original text.
import { h } from './h.js';

export function flagReason(hits) {
  return `Check: ${[...new Set(hits.map((f) => f.value))].join(', ')}. ${hits[0].reason}.`;
}

export function markFlagged(text, flags) {
  const frag = document.createDocumentFragment();
  const units = [...new Set((flags || []).map((f) => f.text).filter(Boolean))];
  let i = 0;
  while (i < text.length) {
    let next = null;
    for (const u of units) {
      const at = text.indexOf(u, i);
      if (at >= 0 && (!next || at < next.at)) next = { at, u };
    }
    if (!next) { frag.append(text.slice(i)); break; }
    if (next.at > i) frag.append(text.slice(i, next.at));
    frag.append(h('mark', { class: 'jc-flagged', title: flagReason(flags.filter((f) => f.text === next.u)) }, next.u));
    i = next.at + next.u.length;
  }
  return frag;
}
