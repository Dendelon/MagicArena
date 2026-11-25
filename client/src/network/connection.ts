import {
  getCodec,
  parseServerMessage,
  PROTOCOL_VERSION,
} from '@magicarena/shared';

import type {
  ClientMessage,
  InputMessage,
  ServerMessage,
  CodecMode,
} from '@magicarena/shared';

import { createTypedEvents } from '../events.ts';

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
}

const byteLength = (data: WireData): number =>
  typeof data === 'string'
    ? textEncoder.encode(data).byteLength
    : data.byteLength;

const TRANSIENT_TYPES = new Set<ClientMessage['type']>(['input', 'ping']);

export const createConnection = ({ name, roomId }: ConnectionOptions) => {
  const events = createTypedEvents<ConnectionEvents>();
  const emit = events.emit;

  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let joined = false;
  let stopped = false;
  let codec: CodecMode | null = null;

  const queue: QueuedMessage[] = [];

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

    joined = false;
    codec = null;
    const currentSocket = new WebSocket(url);
    currentSocket.binaryType = 'arraybuffer';
    socket = currentSocket;

    emit('status', 'Connecting...');

    currentSocket.addEventListener('open', () => {
      if (socket !== currentSocket || stopped) return;

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
      if (socket !== currentSocket) return;

      try {
        const rawData: unknown = event.data;

        if (typeof rawData !== 'string' && !(rawData instanceof ArrayBuffer)) {
          throw new Error('Unsupported WebSocket payload');
        }

        const bytes = byteLength(rawData);

        const decoded: unknown =
          typeof rawData === 'string'
            ? JSON.parse(rawData)
            : getCodec('binary').decode(rawData);

        const result = parseServerMessage(decoded);

        if (!result.success) {
          console.warn('Invalid server message:', result.error.issues);
          return;
        }

        const message = result.data;

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

          default: {
            const exhaustive: never = message;

            throw new Error(
              `Unhandled server message: ${JSON.stringify(exhaustive)}`,
            );
          }
        }
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
    joined = false;
    codec = null;

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
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
  };
};

export type Connection = ReturnType<typeof createConnection>;

