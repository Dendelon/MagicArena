import { performance } from 'node:perf_hooks';
import type { EventLoopUtilization } from 'node:perf_hooks';

import { summarizeTimings } from '@magicarena/shared';
import type { TimingSummary } from '@magicarena/shared';

import { HttpError } from '../errors.ts';

export const DEFAULT_LOAD_TEST_DURATION_MS = 60_000;
const MAX_TICK_SAMPLE_CAPACITY = 131_072;
const RSS_SAMPLE_INTERVAL_MS = 1000;

export interface EluMetrics {
  readonly utilization: number;
  readonly utilizationPercent: number;
  readonly activeMs: number;
  readonly idleMs: number;
}

export interface LoadMemoryMetrics {
  readonly rssStartBytes: number;
  readonly rssEndBytes: number;
  readonly rssPeakBytes: number;
  readonly heapUsedStartBytes: number;
  readonly heapUsedEndBytes: number;
}

export interface LoadNetworkMetrics {
  readonly receivedBytes: number;
  readonly sentBytes: number;
  readonly receivedMessages: number;
  readonly sentMessages: number;
  readonly receivedBytesPerSecond: number;
  readonly sentBytesPerSecond: number;
  readonly totalBytesPerSecond: number;
  readonly droppedMessages: number;
  readonly backpressureEvents: number;
  readonly scopeNote: string;
}

export interface LoadTestResult {
  readonly durationMs: number;
  readonly expectedClients: number;
  readonly ticks: number;
  readonly actualTickRateHz: number;
  readonly ticksOver33Ms: number;
  readonly over33MsShare: number;
  readonly tickMs: TimingSummary | null;
  readonly elu: EluMetrics;
  readonly memory: LoadMemoryMetrics;
  readonly network: LoadNetworkMetrics;
  readonly entities: {
    readonly avg: number | null;
    readonly max: number | null;
  };
  readonly players: number | null;
}

export type LoadTestState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'running';
      readonly durationMs: number;
      readonly expectedClients: number;
      readonly elapsedMs: number;
    }
  | {
      readonly status: 'completed';
      readonly result: LoadTestResult;
    };

export interface LoadMemorySample {
  readonly rss: number;
  readonly heapUsed: number;
}

export interface LoadProfilerOptions {
  readonly now?: () => number;
  readonly memoryUsage?: () => LoadMemorySample;
  readonly eventLoopUtilization?: (
    previous?: EventLoopUtilization,
  ) => EventLoopUtilization;
  readonly rssSampleIntervalMs?: number;
}

export const computeEluMetrics = (elu: EventLoopUtilization): EluMetrics => {
  const utilization = Math.max(0, Math.min(1, elu.utilization));
  return {
    utilization,
    utilizationPercent: utilization * 100,
    activeMs: elu.active,
    idleMs: elu.idle,
  };
};

export const computeNetworkThroughput = (
  counts: {
    readonly receivedBytes: number;
    readonly sentBytes: number;
    readonly receivedMessages: number;
    readonly sentMessages: number;
    readonly droppedMessages: number;
    readonly backpressureEvents: number;
  },
  durationMs: number,
): LoadNetworkMetrics => {
  const durationSec = durationMs > 0 ? durationMs / 1000 : 0;
  const receivedBytesPerSecond =
    durationSec > 0 ? counts.receivedBytes / durationSec : 0;
  const sentBytesPerSecond =
    durationSec > 0 ? counts.sentBytes / durationSec : 0;

  return {
    receivedBytes: counts.receivedBytes,
    sentBytes: counts.sentBytes,
    receivedMessages: counts.receivedMessages,
    sentMessages: counts.sentMessages,
    receivedBytesPerSecond,
    sentBytesPerSecond,
    totalBytesPerSecond: receivedBytesPerSecond + sentBytesPerSecond,
    droppedMessages: counts.droppedMessages,
    backpressureEvents: counts.backpressureEvents,
    scopeNote:
      'WebSocket application payload throughput only (excludes TCP, IP, TLS, and WebSocket framing overhead)',
  };
};

