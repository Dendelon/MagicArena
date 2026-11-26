import { summarizeTimings } from '@magicarena/shared';
import type { TimingSummary } from '@magicarena/shared';

import type { DecodeMode } from '../network/workerProtocol.ts';

const INITIAL_SAMPLE_CAPACITY = 4096;
const MAX_SAMPLE_CAPACITY = 65_536;
const MARK_CLEAR_INTERVAL = 120;

const MEASURE_DECODE = 'magic-arena:decode';

export interface DecodeExperimentReport {
  readonly requestedMode: DecodeMode;
  readonly actualMode: DecodeMode;
  readonly messageCount: number;
  readonly decodedCount: number;
  readonly textMessages: number;
  readonly binaryMessages: number;
  readonly messageTypes: Readonly<Record<string, number>>;
  readonly receivedBytes: number;
  readonly durationMs: number;
  readonly decodeMs: TimingSummary | null;
  readonly mainThreadWorkMs: TimingSummary | null;
  readonly mainThreadTotalMs: number | null;
  readonly postMessageMs: TimingSummary | null;
  readonly responseBookkeepingMs: TimingSummary | null;
  readonly workerDecodeMs: TimingSummary | null;
  readonly roundTripMs: TimingSummary | null;
  readonly estimatedOverheadMs: TimingSummary | null;
  readonly transferredBuffers: number;
  readonly maxPending: number;
  readonly errors: number;
  readonly fallbacks: number;
  readonly workerErrors: number;
  readonly valid: boolean;
  readonly invalidReason: string | null;
  readonly limitations: readonly string[];
}

export interface MainDecodeSample {
  readonly durationMs: number;
  readonly isBinary: boolean;
  readonly bytes: number;
  readonly ok: boolean;
  readonly messageType?: string;
}

export interface WorkerDecodeSample {
  readonly sessionId: number;
  readonly isBinary: boolean;
  readonly bytes: number;
  readonly ok: boolean;
  readonly messageType?: string;
  readonly postMessageMs: number;
  readonly bookkeepingMs: number;
  readonly workerDecodeMs: number;
  readonly roundTripMs: number;
  readonly pendingAtSubmit: number;
  readonly transferredBuffer: boolean;
}

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
    // Ignore environments without timestamp-object support.
  }
};

export const clearDecodeMeasures = (): void => {
  if (
    typeof performance !== 'undefined' &&
    typeof performance.clearMeasures === 'function'
  ) {
    try {
      performance.clearMeasures(MEASURE_DECODE);
    } catch {
      // Ignore measure cleanup errors.
    }
  }
};

class TimingBuffer {
  readonly #values: Float64Array;
  #count = 0;
  #sum = 0;

  constructor(capacity = INITIAL_SAMPLE_CAPACITY) {
    this.#values = new Float64Array(Math.min(MAX_SAMPLE_CAPACITY, capacity));
  }

  push(value: number): void {
    this.#sum += value;

    if (this.#count < this.#values.length) {
      this.#values[this.#count] = value;
      this.#count += 1;
    }
  }

  get count(): number {
    return this.#count;
  }

  get sum(): number {
    return this.#sum;
  }

