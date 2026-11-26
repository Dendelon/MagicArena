import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  PROTOCOL_VERSION,
  createSnapshotMessage,
  getCodec,
  toSeq,
  toTick,
} from '@magicarena/shared';

import {
  createConnection,
  resolveDecodeMode,
} from '../src/network/connection.ts';
import { processDecodeRequest } from '../src/network/decoder.worker.ts';
import {
  WorkerDecoder,
  type DecoderWorkerLike,
  type WorkerDecodeSettlement,
} from '../src/network/workerDecoder.ts';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '../src/network/workerProtocol.ts';
import { DecodeProfiler } from '../src/performance/DecodeProfiler.ts';

type WorkerListenerArgs =
  | ['message', (event: MessageEvent<unknown>) => void]
  | ['error', (event: Event) => void]
  | ['messageerror', (event: Event) => void];

type SocketListenerArgs =
  | ['open', (event: Event) => void]
  | ['message', (event: MessageEvent<string | ArrayBuffer>) => void]
  | ['close', (event: CloseEvent) => void]
  | ['error', (event: Event) => void];

class MockWorkerDouble implements DecoderWorkerLike {
  readonly #messageListeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly #errorListeners = new Set<(event: Event) => void>();
  readonly #messageErrorListeners = new Set<(event: Event) => void>();

  readonly posted: Array<{
    readonly message: WorkerOutboundMessage;
    readonly transfer?: Transferable[];
  }> = [];

  terminated = false;

  postMessage(
    message: WorkerOutboundMessage,
    transfer?: Transferable[],
  ): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(...args: WorkerListenerArgs): void {
    const [type, listener] = args;
    if (type === 'message') {
      this.#messageListeners.add(listener);
    } else if (type === 'error') {
      this.#errorListeners.add(listener);
    } else {
      this.#messageErrorListeners.add(listener);
    }
  }

  removeEventListener(...args: WorkerListenerArgs): void {
    const [type, listener] = args;
    if (type === 'message') {
      this.#messageListeners.delete(listener);
    } else if (type === 'error') {
      this.#errorListeners.delete(listener);
    } else {
      this.#messageErrorListeners.delete(listener);
    }
  }

  emitMessage(data: WorkerInboundMessage): void {
    const event = new MessageEvent<unknown>('message', { data });
    for (const listener of this.#messageListeners) {
      listener(event);
    }
  }

  emitError(message = 'Worker error'): void {
    const event = new Event('error');
    Object.defineProperty(event, 'message', { value: message });
    for (const listener of this.#errorListeners) {
      listener(event);
    }
  }
}

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly #openListeners = new Set<(event: Event) => void>();
  readonly #messageListeners = new Set<
    (event: MessageEvent<string | ArrayBuffer>) => void
  >();
  readonly #closeListeners = new Set<(event: CloseEvent) => void>();
  readonly #errorListeners = new Set<(event: Event) => void>();

  readyState = MockWebSocket.CONNECTING;
  binaryType = 'blob';
  readonly sent: Array<string | ArrayBuffer> = [];

  constructor(_url: string) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(...args: SocketListenerArgs): void {
    const [type, listener] = args;
    if (type === 'open') {
      this.#openListeners.add(listener);
    } else if (type === 'message') {
      this.#messageListeners.add(listener);
    } else if (type === 'close') {
      this.#closeListeners.add(listener);
    } else {
      this.#errorListeners.add(listener);
    }
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    const event = new CloseEvent('close', {
      code,
      reason,
      wasClean: code === 1000,
    });
    for (const listener of this.#closeListeners) {
      listener(event);
    }
  }

  triggerOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    const event = new Event('open');
    for (const listener of this.#openListeners) {
      listener(event);
    }
  }

  triggerMessage(data: string | ArrayBuffer): void {
    const event = new MessageEvent<string | ArrayBuffer>('message', { data });
    for (const listener of this.#messageListeners) {
      listener(event);
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  MockWebSocket.instances = [];
});

