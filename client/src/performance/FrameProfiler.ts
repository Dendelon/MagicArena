import { diffPoolStats, summarizeTimings } from '@magicarena/shared';
import type {
  Bounds,
  CodecMode,
  NetSim,
  PoolDeltaStats,
  PoolStats,
  TimingSummary,
  WorldPoolStats,
} from '@magicarena/shared';

import type { LoopFrameTiming, LoopProfiler } from '../loop.ts';

export const DEFAULT_PROFILE_DURATION_MS = 30_000;
export const FRAME_BUDGET_MS = 1000 / 60;

const MIN_BUFFER_CAPACITY = 1024;
const MAX_BUFFER_CAPACITY = 65_536;
const MARK_CLEAR_INTERVAL_FRAMES = 60;
const SERVER_POLL_INTERVAL_MS = 50;
const SERVER_POLL_TIMEOUT_MS = 2000;

const MARK_PROFILE_START = 'magic-arena:profile:start';
const MARK_PROFILE_END = 'magic-arena:profile:end';
const MEASURE_SIMULATION = 'magic-arena:simulation';
const MEASURE_RENDER = 'magic-arena:render';
const MEASURE_FRAME = 'magic-arena:frame';

export interface FrameProfileResult {
  readonly durationMs: number;
  readonly frames: number;
  readonly fps: number;

  readonly frameIntervalMs: TimingSummary | null;
  readonly frameWorkMs: TimingSummary | null;
  readonly simulationMs: TimingSummary | null;
  readonly renderMs: TimingSummary | null;

  readonly framesOverBudget: number;
  readonly framesOver33Ms: number;
  readonly framesOver50Ms: number;
  readonly valid: boolean;
  readonly cancelledReason: string | null;
}

export interface ServerProfileReport {
  readonly durationMs: number;
  readonly ticks: number;
  readonly ticksOver33Ms: number;
  readonly tickMs: TimingSummary | null;
  readonly worldStepMs: TimingSummary | null;
  readonly collisionMs: TimingSummary | null;
  readonly snapshotCreateMs: TimingSummary | null;
  readonly binaryEncodingMs: TimingSummary | null;
  readonly broadcastMs: TimingSummary | null;
  readonly gc: {
    readonly count: number;
    readonly totalDurationMs: number;
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
    readonly p99Ms: number | null;
    readonly maxMs: number | null;
  };
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
  readonly pools?: {
    readonly bullets: PoolDeltaStats;
    readonly particles: PoolDeltaStats;
  } | null;
}

export interface ProfilePoolSnapshots {
  readonly world: WorldPoolStats;
  readonly localBullets: PoolStats;
}

export interface ProfileExperimentContext {
  readonly roomId: string | null;
  readonly roomName: string | null;
  readonly playerCount: number | null;
  readonly codec: CodecMode | null;
  readonly netSim: NetSim | null;
  readonly bounds: Bounds | null;
  readonly pools?: ProfilePoolSnapshots | null;
}

export interface CombinedProfileReport {
  readonly recordedAt: string;
  readonly requestedDurationMs: number;
  readonly client: FrameProfileResult;
  readonly server: ServerProfileReport | null;
  readonly actualDurationMs: {
    readonly client: number;
    readonly server: number | null;
  };
  readonly players: {
    readonly clientRoom: number | null;
    readonly serverRoom: number | null;
  };
  readonly experiment: {
    readonly roomId: string | null;
    readonly roomName: string | null;
    readonly codec: CodecMode | null;
    readonly netSim: NetSim | null;
    readonly bounds: Bounds | null;
  };
  readonly pools: {
    readonly serverWorld: {
      readonly bullets: PoolDeltaStats;
      readonly particles: PoolDeltaStats;
    } | null;
    readonly clientWorld: {
      readonly bullets: PoolDeltaStats;
      readonly particles: PoolDeltaStats;
    } | null;
    readonly localPredictedBullets: PoolDeltaStats | null;
  };
}

export interface MagicArenaProfileApi {
  start(durationMs?: number): Promise<CombinedProfileReport>;
  result(): CombinedProfileReport | null;
  download(filename?: string): boolean;
}

