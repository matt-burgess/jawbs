// ALL LinkedIn DOM selectors live here. Ordered most-specific → most-generic.
// LinkedIn ships markup changes often; when a field starts coming back empty,
// use the "Copy DOM snapshot" button in the side panel and add new selectors here.
// The JSON-LD + document.title fallbacks in scrape.js are the safety net.

export const SELECTORS = {
  // Main job container. Used only as a scope for the fallback container.innerText path.
  container: [
    '.jobs-search__job-details',
    '.jobs-details__main-content',
    '.job-view-layout',
    '.scaffold-layout__detail',
    'main',
  ],

  title: [
    '.job-details-jobs-unified-top-card__job-title h1',
    'h1.job-details-jobs-unified-top-card__job-title',
    '.jobs-unified-top-card__job-title',
    '.jobs-details-top-card__job-title',
    'h1.topcard__title',
    'h1[class*="job-title"]',
    '.artdeco-entity-lockup__title h1',
    'section[class*="top-card"] h1',
    '.t-24.t-bold',
    'main h1',
    'h1',
  ],

  company: [
    '.job-details-jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name',
    '.jobs-details-top-card__company-url',
    '.topcard__org-name-link',
    '[data-test-id="job-details-company-name"]',
    'a[data-tracking-control-name="public_jobs_topcard-org-name"]',
    '.artdeco-entity-lockup__subtitle a',
    'section[class*="top-card"] a[href*="/company/"]',
    'a[href*="/company/"][data-test-app-aware-link]',
  ],

  location: [
    '.job-details-jobs-unified-top-card__primary-description-container .tvm__text:first-child',
    '.job-details-jobs-unified-top-card__bullet',
    '.jobs-unified-top-card__bullet',
    '.jobs-details-top-card__bullet',
    '.topcard__flavor--bullet',
    '.artdeco-entity-lockup__caption',
  ],

  workplaceType: [
    '.job-details-jobs-unified-top-card__workplace-type',
    '.jobs-unified-top-card__workplace-type',
  ],

  postedDate: [
    '.jobs-unified-top-card__posted-date',
    '.posted-time-ago__text',
    '.job-details-jobs-unified-top-card__primary-description-container time',
    'time[datetime]',
  ],

  applicantCount: [
    '.jobs-unified-top-card__applicant-count',
    '.job-details-jobs-unified-top-card__primary-description-container .tvm__text--positive',
    '.num-applicants__caption',
  ],

  salary: [
    '.jobs-details__salary-main-rail-card',
    '.job-details-jobs-unified-top-card__job-insight',
    '.compensation__salary-range',
    '[class*="salary"]',
  ],

  description: [
    '#job-details',
    '.jobs-description__content .jobs-box__html-content',
    '.jobs-description-content__text',
    '.jobs-description__content',
    '.jobs-box__html-content',
    '.description__text',
    'article.jobs-description',
    '[class*="jobs-description"] [class*="html-content"]',
    '.mt4:has(.jobs-box__html-content)',
  ],

  recruiter: [
    '.hirer-card__hirer-information',
    '.jobs-poster-card',
    '.job-details-people-who-can-help__section',
    '.jobs-details-top-card__hiring-team',
  ],

  // Where to append the launch button. Falls back to fixed-position pill if none match.
  actionRow: [
    '.jobs-apply-button--top-card',
    '.job-details-jobs-unified-top-card__container--two-pane .display-flex',
    '.jobs-s-apply',
    '.jobs-unified-top-card__actions',
    '.jobs-details-top-card__actions',
  ],
};

// Extracts the LinkedIn job ID from either URL shape.
export function extractJobId(url) {
  const view = url.match(/\/jobs\/view\/(\d+)/);
  if (view) return view[1];
  const search = url.match(/[?&]currentJobId=(\d+)/);
  if (search) return search[1];
  return null;
}
