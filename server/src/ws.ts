import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { assertNever, getCodec, PROTOCOL_VERSION } from '@magicarena/shared';
import type { CodecMode, ServerMessage } from '@magicarena/shared';

import { MAX_MESSAGE_SIZE, ProtocolError, parseMessage } from './protocol.ts';
import { createLatencyController } from './network/latency.ts';
import { getErrorMessage } from './errors.ts';
import {
  BUCKET_CAPACITY,
  CHAT_BUCKET_CAPACITY,
  CHAT_RATE_PER_SECOND,
  RATE_PER_SECOND,
  consumeToken,
} from './network/rateLimit.ts';

import type { Player, SocketState, ChatEvent } from './types.ts';
import type { Room, RoomManager } from './rooms.ts';
import type { Match } from './game/Match.ts';
import type { MatchManager } from './game/MatchManager.ts';
import type { ServerProfiler } from './performance/ServerProfiler.ts';
import type { LoadProfiler } from './performance/LoadProfiler.ts';
import type { ServerMetrics } from './performance/ServerMetrics.ts';
import { serializeLogError, type AppLogger } from './log/logger.ts';
import type { RawData } from 'ws';

const MAX_BUFFERED_AMOUNT = 256 * 1024;
const LOAD_TEST_ROOM_ID = 'load-test';

const rawByteLength = (data: RawData): number => {
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) {
    let total = 0;
    for (const chunk of data) {
      total += chunk.byteLength;
    }
    return total;
  }
  return data.byteLength;
};

export type WebSocketLogger = Pick<AppLogger, 'info' | 'warn' | 'error'>;

interface WebSocketOptions {
  matchManager?: MatchManager | null;
  delayMs?: number;
  jitterMs?: number;
  dropRate?: number;
  codec?: CodecMode;
  profiler?: ServerProfiler | null;
  loadProfiler?: LoadProfiler | null;
  metrics?: ServerMetrics | null;
  logger?: WebSocketLogger | null;
}

type WithoutVersion<T> = T extends { v: number } ? Omit<T, 'v'> : never;

type OutgoingMessage = WithoutVersion<
  Exclude<ServerMessage, { type: 'snapshot' }>
>;