interface FrameBuffers {
  readonly capacity: number;
  readonly intervals: Float64Array;
  readonly works: Float64Array;
  readonly simulations: Float64Array;
  readonly renders: Float64Array;
  intervalCount: number;
  frameCount: number;
}

const allocateBuffers = (durationMs: number): FrameBuffers => {
  const estimated = Math.ceil((Math.max(1, durationMs) / 1000) * 240);
  const capacity = Math.min(
    MAX_BUFFER_CAPACITY,
    Math.max(MIN_BUFFER_CAPACITY, estimated),
  );

  return {
    capacity,
    intervals: new Float64Array(capacity),
    works: new Float64Array(capacity),
    simulations: new Float64Array(capacity),
    renders: new Float64Array(capacity),
    intervalCount: 0,
    frameCount: 0,
  };
};

const safeMark = (name: string): void => {
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') {
    return;
  }

  try {
    performance.mark(name);
  } catch {
    // Ignore mark errors in restricted environments.
  }
};

const safeMeasure = (name: string, start: number, end: number): void => {
  if (
    typeof performance === 'undefined' ||
    typeof performance.measure !== 'function'
  ) {
    return;
  }

  try {
    performance.measure(name, { start, end });
  } catch {
    // Ignore environments without object-form performance.measure.
  }
};

const clearPerfEntries = (includeLifecycleMarks: boolean): void => {
  if (typeof performance === 'undefined') return;

  if (typeof performance.clearMeasures === 'function') {
    try {
      performance.clearMeasures(MEASURE_SIMULATION);
      performance.clearMeasures(MEASURE_RENDER);
      performance.clearMeasures(MEASURE_FRAME);
    } catch {
      // Ignore measure cleanup errors.
    }
  }

  if (includeLifecycleMarks && typeof performance.clearMarks === 'function') {
    try {
      performance.clearMarks(MARK_PROFILE_START);
      performance.clearMarks(MARK_PROFILE_END);
    } catch {
      // Ignore mark cleanup errors.
    }
  }
};

const summarizeBuffer = (
  buffer: Float64Array,
  count: number,
): TimingSummary | null => {
  if (count <= 0) return null;
  return summarizeTimings(Array.from(buffer.subarray(0, count)));
};

export interface FrameProfilerOptions {
  readonly now?: () => number;
}

export class FrameProfiler implements LoopProfiler {
  readonly #now: () => number;

  #active = false;
  #buffers: FrameBuffers | null = null;
  #startedAt = 0;
  #lastRafTimestamp: number | null = null;
  #framesOverBudget = 0;
  #framesOver33Ms = 0;
  #framesOver50Ms = 0;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #visibilityHandler: (() => void) | null = null;
  #activePromise: Promise<FrameProfileResult> | null = null;
  #resolveActive: ((result: FrameProfileResult) => void) | null = null;
  #lastResult: FrameProfileResult | null = null;

  constructor(options: FrameProfilerOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
  }

  isActive(): boolean {
    return this.#active;
  }

  getLastResult(): FrameProfileResult | null {
    return this.#lastResult;
  }

  start(durationMs = DEFAULT_PROFILE_DURATION_MS): Promise<FrameProfileResult> {
    if (this.#active) {
      return Promise.reject(new Error('Frame profiling is already running'));
    }

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return Promise.reject(
        new Error('Profile durationMs must be a positive number'),
      );
    }

    clearPerfEntries(true);

    this.#active = true;
    this.#buffers = allocateBuffers(durationMs);
    this.#startedAt = this.#now();
    this.#lastRafTimestamp = null;
    this.#framesOverBudget = 0;
    this.#framesOver33Ms = 0;
    this.#framesOver50Ms = 0;

    safeMark(MARK_PROFILE_START);

