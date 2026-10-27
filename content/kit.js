// The Jawbs kit: a small floating card on the page the user opened with
// "Open" in the Jawbar. It holds what they keep going back to the Jawbar
// for while applying: the pay answer, the resume and the cover letter.
// It is lifted over the page until they close it, and follows that tab
// from page to page (Google results, then the employer's site).
//
// The service worker decides which tab it belongs to; this script does
// nothing on any other page. It copies or prints; it never types into the form.

(async () => {
  if (window.top !== window) return;
  let res;
  try { res = await chrome.runtime.sendMessage({ type: 'kit-for-tab' }); } catch { return; }
  const kit = res?.data;
  if (!kit || !(kit.pay || kit.resume || kit.letter)) return;

  const host = document.createElement('div');
  host.id = 'jc-kit';
  const root = host.attachShadow({ mode: 'open' });
  let open = true;

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) k === 'onclick' ? n.addEventListener('click', v) : n.setAttribute(k, v);
    n.append(...kids.filter((x) => x != null));
    return n;
  };
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const was = btn.textContent;
    btn.textContent = 'Copied';
    setTimeout(() => { btn.textContent = was; }, 1200);
  }
  const copyBtn = (label, text) => { const b = el('button', { type: 'button' }, label); b.addEventListener('click', () => copy(text, b)); return b; };
  const pdfBtn = (kind) => el('button', { type: 'button', onclick: () => chrome.runtime.sendMessage({ type: 'open-kit-pdf', kind }).catch(() => {}) }, 'PDF');
  const row = (name, ...btns) => el('div', { class: 'r' }, el('span', { class: 'n' }, name), el('span', { class: 'b' }, ...btns));

  function paint() {
    const rows = [
      kit.pay?.number != null ? row(`Pay $${Number(kit.pay.number).toLocaleString('en-US')}`, copyBtn('Copy', String(kit.pay.number))) : null,
      kit.pay?.short ? row('Short answer', copyBtn('Copy', kit.pay.short)) : null,
      kit.resume ? row('Resume', pdfBtn('resume'), copyBtn('Copy text', kit.resume)) : null,
      kit.letter ? row('Cover letter', pdfBtn('letter'), copyBtn('Copy', kit.letter)) : null,
    ].filter(Boolean);
    const head = el('div', { class: 'h' },
      el('div', { class: 't' }, el('strong', {}, kit.title || 'Your application'), kit.company ? el('span', {}, kit.company) : null),
      el('button', { type: 'button', class: 'x', 'aria-label': open ? 'Collapse' : 'Expand', onclick: () => { open = !open; paint(); } }, open ? '–' : '+'),
      el('button', { type: 'button', class: 'x', 'aria-label': 'Close', onclick: () => { host.remove(); chrome.runtime.sendMessage({ type: 'kit-dismiss' }).catch(() => {}); } }, '×'));
    root.replaceChildren(el('style', {}, `
      :host{all:initial;position:fixed;top:16px;right:16px;z-index:2147483646;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
      .k{width:300px;background:#0E131B;color:#E6EDF5;border:1px solid #3B4B61;border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
      .h{display:flex;align-items:flex-start;gap:6px;padding:10px 10px 10px 12px}
      .t{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
      .t strong{font-size:14px;line-height:1.25}
      .t span{font-size:12px;color:#8C9AAD}
      .r{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-top:1px solid #2B384A}
      .n{font-weight:600}
      .b{display:flex;gap:6px;flex:none}
      button{font:600 12px/1 system-ui,sans-serif;color:#B3C0CF;background:transparent;border:1px solid #3B4B61;border-radius:4px;padding:6px 10px;cursor:pointer}
      button:hover{color:#E6EDF5;border-color:#22CCEE}
      button.x{border:0;padding:2px 7px;font-size:18px;line-height:1}`),
      el('div', { class: 'k', role: 'dialog', 'aria-label': 'Jawbs kit' }, head, ...(open ? rows : [])));
  }
  paint();
  document.documentElement.append(host);
})();