describe('WorkerDecoder lifecycle and ordering', () => {
  test('preserves strict message order even when worker responses arrive out of order and matches requestId', () => {
    const worker = new MockWorkerDouble();
    const settlements: WorkerDecodeSettlement[] = [];
    const fatalErrors: Error[] = [];

    const decoder = new WorkerDecoder({
      createWorker: () => worker,
      callbacks: {
        onResult: (settlement) => settlements.push(settlement),
        onFatalError: (error) => fatalErrors.push(error),
      },
    });

    worker.emitMessage({ type: 'ready' });

    const joinedJson = JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'notice',
      text: 'First notice',
    });
    const binarySnapshot = getCodec('binary').encode(
      createSnapshotMessage({
        tick: toTick(5),
        lastProcessedSeq: toSeq(2),
        entities: [],
      }),
    );

    if (!(binarySnapshot instanceof ArrayBuffer)) {
      throw new Error('Expected a binary snapshot');
    }

    const sub1 = decoder.submit(joinedJson, joinedJson.length);
    const sub2 = decoder.submit(binarySnapshot, binarySnapshot.byteLength);

    expect(sub1?.requestId).toBe(1);
    expect(sub1?.transferred).toBe(false);
    expect(sub2?.requestId).toBe(2);
    expect(sub2?.transferred).toBe(true);
    expect(worker.posted[1]?.transfer).toEqual([binarySnapshot]);

    const res1 = processDecodeRequest(worker.posted[0]?.message);
    const res2 = processDecodeRequest(worker.posted[1]?.message);
    if (!res1 || !res2) throw new Error('Expected worker responses');

    // Deliver response 2 before response 1: WorkerDecoder must wait and drain 1 -> 2.
    worker.emitMessage(res2);
    expect(settlements).toHaveLength(0);

    worker.emitMessage(res1);
    expect(settlements.map((s) => s.requestId)).toEqual([1, 2]);
    expect(settlements[0]?.response.type).toBe('decoded');
    expect(settlements[1]?.response.type).toBe('decoded');
    expect(fatalErrors).toEqual([]);

    decoder.terminate();
  });

  test('handles worker errors, clears pending requests on terminate, and enforces queue limits', () => {
    const worker = new MockWorkerDouble();
    const settlements: WorkerDecodeSettlement[] = [];
    const fatalErrors: Error[] = [];

    const decoder = new WorkerDecoder({
      createWorker: () => worker,
      maxPending: 2,
      callbacks: {
        onResult: (settlement) => settlements.push(settlement),
        onFatalError: (error) => fatalErrors.push(error),
      },
    });

    worker.emitMessage({ type: 'ready' });
    decoder.submit('{"v":1,"type":"notice","text":"1"}', 32);
    decoder.submit('{"v":1,"type":"notice","text":"2"}', 32);

    // 3rd submit exceeds maxPending=2
    const overflow = decoder.submit('{"v":1,"type":"notice","text":"3"}', 32);
    expect(overflow).toBeNull();
    expect(fatalErrors).toHaveLength(1);
    expect(worker.terminated).toBe(true);
    expect(decoder.getDiagnostics().pending).toBe(0);

    // Late message after termination must be ignored safely
    worker.emitMessage({
      type: 'decodeError',
      requestId: 1,
      error: 'ignored',
      durationMs: 0.1,
      isBinary: false,
    });
    expect(settlements).toHaveLength(0);

    // Worker crash test
    const worker2 = new MockWorkerDouble();
    const crashes: Error[] = [];
    const decoder2 = new WorkerDecoder({
      createWorker: () => worker2,
      callbacks: {
        onResult: () => {},
        onFatalError: (err) => crashes.push(err),
      },
    });
    worker2.emitError('Crash!');
    expect(crashes.map((e) => e.message)).toEqual(['Crash!']);
    expect(worker2.terminated).toBe(true);
    decoder2.terminate();
  });

  test('ignores stale worker responses after WebSocket reconnect and falls back cleanly on fatal worker failure', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);

    const workers: MockWorkerDouble[] = [];
    const decodeProfiler = new DecodeProfiler();
    decodeProfiler.start('worker', 'worker');

    const conn = createConnection({
      name: 'Tester',
      roomId: 'arcane',
      decodeMode: 'worker',
      decodeProfiler,
      createWorker: () => {
        const w = new MockWorkerDouble();
        workers.push(w);
        return w;
      },
    });

    const receivedNotices: string[] = [];
    conn.addEventListener('notice', (ev) => {
      receivedNotices.push(ev.detail.text);
    });

    conn.connect();
    const ws1 = MockWebSocket.instances[0];
    const worker1 = workers[0];
    if (!ws1 || !worker1) throw new Error('Expected initial socket and worker');

    worker1.emitMessage({ type: 'ready' });
    ws1.triggerOpen();

    // Queue message in worker1 before unexpected socket disconnect
    ws1.triggerMessage(
      JSON.stringify({ v: 1, type: 'notice', text: 'stale-from-ws1' }),
    );
    const req1 = worker1.posted[0]?.message;

    // Disconnect socket unexpectedly (triggers reconnect)
    ws1.close(1006, 'Dropped');
    expect(worker1.terminated).toBe(true);

    // Late response from old worker1 must be ignored
    const staleResp = processDecodeRequest(req1);
    if (staleResp) worker1.emitMessage(staleResp);
    expect(receivedNotices).toEqual([]);

    // Reconnect happens -> new worker2 created
    vi.advanceTimersByTime(1000);
    const ws2 = MockWebSocket.instances[1];
    const worker2 = workers[1];
    if (!ws2 || !worker2) throw new Error('Expected reconnected socket and worker');

    // Worker2 crashes -> fallback to main mode and reconnect
    worker2.emitError('Worker boom');
    expect(conn.getDecodeDiagnostics().fallbackOccurred).toBe(true);
    expect(conn.getDecodeDiagnostics().actualMode).toBe('main');

    vi.advanceTimersByTime(5000);
    const ws3 = MockWebSocket.instances[2];
    if (!ws3) throw new Error('Expected main-mode fallback socket');

    ws3.triggerOpen();
    ws3.triggerMessage(
      JSON.stringify({ v: 1, type: 'notice', text: 'fresh-main-fallback' }),
    );
    expect(receivedNotices).toEqual(['fresh-main-fallback']);

    const report = decodeProfiler.stop(true);
    expect(report.fallbacks).toBe(1);
    expect(report.workerErrors).toBe(1);
    expect(report.valid).toBe(false);
    conn.close();
  });
});