    if (typeof document !== 'undefined') {
      const onVisibilityChange = (): void => {
        if (document.hidden || document.visibilityState === 'hidden') {
          this.#finish(false, 'Document became hidden');
        }
      };

      this.#visibilityHandler = onVisibilityChange;
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    const promise = new Promise<FrameProfileResult>((resolve) => {
      this.#resolveActive = resolve;
    });

    this.#activePromise = promise;

    this.#timer = setTimeout(() => {
      this.#finish(true, null);
    }, durationMs);

    return promise;
  }

  beginFrame(rafNow: number): void {
    if (!this.#active || !this.#buffers) return;

    if (this.#lastRafTimestamp === null) {
      this.#lastRafTimestamp = rafNow;
      return;
    }

    const interval = rafNow - this.#lastRafTimestamp;
    this.#lastRafTimestamp = rafNow;

    if (this.#buffers.intervalCount < this.#buffers.capacity) {
      this.#buffers.intervals[this.#buffers.intervalCount] = interval;
      this.#buffers.intervalCount += 1;
    }

    if (interval > FRAME_BUDGET_MS) {
      this.#framesOverBudget += 1;
    }
    if (interval > 33) {
      this.#framesOver33Ms += 1;
    }
    if (interval > 50) {
      this.#framesOver50Ms += 1;
    }
  }

  endFrame(timing: LoopFrameTiming): void {
    if (!this.#active || !this.#buffers) return;

    if (this.#buffers.frameCount < this.#buffers.capacity) {
      const index = this.#buffers.frameCount;
      this.#buffers.works[index] = timing.frameWorkMs;
      this.#buffers.simulations[index] = timing.simulationMs;
      this.#buffers.renders[index] = timing.renderMs;
      this.#buffers.frameCount += 1;
    }

    safeMeasure(MEASURE_SIMULATION, timing.simStart, timing.simEnd);
    safeMeasure(MEASURE_RENDER, timing.renderStart, timing.renderEnd);
    safeMeasure(MEASURE_FRAME, timing.frameStart, timing.frameEnd);

    if (this.#buffers.frameCount % MARK_CLEAR_INTERVAL_FRAMES === 0) {
      clearPerfEntries(false);
    }
  }

  cancel(reason = 'Cancelled'): FrameProfileResult | null {
    if (!this.#active) {
      return this.#lastResult;
    }

    return this.#finish(false, reason);
  }

  dispose(): void {
    if (this.#active) {
      this.#finish(false, 'Disposed');
    } else {
      this.#cleanupResources();
    }
  }

  #cleanupResources(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    if (this.#visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#visibilityHandler);
      this.#visibilityHandler = null;
    }

    clearPerfEntries(true);
  }

  #finish(valid: boolean, cancelledReason: string | null): FrameProfileResult {
    safeMark(MARK_PROFILE_END);

    const endedAt = this.#now();
    const durationMs = Math.max(0, endedAt - this.#startedAt);
    const buffers = this.#buffers;
    const frames = buffers?.frameCount ?? 0;
    const fps = durationMs > 0 && frames > 0 ? (frames * 1000) / durationMs : 0;

    const result: FrameProfileResult = {
      durationMs,
      frames,
      fps,
      frameIntervalMs: buffers
        ? summarizeBuffer(buffers.intervals, buffers.intervalCount)
        : null,
      frameWorkMs: buffers
        ? summarizeBuffer(buffers.works, buffers.frameCount)
        : null,
      simulationMs: buffers
        ? summarizeBuffer(buffers.simulations, buffers.frameCount)
        : null,
      renderMs: buffers
        ? summarizeBuffer(buffers.renders, buffers.frameCount)
        : null,
      framesOverBudget: this.#framesOverBudget,
      framesOver33Ms: this.#framesOver33Ms,
      framesOver50Ms: this.#framesOver50Ms,
      valid,
      cancelledReason,
    };

    this.#active = false;
    this.#buffers = null;
    this.#lastResult = result;
    this.#cleanupResources();

    const resolve = this.#resolveActive;
    this.#resolveActive = null;
    this.#activePromise = null;

    resolve?.(result);
    return result;
  }

  get activePromise(): Promise<FrameProfileResult> | null {
    return this.#activePromise;
  }
}