export class LoadProfiler {
  readonly #now: () => number;
  readonly #memoryUsage: () => LoadMemorySample;
  readonly #elu: (previous?: EventLoopUtilization) => EventLoopUtilization;
  readonly #rssSampleIntervalMs: number;

  #status: 'idle' | 'running' | 'completed' = 'idle';
  #requestedDurationMs = 0;
  #expectedClients = 0;
  #startedAt = 0;
  #eluBaseline: EventLoopUtilization | null = null;

  #rssStartBytes = 0;
  #rssPeakBytes = 0;
  #heapUsedStartBytes = 0;

  #tickBuffer: Float64Array | null = null;
  #tickCount = 0;
  #ticksOver33Ms = 0;

  #receivedBytes = 0;
  #sentBytes = 0;
  #receivedMessages = 0;
  #sentMessages = 0;
  #droppedMessages = 0;
  #backpressureEvents = 0;

  #entitySum = 0;
  #entitySamples = 0;
  #maxEntities: number | null = null;
  #players: number | null = null;

  #durationTimer: ReturnType<typeof setTimeout> | null = null;
  #memoryTimer: ReturnType<typeof setInterval> | null = null;
  #result: LoadTestResult | null = null;

  constructor(options: LoadProfilerOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.#elu =
      options.eventLoopUtilization ??
      ((previous) => performance.eventLoopUtilization(previous));
    this.#rssSampleIntervalMs =
      options.rssSampleIntervalMs ?? RSS_SAMPLE_INTERVAL_MS;
  }

  isRunning(): boolean {
    return this.#status === 'running';
  }

  getState(): LoadTestState {
    if (this.#status === 'running') {
      return {
        status: 'running',
        durationMs: this.#requestedDurationMs,
        expectedClients: this.#expectedClients,
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

  start(
    durationMs = DEFAULT_LOAD_TEST_DURATION_MS,
    expectedClients = 1,
  ): void {
    if (this.#status === 'running') {
      throw new HttpError('Load test is already running', 409);
    }

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new HttpError('durationMs must be a positive number', 400);
    }

    if (!Number.isInteger(expectedClients) || expectedClients < 1) {
      throw new HttpError('expectedClients must be a positive integer', 400);
    }

    this.#clearTimers();

    const startMem = this.#memoryUsage();

    this.#status = 'running';
    this.#requestedDurationMs = durationMs;
    this.#expectedClients = expectedClients;
    this.#startedAt = this.#now();
    this.#eluBaseline = this.#elu();

    this.#rssStartBytes = startMem.rss;
    this.#rssPeakBytes = startMem.rss;
    this.#heapUsedStartBytes = startMem.heapUsed;

    this.#tickBuffer = new Float64Array(MAX_TICK_SAMPLE_CAPACITY);
    this.#tickCount = 0;
    this.#ticksOver33Ms = 0;

    this.#receivedBytes = 0;
    this.#sentBytes = 0;
    this.#receivedMessages = 0;
    this.#sentMessages = 0;
    this.#droppedMessages = 0;
    this.#backpressureEvents = 0;

    this.#entitySum = 0;
    this.#entitySamples = 0;
    this.#maxEntities = null;
    this.#players = null;
    this.#result = null;

    this.#memoryTimer = setInterval(() => {
      if (this.#status !== 'running') return;
      const sample = this.#memoryUsage();
      if (sample.rss > this.#rssPeakBytes) {
        this.#rssPeakBytes = sample.rss;
      }
    }, this.#rssSampleIntervalMs);
    this.#memoryTimer.unref?.();

    this.#durationTimer = setTimeout(() => {
      this.stop();
    }, durationMs);
    this.#durationTimer.unref?.();
  }

