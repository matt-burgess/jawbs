// The resume as plain text: for copying and for the plain-text print path.
export function resumeToPlainText(r) {
  const lines = [];
  // Legacy v1 shape
  if (r.summaryParagraph || Array.isArray(r.sections)) {
    if (r.summaryParagraph) { lines.push(r.summaryParagraph, ''); }
    for (const s of r.sections || []) {
      lines.push(s.heading || '', '');
      for (const entry of s.entries || []) {
        lines.push(entry.role || '');
        for (const b of entry.bullets || []) lines.push(`• ${b.text}`);
        lines.push('');
      }
    }
    return lines.join('\n');
  }
  // v2 structured shape
  if (r.headline) lines.push(r.headline, '');
  if (r.summary) lines.push(r.summary, '');
  if (Array.isArray(r.skills) && r.skills.length) lines.push('SKILLS', '', r.skills.join(' | '), '');
  if (Array.isArray(r.experience) && r.experience.length) {
    lines.push('EXPERIENCE', '');
    for (const role of r.experience) {
      lines.push(`${role.title || ''} · ${role.dates || ''}`);
      const sub = [role.company, role.location].filter(Boolean).join(', ');
      if (sub) lines.push(sub);
      for (const b of role.bullets || []) lines.push(`• ${typeof b === 'string' ? b : (b?.text || '')}`);
      lines.push('');
    }
  }
  if (Array.isArray(r.earlierExperience) && r.earlierExperience.length) {
    lines.push('EARLIER EXPERIENCE', '');
    for (const role of r.earlierExperience) {
      const bits = [role.company, role.detail, role.location, role.dates].filter(Boolean);
      lines.push(`${role.title || ''}, ${bits.join(', ')}`);
    }
    lines.push('');
  }
  if (Array.isArray(r.certifications) && r.certifications.length) {
    lines.push('CERTIFICATIONS & AWARDS', '');
    for (const c of r.certifications) lines.push(`• ${typeof c === 'string' ? c : (c?.text || '')}`);
    lines.push('');
  }
  if (Array.isArray(r.education) && r.education.length) {
    lines.push('EDUCATION', '');
    for (const e of r.education) lines.push(`${e.degree || ''}, ${e.school || ''}`);
    lines.push('');
  }
  return lines.join('\n');
}
