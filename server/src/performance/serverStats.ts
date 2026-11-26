import { performance } from 'node:perf_hooks';
import type { EventLoopUtilization } from 'node:perf_hooks';

import type { MatchStats } from '../game/Match.ts';

export interface LiveMemoryStats {
  readonly rssBytes: number;
  readonly heapTotalBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly arrayBuffersBytes: number;
}

export interface LiveEventLoopStats {
  readonly utilization: number;
  readonly activeMs: number;
  readonly idleMs: number;
}

export interface LiveServerStats {
  readonly matches: MatchStats[];
  readonly memory: LiveMemoryStats;
  readonly eventLoop: LiveEventLoopStats;
}

export interface LiveMemorySnapshot {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

export interface LiveServerStatsDependencies {
  readonly memoryUsage?: () => LiveMemorySnapshot;
  readonly eventLoopUtilization?: () => EventLoopUtilization;
}

export const collectMemoryStats = (
  memoryUsage: () => LiveMemorySnapshot = () => process.memoryUsage(),
): LiveMemoryStats => {
  const memory = memoryUsage();
  return {
    rssBytes: memory.rss,
    heapTotalBytes: memory.heapTotal,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
  };
};

export const collectEventLoopStats = (
  eventLoopUtilization: () => EventLoopUtilization = () =>
    performance.eventLoopUtilization(),
): LiveEventLoopStats => {
  const elu = eventLoopUtilization();
  const utilization = Number.isFinite(elu.utilization)
    ? Math.max(0, Math.min(1, elu.utilization))
    : 0;

  return {
    utilization,
    activeMs: elu.active,
    idleMs: elu.idle,
  };
};

/**
 * Collects live server match, memory, and process-cumulative Event Loop Utilization (ELU) statistics.
 * Note: `eventLoop` reports cumulative process-lifetime ELU from `performance.eventLoopUtilization()`,
 * independent of LoadProfiler's interval-scoped ELU snapshots.
 */
export const collectLiveServerStats = (
  matches: MatchStats[],
  deps: LiveServerStatsDependencies = {},
): LiveServerStats => ({
  matches,
  memory: collectMemoryStats(deps.memoryUsage),
  eventLoop: collectEventLoopStats(deps.eventLoopUtilization),
});

