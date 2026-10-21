// The resume's printed layout, shared by print/ (the PDF) and
// lib/pageMeasure.js (page counting), so what is measured is what prints.
// Styles: print/print.css.

// Build the resume DOM from the structured JSON the LLM returned +
// header fields pulled from Settings. Order matches the user's target
// design: Header -> Summary -> Skills -> Experience -> Earlier Experience ->
// Certifications & Awards -> Education.
export function renderResume(root, resume, header) {
  root.innerHTML = '';
  // The posting's exact title (v3 resumes) replaces the generic Settings
  // tagline — it's the string a recruiter's title search has to match.
  root.append(buildHeader({ ...header, tagline: resume.headline || header.tagline }));
  if (resume.summary) {
    root.append(sectionTitle('Summary'));
    const p = document.createElement('p');
    p.className = 'rz-summary';
    p.textContent = resume.summary;
    root.append(p);
  }
  if (Array.isArray(resume.skills) && resume.skills.length) {
    root.append(sectionTitle('Skills'));
    const p = document.createElement('p');
    p.className = 'rz-summary';
    p.textContent = resume.skills.join(' | ');
    root.append(p);
  }
  if (Array.isArray(resume.experience) && resume.experience.length) {
    root.append(sectionTitle('Experience'));
    for (const role of resume.experience) root.append(buildRole(role));
  }
  if (Array.isArray(resume.earlierExperience) && resume.earlierExperience.length) {
    root.append(sectionTitle('Earlier Experience'));
    for (const role of resume.earlierExperience) root.append(buildEarlierItem(role));
  }
  if (Array.isArray(resume.certifications) && resume.certifications.length) {
    root.append(sectionTitle('Certifications & Awards'));
    const ul = document.createElement('ul');
    ul.className = 'rz-cert-list';
    for (const cert of resume.certifications) {
      const li = document.createElement('li');
      li.textContent = typeof cert === 'string' ? cert : (cert?.text || '');
      ul.append(li);
    }
    root.append(ul);
  }
  if (Array.isArray(resume.education) && resume.education.length) {
    root.append(sectionTitle('Education'));
    for (const edu of resume.education) root.append(buildEduItem(edu));
  }
}

function buildHeader(header) {
  const wrap = document.createElement('div');
  wrap.className = 'rz-header';
  if (header.name) {
    const h = document.createElement('div');
    h.className = 'rz-name';
    h.textContent = header.name;
    wrap.append(h);
  }
  if (header.tagline) {
    const t = document.createElement('div');
    t.className = 'rz-tagline';
    t.textContent = header.tagline;
    wrap.append(t);
  }
  // Contact line: Location | Phone | Email. Only show segments that
  // have a value; skip empty ones (no " | | " rendering).
  const parts = [];
  if (header.location) parts.push(header.location);
  if (header.phone) parts.push(header.phone);
  if (header.email) parts.push(header.email);
  if (parts.length) {
    const c = document.createElement('div');
    c.className = 'rz-contact';
    c.textContent = parts.join(' | ');
    wrap.append(c);
  }
  return wrap;
}

function sectionTitle(label) {
  const h = document.createElement('div');
  h.className = 'rz-section-head';
  h.textContent = label;
  return h;
}

function buildRole(role) {
  const wrap = document.createElement('div');
  wrap.className = 'rz-role';
  const head = document.createElement('div');
  head.className = 'rz-role__head';
  const titleEl = document.createElement('span');
  titleEl.className = 'rz-role__title';
  titleEl.textContent = role.title || '';
  const datesEl = document.createElement('span');
  datesEl.className = 'rz-role__dates';
  datesEl.textContent = role.dates || '';
  head.append(titleEl, datesEl);
  wrap.append(head);
  const subParts = [role.company, role.location].filter(Boolean);
  if (subParts.length) {
    const sub = document.createElement('p');
    sub.className = 'rz-role__sub';
    sub.textContent = subParts.join(', ');
    wrap.append(sub);
  }
  if (Array.isArray(role.bullets) && role.bullets.length) {
    const ul = document.createElement('ul');
    for (const b of role.bullets) {
      const li = document.createElement('li');
      li.textContent = typeof b === 'string' ? b : (b?.text || '');
      ul.append(li);
    }
    wrap.append(ul);
  }
  return wrap;
}

// Compact one-line entry for older roles — mirrors the user's target
// format: "Role, Company (detail) in Location Dates". Title bold.
function buildEarlierItem(role) {
  const p = document.createElement('p');
  p.className = 'rz-earlier-item';
  const title = document.createElement('strong');
  title.textContent = role.title || '';
  p.append(title);
  const rest = [];
  if (role.company) {
    const compPart = role.detail
      ? `${role.company} ${role.detail}`
      : role.company;
    rest.push(compPart);
  }
  if (role.location) rest.push(`in ${role.location}`);
  if (role.dates) rest.push(role.dates);
  if (rest.length) {
    const span = document.createElement('span');
    span.textContent = `, ${rest.join(', ')}`;
    p.append(span);
  }
  return p;
}

function buildEduItem(edu) {
  const p = document.createElement('p');
  p.className = 'rz-edu-item';
  const degree = document.createElement('strong');
  degree.textContent = edu.degree || '';
  p.append(degree);
  if (edu.school) {
    const span = document.createElement('span');
    span.textContent = `, ${edu.school}`;
    p.append(span);
  }
  return p;
}
