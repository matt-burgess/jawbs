import { renderResume } from '../lib/resumeLayout.js';

(async () => {
  const params = new URLSearchParams(location.search);
  const key = params.get('k');
  if (!key) {
    document.getElementById('doc').textContent = 'No document key provided.';
    return;
  }
  const r = await chrome.storage.session.get(key);
  const data = r[key];
  if (!data) {
    document.getElementById('doc').textContent = 'Document data not found (session may have expired).';
    return;
  }
  document.title = data.filename || 'Jawbs document';
  document.getElementById('filename').textContent = data.filename || '';

  const docEl = document.getElementById('doc');
  // Branch: structured resume (new PDF layout) vs. plain text body
  // (cover letters, legacy callers). Resumes pass `resume` + `header`;
  // cover letters pass just `body`.
  if (data.resume && typeof data.resume === 'object') {
    renderResume(docEl, data.resume, data.header || {});
  } else {
    docEl.classList.add('rz-body-text');
    docEl.textContent = data.body || '';
    // Serif body for cover letters — matches the earlier print layout.
    docEl.style.fontFamily = 'Georgia, "Times New Roman", serif';
    docEl.style.fontSize = '11.5pt';
    docEl.style.lineHeight = '1.5';
  }

  // Settings → Documents → Paper. print.css defaults to US Letter.
  if (data.paper === 'a4') document.head.append(Object.assign(document.createElement('style'), { textContent: '@page { size: A4; }' }));

  document.getElementById('printBtn').addEventListener('click', () => window.print());
  setTimeout(() => window.print(), 300);
  chrome.storage.session.remove(key).catch(() => {});
})();