interface ProfileControllerOptions {
  readonly profiler: FrameProfiler;
  readonly getContext: () => ProfileExperimentContext;
  readonly fetchImpl?: typeof fetch;
  readonly apiBaseUrl?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed) && typeof parsed.error === 'string') {
      return parsed.error;
    }
  } catch {
    // Ignore non-JSON error body.
  }

  return `HTTP ${response.status}`;
};

const isServerStatePayload = (
  value: unknown,
): value is
  | { readonly status: 'idle' }
  | { readonly status: 'running' }
  | { readonly status: 'completed'; readonly result: ServerProfileReport } => {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return false;
  }

  if (value.status === 'idle' || value.status === 'running') {
    return true;
  }

  return value.status === 'completed' && isRecord(value.result);
};

export const createMagicArenaProfileApi = ({
  profiler,
  getContext,
  fetchImpl = fetch,
  apiBaseUrl = '',
}: ProfileControllerOptions): MagicArenaProfileApi => {
  let running = false;
  let lastReport: CombinedProfileReport | null = null;

  const fetchServerResult = async (): Promise<ServerProfileReport | null> => {
    const deadline = Date.now() + SERVER_POLL_TIMEOUT_MS;

    while (Date.now() <= deadline) {
      const response = await fetchImpl(`${apiBaseUrl}/api/profile/result`, {
        cache: 'no-store',
      });

      if (!response.ok) {
        throw new Error(
          `Failed to read server profile result: ${await readErrorMessage(response)}`,
        );
      }

      const payload: unknown = await response.json();
      if (!isServerStatePayload(payload)) {
        return null;
      }

      if (payload.status === 'completed') {
        return payload.result;
      }

      if (payload.status === 'idle') {
        return null;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, SERVER_POLL_INTERVAL_MS),
      );
    }

    return null;
  };

  return {
    async start(
      durationMs = DEFAULT_PROFILE_DURATION_MS,
    ): Promise<CombinedProfileReport> {
      if (running || profiler.isActive()) {
        throw new Error('Profiling session is already in progress');
      }

      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error('durationMs must be a positive number');
      }

      running = true;

      try {
        const startResponse = await fetchImpl(
          `${apiBaseUrl}/api/profile/start`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ durationMs }),
          },
        );

        if (!startResponse.ok) {
          throw new Error(
            `Failed to start server profiler: ${await readErrorMessage(startResponse)}`,
          );
        }

        const poolsBefore = getContext().pools ?? null;
        const client = await profiler.start(durationMs);
        const server = await fetchServerResult();
        const context = getContext();
        const poolsAfter = context.pools ?? null;

        const report: CombinedProfileReport = {
          recordedAt: new Date().toISOString(),
          requestedDurationMs: durationMs,
          client,
          server,
          actualDurationMs: {
            client: client.durationMs,
            server: server ? server.durationMs : null,
          },
          players: {
            clientRoom: context.playerCount,
            serverRoom: server ? server.players : null,
          },
          experiment: {
            roomId: context.roomId,
            roomName: context.roomName,
            codec: context.codec,
            netSim: context.netSim,
            bounds: context.bounds,
          },
          pools: {
            serverWorld: server?.pools ?? null,
            clientWorld:
              poolsBefore && poolsAfter
                ? {
                    bullets: diffPoolStats(
                      poolsBefore.world.bullets,
                      poolsAfter.world.bullets,
                    ),
                    particles: diffPoolStats(
                      poolsBefore.world.particles,
                      poolsAfter.world.particles,
                    ),
                  }
                : null,
            localPredictedBullets:
              poolsBefore && poolsAfter
                ? diffPoolStats(
                    poolsBefore.localBullets,
                    poolsAfter.localBullets,
                  )
                : null,
          },
        };

        lastReport = report;
        return report;
      } finally {
        running = false;
      }
    },

    result(): CombinedProfileReport | null {
      return lastReport;
    },

    download(filename?: string): boolean {
      if (!lastReport) {
        return false;
      }

      const serialized = JSON.stringify(lastReport, null, 2);
      const blob = new Blob([serialized], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download =
        filename ??
        `magic-arena-profile-${lastReport.recordedAt.replaceAll(':', '-')}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      return true;
    },
  };
};

