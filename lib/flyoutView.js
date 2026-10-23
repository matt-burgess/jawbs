// The flyout: the detail view for a finished Fit, Comp, Resume or Cover
// letter. One module, two homes:
//   mode 'page'  - content/flyout.js mounts it on the right edge of the
//                  LinkedIn page, just left of the side panel.
//   mode 'panel' - the side panel mounts it over itself when the tab is
//                  a page the content script cannot run on.
// It is a Shadow DOM root, so the host page's CSS cannot reach it.
// No imports: the content script loads this by URL, so it must stand alone.

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
};

// Page focus decides whether the async clipboard works, so fall back to
// a selection copy.
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = el('textarea', { style: 'position:fixed;opacity:0' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand?.('copy');
  ta.remove();
  return !!ok;
}

const TITLES = { fit: 'Fit', comp: 'Comp', resume: 'Resume', letter: 'Cover letter' };

export const FLYOUT_CSS = `
:host { all: initial; position: fixed; top: 0; right: 0; height: 100vh; width: 400px; z-index: 2147483000;
  --bg:#0E131B; --s1:#151C27; --s2:#1B2431; --s3:#222D3C; --bd:#2B384A; --bds:#3B4B61;
  --tx:#E6EDF5; --tx2:#B3C0CF; --tx3:#8C9AAD; --ac:#22CCEE; --acw:rgba(34,204,238,.12); --acl:rgba(34,204,238,.45);
  --pos:#5EDB8A; --posw:rgba(94,219,138,.12); --posl:rgba(94,219,138,.4);
  --caution:#FFB547; --cautionw:rgba(255,181,71,.12); --cautionl:rgba(255,181,71,.4);
  --neg:#FF7373; --negw:rgba(255,115,115,.12); --negl:rgba(255,115,115,.42);
  --sans:"Archivo",system-ui,-apple-system,"Segoe UI",sans-serif; --disp:"Barlow Condensed","Archivo Narrow","Arial Narrow",sans-serif;
  --brand:"Anton",Impact,"Arial Narrow",sans-serif; --mono:"JetBrains Mono",ui-monospace,"SF Mono",Menlo,monospace; }
:host([data-mode="panel"]) { left: 0; width: auto; }
*, *::before, *::after { box-sizing: border-box; }
.jf { height: 100%; display: flex; flex-direction: column; background: var(--bg); color: var(--tx); font: 400 13px/1.5 var(--sans);
  border-left: 1px solid var(--bds); box-shadow: -24px 0 48px -18px rgba(0,0,0,.85); animation: jf-in .16s ease-out; outline: none; }
:host([data-mode="panel"]) .jf { border-left: 0; box-shadow: none; }
@keyframes jf-in { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .jf { animation: none; } }
.jf__head { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px; background: var(--s1); border-bottom: 1px solid var(--bd); }
.jf__eyebrow { font: 700 12px/1 var(--disp); letter-spacing: .12em; text-transform: uppercase; color: var(--ac); }
.jf__job { margin-top: 4px; font: 600 13px/1.3 var(--sans); color: var(--tx2); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.jf__x { margin-left: auto; flex: none; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 6px;
  border: 1px solid var(--bd); background: transparent; color: var(--tx2); font: 400 18px/1 var(--sans); cursor: pointer; }
.jf__x:hover { color: var(--ac); border-color: var(--acl); }
.jf__body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.jf__foot { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; background: var(--s1); border-top: 1px solid var(--bd); }
h4 { margin: 0; font: 700 12px/1 var(--disp); letter-spacing: .12em; text-transform: uppercase; color: var(--tx3); }
p { margin: 0; }
.btn { font: 600 13px/1 var(--sans); padding: 8px 12px; border-radius: 6px; border: 1px solid var(--bds); background: var(--s2); color: var(--tx); cursor: pointer; }
.btn:hover:not(:disabled) { border-color: var(--acl); color: var(--ac); }
.btn:disabled { opacity: .5; cursor: default; }
.btn--pri { background: var(--ac); border-color: var(--ac); color: #041119; }
.btn--pri:hover:not(:disabled) { background: #6BDDF4; color: #041119; }
.btn--sm { padding: 5px 9px; font-size: 12px; }
.link { background: none; border: 0; padding: 0; color: var(--ac); font: 600 12px/1.3 var(--sans); cursor: pointer; text-align: left; }
.link:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--ac); outline-offset: 2px; }
.hero { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.hero__num { font: 400 56px/1 var(--brand); }
.hero__den { font: 500 14px/1 var(--mono); color: var(--tx3); }
.hero__lbl { font: 700 13px/1 var(--disp); letter-spacing: .1em; text-transform: uppercase; padding: 4px 8px; border-radius: 4px; }
.tone-pos { color: var(--pos); } .tone-caution { color: var(--caution); } .tone-neg { color: var(--neg); }
.hero__lbl.tone-pos { background: var(--posw); } .hero__lbl.tone-caution { background: var(--cautionw); } .hero__lbl.tone-neg { background: var(--negw); }
.sum { color: var(--tx2); font-size: 14px; line-height: 1.5; }
.items { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.items li { display: flex; gap: 8px; align-items: flex-start; }
.mk { flex: none; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font: 700 11px/1 var(--mono); margin-top: 1px; }
.mk--gap { background: var(--cautionw); color: var(--caution); border: 1px solid var(--cautionl); }
.mk--ok { background: var(--posw); color: var(--pos); border: 1px solid var(--posl); }
.range { font: 400 40px/1 var(--brand); }
.badge { display: inline-block; font: 700 11px/1 var(--mono); padding: 4px 7px; border-radius: 4px; border: 1px solid; }
.badge.tone-pos { background: var(--posw); border-color: var(--posl); } .badge.tone-caution { background: var(--cautionw); border-color: var(--cautionl); } .badge.tone-neg { background: var(--negw); border-color: var(--negl); }
.sub { color: var(--tx3); font-size: 12px; }
.ladder { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
.rung { border: 1px solid var(--bd); border-radius: 8px; padding: 8px; background: var(--s1); display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rung__n { font: 700 11px/1 var(--mono); color: var(--tx3); }
.rung__name { font: 600 12px/1.2 var(--sans); color: var(--tx2); }
.rung__range { font: 500 13px/1.2 var(--mono); color: var(--tx3); }
.rung--used.tone-pos { border-color: var(--pos); background: var(--posw); } .rung--used.tone-caution { border-color: var(--caution); background: var(--cautionw); } .rung--used.tone-neg { border-color: var(--neg); background: var(--negw); }
.rung--used .rung__range, .rung--used .rung__n { color: inherit; }
.rung--used .rung__name { color: var(--tx); }
.box { border: 1px solid var(--bd); border-radius: 8px; padding: 12px; background: var(--s1); display: flex; flex-direction: column; gap: 8px; }
.box--pos { border-color: var(--posl); background: var(--posw); } .box--caution { border-color: var(--cautionl); background: var(--cautionw); } .box--neg { border-color: var(--negl); background: var(--negw); }
.bar { position: relative; height: 8px; border-radius: 4px; background: var(--s3); margin: 8px 0 4px; }
.bar__band { position: absolute; top: 0; bottom: 0; border-radius: 4px; background: currentColor; opacity: .8; }
.bar__tick { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--tx); }
.bar__tick[data-k="floor"] { background: var(--neg); }
.legend { display: flex; gap: 12px; font: 500 11px/1 var(--mono); color: var(--tx3); }
.field { display: flex; flex-direction: column; gap: 4px; }
.field__row { display: flex; align-items: flex-start; gap: 8px; }
.field__val { flex: 1; min-width: 0; color: var(--tx); }
.field__val--num { font: 500 18px/1.2 var(--mono); }
.prev { white-space: pre-wrap; background: var(--s1); border: 1px solid var(--bd); border-radius: 8px; padding: 12px; color: var(--tx2); max-height: 46vh; overflow-y: auto; font-size: 13px; line-height: 1.55; }
select { font: 600 12px/1 var(--sans); padding: 6px 8px; border-radius: 6px; border: 1px solid var(--bds); background: var(--s2); color: var(--tx); }
.note { color: var(--caution); font-size: 12px; }
`;

function fitBody(p) {
  const f = p.fit;
  const tone = { strong: 'pos', fair: 'caution', weak: 'neg' }[f.band];
  return [
    el('div', { class: 'hero' },
      el('span', { class: `hero__num tone-${tone}` }, String(f.score ?? '-')),
      el('span', { class: 'hero__den' }, '/100'),
      el('span', { class: `hero__lbl tone-${tone}` }, f.label)),
    el('p', { class: 'sum' }, f.summary),
    f.gaps.length ? el('div', {}, el('h4', {}, 'Gaps'),
      el('ul', { class: 'items' }, f.gaps.map((g) => el('li', {}, el('span', { class: 'mk mk--gap', 'aria-hidden': 'true' }, '!'), el('span', {}, g))))) : null,
    f.matches.length ? el('div', {}, el('h4', {}, 'Matches'),
      el('ul', { class: 'items' }, f.matches.map((m) => el('li', {}, el('span', { class: 'mk mk--ok', 'aria-hidden': 'true' }, '✓'), el('span', {}, m))))) : null,
    el('button', { class: 'link', type: 'button', 'data-action': 'details' }, 'Level signals and red flags: open Details'),
  ];
}

// `copy` is what lands on the clipboard when it differs from what is shown
// (a pay field wants 270000, not $270,000).
function copyRow(label, text, cls = '', copy = text) {
  const btn = el('button', { class: 'btn btn--sm', type: 'button' }, 'Copy');
  btn.addEventListener('click', async () => {
    if (!(await copyText(copy))) return;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });
  return el('div', { class: 'field' }, el('h4', {}, label),
    el('div', { class: 'field__row' }, el('span', { class: `field__val ${cls}` }, text), btn));
}

function compBody(p) {
  const c = p.comp;
  const vt = c.verdict?.tone;
  return [
    el('div', {},
      el('div', { class: 'range' }, `${c.estimate && c.range ? '~' : ''}${c.range || 'No range found'}`),
      el('div', { class: 'hero', style: 'margin-top:8px' },
        el('span', { class: `badge tone-${c.badge.tone}` }, c.badge.label),
        c.bonusEquity ? el('span', { class: 'sub' }, c.bonusEquity) : null)),
    el('div', {}, el('h4', {}, 'Where this number came from'),
      el('div', { class: 'ladder' }, c.ladder.map((r) => el('div', { class: `rung${r.used ? ` rung--used tone-${r.tone}` : ''}` },
        el('span', { class: 'rung__n' }, `#${r.n}`), el('span', { class: 'rung__name' }, r.name),
        el('span', { class: 'rung__range' }, r.range || (r.key === 'posting' ? 'Not posted' : 'No estimate'))))),
      c.sourceLabel ? el('p', { class: 'sub', style: 'margin-top:8px' }, c.sourceLabel) : null),
    c.verdict ? el('div', { class: `box box--${vt}` },
      el('strong', { class: `tone-${vt}` }, c.verdict.label),
      el('span', { class: 'sub' }, c.verdict.detail),
      c.bar ? el('div', { class: `tone-${vt}` },
        el('div', { class: 'bar' },
          el('span', { class: 'bar__band', style: `left:${c.bar.band.left}%;width:${c.bar.band.width}%` }),
          c.bar.floor != null ? el('span', { class: 'bar__tick', 'data-k': 'floor', style: `left:${c.bar.floor}%` }) : null,
          c.bar.target != null ? el('span', { class: 'bar__tick', 'data-k': 'target', style: `left:${c.bar.target}%` }) : null),
        el('div', { class: 'legend' },
          c.floor ? el('span', {}, `Floor $${Math.round(c.floor / 1000)}K`) : null,
          c.target ? el('span', {}, `Target $${Math.round(c.target / 1000)}K`) : null)) : null) : null,
    c.answer ? el('div', { class: 'box' }, el('h4', {}, 'If the application asks about pay'),
      c.answer.numberText ? copyRow('Number', c.answer.numberText, 'field__val--num', String(c.answer.number)) : null,
      c.answer.short ? copyRow('Short answer', c.answer.short) : null) : null,
    c.others.length ? el('div', {}, el('h4', {}, 'Lower-confidence estimates'),
      el('ul', { class: 'items' }, c.others.map((o) => el('li', {}, el('span', {},
        el('strong', {}, `${o.name}: ${o.range}`), o.sourceLabel ? el('span', { class: 'sub' }, ` ${o.sourceLabel}`) : null))))) : null,
  ];
}

function docBody(p) {
  return [
    el('p', { class: 'sub' }, p.meta),
    p.kind === 'letter' && p.tones?.length ? el('div', { class: 'field__row', style: 'align-items:center' },
      el('h4', {}, 'Tone for the next one'),
      el('select', { 'aria-label': 'Cover letter tone', 'data-tone': true },
        p.tones.map((t) => el('option', { value: t.key, ...(t.key === p.tone ? { selected: true } : {}) }, t.label)))) : null,
    el('div', { class: 'prev' }, p.preview || 'Nothing to preview.'),
    p.flagged ? el('p', { class: 'note' }, `${p.flagged} sentence${p.flagged === 1 ? '' : 's'} with facts not found in your material. Check them in the editor.`) : null,
    el('button', { class: 'link', type: 'button', 'data-action': p.kind === 'letter' ? 'history' : 'compare' },
      p.kind === 'letter' ? 'History and edits' : 'Compare versions'),
  ];
}

// Footer buttons per step: [label, action, primary?, busyLabel?]
const FOOTERS = {
  fit: (p) => [[p.busy ? 'Casting…' : 'Re-run fit', 'rerun']],
  comp: (p) => [[p.busy ? 'Casting…' : 'Re-run comp', 'rerun']],
  resume: (p) => [['Download PDF', 'pdf', true], ['Copy', 'copy'], [p.busy ? 'Baiting…' : 'Regenerate', 'regenerate']],
  letter: (p) => [['Copy', 'copy', true], ['PDF', 'pdf'], [p.busy ? 'Baiting…' : 'Regenerate', 'regenerate'], ['Undo last change', 'undo', false, !p.canUndo]],
};

export function createFlyout({ mode = 'page', onAction = () => {}, onClose = () => {} } = {}) {
  const host = el('div', { id: 'jawbar-flyout-host', 'data-mode': mode });
  const root = host.attachShadow({ mode: 'open' });
  let step = null;
  let last = null;

  function paint() {
    const p = last;
    const body = el('div', { class: 'jf__body' }, step === 'fit' ? fitBody(p) : step === 'comp' ? compBody(p) : docBody(p));
    const foot = el('div', { class: 'jf__foot' }, FOOTERS[step](p).map(([label, action, pri, off]) => {
      const b = el('button', { class: `btn${pri ? ' btn--pri' : ''}`, type: 'button', 'data-action': action, ...(off || p.busy ? { disabled: true } : {}) }, label);
      return b;
    }));
    const aside = el('aside', { class: 'jf', role: 'dialog', 'aria-label': `${TITLES[step]} detail`, tabindex: '-1' },
      el('div', { class: 'jf__head' },
        el('div', {}, el('div', { class: 'jf__eyebrow' }, TITLES[step]), el('div', { class: 'jf__job' }, p.job || '')),
        el('button', { class: 'jf__x', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)', 'data-action': 'close' }, '×')),
      body, foot);
    // Keep scroll position when the same step repaints with fresh data.
    const prevScroll = root.querySelector('.jf__body')?.scrollTop || 0;
    root.replaceChildren(el('style', {}, FLYOUT_CSS), aside);
    body.scrollTop = prevScroll;
  }

  root.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]');
    if (!t || t.disabled) return;
    const action = t.dataset.action;
    if (action === 'close') return api.close();
    // Copy runs here, where the page has focus and the user's click.
    if (action === 'copy' && last?.copyText) {
      if (await copyText(last.copyText)) { t.textContent = 'Copied'; setTimeout(() => { t.textContent = 'Copy'; }, 1200); }
      return;
    }
    onAction(action, { step });
  });
  root.addEventListener('change', (e) => {
    if (e.target.dataset?.tone) onAction('tone', { step, tone: e.target.value });
  });

  const onKey = (e) => { if (e.key === 'Escape' && step) { e.stopPropagation(); api.close(); } };

  const api = {
    host,
    get step() { return step; },
    // Show `step` with `payload`; same step again just refreshes it.
    show(nextStep, payload) {
      const first = !step;
      step = nextStep;
      last = payload;
      if (!host.isConnected) document.documentElement.append(host);
      if (first) document.addEventListener('keydown', onKey, true);
      paint();
      if (first) root.querySelector('.jf')?.focus({ preventScroll: true });
    },
    close({ silent = false } = {}) {
      if (!step) return;
      step = null;
      last = null;
      document.removeEventListener('keydown', onKey, true);
      host.remove();
      if (!silent) onClose();
    },
  };
  return api;
}
