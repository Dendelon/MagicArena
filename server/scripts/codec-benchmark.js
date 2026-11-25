import { performance } from 'node:perf_hooks';

import {
  encodeMessage,
  decodeMessage,
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
} from '@magicarena/shared';

import { createCodecFixture } from './codec-fixture.js';

const TICK_RATE = 30;
const ITERATIONS = 10000;
const WARMUP = 1000;

const { input, snapshot } = createCodecFixture();

const encoder = new TextEncoder();

const sizeOf = (payload) =>
  typeof payload === 'string'
    ? encoder.encode(payload).byteLength
    : payload.byteLength;

const measure = (encode, decode, message) => {
  for (let i = 0; i < WARMUP; i++) {
    decode(encode(message));
  }

  const started = performance.now();

  for (let i = 0; i < ITERATIONS; i++) {
    decode(encode(message));
  }

  return ((performance.now() - started) * 1000) / ITERATIONS;
};

const codecs = [
  {
    name: 'JSON',
    encodeInput: encodeMessage,
    decodeInput: decodeMessage,
    encodeSnapshot: encodeMessage,
    decodeSnapshot: decodeMessage,
  },
  {
    name: 'Binary',
    encodeInput,
    decodeInput,
    encodeSnapshot,
    decodeSnapshot,
  },
];

const results = codecs.map((codec) => {
  const snapshotBytes = sizeOf(codec.encodeSnapshot(snapshot));
  const inputBytes = sizeOf(codec.encodeInput(input));

  return {
    Codec: codec.name,
    'Bytes/snapshot': snapshotBytes,
    'Bytes/input': inputBytes,
    'KB/s down': Number(((snapshotBytes * TICK_RATE) / 1024).toFixed(2)),
    'KB/s up': Number(((inputBytes * TICK_RATE) / 1024).toFixed(2)),
    'Snapshot µs': Number(
      measure(codec.encodeSnapshot, codec.decodeSnapshot, snapshot).toFixed(2),
    ),
    'Input µs': Number(
      measure(codec.encodeInput, codec.decodeInput, input).toFixed(2),
    ),
  };
});

console.log('Magic Arena — codec benchmark');
console.log('Players: 4');
console.log('Entities:', snapshot.entities.length);
console.log('Tick rate:', TICK_RATE);

console.table(results);

const [json, binary] = results;

const reduction =
  (1 - binary['Bytes/snapshot'] / json['Bytes/snapshot']) * 100;

console.log(`Snapshot size reduction: ${reduction.toFixed(2)}%`);

console.log(
  'Payload throughput per client; transport overhead and service messages excluded.',
);

