// The Resume and Letter documents as editable parts, shared by the Jawbar
// and Recall. Each part shows Edit, Regenerate and Remove on hover or
// focus; removed parts stay visible, struck through, with Put back.
// All changes go to the service worker (document-* messages); the caller
// re-renders from what comes back.

import { h } from './h.js';
import { EDITABLE_KINDS, keptUnits } from './documentUnits.js';
import { undoTarget } from './documentHistory.js';
import { flagReason, markFlagged } from './flagMarks.js';

const SECTION = {
  summary: 'Summary', skill: 'Skills', certification: 'Certifications & awards', education: 'Education',
};
const CAUSE = {
  written: 'Written', edited: 'Edited', regenerated: 'Regenerated', refined: 'Refined in Chat',
  trimmed: 'Trimmed to fit', restored: 'Restored', beforeRestore: 'Before restore', undone: 'Undone',
};

const sectionOf = (u) => (u.kind === 'role' || u.kind === 'bullet'
  ? (u.meta?.earlier ? 'Earlier experience' : 'Experience')
  : SECTION[u.kind] || null);

// send(type, payload) → Promise; onChange(result) re-renders the caller.
export function renderDocUnits(doc, { kind, jobId, send, onChange, onError }) {
  const root = h('div', { class: 'jc-units', dataset: { doc: kind } });
  if (!doc?.units?.length) return root;
  const run = async (btn, type, payload) => {
    if (btn) btn.disabled = true;
    try { onChange(await send(type, { jobId, kind, ...payload })); }
    catch (e) { onError?.(e.message); if (btn) btn.disabled = false; }
  };

  // Bullets of a removed role go with it; Put back is on the role.
  const kept = new Set(keptUnits(doc.units).map((u) => u.id));
  let section = null;
  let list = null;
  let skills = null;
  for (const u of doc.units) {
    if (u.kind === 'sectionHeading') {
      root.append(h('span', { class: 'jc-eyebrow jc-units__head' }, u.text));
      section = u.text; list = null; skills = null;
      continue;
    }
    const s = sectionOf(u);
    if (s && s !== section) {
      root.append(h('span', { class: 'jc-eyebrow jc-units__head' }, s));
      section = s; list = null; skills = null;
    }
    const el = unitBlock(u, run, !u.removed && !kept.has(u.id));
    if (u.kind === 'skill') {
      if (!skills) { skills = h('div', { class: 'jc-units__skills' }); root.append(skills); }
      skills.append(el);
    } else if (u.kind === 'bullet') {
      if (!list) { list = h('ul', { class: 'jc-units__list' }); root.append(list); }
      list.append(el);
    } else {
      list = null;
      root.append(el);
    }
  }
  return root;
}

function unitBlock(u, run, withRole = false) {
  const tag = u.kind === 'bullet' ? 'li' : u.kind === 'skill' ? 'span' : 'div';
  const editable = EDITABLE_KINDS.has(u.kind) && !u.removed;
  // Flagged sentences are underlined inside the part, reason on hover.
  const text = h('span', { class: 'jc-unit__text' }, u.kind === 'role' ? roleLabel(u) : u.flags?.length ? markFlagged(u.text, u.flags) : u.text);
  const el = h(tag, { class: 'jc-unit', dataset: { kind: u.kind, id: u.id, ...(u.removed || withRole ? { removed: 'true' } : {}) } }, text);
  if (withRole) return el;

  const bar = h('span', { class: 'jc-unit__bar' });
  const btn = (label, title, onClick) => h('button', { class: 'jc-unit__act', type: 'button', title, onClick }, label);
  if (u.removed) {
    bar.append(btn('Put back', 'Put this part back', (e) => run(e.currentTarget, 'document-commit', { changes: [{ id: u.id, removed: false }], cause: 'restored', note: `Put back a ${u.kind}` })));
  } else {
    if (editable) {
      bar.append(btn('Edit', 'Edit this part', () => startEdit(el, text, u, run)));
      bar.append(btn('Regenerate', 'Rewrite this part with AI (one AI call)', () => startRegenerate(el, u, run)));
    }
    if (u.kind !== 'header') {
      bar.append(btn('Remove', u.kind === 'role' ? 'Remove this role and its bullets' : 'Remove this part (you can put it back)',
        (e) => run(e.currentTarget, 'document-commit', { changes: [{ id: u.id, removed: true }], note: `Removed a ${u.kind}` })));
    }
  }
  el.append(bar);
  return el;
}

