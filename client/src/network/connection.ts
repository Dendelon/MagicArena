import {
  assertNever,
  getCodec,
  PROTOCOL_VERSION,
} from '@magicarena/shared';

import type {
  ClientMessage,
  InputMessage,
  ServerMessage,
  CodecMode,
} from '@magicarena/shared';

import { createTypedEvents } from '../events.ts';
import { decodeServerMessage } from './decodeMessage.ts';
import {
  WorkerDecoder,
  type DecoderWorkerLike,
  type WorkerTransferDiagnostics,
} from './workerDecoder.ts';
import type { DecodeMode } from './workerProtocol.ts';
import type { DecodeProfiler } from '../performance/DecodeProfiler.ts';

const textEncoder = new TextEncoder();

export interface TrafficEvent {
  readonly bytes: number;

  readonly type: ClientMessage['type'] | ServerMessage['type'];
}

export interface DisconnectEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export type ConnectionEvents = {
  [M in ServerMessage as M['type']]: M;
} & {
  status: string;
  disconnected: DisconnectEvent;
  rx: TrafficEvent;
  tx: TrafficEvent;
};

type WithoutVersion<T> = T extends { v: number } ? Omit<T, 'v'> : never;

type OutgoingMessage =
  | InputMessage
  | WithoutVersion<Exclude<ClientMessage, { type: 'input' }>>;

type WireData = string | ArrayBuffer;

interface QueuedMessage {
  readonly data: WireData;

  readonly type: ClientMessage['type'];
}

interface ConnectionOptions {
  name: string;
  roomId: string;
  decodeMode?: DecodeMode;
  createWorker?: () => DecoderWorkerLike;
  decodeProfiler?: DecodeProfiler | null;
  workerStartupTimeoutMs?: number;
  workerMaxPending?: number;
}

export interface ConnectionDecodeDiagnostics {
  readonly requestedMode: DecodeMode;
  readonly actualMode: DecodeMode;
  readonly fallbackOccurred: boolean;
  readonly worker: WorkerTransferDiagnostics | null;
}

export const resolveDecodeMode = (
  search = typeof window !== 'undefined' ? window.location.search : '',
  profilingEnabled = import.meta.env.VITE_PROFILE === '1',
): DecodeMode => {
  if (!profilingEnabled) {
    return 'main';
  }

  const param = new URLSearchParams(search).get('decode');
  return param === 'worker' ? 'worker' : 'main';
};

const byteLength = (data: WireData): number =>
  typeof data === 'string'
    ? textEncoder.encode(data).byteLength
    : data.byteLength;

const TRANSIENT_TYPES = new Set<ClientMessage['type']>(['input', 'ping']);

