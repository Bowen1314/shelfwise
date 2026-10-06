/**
 * How an affinity reads on screen and in summaries. Live Qloo affinities carry up to 16 decimals
 * (0.9432074816979662); two are enough to read, and the evidence keeps the exact value.
 */
export function formatAffinity(value: number): string {
  return String(Math.round(value * 100) / 100);
}
