import {
  PROTOCOL_VERSION,
} from '../protocol/messages.ts';

import {
  InputMessageSchema,
  SnapshotMessageSchema,
} from '../protocol/schemas.ts';

import type {
  InputMessage,
  SnapshotMessage,
  GameMessage,
} from '../protocol/schemas.ts';

import type {
  GameEntityKind,
} from '../types.ts';

import type { Codec } from './types.ts';

const INPUT = 1;
const SNAPSHOT = 2;

const MAX_PACKET_SIZE = 1024 * 1024;
const MAX_ARRAY_LENGTH = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

type NumberType =
  | 'u8'
  | 'u16'
  | 'u32'
  | 'i16'
  | 'f32'
  | 'f64';

interface NumberFormat {
  readonly size: number;
  readonly min?: number;
  readonly max?: number;
}

const NUMBERS: Readonly<
  Record<NumberType, NumberFormat>
> = {
  u8: {
    size: 1,
    min: 0,
    max: 255,
  },

  u16: {
    size: 2,
    min: 0,
    max: 65535,
  },

  u32: {
    size: 4,
    min: 0,
    max: 4294967295,
  },

  i16: {
    size: 2,
    min: -32768,
    max: 32767,
  },

  f32: { size: 4 },

  f64: { size: 8 },
};

const fail = (message: string): never => {
  throw new Error(`Binary codec: ${message}`);
};

const validateNumber = (
  type: NumberType,
  value: unknown,
): number => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value)
  ) {
    return fail(`Invalid ${type} value`);
  }

  const { min, max } = NUMBERS[type];

  if (
    min !== undefined &&
    max !== undefined &&
    (
      !Number.isInteger(value) ||
      value < min ||
      value > max
    )
  ) {
    return fail(`${type} out of range`);
  }

  if (
    type === 'f32' &&
    !Number.isFinite(Math.fround(value))
  ) {
    return fail('Float32 overflow');
  }

  return value;
};

const isNumberType = (
  value: string,
): value is NumberType =>
  Object.hasOwn(NUMBERS, value);

interface TransferIO {
  readonly reading: boolean;

  number(
    type: NumberType,
    value?: unknown,
  ): number;

  text(value?: unknown): string;
}

class Writer implements TransferIO {
  readonly reading = false;

  buffer: Uint8Array<ArrayBuffer>;
  view: DataView<ArrayBuffer>;
  offset: number;

  constructor() {
    this.buffer = new Uint8Array(256);
    this.view = new DataView(this.buffer.buffer);
    this.offset = 0;
  }

  take(size: number): number {
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

  number(
    type: NumberType,
    value?: unknown,
  ): number {
    const numeric = validateNumber(type, value);

    const offset = this.take(NUMBERS[type].size);

    switch (type) {
      case 'u8':
        this.view.setUint8(offset, numeric);
        break;

      case 'u16':
        this.view.setUint16(offset, numeric, true);
        break;

      case 'u32':
        this.view.setUint32(offset, numeric, true);
        break;

      case 'i16':
        this.view.setInt16(offset, numeric, true);
        break;

      case 'f32':
        this.view.setFloat32(offset, numeric, true);
        break;

      case 'f64':
        this.view.setFloat64(offset, numeric, true);
        break;

      default: {
        const exhaustive: never = type;

        return fail(
          `Unsupported number type: ${exhaustive}`,
        );
      }
    }

    return numeric;
  }

  text(value?: unknown): string {
    if (typeof value !== 'string') {
      return fail('Expected string');
    }

    const bytes = encoder.encode(value);

    this.number('u16', bytes.byteLength);

    const offset = this.take(bytes.byteLength);

    this.buffer.set(bytes, offset);

    return value;
  }

  finish(): Uint8Array<ArrayBuffer> {
    return this.buffer.slice(0, this.offset);
  }
}

class Reader implements TransferIO {
  readonly reading = true;

  buffer: Uint8Array<ArrayBufferLike>;
  view: DataView<ArrayBufferLike>;
  offset: number;

