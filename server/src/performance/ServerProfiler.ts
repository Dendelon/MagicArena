import {
  performance,
  PerformanceObserver,
} from 'node:perf_hooks';

import { diffPoolStats, summarizeTimings } from '@magicarena/shared';
import type {
  PoolDeltaStats,
  TimingSummary,
  WorldPoolStats,
} from '@magicarena/shared';

import { HttpError } from '../errors.ts';

export const DEFAULT_SERVER_PROFILE_DURATION_MS = 30_000;

const MAX_SAMPLE_CAPACITY = 32_768;

export interface ServerGcSummary {
  readonly count: number;
  readonly totalDurationMs: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
}

export interface ServerProfileResult {
  readonly durationMs: number;
  readonly ticks: number;
  readonly ticksOver33Ms: number;
  readonly tickMs: TimingSummary | null;
  readonly worldStepMs: TimingSummary | null;
  readonly collisionMs: TimingSummary | null;
  readonly snapshotCreateMs: TimingSummary | null;
  readonly binaryEncodingMs: TimingSummary | null;
  readonly broadcastMs: TimingSummary | null;
  readonly gc: ServerGcSummary;
  readonly memory: {
    readonly heapUsedBefore: number;
    readonly heapUsedAfter: number;
    readonly rssBefore: number;
    readonly rssAfter: number;
  };
  readonly entities: {
    readonly avg: number | null;
    readonly max: number | null;
  };
  readonly players: number | null;
  readonly pools: {
    readonly bullets: PoolDeltaStats;
    readonly particles: PoolDeltaStats;
  } | null;
}

export type ServerProfileState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'running';
      readonly durationMs: number;
      readonly elapsedMs: number;
    }
  | {
      readonly status: 'completed';
      readonly result: ServerProfileResult;
    };

export interface MemorySample {
  readonly heapUsed: number;
  readonly rss: number;
}

export interface ServerProfilerOptions {
  readonly now?: () => number;
  readonly memoryUsage?: () => MemorySample;
  readonly enableGcObserver?: boolean;
  readonly getPoolStats?: () => WorldPoolStats | null;
}

class MetricBuffer {
  readonly #buffer: Float64Array;
  #count = 0;

  constructor(capacity = MAX_SAMPLE_CAPACITY) {
    this.#buffer = new Float64Array(capacity);
  }

  push(value: number): void {
    if (this.#count < this.#buffer.length) {
      this.#buffer[this.#count] = value;
      this.#count += 1;
    }
  }

  get count(): number {
    return this.#count;
  }

  toArray(): number[] {
    return Array.from(this.#buffer.subarray(0, this.#count));
  }

  summarize(): TimingSummary | null {
    if (this.#count === 0) return null;
    return summarizeTimings(this.toArray());
  }
}

export class ServerProfiler {
  readonly #now: () => number;
  readonly #memoryUsage: () => MemorySample;
  readonly #enableGcObserver: boolean;
  readonly #getPoolStats: (() => WorldPoolStats | null) | null;

  #status: 'idle' | 'running' | 'completed' = 'idle';
  #requestedDurationMs = 0;
  #startedAt = 0;
  #endedAt: number | null = null;
  #memoryBefore: MemorySample = { heapUsed: 0, rss: 0 };
  #poolsBefore: WorldPoolStats | null = null;

  #tickBuffer: MetricBuffer | null = null;
  #worldStepBuffer: MetricBuffer | null = null;
  #collisionBuffer: MetricBuffer | null = null;
  #snapshotCreateBuffer: MetricBuffer | null = null;
  #binaryEncodingBuffer: MetricBuffer | null = null;
  #broadcastBuffer: MetricBuffer | null = null;
  #gcBuffer: MetricBuffer | null = null;

  #ticks = 0;
  #ticksOver33Ms = 0;
  #entityCountSum = 0;
  #entityCountSamples = 0;
  #maxEntityCount: number | null = null;
  #players: number | null = null;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #gcObserver: PerformanceObserver | null = null;
  #result: ServerProfileResult | null = null;

  constructor(options: ServerProfilerOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.#enableGcObserver = options.enableGcObserver ?? true;
    this.#getPoolStats = options.getPoolStats ?? null;
  }

  isRunning(): boolean {
    return this.#status === 'running';
  }

  getState(): ServerProfileState {
    if (this.#status === 'running') {
      return {
        status: 'running',
        durationMs: this.#requestedDurationMs,
        elapsedMs: Math.max(0, this.#now() - this.#startedAt),
      };
    }

    if (this.#status === 'completed' && this.#result !== null) {
      return {
        status: 'completed',
        result: this.#result,
      };
    }

    return { status: 'idle' };
  }

  start(durationMs = DEFAULT_SERVER_PROFILE_DURATION_MS): void {
    if (this.#status === 'running') {
      throw new HttpError('Server profiling is already running', 409);
    }

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new HttpError('durationMs must be a positive number', 400);
    }

    this.#cleanupObserverAndTimer();

    this.#status = 'running';
    this.#requestedDurationMs = durationMs;
    this.#startedAt = this.#now();
    this.#endedAt = null;
    this.#memoryBefore = this.#memoryUsage();
    this.#poolsBefore = this.#getPoolStats?.() ?? null;
    this.#result = null;

    this.#tickBuffer = new MetricBuffer();
    this.#worldStepBuffer = new MetricBuffer();
    this.#collisionBuffer = new MetricBuffer();
    this.#snapshotCreateBuffer = new MetricBuffer();
    this.#binaryEncodingBuffer = new MetricBuffer();
    this.#broadcastBuffer = new MetricBuffer();
    this.#gcBuffer = new MetricBuffer();

    this.#ticks = 0;
    this.#ticksOver33Ms = 0;
    this.#entityCountSum = 0;
    this.#entityCountSamples = 0;
    this.#maxEntityCount = null;
    this.#players = null;

    if (this.#enableGcObserver) {
      this.#attachGcObserver();
    }

    this.#timer = setTimeout(() => {
      this.stop();
    }, durationMs);
    this.#timer.unref?.();
  }

