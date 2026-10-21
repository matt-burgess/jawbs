// How many pages the tailored resume prints to. Renders it with the print
// layout (lib/resumeLayout.js + print/print.css) into a hidden iframe at the
// chosen paper width and divides its height by the printable page height.
// Needs a DOM, so it runs in the Jawbar or Recall, never the service worker.

import { renderResume } from './resumeLayout.js';

const PX = 96; // CSS pixels per inch
const PAPER = { letter: { w: 8.5, h: 11 }, a4: { w: 210 / 25.4, h: 297 / 25.4 } };
// print/print.css: @page { margin: 0.5in 0.6in }.
const MARGIN = { v: 0.5, h: 0.6 };

// ponytail: height / page height ignores the space lost to break-inside: avoid
// on roles, so a resume that only just fits may print one page longer.
// Measure per page (column fragments) if that bites.
export async function measurePages(resume, header, { paper = 'letter', signal } = {}) {
  const size = PAPER[paper] || PAPER.letter;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${size.w * PX}px;height:200px;border:0;visibility:hidden`;
  document.body.append(frame);
  const stop = () => { if (signal?.aborted) throw new DOMException('Measuring cancelled', 'AbortError'); };
  try {
    const doc = frame.contentDocument;
    doc.documentElement.dataset.theme = 'light';
    await Promise.all(['../styles/job-copilot.css', '../print/print.css'].map((rel) => new Promise((resolve) => {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = new URL(rel, import.meta.url).href;
      link.onload = link.onerror = resolve;
      doc.head.append(link);
    })));
    stop();
    // The @media print rules for main, applied on screen.
    const main = doc.createElement('main');
    main.style.cssText = `margin:0;max-width:none;min-height:0;box-shadow:none;box-sizing:border-box;width:${(size.w - 2 * MARGIN.h) * PX}px`;
    doc.body.append(main);
    renderResume(main, resume, header || {});
    await doc.fonts.ready;
    stop();
    const pageHeight = (size.h - 2 * MARGIN.v) * PX;
    return Math.max(1, Math.ceil((main.getBoundingClientRect().height - 1) / pageHeight));
  } finally {
    frame.remove();
  }
}