function roleLabel(u) {
  const m = u.meta;
  if (!m) return u.text;
  const head = [m.title, m.dates].filter(Boolean).join(' · ');
  const sub = [m.company, m.detail, m.location].filter(Boolean).join(', ');
  return sub ? `${head}\n${sub}` : head;
}

function startEdit(el, text, u, run) {
  if (el.querySelector('.jc-unit__form')) return;
  const input = h('textarea', { class: 'jc-unit__input', rows: String(Math.min(8, Math.ceil(u.text.length / 60) + 1)) });
  input.value = u.text;
  const save = h('button', { class: 'jc-btn', 'data-size': 'sm', 'data-variant': 'primary', type: 'button',
    onClick: () => run(save, 'document-commit', { changes: [{ id: u.id, text: input.value }], note: `Edited a ${u.kind}` }) }, 'Save');
  const cancel = h('button', { class: 'jc-btn', 'data-size': 'sm', type: 'button', onClick: () => { form.remove(); text.hidden = false; } }, 'Cancel');
  const form = h('span', { class: 'jc-unit__form' }, input, h('span', { class: 'jc-btn-row' }, save, cancel));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel.click();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save.click();
  });
  text.hidden = true;
  el.insertBefore(form, text.nextSibling);
  input.focus();
}

function startRegenerate(el, u, run) {
  if (el.querySelector('.jc-unit__form')) return;
  const input = h('input', { class: 'jc-unit__input', type: 'text', placeholder: 'What should change? (optional)', 'aria-label': 'Instruction for the rewrite' });
  const go = h('button', { class: 'jc-btn', 'data-size': 'sm', 'data-variant': 'primary', type: 'button',
    onClick: () => { go.textContent = 'Rewriting…'; run(go, 'regenerate-unit', { unitId: u.id, instruction: input.value }); } }, 'Rewrite');
  const cancel = h('button', { class: 'jc-btn', 'data-size': 'sm', type: 'button', onClick: () => form.remove() }, 'Cancel');
  const form = h('span', { class: 'jc-unit__form' }, input, h('span', { class: 'jc-btn-row' }, go, cancel));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') cancel.click(); });
  el.append(form);
  input.focus();
}

// Undo + the version list, newest first, each restorable.
export function renderDocHistory(doc, { kind, jobId, send, onChange, onError, fmt = (iso) => new Date(iso).toLocaleString() }) {
  if (!doc?.versions?.length) return null;
  const run = async (btn, type, payload) => {
    btn.disabled = true;
    try { onChange(await send(type, { jobId, kind, ...payload })); }
    catch (e) { onError?.(e.message); btn.disabled = false; }
  };
  const back = undoTarget(doc);
  const undo = back ? h('button', { class: 'jc-btn', 'data-size': 'sm', type: 'button', title: `Back to the ${CAUSE[back.cause] || back.cause} version`,
    onClick: (e) => run(e.currentTarget, 'document-undo', {}) }, 'Undo last change') : null;
  const list = h('ol', { class: 'jc-history__list' }, ...doc.versions.slice().reverse().map((v) => h('li', { dataset: { current: String(v.id === doc.current) } },
    h('span', { class: 'jc-history__cause' }, CAUSE[v.cause] || v.cause),
    h('span', { class: 'jc-history__when' }, fmt(v.at)),
    v.note ? h('span', { class: 'jc-history__note' }, v.note) : null,
    v.id === doc.current ? h('span', { class: 'jc-footnote' }, 'Showing')
      : h('button', { class: 'jc-btn', 'data-size': 'sm', type: 'button', onClick: (e) => run(e.currentTarget, 'document-restore', { versionId: v.id }) }, 'Restore'),
  )));
  return h('div', { class: 'jc-history' },
    undo,
    h('details', {}, h('summary', {}, `History (${doc.versions.length})`), list));
}

// Distinct flagged parts, for the tab count.
export const flaggedCount = (doc) => (doc?.units || []).filter((u) => !u.removed && u.flags?.length).length;
