import WebSocket, { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { MAX_MESSAGE_SIZE, parseMessage } from './protocol.js';

export const setupWebSocket = (server, roomManager) => {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_SIZE,
    perMessageDeflate: false,
  });

  wss.on('error', (error) => {
    console.error('WebSocket server error:', error);
  });

  const send = (socket, message, critical = false) => {
    if (socket.readyState !== WebSocket.OPEN) return;

    // Не накопичуємо нескінченну чергу для повільного клієнта
    if (socket.bufferedAmount > 256 * 1024) {
      if (critical) {
        socket.close(4009, 'Slow client');
      }
      return;
    }

    socket.send(JSON.stringify({ v: 1, ...message }));
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
    socket.messageCount = 0;
    socket.lastMessageWindow = Date.now();

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
        // Простий ліміт: 15 повідомлень за секунду
        const now = Date.now();

        if (now - socket.lastMessageWindow >= 1000) {
          socket.lastMessageWindow = now;
          socket.messageCount = 0;
        }

        socket.messageCount++;

        if (socket.messageCount > 15) {
          socket.close(4008, 'Rate limit exceeded');
          return;
        }

        const message = parseMessage(data, isBinary);

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

          send(
            socket,
            {
              type: 'joined',
              room: room.getInfo(),
              player: {
                id: player.id,
                name: player.name,
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

        if (message.type === 'chat') {
          currentRoom.chat(currentPlayer, message.text);
        }
      } catch (error) {
        console.warn('Invalid WS message:', error.message);
        socket.close(error.closeCode ?? 1008, 'Invalid message');
      }
    });

    socket.on('close', () => {
      clearTimeout(joinTimeout);

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
    clearInterval(heartbeat);
    server.off('upgrade', handleUpgrade);
    roomManager.off('created', registerRoom);

    for (const socket of wss.clients) {
      socket.close(1001, 'Server shutting down');
    }

    wss.close();

    setTimeout(() => {
      for (const socket of wss.clients) {
        socket.terminate();
      }
    }, 1000).unref();
  };

  return { shutdown };
};
