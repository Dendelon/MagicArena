import { isWorkerInboundMessage } from './workerProtocol.ts';
import type {
  DecodeErrorResponse,
  DecodeSuccessResponse,
  WorkerOutboundMessage,
} from './workerProtocol.ts';
import type { WirePayload } from './decodeMessage.ts';

const DEFAULT_STARTUP_TIMEOUT_MS = 3000;
const DEFAULT_MAX_PENDING = 256;

export interface DecoderWorkerLike {
  postMessage(
    message: WorkerOutboundMessage,
    transfer?: Transferable[],
  ): void;
  terminate(): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: Event) => void): void;
  addEventListener(
    type: 'messageerror',
    listener: (event: Event) => void,
  ): void;
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(type: 'error', listener: (event: Event) => void): void;
  removeEventListener(
    type: 'messageerror',
    listener: (event: Event) => void,
  ): void;
}

export interface WorkerDecodeSubmission {
  readonly requestId: number;
  readonly submittedAt: number;
  readonly postMessageMs: number;
  readonly transferred: boolean;
  readonly detachedAfterTransfer: boolean;
}

export interface WorkerDecodeSettlement {
  readonly requestId: number;
  readonly bytes: number;
  readonly submittedAt: number;
  readonly postMessageMs: number;
  readonly pendingCountAtSubmit: number;
  readonly response: DecodeSuccessResponse | DecodeErrorResponse;
}

export interface WorkerTransferDiagnostics {
  readonly ready: boolean;
  readonly terminated: boolean;
  readonly failed: boolean;
  readonly pending: number;
  readonly maxPendingObserved: number;
  readonly transferredBuffers: number;
  readonly detachedBuffers: number;
}

export interface WorkerDecoderCallbacks {
  readonly onResult: (settlement: WorkerDecodeSettlement) => void;
  readonly onFatalError: (error: Error) => void;
}

export interface WorkerDecoderOptions {
  readonly createWorker?: () => DecoderWorkerLike;
  readonly startupTimeoutMs?: number;
  readonly maxPending?: number;
  readonly callbacks: WorkerDecoderCallbacks;
}

interface PendingEntry {
  readonly requestId: number;
  readonly data: WirePayload;
  readonly bytes: number;
  readonly postReadySent: boolean;
  submittedAt: number;
  postMessageMs: number;
  pendingCountAtSubmit: number;
  response: DecodeSuccessResponse | DecodeErrorResponse | null;
}

const createDefaultWorker = (): DecoderWorkerLike =>
  new Worker(new URL('./decoder.worker.ts', import.meta.url), {
    type: 'module',
  });

export class WorkerDecoder {
  readonly #worker: DecoderWorkerLike;
  readonly #maxPending: number;
  readonly #callbacks: WorkerDecoderCallbacks;

  readonly #pending = new Map<number, PendingEntry>();

  #nextRequestId = 1;
  #ready = false;
  #terminated = false;
  #failed = false;
  #maxPendingObserved = 0;
  #transferredBuffers = 0;
  #detachedBuffers = 0;
  #startupTimer: ReturnType<typeof setTimeout> | null = null;

  readonly #onMessage = (event: MessageEvent<unknown>): void => {
    if (this.#terminated || this.#failed) return;

    const payload = event.data;
    if (!isWorkerInboundMessage(payload)) {
      this.#handleFatalError(new Error('Invalid message from decode worker'));
      return;
    }

    if (payload.type === 'ready') {
      this.#ready = true;
      this.#clearStartupTimer();
      this.#flushPreReadyEntries();
      return;
    }

    const entry = this.#pending.get(payload.requestId);
    if (!entry) {
      return;
    }

    entry.response = payload;
    this.#drainInOrder();
  };

  readonly #onError = (event: Event): void => {
    if (this.#terminated || this.#failed) return;

    const message =
      'message' in event && typeof event.message === 'string' && event.message
        ? event.message
        : 'Decode worker crashed';

    this.#handleFatalError(new Error(message));
  };

  readonly #onMessageError = (): void => {
    if (this.#terminated || this.#failed) return;
    this.#handleFatalError(new Error('Decode worker message deserialization error'));
  };

