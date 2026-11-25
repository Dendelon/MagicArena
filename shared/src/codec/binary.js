import { PROTOCOL_VERSION, assertValidMessage } from '../protocol/messages.ts';

const INPUT = 1;
const SNAPSHOT = 2;

const MAX_PACKET_SIZE = 1024 * 1024;
const MAX_ARRAY_LENGTH = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const NUMBERS = {
  u8: ['Uint8', 1, 0, 255],
  u16: ['Uint16', 2, 0, 65535],
  u32: ['Uint32', 4, 0, 4294967295],
  i16: ['Int16', 2, -32768, 32767],
  f32: ['Float32', 4],
  f64: ['Float64', 8],
};

const fail = (message) => {
  throw new Error(`Binary codec: ${message}`);
};

const validateNumber = (type, value) => {
  const [, , min, max] = NUMBERS[type];

  if (!Number.isFinite(value)) {
    fail(`Invalid ${type} value`);
  }

  if (min !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
    fail(`${type} out of range`);
  }

  if (type === 'f32' && !Number.isFinite(Math.fround(value))) {
    fail('Float32 overflow');
  }

  return value;
};

class Writer {
  constructor() {
    this.reading = false;
    this.buffer = new Uint8Array(256);
    this.view = new DataView(this.buffer.buffer);
    this.offset = 0;
  }

  take(size) {
    const required = this.offset + size;

    if (required > MAX_PACKET_SIZE) {
      fail('Packet too large');
    }

    if (required > this.buffer.length) {
      const capacity = Math.min(
        MAX_PACKET_SIZE,
        Math.max(required, this.buffer.length * 2),
      );

      const next = new Uint8Array(capacity);
      next.set(this.buffer);

      this.buffer = next;
      this.view = new DataView(next.buffer);
    }

    const offset = this.offset;
    this.offset += size;

    return offset;
  }

  number(type, value) {
    validateNumber(type, value);

    const [suffix, size] = NUMBERS[type];
    const offset = this.take(size);

    this.view[`set${suffix}`](offset, value, true);

    return value;
  }

  text(value) {
    if (typeof value !== 'string') {
      fail('Expected string');
    }

    const bytes = encoder.encode(value);

    this.number('u16', bytes.byteLength);

    const offset = this.take(bytes.byteLength);
    this.buffer.set(bytes, offset);

    return value;
  }

  finish() {
    return this.buffer.slice(0, this.offset);
  }
}

class Reader {
  constructor(data) {
    this.reading = true;

    if (data instanceof ArrayBuffer) {
      this.buffer = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      this.buffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      fail('Expected binary data');
    }

    if (this.buffer.byteLength > MAX_PACKET_SIZE) {
      fail('Packet too large');
    }

    this.view = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteLength,
    );

    this.offset = 0;
  }

  take(size) {
    if (this.offset + size > this.buffer.byteLength) {
      fail('Truncated packet');
    }

    const offset = this.offset;
    this.offset += size;

    return offset;
  }

  number(type) {
    const [suffix, size] = NUMBERS[type];
    const offset = this.take(size);

    const value = this.view[`get${suffix}`](offset, true);

    return validateNumber(type, value);
  }

  text() {
    const size = this.number('u16');
    const offset = this.take(size);

    return decoder.decode(this.buffer.subarray(offset, offset + size));
  }

  finish() {
    if (this.offset !== this.buffer.byteLength) {
      fail('Unexpected trailing bytes');
    }
  }
}

const bool = (io, value) => {
  if (!io.reading && typeof value !== 'boolean') {
    fail('Expected boolean');
  }

  const flag = io.number('u8', value ? 1 : 0);

  if (flag !== 0 && flag !== 1) {
    fail('Invalid boolean flag');
  }

  return flag === 1;
};

const transferId = (io, value) => {
  const tag = io.number(
    'u8',
    value === null ? 0 : typeof value === 'number' ? 1 : 2,
  );

  if (tag === 0) return null;
  if (tag === 1) return io.number('u32', value);
  if (tag === 2) return io.text(value);

  fail('Invalid ID type');
};

const normalizeAngle = (angle) => {
  const tau = Math.PI * 2;

  return (((angle + Math.PI) % tau + tau) % tau) - Math.PI;
};