describe('resolveDecodeMode & DecodeProfiler metrics', () => {
  test('resolves decode mode strictly according to VITE_PROFILE flag and query params', () => {
    expect(resolveDecodeMode('?decode=worker', false)).toBe('main');
    expect(resolveDecodeMode('?decode=worker', true)).toBe('worker');
    expect(resolveDecodeMode('?decode=main', true)).toBe('main');
    expect(resolveDecodeMode('?decode=invalid', true)).toBe('main');
    expect(resolveDecodeMode('', true)).toBe('main');
  });

  test('computes main and worker metrics accurately with controlled timestamps and boundary safety', () => {
    let clock = 100;
    const profiler = new DecodeProfiler({ now: () => clock });

    // Main mode run
    profiler.start('main', 'main');
    profiler.recordMainDecode({
      durationMs: 0.4,
      isBinary: true,
      bytes: 120,
      ok: true,
      messageType: 'snapshot',
    });
    profiler.recordMainDecode({
      durationMs: 0.8,
      isBinary: false,
      bytes: 40,
      ok: false,
    });
    clock = 1100;

    const mainReport = profiler.stop(true);
    expect(mainReport.requestedMode).toBe('main');
    expect(mainReport.actualMode).toBe('main');
    expect(mainReport.messageCount).toBe(2);
    expect(mainReport.decodedCount).toBe(1);
    expect(mainReport.errors).toBe(1);
    expect(mainReport.binaryMessages).toBe(1);
    expect(mainReport.textMessages).toBe(1);
    expect(mainReport.receivedBytes).toBe(160);
    expect(mainReport.mainThreadTotalMs).toBeCloseTo(1.2, 6);
    expect(mainReport.decodeMs?.p50).toBe(0.4);
    expect(mainReport.decodeMs?.max).toBe(0.8);
    expect(mainReport.workerDecodeMs).toBeNull();
    expect(mainReport.roundTripMs).toBeNull();
    expect(mainReport.estimatedOverheadMs).toBeNull();

    // Worker mode run
    const sessionId = profiler.start('worker', 'worker');
    // Stale sample from previous session must be excluded at boundary
    profiler.recordWorkerDecode({
      sessionId: sessionId - 1,
      isBinary: true,
      bytes: 100,
      ok: true,
      messageType: 'snapshot',
      postMessageMs: 0.2,
      bookkeepingMs: 0.1,
      workerDecodeMs: 0.5,
      roundTripMs: 1.5,
      pendingAtSubmit: 2,
      transferredBuffer: true,
    });
    profiler.recordWorkerDecode({
      sessionId,
      isBinary: true,
      bytes: 200,
      ok: true,
      messageType: 'snapshot',
      postMessageMs: 0.15,
      bookkeepingMs: 0.1,
      workerDecodeMs: 0.45,
      roundTripMs: 1.25,
      pendingAtSubmit: 3,
      transferredBuffer: true,
    });
    clock = 2100;

    const workerReport = profiler.stop(true);
    expect(workerReport.decodeMs).toBeNull();
    expect(workerReport.messageCount).toBe(1);
    expect(workerReport.transferredBuffers).toBe(1);
    expect(workerReport.maxPending).toBe(3);
    expect(workerReport.mainThreadWorkMs?.p50).toBeCloseTo(0.25, 6);
    expect(workerReport.workerDecodeMs?.p50).toBeCloseTo(0.45, 6);
    expect(workerReport.roundTripMs?.p50).toBeCloseTo(1.25, 6);
    expect(workerReport.estimatedOverheadMs?.p50).toBeCloseTo(0.8, 6);
  });
});

