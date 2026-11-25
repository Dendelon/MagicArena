import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION,
  createInputMessage,
  encodeInput,
  parseClientMessage,
  parseServerMessage,
} from '@magicarena/shared';

import { MAX_MESSAGE_SIZE, ProtocolError, parseMessage } from '../src/protocol.ts';

test('parseMessage accepts valid join message and trims name', () => {
  const data = Buffer.from(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'join',
      room: 'room-1',
      name: '  Alice  ',
    }),
  );

  const parsed = parseMessage(data);

  assert.deepEqual(parsed, {
    v: PROTOCOL_VERSION,
    type: 'join',
    room: 'room-1',
    name: 'Alice',
  });
});

test('parseMessage accepts valid chat message and trims text', () => {
  const data = Buffer.from(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'chat',
      text: '  hello arena  ',
    }),
  );

  const parsed = parseMessage(data);

  assert.deepEqual(parsed, {
    v: PROTOCOL_VERSION,
    type: 'chat',
    text: 'hello arena',
  });
});

test('parseMessage rejects invalid join and chat payloads', () => {
  const invalidJoin = Buffer.from(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'join',
      room: '',
      name: '   ',
    }),
  );

  assert.throws(
    () => parseMessage(invalidJoin),
    (error: unknown) =>
      error instanceof ProtocolError && error.closeCode === 1008,
  );

  const oversizedChat = Buffer.from(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'chat',
      text: 'a'.repeat(301),
    }),
  );

  assert.throws(
    () => parseMessage(oversizedChat),
    (error: unknown) =>
      error instanceof ProtocolError && error.closeCode === 1008,
  );
});

test('parseMessage rejects ping with extra keys or invalid numbers', () => {
  const extraKeyPing = Buffer.from(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'ping',
      id: 1,
      clientTime: 100,
      extra: true,
    }),
  );

  assert.throws(
    () => parseMessage(extraKeyPing),
    (error: unknown) =>
      error instanceof ProtocolError && error.closeCode === 1008,
  );
});

test('parseMessage enforces codec rules for json and binary inputs', () => {
  const input = createInputMessage({
    seq: 3,
    tick: 10,
    thrust: true,
    turn: -0.5,
    fire: true,
    fireSeq: 3,
  });

  const jsonInput = Buffer.from(JSON.stringify(input));
  const binaryInput = Buffer.from(encodeInput(input));

  assert.equal(parseMessage(jsonInput, false, 'json').type, 'input');

  assert.throws(
    () => parseMessage(jsonInput, false, 'binary'),
    (error: unknown) =>
      error instanceof ProtocolError && error.closeCode === 1003,
  );

  assert.throws(
    () => parseMessage(binaryInput, true, 'json'),
    (error: unknown) =>
      error instanceof ProtocolError && error.closeCode === 1003,
  );

  const parsedBinary = parseMessage(binaryInput, true, 'binary');
  assert.equal(parsedBinary.type, 'input');
  if (parsedBinary.type === 'input') {
    assert.equal(parsedBinary.seq, 3);
    assert.equal(parsedBinary.fireSeq, 3);
  }
});

test('parseMessage rejects invalid JSON and oversized payloads', () => {
  assert.throws(
    () => parseMessage(Buffer.from('{invalid'), false, 'json'),
    (error: unknown) =>
      error instanceof ProtocolError && error.closeCode === 1007,
  );

  assert.throws(
    () => parseMessage(Buffer.alloc(MAX_MESSAGE_SIZE + 1), false, 'json'),
    (error: unknown) =>
      error instanceof ProtocolError && error.closeCode === 1009,
  );
});

test('parseClientMessage rejects malformed input payload', () => {
  const invalidMessage: unknown = {
    v: PROTOCOL_VERSION,
    type: 'input',
    seq: 'wrong',
  };

  const result = parseClientMessage(invalidMessage);

  assert.equal(result.success, false);
});

test('parseServerMessage validates joined and rejects unsupported codec', () => {
  const validJoined: unknown = {
    v: PROTOCOL_VERSION,
    type: 'joined',
    room: {
      id: 'room-1',
      name: 'Main Arena',
      obstacleCount: 3,
      maxPlayers: 4,
      players: 1,
    },
    player: {
      id: 'player-1',
      name: 'Alice',
      entityId: null,
    },
    entityId: null,
    bounds: { width: 1600, height: 900 },
    codec: 'binary',
    netSim: {
      delayMs: 0,
      jitterMs: 0,
      dropRate: 0,
    },
  };

  assert.equal(parseServerMessage(validJoined).success, true);

  const invalidCodec: unknown = {
    v: PROTOCOL_VERSION,
    type: 'joined',
    room: {
      id: 'room-1',
      name: 'Main Arena',
      obstacleCount: 3,
      maxPlayers: 4,
      players: 1,
    },
    player: {
      id: 'player-1',
      name: 'Alice',
      entityId: null,
    },
    entityId: null,
    bounds: { width: 1600, height: 900 },
    codec: 'msgpack',
    netSim: {
      delayMs: 0,
      jitterMs: 0,
      dropRate: 0,
    },
  };

  assert.equal(parseServerMessage(invalidCodec).success, false);
});