const transferAngle = (io, value) => {
  if (io.reading) {
    const encoded = io.number('i16');

    if (Math.abs(encoded) > 3142) {
      fail('Invalid angle');
    }

    return encoded / 1000;
  }

  if (!Number.isFinite(value)) {
    fail('Invalid angle');
  }

  return io.number('i16', Math.round(normalizeAngle(value) * 1000));
};

// Компактна схема вкладених полів.
// ['nullable', type] — null або значення.
// ['optional', type] — відсутнє поле або значення.
// ['array', type] — масив із префіксом довжини.

const transfer = (io, schema, value) => {
  if (typeof schema === 'string') {
    if (Object.hasOwn(NUMBERS, schema)) {
      return io.number(schema, value);
    }

    if (schema === 'bool') return bool(io, value);
    if (schema === 'text') return io.text(value);
    if (schema === 'id') return transferId(io, value);
    if (schema === 'angle') return transferAngle(io, value);

    if (schema === 'entity') {
      return transferEntity(io, value);
    }

    fail(`Unknown schema: ${schema}`);
  }

  if (Array.isArray(schema)) {
    const [mode, inner] = schema;

    if (mode === 'nullable') {
      const present = bool(io, value !== null);

      return present ? transfer(io, inner, value) : null;
    }

    if (mode === 'optional') {
      const present = bool(io, value !== undefined);

      return present ? transfer(io, inner, value) : undefined;
    }

    if (mode === 'array') {
      if (!io.reading && !Array.isArray(value)) {
        fail('Expected array');
      }

      const count = io.number('u16', value?.length);

      if (count > MAX_ARRAY_LENGTH) {
        fail('Array too large');
      }

      const result = [];

      for (let i = 0; i < count; i++) {
        result.push(transfer(io, inner, value?.[i]));
      }

      return result;
    }

    fail(`Unknown schema mode: ${mode}`);
  }

  if (!io.reading) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('Expected object');
    }

    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema, key)) {
        fail(`Unexpected field: ${key}`);
      }
    }
  }

  const result = {};

  for (const [key, field] of Object.entries(schema)) {
    const next = transfer(io, field, value?.[key]);

    if (next !== undefined) {
      result[key] = next;
    }
  }

  return result;
};

const VECTOR = {
  x: 'f32',
  y: 'f32',
};

const HOMING = {
  targetKind: 'text',
  turnRate: 'f32',
  speed: ['nullable', 'f32'],
};

const PARTICLE = {
  pos: VECTOR,
  vel: VECTOR,
  lifetime: 'f32',
  remaining: 'f32',
  radius: 'f32',
};

const ENTITY_KINDS = ['sword', 'bullet', 'obstacle', 'pickup', 'explosion'];

const BASE_ENTITY = {
  id: 'id',
  pos: VECTOR,
  vel: VECTOR,
  angle: 'angle',
  radius: 'f32',
  alive: 'bool',
};

const ENTITY_FIELDS = {
  sword: {
    ownerId: 'id',
    hp: 'f32',
    damageCooldown: 'f32',
    thrust: 'bool',
  },

  bullet: {
    ttl: 'f32',
    ownerId: 'id',
    ownerPlayerId: 'id',
    originSeq: ['nullable', 'u32'],
    damage: 'f32',
    homing: ['nullable', HOMING],
  },

  obstacle: {
    hp: 'f32',
    homing: ['nullable', HOMING],
  },

  pickup: {
    effect: [
      'nullable',
      {
        kind: 'text',
        amount: 'f32',
      },
    ],
  },

  explosion: {
    color: 'text',
    particles: ['array', PARTICLE],
  },
};

const transferEntity = (io, entity) => {
  const kindIndex = io.number('u8', ENTITY_KINDS.indexOf(entity?.kind));

  const kind = ENTITY_KINDS[kindIndex];

  if (!kind) {
    fail('Unknown entity kind');
  }

  const schema = {
    ...BASE_ENTITY,
    ...ENTITY_FIELDS[kind],
  };

  if (io.reading) {
    return {
      kind,
      ...transfer(io, schema),
    };
  }

  const { kind: entityKind, ...fields } = entity;

  if (entityKind !== kind) {
    fail('Invalid entity kind');
  }

  transfer(io, schema, fields);

  return entity;
};

