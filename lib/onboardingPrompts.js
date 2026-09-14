// Shared onboarding prompts — used by the setup wizard (welcome/setup.js)
// AND the per-field ✨ Get AI prompt buttons on the Settings page
// (options.js). Every prompt has the same two-branch structure: if the
// user's AI has memory of them, draft the file directly; otherwise, ask
// a targeted question sequence first.

export const PROMPTS = {
  profile: {
    title: 'Profile — about-me.md',
    intro: 'Produces a compact profile document. Positioning, most recent role, prior chapter, anything else worth naming.',
    body: `You are helping me populate the Profile field of Jawbs, a browser extension that reads LinkedIn job postings and scores them against my background. I need a Markdown document I can paste in.

Structure the document as flowing paragraphs (no bullets) in this order:
1. Two-sentence positioning: the level I'm targeting next, the geography I can work from, the work modes I accept (remote-only / hybrid / on-site OK).
2. 3-4 sentences on my most recent role: company, team size, scope, the outcomes I owned. Concrete metrics if I have them.
3. 3-4 sentences on the prior chapter: what I built or led, and the anchor story that carries into my current search.
4. A short "anything else worth naming" paragraph: side projects, certifications, writing, teaching, unusual credentials.

Rules:
- First person. Present tense for current state, past tense for past chapters.
- Concrete over abstract. Real metrics beat vague claims.
- Around 300-450 words total.
- Output as Markdown with no preamble — just the content, ready to paste.

Do you already know enough about my background from our prior conversations to draft this directly? If yes, draft it now and I'll refine.

If not, ask me these questions one at a time and wait for each answer before moving on:
1. What role and level are you targeting next? (e.g., "Senior Engineering Manager", "Head of Product")
2. Where can you work from, and what work modes do you accept?
3. Tell me about your most recent role — company, team size, what you owned, and one or two concrete outcomes with metrics.
4. Tell me about the role before that — same structure.
5. Anything else worth naming? Side projects, certifications, writing, teaching, unusual credentials.

Once you have my answers (or if you already knew), produce the final Markdown document with no preamble.`,
  },

  knowledge: {
    title: 'Extended knowledge base',
    intro: 'Produces a longer, deeper knowledge document that supplements the Profile — background stories, formative experiences, patterns you look for.',
    body: `You are helping me populate the Extended Knowledge Base field of Jawbs, a browser extension that reads LinkedIn job postings and scores them against my background. This document is prepended to every analysis prompt on top of the shorter Profile, so it should go deeper and cover material the Profile can't fit.

Structure as Markdown with clear headings. Suggested sections (skip any that don't apply):
- ## Career arc — the shape of my career so far and where I'm heading
- ## Deep stories — 3-5 specific projects or outcomes I can defend in interviews, each with context, decision, action, result
- ## Patterns I look for — the kinds of problems / teams / companies I do my best work in
- ## Dealbreakers — the kinds of roles or environments I decline
- ## Working style — how I communicate, decide, disagree, and manage
- ## What I'm learning / building now — currency signals
- ## Adjacent capabilities — things not on the resume that recruiters miss

Rules:
- First person, direct, no hedging.
- Concrete stories with names and numbers when possible.
- 800-1500 words is a reasonable target. Longer is fine if you have material.
- Output as Markdown with no preamble.

Do you already know enough from our prior conversations to draft this? If yes, do it now.

If not, walk me through each section one at a time — ask the section's question, wait for my answer, then move on. Once you've collected everything, assemble the final Markdown document.`,
  },

  resume: {
    title: 'Master resume',
    intro: 'Produces the full source-of-truth resume. Every tailored resume Jawbs generates traces back to a bullet here.',
    body: `You are helping me build a master resume for Jawbs, a job-search browser extension. This is the source-of-truth document — every specific bullet in a tailored resume must trace back to a bullet here. Comprehensive beats concise.

Structure (Markdown):

# Full Name
Email · Phone · City, Region · linkedin.com/in/handle · (github/portfolio if relevant)

## Summary
One paragraph, 3-4 sentences. Level, domain, differentiator.

## Experience
### Company · Title · Location · YYYY–YYYY (or Present)
- Achievement bullets (5-8 per role). Each starts with a strong verb, quantifies impact when possible, and describes both what I did and the outcome.
- Include the tools, methods, or technologies used inline where relevant.

(Repeat for every meaningful role. If we've covered less than the last 10-15 years, keep going.)

## Education
### Degree · Institution · Year

## Skills / Tools (optional)
Grouped list — languages, frameworks, methods.

## Certifications / Publications / Speaking (optional)

Rules:
- This is the SOURCE — maximize concrete detail. Not for external submission.
- Every claim must be one I can defend in an interview.
- Output as clean Markdown, no preamble.

Do you already have enough of my history from our prior conversations to draft this directly? If yes, draft it and I'll fill in anything you couldn't.

If not, ask me role-by-role, starting with my current or most recent job and working backwards. For each role, gather: title, dates, one-sentence context, and 5-8 things I did with outcomes. When I say "that's it" or we've reached my first role, produce the final Markdown resume with no preamble.`,
  },

  samples: {
    title: 'Writing samples',
    intro: 'Collects 2-3 paragraphs in your own voice. Used to anchor cover letters and interview-answer prep so drafts sound like you.',
    body: `I need 2-3 paragraphs of my own writing to give a job-search AI a reference for my voice. Paste them exactly — no editing, no polishing. Corporate-speak is the enemy; the goal is voice.

If you have samples of my writing from our previous conversations (Slack posts, LinkedIn posts, email drafts, blog snippets, Substack), pick 2-3 that:
1. Show me in my own voice — not template-speak
2. Cover different registers (persuasive, explanatory, casual)
3. Total roughly 300-600 words combined

Output them as a plain Markdown document — just the samples, separated by "---", with a one-line label above each ("From: LinkedIn post, 2024" / "From: Slack, retro thread" / etc.). No preamble.

If you don't have any of my writing on file, ask me: paste 2-3 things you've written in the last year that sound like you — a Slack rant, a LinkedIn post, a cover email, a Substack draft, anything. Wait for the paste, then output in the same Markdown format.`,
  },

  prepQuestions: {
    title: 'Question Prep questions',
    intro: 'Produces a list of interview questions tuned to your target level. Jawbs\'s Bait button generates answers for each per posting.',
    body: `I need a list of interview questions I'll likely face, tuned to my target role and level. This list will feed a job-search extension that generates tailored answers per posting.

If you know my target role and level from our prior conversations, produce 12-20 questions covering:
- Behavioral (STAR triggers: "tell me about a time…")
- Situational ("how would you approach…")
- Role-specific technical or leadership questions for MY target level
- Motivation ("why this role", "why this company", "why now")
- Reverse-interview questions (things I should ask them)

Format: one question per line, no numbering, no headers, no section labels. Just the questions in the order I should prep them.

If you don't know my target role, first ask: "What role and level are you targeting next, and what industry or domain?" Wait for my answer, then produce the list.`,
  },
};
