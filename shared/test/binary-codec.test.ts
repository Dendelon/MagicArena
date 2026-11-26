import { describe, expect, test } from 'vitest';

import {
  Sword,
  Vector2,
  binaryCodec,
  createInputMessage,
  createSnapshotMessage,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
  toEntityId,
} from '../src/index.ts';

describe('Binary codec error branches and edge cases', () => {
  test('Rejects non-binary inputs passed to Reader', () => {
    expect(() => decodeInput('not-binary')).toThrow('Expected binary data');
    expect(() => decodeInput(123)).toThrow('Expected binary data');
    expect(() => decodeSnapshot(null)).toThrow('Expected binary data');
  });

  test('Rejects oversized binary packet', () => {
    const oversized = new Uint8Array(1024 * 1024 + 1);

    expect(() => decodeInput(oversized)).toThrow('Packet too large');
  });

  test('Rejects unexpected trailing bytes in snapshot packet', () => {
    const packet = encodeSnapshot(createSnapshotMessage());
    const padded = new Uint8Array(packet.byteLength + 1);
    padded.set(packet);

    expect(() => decodeSnapshot(padded)).toThrow('Unexpected trailing bytes');
  });

  test('Rejects wrong message type header and unsupported binaryCodec message', () => {
    const snapshotPacket = encodeSnapshot(createSnapshotMessage());
    expect(() => decodeInput(snapshotPacket)).toThrow('Unexpected message type');

    const badPacket = new Uint8Array([99, 1]);
    expect(() => binaryCodec.decode(badPacket)).toThrow(
      'Unknown binary message type',
    );
  });

  test('binaryCodec dispatches both input and snapshot messages', () => {
    const input = createInputMessage({ seq: 5, tick: 10 });
    const snapshot = createSnapshotMessage({ tick: 10, lastProcessedSeq: 5 });

    expect(binaryCodec.decode(binaryCodec.encode(input))).toEqual(input);
    expect(binaryCodec.decode(binaryCodec.encode(snapshot))).toEqual(snapshot);
  });

  test('Rejects array length exceeding MAX_ARRAY_LENGTH', () => {
    const packet = encodeSnapshot(createSnapshotMessage());
    const view = new DataView(
      packet.buffer,
      packet.byteOffset,
      packet.byteLength,
    );

    // Offset 10 is entities count (u16).
    view.setUint16(10, 4097, true);

    expect(() => decodeSnapshot(packet)).toThrow('Array too large');
  });

  test('Rejects invalid boolean flag in snapshot optional field', () => {
    const packet = encodeSnapshot(createSnapshotMessage());

    // Offset 12 is optional score presence flag (u8).
    packet[12] = 2;

    expect(() => decodeSnapshot(packet)).toThrow('Invalid boolean flag');
  });

  test('Rejects unknown entity kind index', () => {
    const sword = new Sword({ id: toEntityId(1), pos: new Vector2(10, 20) });
    const packet = encodeSnapshot(createSnapshotMessage({ entities: [sword] }));

    // Offset 12 is first entity's kindIndex (u8).
    packet[12] = 99;

    expect(() => decodeSnapshot(packet)).toThrow('Unknown entity kind');
  });

  test('Rejects corrupted ID type tag in entity', () => {
    const sword = new Sword({ id: toEntityId(1), pos: new Vector2(10, 20) });
    const packet = encodeSnapshot(createSnapshotMessage({ entities: [sword] }));

    // Offset 13 is entity id transfer tag (u8).
    packet[13] = 3;

    expect(() => decodeSnapshot(packet)).toThrow('Invalid ID type');
  });

  test('Rejects out-of-range quantized entity angle', () => {
    const sword = new Sword({ id: toEntityId(1), pos: new Vector2(10, 20) });
    const packet = encodeSnapshot(createSnapshotMessage({ entities: [sword] }));
    const view = new DataView(
      packet.buffer,
      packet.byteOffset,
      packet.byteLength,
    );

    // Header(2)+tick(4)+seq(4)+len(2)+kind(1)+idTag(1)+u32(4)+pos(8)+vel(8) = 34.
    view.setInt16(34, 4000, true);

    expect(() => decodeSnapshot(packet)).toThrow('Invalid angle');
  });

  test('Rejects invalid UTF-8 bytes in string ID', () => {
    const sword = new Sword({
      id: toEntityId('abc'),
      pos: new Vector2(10, 20),
    });
    const packet = encodeSnapshot(createSnapshotMessage({ entities: [sword] }));

    // Offset 13: id tag = 2; 14..15: len = 3; 16..18: UTF-8 bytes.
    packet[16] = 0xff;
    packet[17] = 0xfe;

    expect(() => decodeSnapshot(packet)).toThrow();
  });

  test('Supports ArrayBuffer input directly for decoding', () => {
    const packet = encodeInput(createInputMessage({ seq: 9, tick: 18 }));
    const copy = packet.slice().buffer;

    expect(decodeInput(copy)).toEqual(
      createInputMessage({ seq: 9, tick: 18 }),
    );
  });
});

