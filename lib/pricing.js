// Approximate per-million-token pricing (USD). Update if Anthropic pricing changes.
// Marked APPROXIMATE — never present these as authoritative billing figures.
export const MODEL_PRICING = {
  'claude-opus-4-7':          { input:  15.00, output:  75.00 },
  'claude-sonnet-4-6':        { input:   3.00, output:  15.00 },
  'claude-haiku-4-5-20251001':{ input:   0.80, output:   4.00 },
};

export function estimateCostUsd(model, usage) {
  if (!model || !usage) return null;
  const p = MODEL_PRICING[model];
  if (!p) return null;
  const input = (usage.input_tokens  || 0) * p.input  / 1_000_000;
  const output = (usage.output_tokens || 0) * p.output / 1_000_000;
  return input + output;
}

export function formatUsd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}
