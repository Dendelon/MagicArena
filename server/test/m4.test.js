import test from 'node:test';
import assert from 'node:assert/strict';

import { RoomManager } from '../src/rooms.js';
import { MAX_MESSAGE_SIZE, parseMessage } from '../src/protocol.ts';

test('RoomManager enforces room limit', () => {
  const manager = new RoomManager({ maxRooms: 1 });

  manager.create({ name: 'First room' });

  assert.throws(
    () => manager.create({ name: 'Second room' }),
    (error) => error.status === 429,
  );
});

test('Room enforces player limit', () => {
  const manager = new RoomManager();
  const room = manager.create({
    name: 'Test room',
    maxPlayers: 2,
  });

  assert.equal(room.join({ id: '1', name: 'Mage1' }), true);
  assert.equal(room.join({ id: '2', name: 'Mage2' }), true);
  assert.equal(room.join({ id: '3', name: 'Mage3' }), false);

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
    (error) => error.closeCode === 1008,
  );
});

test('Protocol rejects oversized message', () => {
  const data = Buffer.alloc(MAX_MESSAGE_SIZE + 1);

  assert.throws(
    () => parseMessage(data),
    (error) => error.closeCode === 1009,
  );
});