  constructor(data: unknown) {
    if (data instanceof ArrayBuffer) {
      this.buffer = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      this.buffer = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
    } else {
      fail('Expected binary data');
    }

    if (
      this.buffer.byteLength >
      MAX_PACKET_SIZE
    ) {
      fail('Packet too large');
    }

    this.view = new DataView(
      this.buffer.buffer,
      this.buffer.byteOffset,
      this.buffer.byteLength,
    );

    this.offset = 0;
  }

  take(size: number): number {
    if (
      this.offset + size >
      this.buffer.byteLength
    ) {
      fail('Truncated packet');
    }

    const offset = this.offset;

    this.offset += size;

    return offset;
  }

  number(type: NumberType): number {
    const offset = this.take(
      NUMBERS[type].size,
    );

    let value: number;

    switch (type) {
      case 'u8':
        value = this.view.getUint8(offset);
        break;

      case 'u16':
        value = this.view.getUint16(offset, true);
        break;

      case 'u32':
        value = this.view.getUint32(offset, true);
        break;

      case 'i16':
        value = this.view.getInt16(offset, true);
        break;

      case 'f32':
        value = this.view.getFloat32(offset, true);
        break;

      case 'f64':
        value = this.view.getFloat64(offset, true);
        break;

      default: {
        const exhaustive: never = type;

        return fail(
          `Unsupported number type: ${exhaustive}`,
        );
      }
    }

    return validateNumber(type, value);
  }

  text(): string {
    const size = this.number('u16');
    const offset = this.take(size);

    return decoder.decode(
      this.buffer.subarray(
        offset,
        offset + size,
      ),
    );
  }

  finish(): void {
    if (
      this.offset !==
      this.buffer.byteLength
    ) {
      fail('Unexpected trailing bytes');
    }
  }
}

const bool = (
  io: TransferIO,
  value?: unknown,
): boolean => {
  if (
    !io.reading &&
    typeof value !== 'boolean'
  ) {
    return fail('Expected boolean');
  }

  const flag = io.number(
    'u8',
    value ? 1 : 0,
  );

  if (flag !== 0 && flag !== 1) {
    return fail('Invalid boolean flag');
  }

  return flag === 1;
};

const transferId = (
  io: TransferIO,
  value?: unknown,
): number | string | null => {
  const tag = io.number(
    'u8',
    value === null
      ? 0
      : typeof value === 'number'
        ? 1
        : 2,
  );

  switch (tag) {
    case 0:
      return null;

    case 1:
      return io.number('u32', value);

    case 2:
      return io.text(value);

    default:
      return fail('Invalid ID type');
  }
};

const normalizeAngle = (
  angle: number,
): number => {
  const tau = Math.PI * 2;

  return (
    ((angle + Math.PI) % tau + tau) % tau -
    Math.PI
  );
};

const transferAngle = (
  io: TransferIO,
  value?: unknown,
): number => {
  if (io.reading) {
    const encoded = io.number('i16');

    if (Math.abs(encoded) > 3142) {
      return fail('Invalid angle');
    }

    return encoded / 1000;
  }

  if (
    typeof value !== 'number' ||
    !Number.isFinite(value)
  ) {
    return fail('Invalid angle');
  }

  return io.number(
    'i16',
    Math.round(
      normalizeAngle(value) * 1000,
    ),
  );
};

// Компактна схема вкладених полів.
// ['nullable', type] — null або значення.
// ['optional', type] — відсутнє поле або значення.
// ['array', type] — масив із префіксом довжини.

type PrimitiveSchema =
  | NumberType
  | 'bool'
  | 'text'
  | 'id'
  | 'angle'
  | 'entity';

type SchemaTuple = readonly [
  'nullable' | 'optional' | 'array',
  Schema,
];

interface SchemaRecord {
  readonly [key: string]: Schema;
}

type Schema =
  | PrimitiveSchema
  | SchemaTuple
  | SchemaRecord;

const isSchemaTuple = (
  schema: Schema,
): schema is SchemaTuple =>
  Array.isArray(schema);

const isRecord = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value);

