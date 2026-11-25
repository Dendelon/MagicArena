import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { encodeMessage, encodeSnapshot } from '@magicarena/shared';
import { MAX_MESSAGE_SIZE, parseMessage } from './protocol.ts';
import { createLatencyController } from './network/latency.js';

const RATE_PER_SECOND = 60;
const BUCKET_CAPACITY = 60;
const CHAT_RATE_PER_SECOND = 5;
const CHAT_BUCKET_CAPACITY = 10;
const MAX_BUFFERED_AMOUNT = 256 * 1024;

export const setupWebSocket = (
  server,
  roomManager,
  { matchManager = null, delayMs = 0, jitterMs = 0, dropRate = 0, codec = 'binary' } = {},
) => {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_SIZE,
    perMessageDeflate: false,
  });

  const latency = createLatencyController({ delayMs, jitterMs, dropRate });
  let shuttingDown = false;

  wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
  });

  const sendRaw = (socket, payload, critical = false) => {
    if (shuttingDown || socket.readyState !== WebSocket.OPEN) return;

    // Не накопичуємо нескінченну чергу для повільного клієнта
    if (socket.bufferedAmount > MAX_BUFFERED_AMOUNT) {
      if (critical) {
        socket.close(4009, 'Slow client');
      }
      return;
    }

    socket.send(payload);
  };

  const send = (socket, message, critical = false) => {
    sendRaw(socket, JSON.stringify({ v: 1, ...message }), critical);
  };

  const broadcast = (room, message, critical = false) => {
    for (const player of room.players.values()) {
      send(player.socket, message, critical);
    }
  };

  const broadcastRoster = (room) => {
    broadcast(
      room,
      {
        type: 'roster',
        players: room.getRoster(),
      },
      true,
    );
  };

  const broadcastSnapshot = (match) => {
    if (shuttingDown || match.stopped) return;

    const room = match.room;

    for (const player of room.players.values()) {
      if (player.socket.readyState !== WebSocket.OPEN) continue;

      const fireAcks = match.drainFireAcks(player.id);

      for (const ack of fireAcks) {
        latency.schedule(
          () => {
            if (shuttingDown || match.stopped || !room.players.has(player.id)) return;

            send(
              player.socket,
              {
                type: 'fireAck',
                ...ack,
              },
              true,
            );
          },
          { allowDrop: false },
        );
      }

      const snapshot = match.getSnapshotForPlayer(player.id);

      let payload;

      try {
        payload =
          codec === 'binary' ? encodeSnapshot(snapshot) : encodeMessage(snapshot);
      } catch (error) {
        console.error(`Snapshot encoding failed for room ${room.id}:`, error);

        player.socket.close(1011, 'Snapshot encoding failed');
        continue;
      }

      latency.schedule(
        () => {
          if (shuttingDown || match.stopped || !room.players.has(player.id)) return;

          sendRaw(player.socket, payload, false);
        },
        { allowDrop: true },
      );
    }
  };

  const registerRoom = (room) => {
    room.on('join', (player) => {
      broadcast(room, {
        type: 'notice',
        text: `${player.name} joined the room`,
      });

      broadcastRoster(room);
    });

    room.on('leave', (player) => {
      broadcast(room, {
        type: 'notice',
        text: `${player.name} left the room`,
      });

      broadcastRoster(room);
    });

    room.on('chat', (message) => {
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

  const handleUpgrade = (req, socket, head) => {
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

  server.on('upgrade', handleUpgrade);

  wss.on('connection', (socket) => {
    let currentRoom = null;
    let currentPlayer = null;

    socket.missedPongs = 0;
    socket.tokens = BUCKET_CAPACITY;
    socket.lastRefill = Date.now();
    socket.chatTokens = CHAT_BUCKET_CAPACITY;
    socket.lastChatRefill = Date.now();

    // Гравець має приєднатися до кімнати за 5 секунд
    const joinTimeout = setTimeout(() => {
      if (!currentRoom) {
        socket.close(4001, 'Join timeout');
      }
    }, 5000);

    socket.on('pong', () => {
      socket.missedPongs = 0;
    });

    socket.on('message', (data, isBinary) => {
      try {
        // Token Bucket: поступове відновлення токенів
        const now = Date.now();
        const elapsedSeconds = Math.max(0, (now - socket.lastRefill) / 1000);

        socket.tokens = Math.min(
          BUCKET_CAPACITY,
          socket.tokens + elapsedSeconds * RATE_PER_SECOND,
        );

        socket.lastRefill = now;

        if (socket.tokens < 1) {
          socket.close(4008, 'Rate limit exceeded');
          return;
        }

        socket.tokens -= 1;

        const message = parseMessage(data, isBinary, codec);

        if (message.type === 'join') {
          if (currentRoom) {
            socket.close(1008, 'Already joined');
            return;
          }

          const room = roomManager.get(message.room);

          if (!room) {
            socket.close(4004, 'Room not found');
            return;
          }

          const player = {
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
          );

          return;
        }

        if (!currentRoom || !currentPlayer) {
          socket.close(1008, 'Join required');
          return;
        }

        if (message.type === 'ping') {
          const room = currentRoom;
          const player = currentPlayer;

          latency.schedule(
            () => {
              if (shuttingDown || socket.readyState !== WebSocket.OPEN) return;
              if (!room.players.has(player.id)) return;

              latency.schedule(
                () => {
                  if (shuttingDown || !room.players.has(player.id)) return;

                  send(socket, {
                    type: 'pong',
                    id: message.id,
                    clientTime: message.clientTime,
                  });
                },
                { allowDrop: false },
              );
            },
            { allowDrop: false },
          );

          return;
        }

        if (message.type === 'input') {
          const room = currentRoom;
          const player = currentPlayer;
          const match = matchManager?.getMatch(room.id);

          if (!match) return;

          latency.schedule(
            () => {
              if (shuttingDown || match.stopped) return;
              if (socket.readyState !== WebSocket.OPEN) return;
              if (!room.players.has(player.id)) return;

              match.applyInput(player.id, message);
            },
            { allowDrop: true },
          );

          return;
        }

        if (message.type === 'chat') {
          const chatElapsed = Math.max(0, (now - socket.lastChatRefill) / 1000);
          socket.chatTokens = Math.min(
            CHAT_BUCKET_CAPACITY,
            socket.chatTokens + chatElapsed * CHAT_RATE_PER_SECOND,
          );
          socket.lastChatRefill = now;

          if (socket.chatTokens < 1) {
            socket.close(4008, 'Chat rate limit exceeded');
            return;
          }

          socket.chatTokens -= 1;

          if (currentRoom.logBackpressured) {
            socket.close(4009, 'Log backpressure');
            return;
          }

          currentRoom.chat(currentPlayer, message.text);
        }
      } catch (error) {
        console.warn('Invalid WS message:', error.message);
        socket.close(error.closeCode ?? 1008, 'Invalid message');
      }
    });

    socket.on('close', (code, reason) => {
      clearTimeout(joinTimeout);

      console.info('[WS] Client closed:', {
        playerId: currentPlayer?.id ?? null,
        code,
        reason: reason ? reason.toString('utf8') : '',
      });

      if (currentRoom && currentPlayer) {
        currentRoom.leave(currentPlayer.id);
      }
    });

    socket.on('error', (error) => {
      console.error('WebSocket error:', error.message);
    });
  });

  // Ping кожні 15 с; два пропущені pong — відключення
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;

      if (socket.missedPongs >= 2) {
        socket.terminate();
        continue;
      }

      socket.missedPongs++;
      socket.ping();
    }
  }, 15000);

  heartbeat.unref();

  // Викликаємо перед завершенням HTTP-сервера

  const shutdown = () => {
    shuttingDown = true;
    latency.clear();
    clearInterval(heartbeat);

    server.off('upgrade', handleUpgrade);
    roomManager.off('created', registerRoom);

    // Повідомляємо всім гравцям про завершення
    for (const socket of wss.clients) {
      socket.close(1001, 'Server shutting down');
    }

    return new Promise((resolve) => {
      // Чекаємо закриття WebSocket-з'єднань
      wss.close(() => resolve());

      // Примусове закриття завислих сокетів
      setTimeout(() => {
        for (const socket of wss.clients) {
          socket.terminate();
        }
      }, 1000).unref();
    });
  };

  return { broadcastSnapshot, shutdown };
};