export const createConnection = ({
  name,
  roomId,
  decodeMode,
  createWorker,
  decodeProfiler = null,
  workerStartupTimeoutMs,
  workerMaxPending,
}: ConnectionOptions) => {
  const events = createTypedEvents<ConnectionEvents>();
  const emit = events.emit;

  const requestedDecodeMode: DecodeMode = decodeMode ?? resolveDecodeMode();
  let activeDecodeMode: DecodeMode = requestedDecodeMode;
  let fallbackOccurred = false;
  let generation = 0;

  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let joined = false;
  let stopped = false;
  let codec: CodecMode | null = null;
  let activeWorkerDecoder: WorkerDecoder | null = null;
  let lastWorkerDiagnostics: WorkerTransferDiagnostics | null = null;
  const workerRequestSessions = new Map<number, number>();
  let inFlightSubmitSessionId: number | null = null;
  let settledDuringSyncSubmit = false;

  const queue: QueuedMessage[] = [];

  const terminateWorkerDecoder = (): void => {
    if (activeWorkerDecoder) {
      activeWorkerDecoder.terminate();
      lastWorkerDiagnostics = activeWorkerDecoder.getDiagnostics();
      activeWorkerDecoder = null;
    }
    workerRequestSessions.clear();
  };

  const transmit = (data: WireData, type: ClientMessage['type']): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(data);
    emit('tx', {
      bytes: byteLength(data),
      type,
    });
  };

  const dispatchServerMessage = (
    message: ServerMessage,
    bytes: number,
  ): void => {
    if (message.type === 'joined') {
      codec = message.codec;
      joined = true;
      reconnectAttempts = 0;

      while (queue.length > 0) {
        const item = queue.shift();

        if (!item) break;

        transmit(item.data, item.type);
      }
    }

    emit('rx', {
      bytes,
      type: message.type,
    });

    switch (message.type) {
      case 'joined':
        emit('joined', message);
        break;

      case 'snapshot':
        emit('snapshot', message);
        break;

      case 'fireAck':
        emit('fireAck', message);
        break;

      case 'roster':
        emit('roster', message);
        break;

      case 'notice':
        emit('notice', message);
        break;

      case 'chat':
        emit('chat', message);
        break;

      case 'pong':
        emit('pong', message);
        break;

      case 'shutdown':
        stopped = true;
        joined = false;
        codec = null;
        clearRetryTimer();
        queue.length = 0;
        emit('shutdown', message);
        emit('status', message.reason || 'Server is shutting down');
        break;

      default:
        return assertNever(message, 'Unhandled server message');
    }
  };

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const connect = (): void => {
    if (stopped) return;

    clearRetryTimer();

    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${scheme}//${window.location.host}/ws`;

    terminateWorkerDecoder();
    const connGeneration = ++generation;

    if (reconnectAttempts > 0) {
      decodeProfiler?.recordReconnect();
    }

    joined = false;
    codec = null;
    const currentSocket = new WebSocket(url);
    currentSocket.binaryType = 'arraybuffer';
    socket = currentSocket;

    if (activeDecodeMode === 'worker') {
      const workerDecoder = new WorkerDecoder({
        createWorker,
        startupTimeoutMs: workerStartupTimeoutMs,
        maxPending: workerMaxPending,
        callbacks: {
          onResult: (settlement) => {
            if (
              stopped ||
              socket !== currentSocket ||
              connGeneration !== generation
            ) {
              workerRequestSessions.delete(settlement.requestId);
              return;
            }

            const hasMappedSession = workerRequestSessions.has(
              settlement.requestId,
            );
            const sessionId = hasMappedSession
              ? workerRequestSessions.get(settlement.requestId)
              : inFlightSubmitSessionId !== null
                ? inFlightSubmitSessionId
                : undefined;

            if (!hasMappedSession && inFlightSubmitSessionId !== null) {
              settledDuringSyncSubmit = true;
            }
            workerRequestSessions.delete(settlement.requestId);

            const bookkeepingStart = performance.now();
            const response = settlement.response;

            if (response.type === 'decoded') {
              dispatchServerMessage(response.message, settlement.bytes);
            } else {
              console.warn('Invalid server message:', response.error);
            }

            const finishedAt = performance.now();

            if (sessionId !== undefined && decodeProfiler?.isActive()) {
              decodeProfiler.recordWorkerDecode({
                sessionId,
                isBinary: response.isBinary,
                bytes: settlement.bytes,
                ok: response.type === 'decoded',
                messageType:
                  response.type === 'decoded'
                    ? response.message.type
                    : undefined,
                postMessageMs: settlement.postMessageMs,
                bookkeepingMs: Math.max(0, finishedAt - bookkeepingStart),
                workerDecodeMs: response.durationMs,
                roundTripMs: Math.max(0, finishedAt - settlement.submittedAt),
                pendingAtSubmit: settlement.pendingCountAtSubmit,
                transferredBuffer: response.isBinary,
              });
            }
          },

          onFatalError: (error) => {
            if (
              stopped ||
              socket !== currentSocket ||
              connGeneration !== generation
            ) {
              return;
            }

            console.warn(
              'Decode worker failed, falling back to main mode:',
              error.message,
            );
            decodeProfiler?.recordWorkerError();
            decodeProfiler?.recordFallback('main');
            fallbackOccurred = true;
            activeDecodeMode = 'main';
            terminateWorkerDecoder();
            currentSocket.close(1011, 'Worker decoder failed');
          },
        },
      });

      activeWorkerDecoder = workerDecoder;
    }

    emit('status', 'Connecting...');

    currentSocket.addEventListener('open', () => {
      if (socket !== currentSocket || stopped || connGeneration !== generation) {
        return;
      }

      // При кожному підключенні спочатку входимо в кімнату
      transmit(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'join',
          room: roomId,
          name,
        }),
        'join',
      );

      emit('status', 'Connected');
    });

    currentSocket.addEventListener('message', (event: MessageEvent) => {
      if (socket !== currentSocket || connGeneration !== generation) return;

      try {
        const rawData: unknown = event.data;

        if (typeof rawData !== 'string' && !(rawData instanceof ArrayBuffer)) {
          throw new Error('Unsupported WebSocket payload');
        }

        const bytes = byteLength(rawData);

        if (activeDecodeMode === 'worker' && activeWorkerDecoder) {
          const sessionId = decodeProfiler?.isActive()
            ? decodeProfiler.getSessionId()
            : null;
          inFlightSubmitSessionId = sessionId;
          settledDuringSyncSubmit = false;
          let submission = null;
          try {
            submission = activeWorkerDecoder.submit(rawData, bytes);
          } finally {
            inFlightSubmitSessionId = null;
          }

          if (
            submission &&
            sessionId !== null &&
            !settledDuringSyncSubmit
          ) {
            workerRequestSessions.set(submission.requestId, sessionId);
          }
          settledDuringSyncSubmit = false;

          return;
        }

        const decodeStart = performance.now();
        const result = decodeServerMessage(rawData);
        const decodeEnd = performance.now();

        if (decodeProfiler?.isActive()) {
          decodeProfiler.recordMainDecode(
            {
              durationMs: Math.max(0, decodeEnd - decodeStart),
              isBinary: result.isBinary,
              bytes,
              ok: result.ok,
              messageType: result.ok ? result.message.type : undefined,
            },
            decodeStart,
            decodeEnd,
          );
        }

        if (!result.ok) {
          console.warn('Invalid server message:', result.error);
          return;
        }

        dispatchServerMessage(result.message, bytes);
      } catch (error: unknown) {
        console.error('Invalid server message:', error);
      }
    });

    currentSocket.addEventListener('close', (event: CloseEvent) => {
      if (socket !== currentSocket) return;

      console.info('[WS] Closed:', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      terminateWorkerDecoder();
      socket = null;
      joined = false;
      codec = null;
      queue.length = 0;

      emit('disconnected', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (stopped) return;

      reconnectAttempts += 1;

      const delay = Math.min(10000, 500 * 2 ** Math.min(reconnectAttempts, 5));

      emit('status', `Reconnecting in ${delay} ms...`);

      clearRetryTimer();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay);
    });

    currentSocket.addEventListener('error', () => {
      if (socket !== currentSocket) return;

      emit('status', 'Connection error');
    });
  };

  const send = (message: OutgoingMessage): void => {
    const isReady = joined && socket?.readyState === WebSocket.OPEN;

    if (TRANSIENT_TYPES.has(message.type) && !isReady) {
      return;
    }

    let data: WireData;

    if (message.type === 'input') {
      if (codec === null) return;

      data = getCodec(codec).encode(message);
    } else {
      data = JSON.stringify({
        v: PROTOCOL_VERSION,
        ...message,
      });
    }

    if (isReady) {
      transmit(data, message.type);
      return;
    }

    if (!stopped && queue.length < 20) {
      queue.push({
        data,
        type: message.type,
      });
    }
  };

  const close = (): void => {
    stopped = true;
    generation += 1;
    joined = false;
    codec = null;

    terminateWorkerDecoder();
    clearRetryTimer();
    queue.length = 0;

    socket?.close(1000, 'Leaving game');
  };

  return {
    connect,
    send,
    close,
    isOpen: () => socket?.readyState === WebSocket.OPEN,
    isJoined: () => Boolean(socket?.readyState === WebSocket.OPEN && joined),
    getDecodeDiagnostics: (): ConnectionDecodeDiagnostics => ({
      requestedMode: requestedDecodeMode,
      actualMode: activeDecodeMode,
      fallbackOccurred,
      worker: activeWorkerDecoder
        ? activeWorkerDecoder.getDiagnostics()
        : lastWorkerDiagnostics,
    }),
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
  };
};

export type Connection = ReturnType<typeof createConnection>;

