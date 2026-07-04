/**
 * リトライのバックオフ遅延 (ms)。
 * `delay = min(base * 2^(attempt-1), max)`。attempt は 1 始まり。
 */
export function computeBackoff(
  attempt: number,
  base = 10_000,
  max = 300_000,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = base * Math.pow(2, n - 1);
  return Math.min(raw, max);
}