  summarize(): TimingSummary | null {
    if (this.#count === 0) return null;
    return summarizeTimings(Array.from(this.#values.subarray(0, this.#count)));
  }
}

export interface DecodeProfilerOptions {
  readonly now?: () => number;
}

export class DecodeProfiler {
  readonly #now: () => number;

  #active = false;
  #sessionId = 0;
  #requestedMode: DecodeMode = 'main';
  #actualMode: DecodeMode = 'main';
  #startedAt = 0;

  #messageCount = 0;
  #decodedCount = 0;
  #textMessages = 0;
  #binaryMessages = 0;
  #receivedBytes = 0;
  #messageTypes: Record<string, number> = {};
  #transferredBuffers = 0;
  #maxPending = 0;
  #errors = 0;
  #fallbacks = 0;
  #workerErrors = 0;
  #invalidReason: string | null = null;

  #mainDecodeBuffer: TimingBuffer | null = null;
  #mainWorkBuffer: TimingBuffer | null = null;
  #postMessageBuffer: TimingBuffer | null = null;
  #bookkeepingBuffer: TimingBuffer | null = null;
  #workerDecodeBuffer: TimingBuffer | null = null;
  #roundTripBuffer: TimingBuffer | null = null;
  #overheadBuffer: TimingBuffer | null = null;

  constructor(options: DecodeProfilerOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
  }

  isActive(): boolean {
    return this.#active;
  }

  getSessionId(): number | null {
    return this.#active ? this.#sessionId : null;
  }

  start(requestedMode: DecodeMode, actualMode: DecodeMode): number {
    this.#sessionId += 1;
    this.#active = true;
    this.#requestedMode = requestedMode;
    this.#actualMode = actualMode;
    this.#startedAt = this.#now();

    this.#messageCount = 0;
    this.#decodedCount = 0;
    this.#textMessages = 0;
    this.#binaryMessages = 0;
    this.#receivedBytes = 0;
    this.#messageTypes = {};
    this.#transferredBuffers = 0;
    this.#maxPending = 0;
    this.#errors = 0;
    this.#fallbacks = 0;
    this.#workerErrors = 0;
    this.#invalidReason = null;

    this.#mainDecodeBuffer = new TimingBuffer();
    this.#mainWorkBuffer = new TimingBuffer();
    this.#postMessageBuffer = new TimingBuffer();
    this.#bookkeepingBuffer = new TimingBuffer();
    this.#workerDecodeBuffer = new TimingBuffer();
    this.#roundTripBuffer = new TimingBuffer();
    this.#overheadBuffer = new TimingBuffer();

    clearDecodeMeasures();

    return this.#sessionId;
  }

  recordMainDecode(sample: MainDecodeSample, startTime?: number, endTime?: number): void {
    if (!this.#active) return;

    this.#recordCommon(
      sample.isBinary,
      sample.bytes,
      sample.ok,
      sample.messageType,
    );
    this.#mainDecodeBuffer?.push(sample.durationMs);
    this.#mainWorkBuffer?.push(sample.durationMs);

    if (startTime !== undefined && endTime !== undefined) {
      safeMeasure(MEASURE_DECODE, startTime, endTime);
      if (this.#messageCount % MARK_CLEAR_INTERVAL === 0) {
        clearDecodeMeasures();
      }
    }
  }

  recordWorkerDecode(sample: WorkerDecodeSample): void {
    if (!this.#active || sample.sessionId !== this.#sessionId) {
      return;
    }

    this.#recordCommon(
      sample.isBinary,
      sample.bytes,
      sample.ok,
      sample.messageType,
    );

    if (sample.transferredBuffer) {
      this.#transferredBuffers += 1;
    }

    if (sample.pendingAtSubmit > this.#maxPending) {
      this.#maxPending = sample.pendingAtSubmit;
    }

    const mainWorkMs = sample.postMessageMs + sample.bookkeepingMs;
    const overheadMs = Math.max(0, sample.roundTripMs - sample.workerDecodeMs);

    this.#postMessageBuffer?.push(sample.postMessageMs);
    this.#bookkeepingBuffer?.push(sample.bookkeepingMs);
    this.#mainWorkBuffer?.push(mainWorkMs);
    this.#workerDecodeBuffer?.push(sample.workerDecodeMs);
    this.#roundTripBuffer?.push(sample.roundTripMs);
    this.#overheadBuffer?.push(overheadMs);
  }

  recordReconnect(): void {
    if (!this.#active) return;
    this.#invalidReason ??= 'WebSocket reconnected during profiling';
  }

  recordFallback(nextMode: DecodeMode = 'main'): void {
    if (!this.#active) return;
    this.#fallbacks += 1;
    this.#actualMode = nextMode;
    this.#invalidReason ??= 'Fallback to main-thread decoding occurred';
  }

  recordWorkerError(): void {
    if (!this.#active) return;
    this.#workerErrors += 1;
    this.#invalidReason ??= 'Decode worker failed during profiling';
  }

  #recordCommon(
    isBinary: boolean,
    bytes: number,
    ok: boolean,
    messageType?: string,
  ): void {
    this.#messageCount += 1;
    this.#receivedBytes += bytes;

    if (isBinary) {
      this.#binaryMessages += 1;
    } else {
      this.#textMessages += 1;
    }

    if (ok) {
      this.#decodedCount += 1;
      if (messageType) {
        this.#messageTypes[messageType] =
          (this.#messageTypes[messageType] ?? 0) + 1;
      }
    } else {
      this.#errors += 1;
    }
  }

  stop(valid = true, externalInvalidReason: string | null = null): DecodeExperimentReport {
    const durationMs = Math.max(0, this.#now() - this.#startedAt);
    const wasWorkerSession = this.#requestedMode === 'worker' || this.#actualMode === 'worker';
    const isMainOnly = this.#requestedMode === 'main' && this.#actualMode === 'main';

    const invalidReason =
      this.#invalidReason ?? externalInvalidReason ?? (valid ? null : 'Invalid session');
    const finalValid = valid && invalidReason === null;

    const mainWorkTotal =
      this.#mainWorkBuffer && this.#mainWorkBuffer.count > 0
        ? this.#mainWorkBuffer.sum
        : this.#messageCount === 0
          ? 0
          : null;

    const report: DecodeExperimentReport = {
      requestedMode: this.#requestedMode,
      actualMode: this.#actualMode,
      messageCount: this.#messageCount,
      decodedCount: this.#decodedCount,
      textMessages: this.#textMessages,
      binaryMessages: this.#binaryMessages,
      messageTypes: { ...this.#messageTypes },
      receivedBytes: this.#receivedBytes,
      durationMs,
      decodeMs:
        this.#mainDecodeBuffer && this.#mainDecodeBuffer.count > 0
          ? this.#mainDecodeBuffer.summarize()
          : null,
      mainThreadWorkMs: this.#mainWorkBuffer?.summarize() ?? null,
      mainThreadTotalMs: mainWorkTotal,
      postMessageMs: isMainOnly
        ? null
        : (this.#postMessageBuffer?.summarize() ?? null),
      responseBookkeepingMs: isMainOnly
        ? null
        : (this.#bookkeepingBuffer?.summarize() ?? null),
      workerDecodeMs: isMainOnly
        ? null
        : (this.#workerDecodeBuffer?.summarize() ?? null),
      roundTripMs: isMainOnly
        ? null
        : (this.#roundTripBuffer?.summarize() ?? null),
      estimatedOverheadMs: isMainOnly
        ? null
        : (this.#overheadBuffer?.summarize() ?? null),
      transferredBuffers: this.#transferredBuffers,
      maxPending: this.#maxPending,
      errors: this.#errors,
      fallbacks: this.#fallbacks,
      workerErrors: this.#workerErrors,
      valid: finalValid,
      invalidReason,
      limitations: wasWorkerSession
        ? [
            'Measured main-thread work covers postMessage dispatch and response bookkeeping; browser internal structured clone cost for returned ServerMessage may not be fully captured.',
            'Estimated messaging overhead (roundTripMs - workerDecodeMs) combines queue wait, thread scheduling, message delivery, and structured clone.',
          ]
        : [],
    };

    this.#active = false;
    this.#mainDecodeBuffer = null;
    this.#mainWorkBuffer = null;
    this.#postMessageBuffer = null;
    this.#bookkeepingBuffer = null;
    this.#workerDecodeBuffer = null;
    this.#roundTripBuffer = null;
    this.#overheadBuffer = null;
    clearDecodeMeasures();

    return report;
  }
}

