import {
  monitorEventLoopDelay,
  performance,
  type EventLoopUtilization,
} from 'node:perf_hooks';

import type { MatchStats } from '../game/Match.ts';
import type { RoomManager } from '../rooms.ts';
import {
  collectEventLoopStats,
  collectMemoryStats,
  type LiveEventLoopStats,
  type LiveMemorySnapshot,
  type LiveMemoryStats,
} from './serverStats.ts';

const DEFAULT_RATE_WINDOW_MS = 1000;
const DEFAULT_ELD_RESOLUTION_MS = 20;

export interface RuntimeBuildMetadata {
  readonly version: string;
  readonly nodeVersion: string;
  readonly nodeEnv: string;
  readonly gitSha: string | null;
  readonly buildId: string | null;
}

export interface EventLoopDelayMetrics {
  readonly min: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface MetricsSnapshot {
  readonly status: 'ready' | 'shutting-down';
  readonly uptimeSeconds: number;
  readonly runtime: RuntimeBuildMetadata;
  readonly rooms: {
    readonly active: number;
    readonly activePlayers: number;
    readonly activeConnections: number;
  };
  readonly messages: {
    readonly windowMs: number;
    readonly receivedTotal: number;
    readonly sentTotal: number;
    readonly droppedTotal: number;
    readonly backpressureTotal: number;
    readonly receivedPerSec: number;
    readonly sentPerSec: number;
    readonly totalPerSec: number;
  };
  readonly bytes: {
    readonly windowMs: number;
    readonly receivedTotal: number;
    readonly sentTotal: number;
    readonly receivedPerSec: number;
    readonly sentPerSec: number;
    readonly totalPerSec: number;
  };
  readonly ticks: {
    readonly windowMs: number;
    readonly activeMatches: number;
    readonly targetHz: number;
    readonly ticksTotal: number;
    readonly ticksPerSec: number;
    readonly avgMatchTickRateHz: number;
    readonly durationMs: {
      readonly last: number;
      readonly avg: number;
      readonly max: number;
    };
  };
  readonly eventLoop: LiveEventLoopStats & {
    readonly delayMs: EventLoopDelayMetrics;
  };
  readonly memory: LiveMemoryStats;
}

export interface EventLoopDelayReader {
  enable(): void;
  disable(): void;
  readonly count: number;
  readonly min: number;
  readonly mean: number;
  readonly max: number;
  percentile(percentile: number): number;
}

export interface ServerMetricsOptions {
  readonly runtime: RuntimeBuildMetadata;
  readonly sampleIntervalMs?: number;
  readonly now?: () => number;
  readonly memoryUsage?: () => LiveMemorySnapshot;
  readonly eventLoopUtilization?: () => EventLoopUtilization;
  readonly enableEventLoopDelay?: boolean;
  readonly createDelayMonitor?: () => EventLoopDelayReader;
}

const nsToMs = (ns: number): number => {
  if (!Number.isFinite(ns) || ns < 0) {
    return 0;
  }
  return Math.round((ns / 1_000_000) * 1000) / 1000;
};

const roundRate = (count: number, elapsedMs: number): number => {
  if (elapsedMs <= 0) {
    return 0;
  }
  return Math.round(((count * 1000) / elapsedMs) * 100) / 100;
};

const roundMs = (ms: number): number =>
  Number.isFinite(ms) && ms >= 0 ? Math.round(ms * 1000) / 1000 : 0;

/**
 * Lightweight, constant-overhead observability collector for `/metrics`.
 * Tracks WebSocket message/byte rates over bounded 1s windows, match ticks,
 * memory usage, cumulative ELU, and libuv Event Loop Delay quantiles.
 */
export class ServerMetrics {
  readonly #runtime: RuntimeBuildMetadata;
  readonly #now: () => number;
  readonly #memoryUsage: () => LiveMemorySnapshot;
  readonly #elu: () => EventLoopUtilization;
  readonly #delayMonitor: EventLoopDelayReader | null;
  readonly #startedAt: number;

  #sampleTimer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  #activeConnections = 0;
  #receivedMessagesTotal = 0;
  #sentMessagesTotal = 0;
  #droppedMessagesTotal = 0;
  #backpressureEventsTotal = 0;
  #receivedBytesTotal = 0;
  #sentBytesTotal = 0;
  #ticksTotal = 0;

  #lastTickDurationMs = 0;
  #windowMaxTickDurationMs = 0;
  #maxTickDurationInLastWindowMs = 0;

