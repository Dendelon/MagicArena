import { describe, expect, test } from 'vitest';
import { toTick } from '@magicarena/shared';

import { collectLiveServerStats } from '../src/performance/serverStats.ts';
import type { MatchStats } from '../src/game/Match.ts';

describe('collectLiveServerStats', () => {
  test('formats matches, process memoryUsage, and cumulative ELU snapshot', () => {
    const sampleMatches: MatchStats[] = [
      {
        roomId: 'arcane',
        tick: toTick(120),
        targetHz: 30,
        lastStepMs: 1.4,
        avgStepMs: 1.1,
        lastJitterMs: 0.25,
        avgJitterMs: 0.15,
        players: 2,
      },
    ];

    const stats = collectLiveServerStats(sampleMatches, {
      memoryUsage: () => ({
        rss: 100_000_000,
        heapTotal: 50_000_000,
        heapUsed: 32_000_000,
        external: 2_500_000,
        arrayBuffers: 512_000,
      }),
      eventLoopUtilization: () => ({
        utilization: 0.125,
        active: 1250,
        idle: 8750,
      }),
    });

    expect(stats).toEqual({
      matches: sampleMatches,
      memory: {
        rssBytes: 100_000_000,
        heapTotalBytes: 50_000_000,
        heapUsedBytes: 32_000_000,
        externalBytes: 2_500_000,
        arrayBuffersBytes: 512_000,
      },
      eventLoop: {
        utilization: 0.125,
        activeMs: 1250,
        idleMs: 8750,
      },
    });
  });

  test('reads real process.memoryUsage and cumulative performance.eventLoopUtilization defaults', () => {
    const stats = collectLiveServerStats([]);

    expect(stats.matches).toEqual([]);
    expect(stats.memory.rssBytes).toBeGreaterThan(0);
    expect(stats.memory.heapUsedBytes).toBeGreaterThan(0);
    expect(stats.eventLoop.utilization).toBeGreaterThanOrEqual(0);
    expect(stats.eventLoop.utilization).toBeLessThanOrEqual(1);
    expect(Number.isFinite(stats.eventLoop.activeMs)).toBe(true);
    expect(Number.isFinite(stats.eventLoop.idleMs)).toBe(true);
  });
});

