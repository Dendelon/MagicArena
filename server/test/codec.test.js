import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createInputMessage,
  createSnapshotMessage,
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
  jsonCodec,
  binaryCodec,
  getCodec,
} from '@magicarena/shared';

import { createCodecFixture } from '../scripts/codec-fixture.js';

const assertApproximatelyEqual = (actual, expected, path = 'root') => {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', path);

    let difference = Math.abs(actual - expected);

    if (path.endsWith('.angle')) {
      difference = Math.abs(
        Math.atan2(
          Math.sin(actual - expected),
          Math.cos(actual - expected),
        ),
      );

      assert.ok(difference <= 0.001, path);
      return;
    }

    const tolerance = Math.max(0.00001, Math.abs(expected) * 0.000001);

    assert.ok(difference <= tolerance, path);
    return;
  }

  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, path);

    expected.forEach((value, i) => {
      assertApproximatelyEqual(actual[i], value, `${path}[${i}]`);
    });

    return;
  }

  if (expected !== null && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', path);

    assert.deepEqual(
      Object.keys(actual).sort(),
      Object.keys(expected).sort(),
      path,
    );

    for (const key of Object.keys(expected)) {
      assertApproximatelyEqual(actual[key], expected[key], `${path}.${key}`);
    }

    return;
  }

  assert.equal(actual, expected, path);
};

test('Binary input round-trip', () => {
  const { input } = createCodecFixture();

  assert.deepEqual(decodeInput(encodeInput(input)), input);
});

test('Input without optional fire sequence', () => {
  const input = createInputMessage({
    seq: 1,
    tick: 2,
  });

  assert.deepEqual(decodeInput(encodeInput(input)), input);
});

test('Snapshot with all entity types', () => {
  const { snapshot } = createCodecFixture();

  const decoded = decodeSnapshot(encodeSnapshot(snapshot));

  assertApproximatelyEqual(decoded, snapshot);
});

test('Empty snapshot round-trip', () => {
  const snapshot = createSnapshotMessage({
    tick: 1,
    lastProcessedSeq: 0,
    entities: [],
  });

  assert.deepEqual(decodeSnapshot(encodeSnapshot(snapshot)), snapshot);
});

test('Reject unsupported version', () => {
  const { input } = createCodecFixture();
  const packet = encodeInput(input);

  packet[1] = 255;

  assert.throws(() => decodeInput(packet));
});

test('Reject unknown message type', () => {
  const { input } = createCodecFixture();
  const packet = encodeInput(input);

  packet[0] = 255;

  assert.throws(() => decodeInput(packet));
});

test('Reject truncated input and snapshot', () => {
  const { input, snapshot } = createCodecFixture();

  assert.throws(() => decodeInput(encodeInput(input).subarray(0, 5)));

  const packet = encodeSnapshot(snapshot);

  assert.throws(() =>
    decodeSnapshot(packet.subarray(0, packet.byteLength - 1)),
  );
});

test('Decode Uint8Array with non-zero byteOffset', () => {
  const { input } = createCodecFixture();
  const packet = encodeInput(input);

  const padded = new Uint8Array(packet.byteLength + 16);
  padded.set(packet, 8);

  const view = padded.subarray(8, 8 + packet.byteLength);

  assert.deepEqual(decodeInput(view), input);
});

test('Binary snapshots are smaller than JSON', () => {
  const { snapshot } = createCodecFixture();

  const jsonBytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;

  const binaryBytes = encodeSnapshot(snapshot).byteLength;

  assert.ok(binaryBytes < jsonBytes);
});

test('Both codecs implement the same API', () => {
  const input = createInputMessage({
    seq: 42,
    tick: 100,
    thrust: true,
    turn: -1,
    fire: true,
    fireSeq: 42,
  });

  for (const codec of [jsonCodec, binaryCodec]) {
    assert.deepEqual(codec.decode(codec.encode(input)), input);
  }
});

test('Select codec by configured mode', () => {
  assert.equal(getCodec('json'), jsonCodec);
  assert.equal(getCodec('binary'), binaryCodec);
});

test('Binary codec returns ArrayBuffer', () => {
  const input = createInputMessage();

  assert.ok(binaryCodec.encode(input) instanceof ArrayBuffer);
});

test('Input wire format remains unchanged', () => {
  const input = createInputMessage({
    seq: 42,
    tick: 100,
    thrust: true,
    turn: -1,
    fire: true,
    fireSeq: 42,
  });

  const expected = Buffer.from(
    '01012a00000064000000000000000000f0bf152a000000',
    'hex',
  );

  const actual = Buffer.from(encodeInput(input));

  assert.deepEqual(actual, expected);
  assert.equal(actual.byteLength, 23);
});

test('Empty snapshot wire format remains unchanged', () => {
  const snapshot = createSnapshotMessage({
    tick: 100,
    lastProcessedSeq: 42,
    entities: [],
  });

  const expected = Buffer.from('0201640000002a000000000000000000', 'hex');

  const actual = Buffer.from(encodeSnapshot(snapshot));

  assert.deepEqual(actual, expected);
  assert.equal(actual.byteLength, 16);
});

test('Reject invalid binary input flags', () => {
  const packet = encodeInput(createInputMessage());

  packet[18] |= 128;

  assert.throws(() => decodeInput(packet));
});

test('Reject trailing binary bytes', () => {
  const packet = encodeInput(createInputMessage());

  const padded = new Uint8Array(packet.byteLength + 1);

  padded.set(packet);

  assert.throws(() => decodeInput(padded));
});

test('Reject binary input outside turn range', () => {
  const packet = encodeInput(createInputMessage());

  const view = new DataView(
    packet.buffer,
    packet.byteOffset,
    packet.byteLength,
  );

  view.setFloat64(10, 1000, true);

  assert.throws(() => decodeInput(packet));
});

