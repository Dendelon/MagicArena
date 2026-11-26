import { test } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';

import { HttpError } from '../src/errors.ts';
import { RoomManager } from '../src/rooms.ts';
import {
  MAX_MESSAGE_SIZE,
  ProtocolError,
  parseMessage,
} from '../src/protocol.ts';

test('RoomManager enforces room limit', () => {
  const manager = new RoomManager({ maxRooms: 1 });

  manager.create({ name: 'First room' });

  assert.throws(
    () => manager.create({ name: 'Second room' }),
    (error: unknown) => error instanceof HttpError && error.status === 429,
  );
});

test('Room enforces player limit', async ({ onTestFinished }) => {
  const manager = new RoomManager();
  const room = manager.create({
    name: 'Test room',
    maxPlayers: 2,
  });

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
  });

  const clients: WebSocket[] = [];

  onTestFinished(async () => {
    for (const client of clients) {
      client.terminate();
    }

    for (const socket of wss.clients) {
      socket.terminate();
    }

    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  await once(wss, 'listening');

  const address = wss.address();

  if (!address || typeof address === 'string') {
    throw new Error('Invalid test server address');
  }

  const createTestSocket = async (): Promise<WebSocket> => {
    const accepted = new Promise<WebSocket>((resolve) => {
      wss.once('connection', resolve);
    });

    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);

    clients.push(client);

    const [socket] = await Promise.all([accepted, once(client, 'open')]);

    return socket;
  };

  assert.equal(
    room.join({ id: '1', name: 'Mage1', socket: await createTestSocket() }),
    true,
  );
  assert.equal(
    room.join({ id: '2', name: 'Mage2', socket: await createTestSocket() }),
    true,
  );
  assert.equal(
    room.join({ id: '3', name: 'Mage3', socket: await createTestSocket() }),
    false,
  );

  room.leave('1');
  room.leave('2');

  assert.equal(manager.get(room.id), undefined);
});

test('Protocol rejects unknown message type', () => {
  const data = Buffer.from(
    JSON.stringify({
      v: 1,
      type: 'unknown',
    }),
  );

  assert.throws(
    () => parseMessage(data),
    (error: unknown) =>
      error instanceof ProtocolError && error.closeCode === 1008,
  );
});

test('Protocol rejects oversized message', () => {
  const data = Buffer.alloc(MAX_MESSAGE_SIZE + 1);

  assert.throws(
    () => parseMessage(data),
    (error: unknown) =>
      error instanceof ProtocolError && error.closeCode === 1009,
  );
});