const isUnknownArray = (
  value: unknown,
): value is readonly unknown[] =>
  Array.isArray(value);

const transfer = (
  io: TransferIO,
  schema: Schema,
  value?: unknown,
): unknown => {
  if (typeof schema === 'string') {
    if (isNumberType(schema)) {
      return io.number(schema, value);
    }

    switch (schema) {
      case 'bool':
        return bool(io, value);

      case 'text':
        return io.text(value);

      case 'id':
        return transferId(io, value);

      case 'angle':
        return transferAngle(io, value);

      case 'entity':
        return transferEntity(io, value);

      default: {
        const exhaustive: never = schema;

        return fail(
          `Unknown schema: ${exhaustive}`,
        );
      }
    }
  }

  if (isSchemaTuple(schema)) {
    const [mode, inner] = schema;

    switch (mode) {
      case 'nullable': {
        const present = bool(
          io,
          value !== null,
        );

        return present
          ? transfer(io, inner, value)
          : null;
      }

      case 'optional': {
        const present = bool(
          io,
          value !== undefined,
        );

        return present
          ? transfer(io, inner, value)
          : undefined;
      }

      case 'array': {
        const source = isUnknownArray(value)
          ? value
          : undefined;

        if (!io.reading && !source) {
          return fail('Expected array');
        }

        const count = io.number(
          'u16',
          source?.length,
        );

        if (count > MAX_ARRAY_LENGTH) {
          return fail('Array too large');
        }

        const result: unknown[] = [];

        for (let i = 0; i < count; i++) {
          result.push(
            transfer(
              io,
              inner,
              source?.[i],
            ),
          );
        }

        return result;
      }

      default: {
        const exhaustive: never = mode;

        return fail(
          `Unknown schema mode: ${exhaustive}`,
        );
      }
    }
  }

  const source = isRecord(value)
    ? value
    : undefined;

  if (!io.reading) {
    if (!source) {
      return fail('Expected object');
    }

    for (const key of Object.keys(source)) {
      if (!Object.hasOwn(schema, key)) {
        return fail(
          `Unexpected field: ${key}`,
        );
      }
    }
  }

  const result: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(
    schema,
  )) {
    const next = transfer(
      io,
      field,
      source?.[key],
    );

    if (next !== undefined) {
      result[key] = next;
    }
  }

  return result;
};

const VECTOR: SchemaRecord = {
  x: 'f32',
  y: 'f32',
};

const HOMING: SchemaRecord = {
  targetKind: 'text',
  turnRate: 'f32',
  speed: ['nullable', 'f32'],
};

const PARTICLE: SchemaRecord = {
  pos: VECTOR,
  vel: VECTOR,
  lifetime: 'f32',
  remaining: 'f32',
  radius: 'f32',
};

const ENTITY_KINDS: readonly GameEntityKind[] = [
  'sword',
  'bullet',
  'obstacle',
  'pickup',
  'explosion',
];

const BASE_ENTITY: SchemaRecord = {
  id: 'id',
  pos: VECTOR,
  vel: VECTOR,
  angle: 'angle',
  radius: 'f32',
  alive: 'bool',
};

const ENTITY_FIELDS: Readonly<
  Record<GameEntityKind, SchemaRecord>
