import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  createInputMessage,
  createSnapshotMessage,
  getCodec,
  toSeq,
  toTick,
} from '@magicarena/shared';

import { createConnection } from '../src/network/connection.ts';
import { decodeServerMessage } from '../src/network/decodeMessage.ts';
import type { DecoderWorkerLike } from '../src/network/workerDecoder.ts';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '../src/network/workerProtocol.ts';

type SocketListenerArgs =
  | ['open', (event: Event) => void]
  | ['message', (event: MessageEvent<string | ArrayBuffer>) => void]
  | ['close', (event: CloseEvent) => void]
  | ['error', (event: Event) => void];

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: Array<string | ArrayBuffer> = [];
  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = 'arraybuffer';

  readonly #listeners: {
    open: Array<(event: Event) => void>;
    message: Array<(event: MessageEvent<string | ArrayBuffer>) => void>;
    close: Array<(event: CloseEvent) => void>;
    error: Array<(event: Event) => void>;
  } = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(...args: SocketListenerArgs): void {
    switch (args[0]) {
      case 'open':
        this.#listeners.open.push(args[1]);
        break;
      case 'message':
        this.#listeners.message.push(args[1]);
        break;
      case 'close':
        this.#listeners.close.push(args[1]);
        break;
      case 'error':
        this.#listeners.error.push(args[1]);
        break;
    }
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.triggerClose(code, reason, true);
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    const event = new Event('open');
    for (const listener of [...this.#listeners.open]) {
      listener(event);
    }
  }

  triggerMessage(data: string | ArrayBuffer): void {
    const event = new MessageEvent<string | ArrayBuffer>('message', { data });
    for (const listener of [...this.#listeners.message]) {
      listener(event);
    }
  }

  triggerError(): void {
    const event = new Event('error');
    for (const listener of [...this.#listeners.error]) {
      listener(event);
    }
  }

  triggerClose(code: number, reason: string, wasClean = true): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    const event = new CloseEvent('close', { code, reason, wasClean });
    for (const listener of [...this.#listeners.close]) {
      listener(event);
    }
  }
}

type WorkerListenerArgs =
  | ['message', (event: MessageEvent<unknown>) => void]
  | ['error', (event: Event) => void]
  | ['messageerror', (event: Event) => void];

class InlineChaosWorker implements DecoderWorkerLike {
  readonly #messageListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();
  terminated = false;

  addEventListener(...args: WorkerListenerArgs): void {
    const [type, listener] = args;
    if (type === 'message') {
      this.#messageListeners.add(listener);
    }
  }

  removeEventListener(...args: WorkerListenerArgs): void {
    const [type, listener] = args;
    if (type === 'message') {
      this.#messageListeners.delete(listener);
    }
  }

  emitReady(): void {
    if (this.terminated) return;
    const ev = new MessageEvent<unknown>('message', {
      data: { type: 'ready' } satisfies WorkerInboundMessage,
    });
    for (const listener of this.#messageListeners) {
      listener(ev);
    }
  }

  postMessage(message: WorkerOutboundMessage): void {
    queueMicrotask(() => {
      if (this.terminated) return;

      const decoded = decodeServerMessage(message.data);
      const response: WorkerInboundMessage = decoded.ok
        ? {
            type: 'decoded',
            requestId: message.requestId,
            message: decoded.message,
            isBinary: decoded.isBinary,
            durationMs: 0.1,
          }
        : {
            type: 'decodeError',
            requestId: message.requestId,
            error: decoded.error,
            isBinary: decoded.isBinary,
            durationMs: 0.1,
          };

      const ev = new MessageEvent<unknown>('message', { data: response });
      for (const listener of this.#messageListeners) {
        listener(ev);
      }
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

const joinedJson = JSON.stringify({
  v: PROTOCOL_VERSION,
  type: 'joined',
  room: {
    id: 'arcane',
    name: 'Arcane Ruins',
    obstacleCount: 3,
    maxPlayers: 4,
    players: 1,
  },
  player: { id: 'p-1', name: 'Hero', entityId: 1 },
  entityId: 1,
  bounds: { width: 960, height: 640 },
  codec: 'binary',
  netSim: { delayMs: 0, jitterMs: 0, dropRate: 0 },
});

const shutdownJson = JSON.stringify({
  v: PROTOCOL_VERSION,
  type: 'shutdown',
  reason: 'Server is shutting down',
});

const requireSocket = (index: number): FakeWebSocket => {
  const socket = FakeWebSocket.instances[index];
  if (!socket) {
    throw new Error(`Expected FakeWebSocket at index ${index}`);
  }
  return socket;
};

describe('Client chaos & resilience', () => {
  test('reconnects with exponential backoff across client disconnect and server death, then resets backoff upon recovery', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const conn = createConnection({
      name: 'Hero',
      roomId: 'arcane',
      decodeMode: 'main',
    });

    const statuses: string[] = [];
    const joinedTicks: number[] = [];
    conn.addEventListener('status', (e) => statuses.push(e.detail));
    conn.addEventListener('joined', () => joinedTicks.push(joinedTicks.length + 1));

    conn.connect();
    const s1 = requireSocket(0);
    s1.triggerOpen();
    s1.triggerMessage(joinedJson);
    expect(conn.isJoined()).toBe(true);

    // 1. Unexpected client disconnect -> 1000ms backoff (500 * 2^1)
    s1.triggerClose(1006, 'Network dropped', false);
    expect(conn.isJoined()).toBe(false);
    expect(statuses.at(-1)).toBe('Reconnecting in 1000 ms...');

    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances.length).toBe(1);

    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(2);

    // 2. Server still dead during reconnect attempt -> 2000ms backoff (500 * 2^2)
    const s2 = requireSocket(1);
    s2.triggerError();
    s2.triggerClose(1006, 'ECONNREFUSED', false);
    expect(statuses.at(-1)).toBe('Reconnecting in 2000 ms...');

    vi.advanceTimersByTime(1999);
    expect(FakeWebSocket.instances.length).toBe(2);

    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(3);

    // 3. Server recovers -> client joins cleanly and resets reconnectAttempts
    const s3 = requireSocket(2);
    s3.triggerOpen();
    s3.triggerMessage(joinedJson);
    expect(conn.isJoined()).toBe(true);
    expect(joinedTicks).toEqual([1, 2]);

    conn.send(
      createInputMessage({ seq: toSeq(10), tick: toTick(20), thrust: true }),
    );
    expect(s3.sent.length).toBe(2); // join + binary input

    // Subsequent disconnect restarts backoff at 1000ms rather than 4000ms
    s3.triggerClose(1006, 'Transient drop', false);
    expect(statuses.at(-1)).toBe('Reconnecting in 1000 ms...');

    // Clean teardown leaves zero pending timers
    conn.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('terminates old worker decoder and re-initializes cleanly in worker mode on reconnect', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const workers: InlineChaosWorker[] = [];
    const conn = createConnection({
      name: 'Hero',
      roomId: 'arcane',
      decodeMode: 'worker',
      createWorker: () => {
        const w = new InlineChaosWorker();
        workers.push(w);
        return w;
      },
    });

    const snapshotTicks: number[] = [];
    conn.addEventListener('snapshot', (e) => snapshotTicks.push(e.detail.tick));

    conn.connect();
    const w1 = workers[0];
    if (!w1) throw new Error('Expected worker #1');
    w1.emitReady();

    const s1 = requireSocket(0);
    s1.triggerOpen();
    s1.triggerMessage(joinedJson);
    await vi.advanceTimersByTimeAsync(0);

    const binarySnap1 = getCodec('binary').encode(
      createSnapshotMessage({ tick: toTick(3) }),
    );
    s1.triggerMessage(binarySnap1);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshotTicks).toEqual([3]);

    // Disconnect terminates worker #1 and schedules reconnect
    s1.triggerClose(1006, 'Drop', false);
    expect(w1.terminated).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(workers.length).toBe(2);
    const w2 = workers[1];
    if (!w2) throw new Error('Expected worker #2');
    w2.emitReady();

    const s2 = requireSocket(1);
    s2.triggerOpen();
    s2.triggerMessage(joinedJson);
    await vi.advanceTimersByTimeAsync(0);

    const binarySnap2 = getCodec('binary').encode(
      createSnapshotMessage({ tick: toTick(12) }),
    );
    s2.triggerMessage(binarySnap2);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshotTicks).toEqual([3, 12]);

    conn.close();
    expect(w2.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('intentional server shutdown prevents infinite reconnect loops in both main and worker modes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    for (const mode of ['main', 'worker'] as const) {
      FakeWebSocket.instances = [];
      const workers: InlineChaosWorker[] = [];
      const conn = createConnection({
        name: 'Hero',
        roomId: 'arcane',
        decodeMode: mode,
        createWorker: () => {
          const w = new InlineChaosWorker();
          workers.push(w);
          return w;
        },
      });

      const statuses: string[] = [];
      conn.addEventListener('status', (e) => statuses.push(e.detail));
      conn.connect();

      if (mode === 'worker') {
        workers[0]?.emitReady();
      }

      const s1 = requireSocket(0);
      s1.triggerOpen();
      s1.triggerMessage(joinedJson);
      await vi.advanceTimersByTimeAsync(0);

      s1.triggerMessage(shutdownJson);
      await vi.advanceTimersByTimeAsync(0);
      s1.triggerClose(1001, 'Server shutting down', true);

      await vi.advanceTimersByTimeAsync(120_000);

      expect(FakeWebSocket.instances.length).toBe(1);
      expect(statuses.at(-1)).toBe('Server is shutting down');
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

