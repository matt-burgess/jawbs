// Floating quick-fill toolbar that appears above any focused text input or
// textarea. Shows one pill per stored contact value (email, phone, LinkedIn
// URL, "city, state"). Clicking a pill pastes that value into the focused
// field. Field context is intentionally ignored per the user's directive —
// the toolbar always offers all four values regardless of the field's
// label, placeholder, or type. Buttons only render for values the user has
// actually saved in Options → Shortcuts.
//
// When any settings are missing, a trailing "ⓘ" info button appears in the
// same row; hovering it reveals which values still need to be set.

const TOOLBAR_ID = 'jc-quickfill-bar';

// Each entry: [values-key, pill label, long name used in the missing-values
// tooltip]. Long names are more descriptive so the "set more values" hint
// reads naturally when several are missing.
const FIELD_DEFS = [
  ['email',       'Email',       'Email'],
  ['phone',       'Phone',       'Phone Number'],
  ['linkedInUrl', 'LinkedIn',    'LinkedIn Profile'],
  ['location',    'City, State', 'City/State'],
];

// `getValues` is a fn returning { email, phone, linkedInUrl, location }.
// Values may be empty strings; empty ones are omitted from the toolbar.
// `opts.onDraftAi` — optional async fn ({ target, question }) => answerString.
// When provided AND the focused element is a <textarea>, a "🦈 Draft"
// pill appears in the toolbar. Clicking it invokes onDraftAi with the
// target element; the returned string is pasted into the textarea.
export function attachQuickFill(root, getValues, opts = {}) {
  const onDraftAi = typeof opts.onDraftAi === 'function' ? opts.onDraftAi : null;
  let currentBar = null;
  let currentTarget = null;

  const isFillTarget = (el) => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return false;
    if (el.readOnly || el.disabled) return false;
    if (el.dataset.fill === 'none') return false; // opt-out (options page fields storing the values themselves)
    if (el instanceof HTMLInputElement) {
      // Skip non-text input types where paste would be meaningless / destructive.
      const t = (el.type || 'text').toLowerCase();
      const OK = new Set(['text', 'email', 'tel', 'url', 'search', 'password', '']);
      if (!OK.has(t)) return false;
    }
    return true;
  };

  const remove = () => {
    if (currentBar) { currentBar.remove(); currentBar = null; }
    currentTarget = null;
  };

  const position = () => {
    if (!currentBar || !currentTarget) return;
    const rect = currentTarget.getBoundingClientRect();
    currentBar.style.top = `${rect.top + window.scrollY - currentBar.offsetHeight - 4}px`;
    currentBar.style.left = `${rect.left + window.scrollX}px`;
  };

  const fillValue = (value) => {
    if (!currentTarget) return;
    currentTarget.value = value;
    currentTarget.dispatchEvent(new Event('input', { bubbles: true }));
    currentTarget.dispatchEvent(new Event('change', { bubbles: true }));
    const t = currentTarget;
    remove();
    t.focus();
  };

  const makePill = (label, value) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.title = value;
    btn.style.cssText = [
      'padding: 3px 8px',
      'background: var(--jc-accent, #F59320)',
      'color: var(--jc-accent-ink, #1B0703)',
      'border: 1px solid var(--jc-accent, #F59320)',
      'border-radius: 4px',
      'font: 600 11px/1 var(--jc-font, system-ui, sans-serif)',
      'cursor: pointer',
      'white-space: nowrap',
    ].join(';');
    btn.onmousedown = (ev) => ev.preventDefault(); // keep target focused
    btn.onclick = () => fillValue(value);
    return btn;
  };

  // Draft-with-AI pill — only rendered when opts.onDraftAi is provided
  // AND the focused element is a <textarea>. Styled with a teal accent
  // so it's visually distinct from the orange contact-fill pills. Async
  // onclick shows a working state and re-enables on error so the user
  // can retry without moving focus.
  const makeDraftPill = () => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = 'Draft an answer with your AI, grounded in your resume + this jawb.';
    btn.style.cssText = [
      'padding: 3px 8px',
      'background: #235A5D',
      'color: #ffffff',
      'border: 1px solid #235A5D',
      'border-radius: 4px',
      'font: 600 11px/1 var(--jc-font, system-ui, sans-serif)',
      'cursor: pointer',
      'white-space: nowrap',
      'display: inline-flex',
      'align-items: center',
      'gap: 4px',
    ].join(';');
    // Jawbar logo as the pill's icon — served from web_accessible_resources
    // via chrome.runtime.getURL so the ATS page can load it. Icon element
    // is kept in the DOM across state changes; only the sibling label span
    // swaps text so we don't have to re-append the image every re-render.
    const icon = document.createElement('img');
    try { icon.src = chrome.runtime.getURL('assets/jawb-logo.png'); } catch { /* content script context — leave blank */ }
    icon.alt = '';
    icon.style.cssText = 'width: 12px; height: 12px; flex: none; display: block;';
    const label = document.createElement('span');
    label.textContent = 'Draft';
    btn.appendChild(icon);
    btn.appendChild(label);

    btn.onmousedown = (ev) => ev.preventDefault();
    btn.onclick = async () => {
      if (!currentTarget || btn.disabled) return;
      const originalLabelText = label.textContent;
      const originalTitle = btn.title;
      btn.disabled = true;
      label.textContent = 'Drafting…';
      btn.title = 'Drafting…';
      try {
        const answer = await onDraftAi({ target: currentTarget });
        if (answer && typeof answer === 'string') fillValue(answer);
        // fillValue removes the bar, so no state restoration needed on success.
      } catch (e) {
        label.textContent = 'Retry';
        btn.title = e?.message || 'Draft failed — click to retry';
        btn.style.background = '#CC0000';
        btn.style.borderColor = '#CC0000';
        btn.disabled = false;
        setTimeout(() => {
          if (!btn.isConnected) return;
          label.textContent = originalLabelText;
          btn.title = originalTitle;
          btn.style.background = '#235A5D';
          btn.style.borderColor = '#235A5D';
        }, 3500);
      }
    };
    return btn;
  };

  const makeInfoIcon = (missingLongNames) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'ⓘ';
    btn.title = `Set more values in Jawbs → Settings → Shortcuts for ${missingLongNames.join(', ')}.`;
    btn.setAttribute('aria-label', btn.title);
    btn.style.cssText = [
      'padding: 3px 6px',
      'background: transparent',
      'color: rgba(0,0,0,0.55)',
      'border: 1px solid rgba(0,0,0,0.15)',
      'border-radius: 4px',
      'font: 600 12px/1 var(--jc-font, system-ui, sans-serif)',
      'cursor: help',
    ].join(';');
    btn.onmousedown = (ev) => ev.preventDefault();
    return btn;
  };

  const buildBar = (values, targetEl) => {
    const bar = document.createElement('div');
    bar.id = TOOLBAR_ID;
    bar.style.cssText = [
      'position: absolute',
      'display: flex',
      'align-items: center',
      'gap: 4px',
      'z-index: 2147483000',
      'padding: 3px',
      'background: rgba(255,255,255,0.95)',
      'border: 1px solid rgba(0,0,0,0.15)',
      'border-radius: 6px',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.15)',
    ].join(';');
    // Keep click focus inside the bar from stealing selection from the input.
    bar.onmousedown = (ev) => ev.preventDefault();

    let pillCount = 0;
    const missingLongNames = [];
    for (const [key, pillLabel, longName] of FIELD_DEFS) {
      const value = values[key];
      if (value) {
        bar.appendChild(makePill(pillLabel, value));
        pillCount++;
      } else {
        missingLongNames.push(longName);
      }
    }
    if (missingLongNames.length) bar.appendChild(makeInfoIcon(missingLongNames));
    // Draft-with-AI pill only for textareas (long-form questions). Short
    // inputs like Email / Phone / City don't warrant an LLM roundtrip.
    if (onDraftAi && targetEl instanceof HTMLTextAreaElement) {
      bar.appendChild(makeDraftPill());
      pillCount++;
    }
    // Render the bar as long as SOMETHING is showable — either a pill or
    // the info icon. If every value is set, the info icon is absent and we
    // fall back to the pills-only case (still rendered).
    return (pillCount || missingLongNames.length) ? bar : null;
  };

  root.addEventListener('focusin', (e) => {
    // The LinkedIn walker sets this flag while a full sync is running;
    // don't pop pills over the tab we're driving.
    if (typeof window !== 'undefined' && window.__JT_SYNCING__) return;
    if (!isFillTarget(e.target)) return;
    const values = getValues() || {};
    remove();
    const bar = buildBar(values, e.target);
    if (!bar) return;
    currentTarget = e.target;
    currentBar = bar;
    document.body.appendChild(currentBar);
    requestAnimationFrame(position);
  });

  root.addEventListener('focusout', () => {
    setTimeout(() => {
      if (!currentBar) return;
      const active = document.activeElement;
      if (active === currentTarget) return;
      if (currentBar.contains(active)) return;
      remove();
    }, 100);
  });

  window.addEventListener('scroll', position, true);
  window.addEventListener('resize', position);
}