> = {
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

const transferEntity = (
  io: TransferIO,
  entity?: unknown,
): unknown => {
  const source = isRecord(entity)
    ? entity
    : undefined;

  const kindIndex = io.number(
    'u8',
    ENTITY_KINDS.findIndex(
      (kind) => kind === source?.kind,
    ),
  );

  const kind = ENTITY_KINDS[kindIndex];

  if (!kind) {
    return fail('Unknown entity kind');
  }

  const schema: SchemaRecord = {
    ...BASE_ENTITY,
    ...ENTITY_FIELDS[kind],
  };

  if (io.reading) {
    const fields = transfer(io, schema);

    if (!isRecord(fields)) {
      return fail('Invalid entity fields');
    }

    return {
      kind,
      ...fields,
    };
  }

  if (!source || source.kind !== kind) {
    return fail('Invalid entity kind');
  }

  const fields = {
    ...source,
  };

  delete fields.kind;

  transfer(io, schema, fields);

  return entity;
};

const EVENT_DETAIL: SchemaRecord = {
  kind: ['optional', 'text'],
  entityId: ['optional', 'id'],
  ownerId: ['optional', 'id'],
  ownerPlayerId: ['optional', 'id'],
  originSeq: ['optional', ['nullable', 'u32']],
  hp: ['optional', 'f32'],
  score: ['optional', 'f64'],
  pos: ['optional', VECTOR],
};

const SNAPSHOT_SCHEMA: SchemaRecord = {
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

const writeHeader = (
  writer: Writer,
  type: number,
): void => {
  writer.number('u8', type);

  writer.number(
    'u8',
    PROTOCOL_VERSION,
  );
};

const readHeader = (
  reader: Reader,
  expectedType: number,
): void => {
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

export const encodeInput = (
  message: InputMessage,
): Uint8Array<ArrayBuffer> => {
  InputMessageSchema.parse(message);

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

  if (message.fireSeq !== undefined) {
    writer.number(
      'u32',
      message.fireSeq,
    );
  }

  return writer.finish();
};

export const decodeInput = (
  data: unknown,
): InputMessage => {
  const reader = new Reader(data);

  readHeader(reader, INPUT);

  const seq = reader.number('u32');
  const tick = reader.number('u32');
  const turn = reader.number('f64');
  const flags = reader.number('u8');

  if (flags & ~31) {
    return fail('Unknown input flags');
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

    ...(flags & 16
      ? {
          fireSeq: reader.number('u32'),
        }
      : {}),
  };

  reader.finish();

  return InputMessageSchema.parse(message);
};

// SNAPSHOT:
// Header: type u8, version u8.
// Далі поля SNAPSHOT_SCHEMA у визначеному порядку.
// Масиви мають префікс довжини Uint16.
// Рядки: Uint16 length + UTF-8 bytes.
// Кожна сутність починається з Uint8 kind.

export const encodeSnapshot = (
  message: SnapshotMessage,
): Uint8Array<ArrayBuffer> => {
  SnapshotMessageSchema.parse(message);

  const writer = new Writer();

  writeHeader(writer, SNAPSHOT);

  const { v, type, ...fields } = message;

  if (
    v !== PROTOCOL_VERSION ||
    type !== 'snapshot'
  ) {
    return fail('Invalid snapshot header');
  }

  transfer(
    writer,
    SNAPSHOT_SCHEMA,
    fields,
  );

  return writer.finish();
};

export const decodeSnapshot = (
  data: unknown,
): SnapshotMessage => {
  const reader = new Reader(data);

  readHeader(reader, SNAPSHOT);

  const fields = transfer(
    reader,
    SNAPSHOT_SCHEMA,
  );

  reader.finish();

  if (!isRecord(fields)) {
    return fail('Invalid snapshot fields');
  }

  return SnapshotMessageSchema.parse({
    v: PROTOCOL_VERSION,
    type: 'snapshot',
    ...fields,
  });
};

export const binaryCodec: Codec<
  GameMessage,
  ArrayBuffer
> = {
  name: 'binary',

  encode(message) {
    switch (message.type) {
      case 'input':
        return encodeInput(message).buffer;

      case 'snapshot':
        return encodeSnapshot(message).buffer;

      default: {
        const exhaustive: never = message;

        return fail(
          `Unsupported message: ${
            JSON.stringify(exhaustive)
          }`,
        );
      }
    }
  },

  decode(data) {
    const reader = new Reader(data);

    const type = reader.number('u8');

    switch (type) {
      case INPUT:
        return decodeInput(data);

      case SNAPSHOT:
        return decodeSnapshot(data);

      default:
        return fail(
          'Unknown binary message type',
        );
    }
  },
};

