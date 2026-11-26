export interface TimingSummary {
  readonly count: number;
  readonly min: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

const nearestRank = (sorted: readonly number[], percentile: number): number => {
  const rawIndex = Math.ceil(percentile * sorted.length) - 1;
  const clampedIndex = Math.max(0, Math.min(sorted.length - 1, rawIndex));
  return sorted[clampedIndex] ?? 0;
};

export const summarizeTimings = (
  samples: readonly number[],
): TimingSummary | null => {
  if (samples.length === 0) {
    return null;
  }

  const sorted = [...samples].sort((a, b) => a - b);

  let sum = 0;
  for (const value of sorted) {
    sum += value;
  }

  const first = sorted[0] ?? 0;
  const last = sorted[sorted.length - 1] ?? 0;

  return {
    count: sorted.length,
    min: first,
    mean: sum / sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    max: last,
  };
};

