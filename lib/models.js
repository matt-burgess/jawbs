// Model registry — Anthropic-native IDs plus the currently-selected
// default per non-Anthropic provider. Only one model per provider gets
// used in the shipped MVP; power users can extend PROVIDER_DEFAULTS
// or override per-feature in a later patch.

export const MODEL_IDS = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

export const DEFAULT_MODELS = {
  fit: MODEL_IDS.sonnet,
  comp: MODEL_IDS.sonnet,
  questionPrep: MODEL_IDS.sonnet,
  coverLetter: MODEL_IDS.opus,
  resume: MODEL_IDS.opus,
  diagnostic: MODEL_IDS.haiku,
};

// Per-provider defaults. `main` handles every feature; `fast` runs
// the connectivity diagnostic where a cheap round-trip is fine.
export const PROVIDER_DEFAULTS = {
  anthropic: {
    main: MODEL_IDS.sonnet,
    fast: MODEL_IDS.haiku,
  },
  openai: {
    main: 'gpt-4o',
    fast: 'gpt-4o-mini',
  },
  gemini: {
    main: 'gemini-2.5-pro',
    fast: 'gemini-2.5-flash',
  },
};

export function defaultModelForProvider(provider) {
  const set = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.anthropic;
  return set.main;
}

export function defaultDiagnosticModelForProvider(provider) {
  const set = PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.anthropic;
  return set.fast;
}
