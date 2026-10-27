// The "Jawbs kit" for a job: what content/kit.js offers on the page opened
// with Open. Built in the side panel and, after a Generate click on that
// page, in the service worker, so both give the same shape.
import { compView, stepStates } from './jawbSteps.js';
import { resumeToPlainText } from './resumeText.js';

// `header` is { name, ... } from the resume-header settings.
export function buildKit(job, { targets, header } = {}) {
  const a = job.analyses || {};
  const st = stepStates(a);
  const answer = st.done.comp ? compView(a.comp, targets || {})?.answer : null;
  const company = (job.posting?.company || 'Company').replace(/[^A-Za-z0-9]+/g, '');
  const last = ((header?.name || '').trim().split(/\s+/).pop() || 'Candidate').replace(/[^A-Za-z0-9]+/g, '');
  const kit = {
    jobId: String(job.jobId), title: job.posting?.title || '', company: job.posting?.company || '', at: Date.now(),
    pay: answer ? { number: answer.number, short: answer.short } : null, resume: null, letter: null, print: {},
  };
  if (st.done.resume) {
    const r = a.resume.result || {};
    const isV2 = r.summary != null || Array.isArray(r.experience);
    kit.resume = resumeToPlainText(r);
    kit.print.resume = { kind: 'Resume', filename: `${last}_${company}_Resume.pdf`, resume: isV2 ? r : null, header: isV2 ? header : null, body: isV2 ? null : kit.resume };
  }
  if (st.done.letter) {
    kit.letter = a.coverLetter.result?.letter || '';
    kit.print.letter = { kind: 'CoverLetter', filename: `${last}_${company}_CoverLetter.pdf`, body: kit.letter };
  }
  return kit;
}
