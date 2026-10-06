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

  document.getElementById('printBtn').addEventListener('click', () => window.print());
  setTimeout(() => window.print(), 300);
  chrome.storage.session.remove(key).catch(() => {});
})();

// Build the resume DOM from the structured JSON the LLM returned +
// header fields pulled from Settings. Order matches the user's target
// design: Header -> Summary -> Experience -> Earlier Experience ->
// Certifications & Awards -> Education.
function renderResume(root, resume, header) {
  root.innerHTML = '';
  root.append(buildHeader(header));
  if (resume.summary) {
    root.append(sectionTitle('Summary'));
    const p = document.createElement('p');
    p.className = 'rz-summary';
    p.textContent = resume.summary;
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