const EVENT_DETAIL = {
  kind: ['optional', 'text'],
  entityId: ['optional', 'id'],
  ownerId: ['optional', 'id'],
  ownerPlayerId: ['optional', 'id'],
  originSeq: ['optional', ['nullable', 'u32']],
  hp: ['optional', 'f32'],
  score: ['optional', 'f64'],
  pos: ['optional', VECTOR],
};

const SNAPSHOT_SCHEMA = {
  tick: 'u32',
  lastProcessedSeq: 'u32',
  entities: ['array', 'entity'],
  score: ['optional', 'f64'],
  bounds: [
    'optional',
    {
      width: 'f32',
      height: 'f32',
    },
  ],
  events: [
    'optional',
    [
      'array',
      {
        type: 'text',
        detail: EVENT_DETAIL,
      },
    ],
  ],
  respawnSeconds: ['optional', ['nullable', 'f32']],
};

const writeHeader = (writer, type) => {
  writer.number('u8', type);
  writer.number('u8', PROTOCOL_VERSION);
};

const readHeader = (reader, expectedType) => {
  const type = reader.number('u8');
  const version = reader.number('u8');

  if (type !== expectedType) {
    fail('Unexpected message type');
  }

  if (version !== PROTOCOL_VERSION) {
    fail('Unsupported protocol version');
  }
};

// INPUT:
// Header: type u8, version u8.
// seq: u32.
// tick: u32.
// turn: f64.
// flags: u8.
// fireSeq: optional u32.
//
// flags:
// bit 0 — thrust.
// bit 1 — brake.
// bit 2 — fire.
// bit 3 — homingFire.
// bit 4 — fireSeq present.

export const encodeInput = (message) => {
  assertValidMessage(message);

  if (message.type !== 'input') {
    fail('Expected input message');
  }

  const writer = new Writer();

  writeHeader(writer, INPUT);

  writer.number('u32', message.seq);
  writer.number('u32', message.tick);
  writer.number('f64', message.turn);

  let flags = 0;

  if (message.thrust) flags |= 1;
  if (message.brake) flags |= 2;
  if (message.fire) flags |= 4;
  if (message.homingFire) flags |= 8;
  if (message.fireSeq !== undefined) flags |= 16;

  writer.number('u8', flags);

  if (flags & 16) {
    writer.number('u32', message.fireSeq);
  }

  return writer.finish();
};

export const decodeInput = (data) => {
  const reader = new Reader(data);

  readHeader(reader, INPUT);

  const seq = reader.number('u32');
  const tick = reader.number('u32');
  const turn = reader.number('f64');
  const flags = reader.number('u8');

  if (flags & ~31) {
    fail('Unknown input flags');
  }

  const message = {
    v: PROTOCOL_VERSION,
    type: 'input',
    seq,
    tick,
    turn,
    thrust: Boolean(flags & 1),
    brake: Boolean(flags & 2),
    fire: Boolean(flags & 4),
    homingFire: Boolean(flags & 8),
  };

  if (flags & 16) {
    message.fireSeq = reader.number('u32');
  }

  reader.finish();

  return assertValidMessage(message);
};

// SNAPSHOT:
// Header: type u8, version u8.
// Далі поля SNAPSHOT_SCHEMA у визначеному порядку.
// Масиви мають префікс довжини Uint16.
// Рядки: Uint16 length + UTF-8 bytes.
// Кожна сутність починається з Uint8 kind.

export const encodeSnapshot = (message) => {
  assertValidMessage(message);

  if (message.type !== 'snapshot') {
    fail('Expected snapshot message');
  }

  const writer = new Writer();

  writeHeader(writer, SNAPSHOT);

  const { v, type, ...fields } = message;

  if (v !== PROTOCOL_VERSION || type !== 'snapshot') {
    fail('Invalid snapshot header');
  }

  transfer(writer, SNAPSHOT_SCHEMA, fields);

  return writer.finish();
};

export const decodeSnapshot = (data) => {
  const reader = new Reader(data);

  readHeader(reader, SNAPSHOT);

  const fields = transfer(reader, SNAPSHOT_SCHEMA);

  reader.finish();

  return assertValidMessage({
    v: PROTOCOL_VERSION,
    type: 'snapshot',
    ...fields,
  });
};