export const setupWebSocket = (
  server: Server,
  roomManager: RoomManager,
  {
    matchManager = null,
    delayMs = 0,
    jitterMs = 0,
    dropRate = 0,
    codec = 'binary',
    profiler = null,
    loadProfiler = null,
    metrics = null,
    logger = null,
  }: WebSocketOptions = {},
) => {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_SIZE,
    perMessageDeflate: false,
  });

  const latency = createLatencyController({ delayMs, jitterMs, dropRate });
  const gameCodec = getCodec(codec);
  const socketStates = new WeakMap<WebSocket, SocketState>();
  const activeJoinTimeouts = new Set<ReturnType<typeof setTimeout>>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  wss.on('error', (error: Error) => {
    if (logger) {
      logger.error(
        { event: 'wss.error', err: serializeLogError(error) },
        'wss.error',
      );
    } else {
      console.error('WebSocket server error:', error);
    }
  });

  const sendRaw = (
    socket: WebSocket,
    payload: string | ArrayBuffer,
    critical = false,
    isLoadTestRoom = false,
  ): void => {
    if (shuttingDown || socket.readyState !== WebSocket.OPEN) return;

    // Не накопичуємо нескінченну чергу для повільного клієнта
    if (socket.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      metrics?.recordBackpressure();
      if (isLoadTestRoom) {
        loadProfiler?.recordBackpressure();
      }
      if (critical) {
        socket.close(4009, 'Slow client');
      }
      return;
    }

    socket.send(payload);

    if (metrics !== null || isLoadTestRoom) {
      const bytes =
        typeof payload === 'string'
          ? Buffer.byteLength(payload)
          : payload.byteLength;
      metrics?.recordOutgoingMessage(bytes);
      if (isLoadTestRoom) {
        loadProfiler?.recordSent(bytes);
      }
    }
  };

  const send = (
    socket: WebSocket,
    message: OutgoingMessage,
    critical = false,
    isLoadTestRoom = false,
  ): void => {
    sendRaw(
      socket,
      JSON.stringify({
        v: PROTOCOL_VERSION,
        ...message,
      }),
      critical,
      isLoadTestRoom,
    );
  };

  const broadcast = (
    room: Room,
    message: OutgoingMessage,
    critical = false,
  ): void => {
    const isLoadTestRoom = room.id === LOAD_TEST_ROOM_ID;
    for (const player of room.players.values()) {
      send(player.socket, message, critical, isLoadTestRoom);
    }
  };

  const broadcastRoster = (room: Room): void => {
    broadcast(
      room,
      {
        type: 'roster',
        players: room.getRoster(),
      },
      true,
    );
  };

  const broadcastSnapshot = (match: Match): void => {
    if (shuttingDown || match.stopped) return;

    const room = match.room;
    const profiling = room.players.size > 0 && (profiler?.isRunning() ?? false);
    const broadcastStart = profiling ? performance.now() : 0;
    let snapshotCreateMs = 0;
    let binaryEncodingMs = 0;
    let encodedCount = 0;
    let snapshotCount = 0;

    for (const player of room.players.values()) {
      if (player.socket.readyState !== WebSocket.OPEN) continue;

      const fireAcks = match.drainFireAcks(player.id);

      for (const ack of fireAcks) {
        latency.schedule(
          () => {
            if (
              shuttingDown ||
              match.stopped ||
              !room.players.has(player.id)
            ) {
              return;
            }

            send(
              player.socket,
              {
                type: 'fireAck',
                ...ack,
              },
              true,
              room.id === LOAD_TEST_ROOM_ID,
            );
          },
          { allowDrop: false },
        );
      }

      const snapshotStart = profiling ? performance.now() : 0;
      const snapshot = match.getSnapshotForPlayer(player.id);
      if (profiling) {
        snapshotCreateMs += performance.now() - snapshotStart;
        snapshotCount += 1;
      }

      let payload: string | ArrayBuffer;

      try {
        const encodeStart = profiling ? performance.now() : 0;
        payload = gameCodec.encode(snapshot);
        if (profiling && codec === 'binary') {
          binaryEncodingMs += performance.now() - encodeStart;
          encodedCount += 1;
        }
      } catch (error: unknown) {
        if (logger) {
          logger.error(
            {
              event: 'ws.snapshot.encode_failed',
              roomId: room.id,
              err: serializeLogError(error),
            },
            'ws.snapshot.encode_failed',
          );
        } else {
          console.error(`Snapshot encoding failed for room ${room.id}:`, error);
        }

        player.socket.close(1011, 'Snapshot encoding failed');
        continue;
      }

      const isLoadTestRoom = room.id === LOAD_TEST_ROOM_ID;
      const scheduled = latency.schedule(
        () => {
          if (shuttingDown || match.stopped || !room.players.has(player.id)) {
            return;
          }

          sendRaw(player.socket, payload, false, isLoadTestRoom);
        },
        { allowDrop: true },
      );

      if (!scheduled) {
        metrics?.recordDroppedMessage();
        if (isLoadTestRoom) {
          loadProfiler?.recordDropped();
        }
      }
    }

    if (profiling && profiler) {
      if (snapshotCount > 0) {
        profiler.recordSnapshotCreate(snapshotCreateMs);
      }
      if (encodedCount > 0) {
        profiler.recordBinaryEncode(binaryEncodingMs);
      }
      profiler.recordBroadcast(performance.now() - broadcastStart);
      profiler.recordPlayers(room.players.size);
    }
  };

  const registerRoom = (room: Room): void => {
    room.on('join', (player: Player) => {
      broadcast(room, {
        type: 'notice',
        text: `${player.name} joined the room`,
      });

      broadcastRoster(room);
    });

    room.on('leave', (player: Player) => {
      broadcast(room, {
        type: 'notice',
        text: `${player.name} left the room`,
      });

      broadcastRoster(room);
    });

    room.on('chat', (message: ChatEvent) => {
      broadcast(room, {
        type: 'chat',
        ...message,
      });
    });
  };

  // Підписуємося на кімнати, які існують або будуть створені
  for (const room of roomManager.rooms.values()) {
    registerRoom(room);
  }

  roomManager.on('created', registerRoom);

  const rejectUpgrade = (socket: Duplex): void => {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
  };

  const handleUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (shuttingDown) {
      rejectUpgrade(socket);
      return;
    }

    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  };

  const rejectUpgradeDuringShutdown = (
    _req: IncomingMessage,
    socket: Duplex,
  ): void => {
    rejectUpgrade(socket);
  };

  server.on('upgrade', handleUpgrade);

  wss.on('connection', (socket: WebSocket) => {
    if (shuttingDown) {
      socket.close(1001, 'Server shutting down');
      return;
    }

    metrics?.recordConnectionOpened();
    logger?.info({ event: 'player.connected' }, 'player.connected');

    let currentRoom: Room | null = null;
    let currentPlayer: Player | null = null;

    const state: SocketState = {
      missedPongs: 0,

      tokens: BUCKET_CAPACITY,
      lastRefill: Date.now(),

      chatTokens: CHAT_BUCKET_CAPACITY,
      lastChatRefill: Date.now(),
    };

    socketStates.set(socket, state);

    // Гравець має приєднатися до кімнати за 5 секунд
    const joinTimeout = setTimeout(() => {
      activeJoinTimeouts.delete(joinTimeout);
      if (!currentRoom) {
        socket.close(4001, 'Join timeout');
      }
    }, 5000);
    activeJoinTimeouts.add(joinTimeout);

    socket.on('pong', () => {
      state.missedPongs = 0;
    });

    socket.on('message', (data, isBinary) => {
      try {
        const messageBytes = rawByteLength(data);
        metrics?.recordIncomingMessage(messageBytes);
        if (currentRoom?.id === LOAD_TEST_ROOM_ID) {
          loadProfiler?.recordReceived(messageBytes);
        }

        // Token Bucket: поступове відновлення токенів
        const now = Date.now();
        const messageLimit = consumeToken(state.tokens, state.lastRefill, now, {
          capacity: BUCKET_CAPACITY,
          ratePerSecond: RATE_PER_SECOND,
        });

        state.tokens = messageLimit.tokens;
        state.lastRefill = messageLimit.lastRefill;

        if (!messageLimit.allowed) {
          socket.close(4008, 'Rate limit exceeded');
          return;
        }

        const message = parseMessage(data, isBinary, codec);

        if (
          message.type !== 'join' &&
          (!currentRoom || !currentPlayer)
        ) {
          socket.close(1008, 'Join required');
          return;
        }

        switch (message.type) {
          case 'join': {
            if (shuttingDown) {
              socket.close(1001, 'Server shutting down');
              return;
            }

            if (currentRoom) {
              socket.close(1008, 'Already joined');
              return;
            }

            const room = roomManager.get(message.room);

            if (!room) {
              socket.close(4004, 'Room not found');
              return;
            }

            const player: Player = {
              id: randomUUID(),
              name: message.name,
              socket,
            };

            if (!room.join(player)) {
              socket.close(4003, 'Room is full');
              return;
            }

            currentRoom = room;
            currentPlayer = player;
            clearTimeout(joinTimeout);
            activeJoinTimeouts.delete(joinTimeout);

            if (room.id === LOAD_TEST_ROOM_ID) {
              loadProfiler?.recordReceived(messageBytes);
            }

            const match = matchManager?.getMatch(room.id) ?? null;
            const playerState = match?.getPlayer(player.id) ?? null;
            const entityId = playerState?.entityId ?? null;

            send(
              socket,
              {
                type: 'joined',
                room: room.getInfo(),
                player: {
                  id: player.id,
                  name: player.name,
                  entityId,
                },
                entityId,
                bounds: match?.bounds ?? null,
                codec,
                netSim: {
                  delayMs,
                  jitterMs,
                  dropRate,
                },
              },
              true,
              room.id === LOAD_TEST_ROOM_ID,
            );

            return;
          }

          case 'ping': {
            if (!currentRoom || !currentPlayer) return;

            const room = currentRoom;
            const player = currentPlayer;

            latency.schedule(
              () => {
                if (shuttingDown || socket.readyState !== WebSocket.OPEN) return;
                if (!room.players.has(player.id)) return;

                latency.schedule(
                  () => {
                    if (shuttingDown || !room.players.has(player.id)) return;

                    send(
                      socket,
                      {
                        type: 'pong',
                        id: message.id,
                        clientTime: message.clientTime,
                      },
                      false,
                      room.id === LOAD_TEST_ROOM_ID,
                    );
                  },
                  { allowDrop: false },
                );
              },
              { allowDrop: false },
            );

            return;
          }

          case 'input': {
            if (!currentRoom || !currentPlayer) return;

            const room = currentRoom;
            const player = currentPlayer;
            const match = matchManager?.getMatch(room.id);

            if (!match) return;

            const scheduled = latency.schedule(
              () => {
                if (shuttingDown || match.stopped) return;
                if (socket.readyState !== WebSocket.OPEN) return;
                if (!room.players.has(player.id)) return;

                match.applyInput(player.id, message);
              },
              { allowDrop: true },
            );

            if (!scheduled) {
              metrics?.recordDroppedMessage();
              if (room.id === LOAD_TEST_ROOM_ID) {
                loadProfiler?.recordDropped();
              }
            }

            return;
          }

          case 'chat': {
            if (!currentRoom || !currentPlayer) return;

            const room = currentRoom;
            const player = currentPlayer;

            const chatLimit = consumeToken(
              state.chatTokens,
              state.lastChatRefill,
              now,
              {
                capacity: CHAT_BUCKET_CAPACITY,
                ratePerSecond: CHAT_RATE_PER_SECOND,
              },
            );

            state.chatTokens = chatLimit.tokens;
            state.lastChatRefill = chatLimit.lastRefill;

            if (!chatLimit.allowed) {
              socket.close(4008, 'Chat rate limit exceeded');
              return;
            }

            if (room.logBackpressured) {
              socket.close(4009, 'Log backpressure');
              return;
            }

            room.chat(player, message.text);
            return;
          }

          default:
            return assertNever(message, 'Unhandled client message');
        }
      } catch (error: unknown) {
        if (logger) {
          logger.warn(
            {
              event: 'ws.message.invalid',
              playerId: currentPlayer?.id ?? null,
              roomId: currentRoom?.id ?? null,
              reason: getErrorMessage(error),
            },
            'ws.message.invalid',
          );
        } else {
          console.warn('Invalid WS message:', getErrorMessage(error));
        }

        const closeCode =
          error instanceof ProtocolError ? error.closeCode : 1008;

        socket.close(closeCode, 'Invalid message');
      }
    });

    socket.on('close', (code) => {
      clearTimeout(joinTimeout);
      activeJoinTimeouts.delete(joinTimeout);
      metrics?.recordConnectionClosed();

      logger?.info(
        {
          event: 'player.disconnected',
          playerId: currentPlayer?.id ?? null,
          roomId: currentRoom?.id ?? null,
          code,
        },
        'player.disconnected',
      );

      if (currentRoom && currentPlayer) {
        currentRoom.leave(currentPlayer.id);
      }
    });

    socket.on('error', (error: Error) => {
      if (logger) {
        logger.error(
          {
            event: 'ws.error',
            playerId: currentPlayer?.id ?? null,
            roomId: currentRoom?.id ?? null,
            err: serializeLogError(error),
          },
          'ws.error',
        );
      } else {
        console.error('WebSocket error:', error.message);
      }
    });
  });

  // Ping кожні 15 с; два пропущені pong — відключення
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;

      const state = socketStates.get(socket);
      if (!state) continue;

      if (state.missedPongs >= 2) {
        socket.terminate();
        continue;
      }

      state.missedPongs++;
      socket.ping();
    }
  }, 15000);

  heartbeat.unref();

  // Викликаємо перед завершенням HTTP-сервера

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== null) {
      return shutdownPromise;
    }

    shuttingDown = true;
    latency.clear();
    clearInterval(heartbeat);

    for (const timer of activeJoinTimeouts) {
      clearTimeout(timer);
    }
    activeJoinTimeouts.clear();

    server.off('upgrade', handleUpgrade);
    server.on('upgrade', rejectUpgradeDuringShutdown);
    server.once('close', () => {
      server.off('upgrade', rejectUpgradeDuringShutdown);
    });
    roomManager.off('created', registerRoom);

    const shutdownPayload = JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'shutdown',
      reason: 'Server is shutting down',
    });

    // Повідомляємо всім гравцям про завершення перед закриттям із кодом 1001
    for (const socket of wss.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(shutdownPayload);
          socket.close(1001, 'Server shutting down');
        } catch {
          socket.terminate();
        }
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
    }

    shutdownPromise = new Promise<void>((resolve) => {
      // Примусове закриття завислих сокетів
      const forceTerminateTimer = setTimeout(() => {
        for (const socket of wss.clients) {
          socket.terminate();
        }
      }, 1000);
      forceTerminateTimer.unref();

      // Чекаємо закриття WebSocket-з'єднань
      wss.close(() => {
        clearTimeout(forceTerminateTimer);
        resolve();
      });
    });

    return shutdownPromise;
  };

  return { broadcastSnapshot, shutdown };
};

