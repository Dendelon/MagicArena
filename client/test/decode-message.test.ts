import { describe, expect, test } from 'vitest';

import {
  PROTOCOL_VERSION,
  Sword,
  createSnapshotMessage,
  getCodec,
  toEntityId,
  toSeq,
  toTick,
} from '@magicarena/shared';

import { decodeServerMessage } from '../src/network/decodeMessage.ts';
import { processDecodeRequest } from '../src/network/decoder.worker.ts';

describe('decodeServerMessage & worker parity', () => {
  test('decodes a valid JSON server message', () => {
    const payload = JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'notice',
      text: 'Welcome to the arena',
    });

    const mainResult = decodeServerMessage(payload);
    const workerResult = processDecodeRequest({
      type: 'decode',
      requestId: 1,
      data: payload,
    });

    expect(mainResult).toEqual({
      ok: true,
      isBinary: false,
      message: {
        v: PROTOCOL_VERSION,
        type: 'notice',
        text: 'Welcome to the arena',
      },
    });
    expect(workerResult).toMatchObject({
      type: 'decoded',
      requestId: 1,
      isBinary: false,
      message: mainResult.ok ? mainResult.message : null,
    });
  });

  test('decodes a valid binary snapshot identically in main and worker paths', () => {
    const sword = new Sword({
      id: toEntityId(10),
      ownerId: 'p1',
      pos: { x: 120, y: 240 },
      vel: { x: 30, y: -15 },
      angle: 0.5,
    });

    const snapshot = createSnapshotMessage({
      tick: toTick(12),
      lastProcessedSeq: toSeq(4),
      entities: [sword.toJSON()],
      bounds: { width: 960, height: 640 },
      score: 100,
    });

    const encodedMain = getCodec('binary').encode(snapshot);
    const encodedWorker = encodedMain.slice(0);

    const mainResult = decodeServerMessage(encodedMain);
    const workerResult = processDecodeRequest({
      type: 'decode',
      requestId: 7,
      data: encodedWorker,
    });

    expect(mainResult.ok).toBe(true);
    if (!mainResult.ok) {
      throw new Error('Expected binary snapshot decode to succeed');
    }

    expect(mainResult.isBinary).toBe(true);
    expect(mainResult.message).toEqual(snapshot);
    expect(workerResult?.type).toBe('decoded');
    if (workerResult?.type !== 'decoded') {
      throw new Error('Expected worker decoded response');
    }

    expect(workerResult.isBinary).toBe(true);
    expect(workerResult.message).toEqual(mainResult.message);
  });

  test('returns typed error for malformed JSON or schema-invalid JSON without throwing', () => {
    const malformed = decodeServerMessage('{broken-json');
    expect(malformed).toMatchObject({
      ok: false,
      isBinary: false,
    });

    const invalidSchema = decodeServerMessage(
      JSON.stringify({ v: 1, type: 'unknown_type' }),
    );
    expect(invalidSchema).toMatchObject({
      ok: false,
      isBinary: false,
    });

    const workerResponse = processDecodeRequest({
      type: 'decode',
      requestId: 3,
      data: '{broken-json',
    });
    expect(workerResponse).toMatchObject({
      type: 'decodeError',
      requestId: 3,
      isBinary: false,
    });
  });

  test('returns typed error for corrupted binary packet without throwing', () => {
    const corrupted = new Uint8Array([255, 1, 2, 3]).buffer;
    const workerCopy = corrupted.slice(0);

    const mainResult = decodeServerMessage(corrupted);
    const workerResponse = processDecodeRequest({
      type: 'decode',
      requestId: 9,
      data: workerCopy,
    });

    expect(mainResult).toMatchObject({
      ok: false,
      isBinary: true,
    });
    expect(workerResponse).toMatchObject({
      type: 'decodeError',
      requestId: 9,
      isBinary: true,
    });
  });
});

