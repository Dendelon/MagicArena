import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  createInputMessage,
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
  readyState = FakeWebSocket.OPEN;
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
    this.readyState = FakeWebSocket.CLOSED;
    this.triggerClose(code, reason, true);
  }

  triggerOpen(): void {
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

  triggerClose(code: number, reason: string, wasClean = true): void {
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

class InlineShutdownWorker implements DecoderWorkerLike {
  readonly #messageListeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();
  #terminated = false;

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
    if (this.#terminated) return;
    const ev = new MessageEvent<unknown>('message', {
      data: { type: 'ready' } satisfies WorkerInboundMessage,
    });
    for (const listener of this.#messageListeners) {
      listener(ev);
    }
  }

  postMessage(message: WorkerOutboundMessage): void {
    queueMicrotask(() => {
      if (this.#terminated) return;

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
    this.#terminated = true;
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

describe('Client shutdown handling', () => {
  for (const mode of ['main', 'worker'] as const) {
    test(`handles server shutdown in ${mode} mode without reconnect loops or extra input sends`, async () => {
      vi.useFakeTimers();
      vi.stubGlobal('WebSocket', FakeWebSocket);

      const workers: InlineShutdownWorker[] = [];
      const conn = createConnection({
        name: 'Hero',
        roomId: 'arcane',
        decodeMode: mode,
        createWorker: () => {
          const worker = new InlineShutdownWorker();
          workers.push(worker);
          return worker;
        },
      });

      const receivedReasons: string[] = [];
      const statuses: string[] = [];
      const disconnectCodes: number[] = [];

      conn.addEventListener('shutdown', (event) => {
        receivedReasons.push(event.detail.reason);
      });
      conn.addEventListener('status', (event) => {
        statuses.push(event.detail);
      });
      conn.addEventListener('disconnected', (event) => {
        disconnectCodes.push(event.detail.code);
      });

      conn.connect();
      const socket = FakeWebSocket.instances[0];
      if (!socket) {
        throw new Error('Expected FakeWebSocket instance');
      }

      if (mode === 'worker') {
        expect(workers.length).toBe(1);
        const worker = workers[0];
        if (!worker) throw new Error('Expected InlineShutdownWorker');
        worker.emitReady();
      }

      socket.triggerOpen();
      socket.triggerMessage(joinedJson);
      await vi.advanceTimersByTimeAsync(0);

      expect(conn.isJoined()).toBe(true);
      const sentBeforeShutdown = socket.sent.length;

      socket.triggerMessage(shutdownJson);
      await vi.advanceTimersByTimeAsync(0);

      expect(receivedReasons).toEqual(['Server is shutting down']);
      expect(statuses.at(-1)).toBe('Server is shutting down');
      expect(conn.isJoined()).toBe(false);

      // Sending game input after server shutdown must not transmit or queue.
      conn.send(
        createInputMessage({
          seq: toSeq(2),
          tick: toTick(5),
          thrust: true,
        }),
      );
      expect(socket.sent.length).toBe(sentBeforeShutdown);

      // Subsequent 1001 close must NOT schedule a reconnect attempt.
      socket.triggerClose(1001, 'Server shutting down', true);
      expect(disconnectCodes).toEqual([1001]);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(FakeWebSocket.instances.length).toBe(1);
    });
  }
});
