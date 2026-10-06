// Boots the floating quick-fill toolbar used across every extension
// page (sidepanel, archive, recall, options). Returns the mutable
// cache object so pages that edit the same contact fields in-situ
// (the Options page's Save handlers) can poke keys for immediate
// feedback without waiting for storage.onChanged to echo back.
//
// Four fields: email, phone, LinkedIn URL, "City, State" location.
// Loads initial values from storage, wires live updates via
// chrome.storage.onChanged, and attaches the toolbar handler to the
// given root (defaults to document.body).

import { attachQuickFill } from './linkedInFill.js';
import {
  getContactEmail,
  getContactPhone,
  getLinkedInProfileUrl,
  getContactLocation,
} from './store.js';

export function initQuickFill(root = document.body) {
  const cache = { email: '', phone: '', linkedInUrl: '', location: '' };
  attachQuickFill(root, () => cache);
  Promise.all([
    getContactEmail(), getContactPhone(), getLinkedInProfileUrl(), getContactLocation(),
  ]).then(([email, phone, linkedInUrl, location]) => {
    Object.assign(cache, { email, phone, linkedInUrl, location });
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes['settings.linkedInProfileUrl']) cache.linkedInUrl = changes['settings.linkedInProfileUrl'].newValue || '';
    if (changes['settings.email']) cache.email = changes['settings.email'].newValue || '';
    if (changes['settings.phone']) cache.phone = changes['settings.phone'].newValue || '';
    if (changes['settings.location']) cache.location = changes['settings.location'].newValue || '';
  });
  return cache;
}
