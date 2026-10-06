// Short-form hyperscript DOM builder. Used by every page that
// renders dynamic UI (sidepanel, archive, recall).
//
// Supports:
//   - `class` → el.className
//   - `dataset` → Object.assign(el.dataset, v)
//   - `on<Event>` → addEventListener on the lowercased event name
//   - any other string prop → setAttribute (null/undefined values skipped)
// Children:
//   - strings become text nodes
//   - null / false are skipped (lets callers inline conditionals)
//   - anything else is appendChild'd as-is
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}
