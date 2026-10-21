# Changelog

## 0.11.0 · 2026-10-21

Ideas from [Dossier](https://github.com/AienTech/dossier) (AGPL-3.0), a
self-hosted job search app by AienTech. The ideas were reimplemented in
Jawbs' own code; no Dossier code was copied.

- **Requirement map.** Each requirement in the posting is marked covered,
  partial or gap. The model only points at excerpts of your material; code
  checks each excerpt exists and decides the state. Gaps become one-click
  chips above Chat.
- **Fact guard.** Every generated letter, resume, follow-up, drafted answer
  and email reply is checked for numbers, years, acronyms, names and
  credentials that are not in your material or the posting. Flagged
  sentences are underlined, and the tab shows a count. Optional Strict facts
  mode retries once without them.
- **Documents as units with history.** The tailored resume and cover letter
  are stored as parts. Edit, regenerate or remove one part; ask Chat to edit
  the letter or resume in words; undo the last change or restore any of the
  last 25 versions. Works in the Jawbar and in Recall, which now shows the
  tailored resume (it rendered blank before).
- **Page limit.** Hold tailored resumes to one or two pages, US Letter or A4.
  Jawbs measures the printed resume and trims the least valuable parts first,
  never your latest role or anything that speaks to a must-have. Trimmed
  parts can be put back.
- **Paste an email.** Match a recruiter email to its jawb, see what it means,
  move the status (forward only), add the interview round with its date, and
  draft a reply that lists the questions you still need to answer.
- **Untrusted text fences.** Postings and emails are marked as material to
  read, never instructions, in every prompt.
- **Undoable status changes.** Undo from the LinkedIn toast and the Jawboard
  reconcile dialog; the Strike Rate funnel counts the furthest stage a jawb
  reached.
- **Named progress steps** under the progress bar for multi-call analyses,
  restored if the Jawbar is reopened mid-run.
- **Letter tone presets** Warm, Direct and Formal, each with its own voice
  and sign-off, kept per jawb with a default in Settings.
- **Profile strength** meter on Settings → You → About me.

Also: no em or en dashes in UI copy; the resume prompt writes date ranges
with a hyphen. Deferred: an opt-in usage ping (see `docs/decisions.md`).
