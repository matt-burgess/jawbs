// "Paste an email": match it to a jawb (no AI), classify it (one AI call),
// then act on it: move the status, add the interview round, draft a reply.
// Shared by the Jawbar and Recall; the service worker does the work.

import { h } from './h.js';
import { statusLabel } from './statuses.js';
import { markFlagged } from './flagMarks.js';

const KIND = { rejection: 'Rejection', interview: 'Interview', question: 'Question', offer: 'Offer', acknowledgement: 'Acknowledgement', other: 'Other' };
const TONE = { rejection: 'neg', interview: 'pos', offer: 'pos', question: 'caution', acknowledgement: 'info', other: 'info' };

// opts: { send, jobId?, jobLabel?, onChanged?(jobId), onRound?(jobId) }
export function renderEmailFlow({ send, jobId = null, jobLabel = 'This jawb', onChanged, onRound }) {
  const err = h('p', { class: 'jc-footnote jc-email__err', hidden: '' });
  const fail = (e, btn, label) => { err.hidden = false; err.textContent = e.message; if (btn) { btn.disabled = false; btn.textContent = label; } };
  const input = h('textarea', { class: 'jc-textarea', rows: '6', 'aria-label': 'Email to read',
    placeholder: 'Paste the whole email, including the From and Subject lines if you can.' });
  const read = h('button', { class: 'jc-btn', 'data-size': 'sm', 'data-variant': 'primary', type: 'button' }, 'Read email');
  const out = h('div', { class: 'jc-email__out' });
  const root = h('div', { class: 'jc-email' }, input, h('div', { class: 'jc-btn-row' }, read,
    h('span', { class: 'jc-footnote' }, 'Matching is free. Reading what it means is one AI call.')), err, out);

  read.addEventListener('click', async () => {
    err.hidden = true;
    out.innerHTML = '';
    read.disabled = true;
    try {
      const { email, candidates } = await send('email-match', { text: input.value });
      out.append(pickJob(email, candidates));
    } catch (e) { fail(e); }
    read.disabled = false;
  });

  function pickJob(email, candidates) {
    const options = [...candidates];
    if (jobId && !options.some((c) => c.jobId === jobId)) options.push({ jobId, title: jobLabel, company: '', reason: 'The jawb you have open' });
    if (!options.length) return h('p', { class: 'jc-footnote' }, 'No saved jawb matches this email. Open the jawb it is about and paste it there.');
    const chosen = options.find((c) => c.jobId === jobId) || options[0];
    const list = h('div', { class: 'jc-email__matches', role: 'radiogroup', 'aria-label': 'Which jawb is this email about?' },
      ...options.map((c) => h('label', { class: 'jc-email__match' },
        h('input', { type: 'radio', name: 'emailJob', value: c.jobId, ...(c === chosen ? { checked: '' } : {}) }),
        h('span', {}, h('strong', {}, [c.title, c.company].filter(Boolean).join(' at ')), h('span', { class: 'jc-footnote' }, c.reason)))));
    const go = h('button', { class: 'jc-btn', 'data-size': 'sm', 'data-variant': 'primary', type: 'button' }, 'What does it mean?');
    const result = h('div');
    go.addEventListener('click', async () => {
      const id = list.querySelector('input:checked')?.value;
      if (!id) return;
      err.hidden = true;
      go.disabled = true; go.textContent = 'Reading…';
      try {
        const res = await send('classify-email', { jobId: id, email });
        result.replaceChildren(classificationCard(id, res));
        go.textContent = 'Read again';
        go.disabled = false;
        onChanged?.(id);
      } catch (e) { fail(e, go, 'What does it mean?'); }
    });
    return h('div', { class: 'jc-email__step' },
      h('span', { class: 'jc-eyebrow' }, candidates.length ? 'Best match' : 'Which jawb?'), list,
      h('div', { class: 'jc-btn-row' }, go), result);
  }

  function classificationCard(id, { at, classification: c }) {
    const actions = h('span', { class: 'jc-btn-row' });
    const note = h('p', { class: 'jc-footnote', hidden: '' });
    const act = (label, fn) => {
      const b = h('button', { class: 'jc-btn', 'data-size': 'sm', type: 'button' }, label);
      b.addEventListener('click', async () => {
        b.disabled = true;
        err.hidden = true;
        try { await fn(b); } catch (e) { fail(e, b, label); }
      });
      actions.append(b);
      return b;
    };
    if (c.suggestedStatus) {
      act(`Move to ${statusLabel(c.suggestedStatus)}`, async (b) => {
        const r = await send('email-move-status', { jobId: id, status: c.suggestedStatus });
        b.textContent = r.changed ? `Moved to ${r.label}` : `Kept at ${r.label}`;
        note.hidden = r.changed;
        note.textContent = 'Emails only move a jawb forward, and a jawb you closed by hand stays closed. Change it with Update status if you need to.';
        onChanged?.(id);
      });
    }
    if (c.interviewAt) {
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(c.interviewAt);
      const when = dateOnly ? new Date(`${c.interviewAt}T00:00`).toLocaleDateString([], { dateStyle: 'medium' })
        : new Date(c.interviewAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      act(`Add round on ${when}`, async (b) => {
        await send('email-add-round', { jobId: id, at });
        b.textContent = 'Round added';
        onRound?.(id);
      });
    }
    const reply = h('div');
    act('Draft reply', async (b) => {
      b.textContent = 'Drafting…';
      const r = await send('draft-reply', { jobId: id, at });
      reply.replaceChildren(...replyView(r.reply));
      b.textContent = 'Draft again';
      b.disabled = false;
    });
    return h('div', { class: 'jc-notice', dataset: { tone: TONE[c.kind] || 'info' } },
      h('div', { class: 'jc-notice__body' },
        h('span', { class: 'jc-notice__title' }, KIND[c.kind] || c.kind),
        h('span', {}, c.summary),
        c.questions?.length ? h('ul', { class: 'jc-list' }, ...c.questions.map((q) => h('li', {}, q))) : null,
        actions, note, reply));
  }

  function replyView(r) {
    const copy = h('button', { class: 'jc-btn', 'data-size': 'sm', type: 'button' }, 'Copy reply');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(r.body);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy reply'; }, 1200);
    });
    const facts = [...new Set((r.factGuard?.flags || []).map((f) => f.value))];
    return [
      r.unanswered?.length ? h('div', { class: 'jc-email__unanswered' },
        h('strong', {}, 'Fill these in before sending'),
        h('ul', { class: 'jc-list' }, ...r.unanswered.map((q) => h('li', {}, q)))) : null,
      facts.length ? h('p', { class: 'jc-footnote' }, `Check before sending, not found in your material: ${facts.join(', ')}.`) : null,
      r.subject ? h('p', { class: 'jc-footnote' }, `Subject: ${r.subject}`) : null,
      h('div', { class: 'jc-doc-body jc-email__reply' }, markFlagged(r.body, r.factGuard?.flags)),
      h('div', { class: 'jc-btn-row' }, copy),
    ].filter(Boolean);
  }

  return root;
}