  constructor({
    createWorker = createDefaultWorker,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    maxPending = DEFAULT_MAX_PENDING,
    callbacks,
  }: WorkerDecoderOptions) {
    this.#maxPending = Math.max(1, Math.floor(maxPending));
    this.#callbacks = callbacks;
    this.#worker = createWorker();

    this.#worker.addEventListener('message', this.#onMessage);
    this.#worker.addEventListener('error', this.#onError);
    this.#worker.addEventListener('messageerror', this.#onMessageError);

    this.#startupTimer = setTimeout(() => {
      if (!this.#ready && !this.#terminated && !this.#failed) {
        this.#handleFatalError(new Error('Decode worker startup timed out'));
      }
    }, startupTimeoutMs);
  }

  submit(data: WirePayload, bytes: number): WorkerDecodeSubmission | null {
    if (this.#terminated || this.#failed) {
      return null;
    }

    if (this.#pending.size >= this.#maxPending) {
      this.#handleFatalError(
        new Error(
          `Worker decode queue limit exceeded (${this.#maxPending} pending requests)`,
        ),
      );
      return null;
    }

    const requestId = this.#nextRequestId++;
    const pendingCountAtSubmit = this.#pending.size + 1;
    if (pendingCountAtSubmit > this.#maxPendingObserved) {
      this.#maxPendingObserved = pendingCountAtSubmit;
    }

    const entry: PendingEntry = {
      requestId,
      data,
      bytes,
      postReadySent: this.#ready,
      submittedAt: 0,
      postMessageMs: 0,
      pendingCountAtSubmit,
      response: null,
    };

    this.#pending.set(requestId, entry);

    if (!this.#ready) {
      return {
        requestId,
        submittedAt: performance.now(),
        postMessageMs: 0,
        transferred: false,
        detachedAfterTransfer: false,
      };
    }

    return this.#dispatchEntry(entry);
  }

  #dispatchEntry(entry: PendingEntry): WorkerDecodeSubmission {
    const request: WorkerOutboundMessage = {
      type: 'decode',
      requestId: entry.requestId,
      data: entry.data,
    };

    const isBinary = entry.data instanceof ArrayBuffer;
    const submittedAt = performance.now();

    if (isBinary && entry.data instanceof ArrayBuffer) {
      this.#worker.postMessage(request, [entry.data]);
      const postMessageMs = Math.max(0, performance.now() - submittedAt);
      const detached = entry.data.byteLength === 0;

      this.#transferredBuffers += 1;
      if (detached) {
        this.#detachedBuffers += 1;
      }

      entry.submittedAt = submittedAt;
      entry.postMessageMs = postMessageMs;

      return {
        requestId: entry.requestId,
        submittedAt,
        postMessageMs,
        transferred: true,
        detachedAfterTransfer: detached,
      };
    }

    this.#worker.postMessage(request);
    const postMessageMs = Math.max(0, performance.now() - submittedAt);
    entry.submittedAt = submittedAt;
    entry.postMessageMs = postMessageMs;

    return {
      requestId: entry.requestId,
      submittedAt,
      postMessageMs,
      transferred: false,
      detachedAfterTransfer: false,
    };
  }

  #flushPreReadyEntries(): void {
    for (const entry of this.#pending.values()) {
      if (this.#terminated || this.#failed) return;
      if (entry.submittedAt === 0 && entry.response === null) {
        this.#dispatchEntry(entry);
      }
    }
  }

  #drainInOrder(): void {
    while (this.#pending.size > 0 && !this.#terminated && !this.#failed) {
      const oldest = this.#pending.entries().next();
      if (oldest.done) break;

      const [requestId, entry] = oldest.value;
      if (entry.response === null) {
        break;
      }

      this.#pending.delete(requestId);

      this.#callbacks.onResult({
        requestId: entry.requestId,
        bytes: entry.bytes,
        submittedAt: entry.submittedAt,
        postMessageMs: entry.postMessageMs,
        pendingCountAtSubmit: entry.pendingCountAtSubmit,
        response: entry.response,
      });
    }
  }

  #clearStartupTimer(): void {
    if (this.#startupTimer !== null) {
      clearTimeout(this.#startupTimer);
      this.#startupTimer = null;
    }
  }

  #handleFatalError(error: Error): void {
    if (this.#terminated || this.#failed) return;

    this.#failed = true;
    this.terminate();
    this.#callbacks.onFatalError(error);
  }

  getDiagnostics(): WorkerTransferDiagnostics {
    return {
      ready: this.#ready,
      terminated: this.#terminated,
      failed: this.#failed,
      pending: this.#pending.size,
      maxPendingObserved: this.#maxPendingObserved,
      transferredBuffers: this.#transferredBuffers,
      detachedBuffers: this.#detachedBuffers,
    };
  }

  terminate(): void {
    if (this.#terminated) return;

    this.#terminated = true;
    this.#clearStartupTimer();
    this.#pending.clear();

    this.#worker.removeEventListener('message', this.#onMessage);
    this.#worker.removeEventListener('error', this.#onError);
    this.#worker.removeEventListener('messageerror', this.#onMessageError);
    this.#worker.terminate();
  }
}