  #windowStartMs: number;
  #lastSampleDurationMs = DEFAULT_RATE_WINDOW_MS;
  #prevReceivedMessages = 0;
  #prevSentMessages = 0;
  #prevReceivedBytes = 0;
  #prevSentBytes = 0;
  #prevTicks = 0;

  #receivedMessagesPerSec = 0;
  #sentMessagesPerSec = 0;
  #receivedBytesPerSec = 0;
  #sentBytesPerSec = 0;
  #ticksPerSec = 0;
  #hasCompletedWindow = false;

  constructor(options: ServerMetricsOptions) {
    this.#runtime = options.runtime;
    this.#now = options.now ?? (() => performance.now());
    this.#memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
    this.#elu =
      options.eventLoopUtilization ?? (() => performance.eventLoopUtilization());
    this.#startedAt = this.#now();
    this.#windowStartMs = this.#startedAt;

    const sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_RATE_WINDOW_MS;

    if (options.enableEventLoopDelay !== false) {
      const monitor: EventLoopDelayReader =
        options.createDelayMonitor?.() ??
        monitorEventLoopDelay({ resolution: DEFAULT_ELD_RESOLUTION_MS });
      monitor.enable();
      this.#delayMonitor = monitor;
    } else {
      this.#delayMonitor = null;
    }

    if (sampleIntervalMs > 0) {
      this.#sampleTimer = setInterval(() => {
        this.sampleWindow();
      }, sampleIntervalMs);
      this.#sampleTimer.unref?.();
    }
  }

  recordConnectionOpened(): void {
    this.#activeConnections += 1;
  }

  recordConnectionClosed(): void {
    this.#activeConnections = Math.max(0, this.#activeConnections - 1);
  }

  recordIncomingMessage(bytes: number): void {
    this.#receivedMessagesTotal += 1;
    this.#receivedBytesTotal += Math.max(0, bytes);
  }

  recordOutgoingMessage(bytes: number): void {
    this.#sentMessagesTotal += 1;
    this.#sentBytesTotal += Math.max(0, bytes);
  }

  recordDroppedMessage(): void {
    this.#droppedMessagesTotal += 1;
  }

  recordBackpressure(): void {
    this.#backpressureEventsTotal += 1;
  }

  recordTick(durationMs: number): void {
    this.#ticksTotal += 1;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.#lastTickDurationMs = durationMs;
      if (durationMs > this.#windowMaxTickDurationMs) {
        this.#windowMaxTickDurationMs = durationMs;
      }
    }
  }

  sampleWindow(): void {
    const currentNow = this.#now();
    const elapsedMs = currentNow - this.#windowStartMs;
    if (elapsedMs <= 0) {
      return;
    }

    const deltaRxMessages =
      this.#receivedMessagesTotal - this.#prevReceivedMessages;
    const deltaTxMessages = this.#sentMessagesTotal - this.#prevSentMessages;
    const deltaRxBytes = this.#receivedBytesTotal - this.#prevReceivedBytes;
    const deltaTxBytes = this.#sentBytesTotal - this.#prevSentBytes;
    const deltaTicks = this.#ticksTotal - this.#prevTicks;

    this.#receivedMessagesPerSec = roundRate(deltaRxMessages, elapsedMs);
    this.#sentMessagesPerSec = roundRate(deltaTxMessages, elapsedMs);
    this.#receivedBytesPerSec = roundRate(deltaRxBytes, elapsedMs);
    this.#sentBytesPerSec = roundRate(deltaTxBytes, elapsedMs);
    this.#ticksPerSec = roundRate(deltaTicks, elapsedMs);

    this.#maxTickDurationInLastWindowMs = this.#windowMaxTickDurationMs;
    this.#windowMaxTickDurationMs = 0;

    this.#prevReceivedMessages = this.#receivedMessagesTotal;
    this.#prevSentMessages = this.#sentMessagesTotal;
    this.#prevReceivedBytes = this.#receivedBytesTotal;
    this.#prevSentBytes = this.#sentBytesTotal;
    this.#prevTicks = this.#ticksTotal;
    this.#windowStartMs = currentNow;
    this.#lastSampleDurationMs = elapsedMs;
    this.#hasCompletedWindow = true;
  }

  getMetrics({
    shuttingDown,
    matches,
    roomManager,
  }: {
    readonly shuttingDown: boolean;
    readonly matches: readonly MatchStats[];
    readonly roomManager: Pick<RoomManager, 'rooms'>;
  }): MetricsSnapshot {
    const currentNow = this.#now();
    const uptimeMs = Math.max(0, currentNow - this.#startedAt);

    let activePlayers = 0;
    for (const room of roomManager.rooms.values()) {
      activePlayers += room.players.size;
    }

    const effectiveWindowMs = this.#hasCompletedWindow
      ? this.#lastSampleDurationMs
      : uptimeMs;
    const receivedMessagesPerSec = this.#hasCompletedWindow
      ? this.#receivedMessagesPerSec
      : roundRate(this.#receivedMessagesTotal, uptimeMs);
    const sentMessagesPerSec = this.#hasCompletedWindow
      ? this.#sentMessagesPerSec
      : roundRate(this.#sentMessagesTotal, uptimeMs);
    const receivedBytesPerSec = this.#hasCompletedWindow
      ? this.#receivedBytesPerSec
      : roundRate(this.#receivedBytesTotal, uptimeMs);
    const sentBytesPerSec = this.#hasCompletedWindow
      ? this.#sentBytesPerSec
      : roundRate(this.#sentBytesTotal, uptimeMs);
    const ticksPerSec = this.#hasCompletedWindow
      ? this.#ticksPerSec
      : roundRate(this.#ticksTotal, uptimeMs);

    const activeMatches = matches.length;
    let avgStepSum = 0;
    let targetHz = 0;
    for (const match of matches) {
      avgStepSum += match.avgStepMs;
      if (match.targetHz > targetHz) {
        targetHz = match.targetHz;
      }
    }

    const avgTickDurationMs =
      activeMatches > 0 ? avgStepSum / activeMatches : this.#lastTickDurationMs;
    const maxTickDurationMs = Math.max(
      this.#maxTickDurationInLastWindowMs,
      this.#windowMaxTickDurationMs,
      this.#lastTickDurationMs,
    );
    const avgMatchTickRateHz =
      activeMatches > 0
        ? Math.round((ticksPerSec / activeMatches) * 100) / 100
        : 0;

    const delayMs = this.#readEventLoopDelay();

    return {
      status: shuttingDown ? 'shutting-down' : 'ready',
      uptimeSeconds: Math.round((uptimeMs / 1000) * 100) / 100,
      runtime: this.#runtime,
      rooms: {
        active: roomManager.rooms.size,
        activePlayers,
        activeConnections: this.#activeConnections,
      },
      messages: {
        windowMs: Math.round(effectiveWindowMs),
        receivedTotal: this.#receivedMessagesTotal,
        sentTotal: this.#sentMessagesTotal,
        droppedTotal: this.#droppedMessagesTotal,
        backpressureTotal: this.#backpressureEventsTotal,
        receivedPerSec: receivedMessagesPerSec,
        sentPerSec: sentMessagesPerSec,
        totalPerSec:
          Math.round((receivedMessagesPerSec + sentMessagesPerSec) * 100) / 100,
      },
      bytes: {
        windowMs: Math.round(effectiveWindowMs),
        receivedTotal: this.#receivedBytesTotal,
        sentTotal: this.#sentBytesTotal,
        receivedPerSec: receivedBytesPerSec,
        sentPerSec: sentBytesPerSec,
        totalPerSec:
          Math.round((receivedBytesPerSec + sentBytesPerSec) * 100) / 100,
      },
      ticks: {
        windowMs: Math.round(effectiveWindowMs),
        activeMatches,
        targetHz,
        ticksTotal: this.#ticksTotal,
        ticksPerSec,
        avgMatchTickRateHz,
        durationMs: {
          last: roundMs(this.#lastTickDurationMs),
          avg: roundMs(avgTickDurationMs),
          max: roundMs(maxTickDurationMs),
        },
      },
      eventLoop: {
        ...collectEventLoopStats(this.#elu),
        delayMs,
      },
      memory: collectMemoryStats(this.#memoryUsage),
    };
  }

  shutdown(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    if (this.#sampleTimer !== null) {
      clearInterval(this.#sampleTimer);
      this.#sampleTimer = null;
    }
    this.#delayMonitor?.disable();
  }

  #readEventLoopDelay(): EventLoopDelayMetrics {
    const monitor = this.#delayMonitor;
    if (monitor === null || monitor.count === 0) {
      return {
        min: 0,
        mean: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        max: 0,
      };
    }

    return {
      min: nsToMs(monitor.min),
      mean: nsToMs(monitor.mean),
      p50: nsToMs(monitor.percentile(50)),
      p95: nsToMs(monitor.percentile(95)),
      p99: nsToMs(monitor.percentile(99)),
      max: nsToMs(monitor.max),
    };
  }
}