  #attachGcObserver(): void {
    try {
      const observer = new PerformanceObserver((list) => {
        if (this.#status !== 'running') return;

        for (const entry of list.getEntries()) {
          this.recordGcPause(entry.duration, entry.startTime);
        }
      });

      observer.observe({ entryTypes: ['gc'] });
      this.#gcObserver = observer;
    } catch {
      this.#gcObserver = null;
    }
  }

  recordGcPause(durationMs: number, startTime?: number): void {
    if (this.#status !== 'running' || !this.#gcBuffer) return;

    if (startTime !== undefined) {
      if (startTime < this.#startedAt) return;
      if (this.#endedAt !== null && startTime > this.#endedAt) return;
    }

    this.#gcBuffer.push(durationMs);
  }

  recordTick(durationMs: number): void {
    if (this.#status !== 'running' || !this.#tickBuffer) return;

    this.#tickBuffer.push(durationMs);
    this.#ticks += 1;

    if (durationMs > 33) {
      this.#ticksOver33Ms += 1;
    }
  }

  recordWorldStep(durationMs: number): void {
    if (this.#status !== 'running' || !this.#worldStepBuffer) return;
    this.#worldStepBuffer.push(durationMs);
  }

  recordCollision(durationMs: number): void {
    if (this.#status !== 'running' || !this.#collisionBuffer) return;
    this.#collisionBuffer.push(durationMs);
  }

  recordSnapshotCreate(durationMs: number): void {
    if (this.#status !== 'running' || !this.#snapshotCreateBuffer) return;
    this.#snapshotCreateBuffer.push(durationMs);
  }

  recordBinaryEncode(durationMs: number): void {
    if (this.#status !== 'running' || !this.#binaryEncodingBuffer) return;
    this.#binaryEncodingBuffer.push(durationMs);
  }

  recordBroadcast(durationMs: number): void {
    if (this.#status !== 'running' || !this.#broadcastBuffer) return;
    this.#broadcastBuffer.push(durationMs);
  }

  recordEntities(count: number): void {
    if (this.#status !== 'running') return;

    this.#entityCountSum += count;
    this.#entityCountSamples += 1;
    this.#maxEntityCount =
      this.#maxEntityCount === null
        ? count
        : Math.max(this.#maxEntityCount, count);
  }

  recordPlayers(count: number): void {
    if (this.#status !== 'running') return;

    this.#players =
      this.#players === null ? count : Math.max(this.#players, count);
  }

  stop(): ServerProfileResult | null {
    if (this.#status !== 'running') {
      return this.#result;
    }

    const endedAt = this.#now();
    this.#endedAt = endedAt;
    this.#status = 'completed';

    this.#cleanupObserverAndTimer();

    const memoryAfter = this.#memoryUsage();
    const poolsAfter = this.#getPoolStats?.() ?? null;
    const pools =
      this.#poolsBefore && poolsAfter
        ? {
            bullets: diffPoolStats(
              this.#poolsBefore.bullets,
              poolsAfter.bullets,
            ),
            particles: diffPoolStats(
              this.#poolsBefore.particles,
              poolsAfter.particles,
            ),
          }
        : null;
    const gcValues = this.#gcBuffer?.toArray() ?? [];
    const gcSummary = summarizeTimings(gcValues);

    let gcTotalDurationMs = 0;
    for (const pauseMs of gcValues) {
      gcTotalDurationMs += pauseMs;
    }

    const result: ServerProfileResult = {
      durationMs: Math.max(0, endedAt - this.#startedAt),
      ticks: this.#ticks,
      ticksOver33Ms: this.#ticksOver33Ms,
      tickMs: this.#tickBuffer?.summarize() ?? null,
      worldStepMs: this.#worldStepBuffer?.summarize() ?? null,
      collisionMs: this.#collisionBuffer?.summarize() ?? null,
      snapshotCreateMs: this.#snapshotCreateBuffer?.summarize() ?? null,
      binaryEncodingMs: this.#binaryEncodingBuffer?.summarize() ?? null,
      broadcastMs: this.#broadcastBuffer?.summarize() ?? null,
      gc: {
        count: gcValues.length,
        totalDurationMs: gcTotalDurationMs,
        p50Ms: gcSummary ? gcSummary.p50 : null,
        p95Ms: gcSummary ? gcSummary.p95 : null,
        p99Ms: gcSummary ? gcSummary.p99 : null,
        maxMs: gcSummary ? gcSummary.max : null,
      },
      memory: {
        heapUsedBefore: this.#memoryBefore.heapUsed,
        heapUsedAfter: memoryAfter.heapUsed,
        rssBefore: this.#memoryBefore.rss,
        rssAfter: memoryAfter.rss,
      },
      entities: {
        avg:
          this.#entityCountSamples > 0
            ? this.#entityCountSum / this.#entityCountSamples
            : null,
        max: this.#maxEntityCount,
      },
      players: this.#players,
      pools,
    };

    this.#result = result;
    return result;
  }

  #cleanupObserverAndTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    if (this.#gcObserver !== null) {
      this.#gcObserver.disconnect();
      this.#gcObserver = null;
    }
  }

  shutdown(): void {
    if (this.#status === 'running') {
      this.stop();
    } else {
      this.#cleanupObserverAndTimer();
    }
  }
}

