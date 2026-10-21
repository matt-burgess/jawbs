// Cover letter tone presets: a voice note for the prompt and the sign-off
// line the letter ends with. Idea from Dossier's tones
// (github.com/AienTech/dossier, AGPL-3.0); reimplemented, no code copied.
export const TONES = {
  warm: { label: 'Warm', signOff: 'Warm regards,',
    voice: 'Friendly and personal: first person, contractions welcome, one line of genuine interest in the team or product.' },
  direct: { label: 'Direct', signOff: 'Best,',
    voice: 'Lead with the strongest match in the first sentence. Short sentences, no pleasantries, every line a fact or an ask.' },
  formal: { label: 'Formal', signOff: 'Sincerely,',
    voice: 'Polished and reserved: no contractions, complete sentences, measured claims, courteous close.' },
};

export const toneKey = (t) => (t in TONES ? t : 'warm');

// The sign-off unit appended to a generated letter (lib/documentUnits.js).
export function signOffUnit(tone, name) {
  const t = TONES[toneKey(tone)];
  return { kind: 'signoff', text: name ? `${t.signOff}\n${name}` : t.signOff };
}
