// Helpers every extension page imports.
//
// $          — document.getElementById shortcut.
// els        — Proxy that resolves ids lazily on access, so a page can
//              reference `els.foo` even before #foo renders.
// escapeHtml — for the few innerHTML template sites.
// fmtDate    — ISO → "Oct 3, 2026"; '—' when empty.
// send(type) — RPC to the service worker. Throws on no-response or
//              `{ ok: false, error }`, so callers can rely on
//              `await send(...)` meaning success.

export const $ = (id) => document.getElementById(id);
export const els = new Proxy({}, { get: (_, id) => $(id) });

export async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error('No response from service worker');
  if (!response.ok) throw new Error(response.error || 'Unknown error');
  return response;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}
