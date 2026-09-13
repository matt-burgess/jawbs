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
  document.getElementById('doc').textContent = data.body || '';

  document.getElementById('printBtn').addEventListener('click', () => window.print());

  // Auto-open the print dialog once the page paints. Users can dismiss and use
  // the button if they wanted to edit first (letter is editable in the panel).
  setTimeout(() => window.print(), 300);

  // Clean up the session key to avoid clutter.
  chrome.storage.session.remove(key).catch(() => {});
})();
