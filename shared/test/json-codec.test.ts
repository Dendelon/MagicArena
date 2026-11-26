import { describe, expect, test } from 'vitest';

import {
  createInputMessage,
  createSnapshotMessage,
  decodeMessage,
  encodeMessage,
  jsonCodec,
} from '../src/index.ts';

describe('JSON codec', () => {
  test('Encodes and decodes input and snapshot messages from JSON string', () => {
    const input = createInputMessage({
      seq: 7,
      tick: 12,
      thrust: true,
      turn: -0.5,
      fire: true,
      fireSeq: 7,
    });
    const snapshot = createSnapshotMessage({
      tick: 12,
      lastProcessedSeq: 7,
      entities: [],
    });

    expect(decodeMessage(encodeMessage(input))).toEqual(input);
    expect(decodeMessage(encodeMessage(snapshot))).toEqual(snapshot);
    expect(jsonCodec.decode(jsonCodec.encode(input))).toEqual(input);
  });

  test('Decodes from ArrayBuffer, Uint8Array, and DataView', () => {
    const input = createInputMessage({ seq: 15, tick: 30 });
    const bytes = new TextEncoder().encode(JSON.stringify(input));
    const bufferCopy = bytes.slice().buffer;

    expect(decodeMessage(bufferCopy)).toEqual(input);
    expect(decodeMessage(bytes)).toEqual(input);
    expect(decodeMessage(new DataView(bufferCopy))).toEqual(input);
  });

  test('Decodes DataView with non-zero byteOffset', () => {
    const input = createInputMessage({
      seq: 42,
      tick: 100,
    });

    const encoded = new TextEncoder().encode(JSON.stringify(input));
    const padded = new Uint8Array(encoded.byteLength + 10);

    padded.set(encoded, 5);

    const view = new DataView(padded.buffer, 5, encoded.byteLength);

    expect(decodeMessage(view)).toEqual(input);
  });

  test('Rejects unsupported non-string and non-buffer payloads', () => {
    expect(() => decodeMessage(null)).toThrow(TypeError);
    expect(() => decodeMessage(123)).toThrow(TypeError);
    expect(() => decodeMessage({ v: 1, type: 'input' })).toThrow(TypeError);
  });

  test('Rejects malformed JSON and valid JSON with invalid message shape', () => {
    expect(() => decodeMessage('{not valid json')).toThrow(
      'Invalid JSON message',
    );
    expect(() => decodeMessage('{"v": 99, "type": "input"}')).toThrow();
    expect(() => decodeMessage('{"v": 1, "type": "unknown"}')).toThrow();
  });
});

