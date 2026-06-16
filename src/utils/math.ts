/**
 * Rounds a ratio to a percentage with 2 decimal places.
 * Single source of truth — imported by all service files.
 * e.g. roundPercentage(3, 5) → 60, roundPercentage(1, 3) → 33.33
 */
export function roundPercentage(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 10_000) / 100;
}