  recordTick(durationMs: number, entityCount: number, playerCount: number): void {
    if (this.#status !== 'running' || !this.#tickBuffer) return;

    if (this.#tickCount < this.#tickBuffer.length) {
      this.#tickBuffer[this.#tickCount] = durationMs;
    }
    this.#tickCount += 1;

    if (durationMs > 33) {
      this.#ticksOver33Ms += 1;
    }

    this.#entitySum += entityCount;
    this.#entitySamples += 1;
    this.#maxEntities =
      this.#maxEntities === null
        ? entityCount
        : Math.max(this.#maxEntities, entityCount);
    this.#players =
      this.#players === null
        ? playerCount
        : Math.max(this.#players, playerCount);
  }

  recordReceived(bytes: number): void {
    if (this.#status !== 'running') return;
    this.#receivedBytes += bytes;
    this.#receivedMessages += 1;
  }

  recordSent(bytes: number): void {
    if (this.#status !== 'running') return;
    this.#sentBytes += bytes;
    this.#sentMessages += 1;
  }

  recordDropped(): void {
    if (this.#status !== 'running') return;
    this.#droppedMessages += 1;
  }

  recordBackpressure(): void {
    if (this.#status !== 'running') return;
    this.#backpressureEvents += 1;
  }

  sampleMemory(): void {
    if (this.#status !== 'running') return;
    const sample = this.#memoryUsage();
    if (sample.rss > this.#rssPeakBytes) {
      this.#rssPeakBytes = sample.rss;
    }
  }

  stop(): LoadTestResult | null {
    if (this.#status !== 'running') {
      return this.#result;
    }

    this.#status = 'completed';
    this.#clearTimers();

    const endedAt = this.#now();
    const durationMs = Math.max(0, endedAt - this.#startedAt);

    const endMem = this.#memoryUsage();
    const rssPeakBytes = Math.max(this.#rssPeakBytes, endMem.rss);

    const eluRaw = this.#eluBaseline
      ? this.#elu(this.#eluBaseline)
      : this.#elu();
    this.#eluBaseline = null;

    const sampleCount = this.#tickBuffer
      ? Math.min(this.#tickCount, this.#tickBuffer.length)
      : 0;
    const tickSummary =
      this.#tickBuffer && sampleCount > 0
        ? summarizeTimings(Array.from(this.#tickBuffer.subarray(0, sampleCount)))
        : null;

    const actualTickRateHz =
      durationMs > 0 ? (this.#tickCount * 1000) / durationMs : 0;
    const over33MsShare =
      this.#tickCount > 0 ? this.#ticksOver33Ms / this.#tickCount : 0;

    const result: LoadTestResult = {
      durationMs,
      expectedClients: this.#expectedClients,
      ticks: this.#tickCount,
      actualTickRateHz,
      ticksOver33Ms: this.#ticksOver33Ms,
      over33MsShare,
      tickMs: tickSummary,
      elu: computeEluMetrics(eluRaw),
      memory: {
        rssStartBytes: this.#rssStartBytes,
        rssEndBytes: endMem.rss,
        rssPeakBytes,
        heapUsedStartBytes: this.#heapUsedStartBytes,
        heapUsedEndBytes: endMem.heapUsed,
      },
      network: computeNetworkThroughput(
        {
          receivedBytes: this.#receivedBytes,
          sentBytes: this.#sentBytes,
          receivedMessages: this.#receivedMessages,
          sentMessages: this.#sentMessages,
          droppedMessages: this.#droppedMessages,
          backpressureEvents: this.#backpressureEvents,
        },
        durationMs,
      ),
      entities: {
        avg:
          this.#entitySamples > 0
            ? this.#entitySum / this.#entitySamples
            : null,
        max: this.#maxEntities,
      },
      players: this.#players,
    };

    this.#tickBuffer = null;
    this.#result = result;
    return result;
  }

  #clearTimers(): void {
    if (this.#durationTimer !== null) {
      clearTimeout(this.#durationTimer);
      this.#durationTimer = null;
    }

    if (this.#memoryTimer !== null) {
      clearInterval(this.#memoryTimer);
      this.#memoryTimer = null;
    }
  }

  shutdown(): void {
    if (this.#status === 'running') {
      this.stop();
    } else {
      this.#clearTimers();
    }
  }
}

