// "Is this pay enough for me?" — the posted (or offered) base range
// against the user's own floor and target from Settings. Arithmetic, not
// a model call, so the answer is exact and matches the numbers shown.
const k = (n) => `$${Math.round(n / 1000)}K`;

// { tone: 'pos'|'caution'|'neg', label, detail } or null when the user
// has set neither floor nor target, or the range has no numbers.
export function compVerdict({ low, high } = {}, { floor, target } = {}) {
  floor = Number(floor) || null;
  target = Number(target) || null;
  if (!floor && !target) return null;
  low = Number.isFinite(low) ? low : (Number.isFinite(high) ? high : null);
  high = Number.isFinite(high) ? high : low;
  if (low == null) return null;
  if (floor && high < floor) return { tone: 'neg', label: 'Below your floor', detail: `Top end ${k(high)} is ${k(floor - high)} under your floor ${k(floor)}` };
  if (floor && low < floor) {
    return { tone: 'caution', label: 'Low end under your floor', detail: `${k(low)} low vs ${k(floor)} floor${target && high >= target ? ` · top ${k(high)} clears your target` : ''}` };
  }
  if (!target) return { tone: 'pos', label: 'Clears your floor', detail: `Low end ${k(low)} vs floor ${k(floor)}` };
  if (low >= target) return { tone: 'pos', label: 'Clears your target', detail: `Low end ${k(low)} vs target ${k(target)}` };
  if (high >= target) return { tone: 'caution', label: 'Top end reaches your target', detail: `Low end ${k(low)} is under your target ${k(target)}` };
  return { tone: 'caution', label: floor ? 'Above floor, under target' : 'Under your target', detail: `Top end ${k(high)} vs target ${k(target)}` };
}

// Percent positions for the range bar: the posted band and the floor and
// target ticks on one shared scale. null when there's nothing to place.
export function rangeBar({ low, high } = {}, { floor, target } = {}) {
  floor = Number(floor) || null;
  target = Number(target) || null;
  if (!Number.isFinite(low) || !Number.isFinite(high) || (!floor && !target)) return null;
  const min = Math.min(low, floor || low, target || low) * 0.85;
  const max = Math.max(high, floor || high, target || high) * 1.05;
  const pct = (n) => Math.round(((n - min) / (max - min)) * 1000) / 10;
  return {
    band: { left: pct(low), width: Math.max(pct(high) - pct(low), 1) },
    floor: floor ? pct(floor) : null,
    target: target ? pct(target) : null,
  };
}
