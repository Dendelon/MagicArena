import { toSeq, toTick } from '../types.ts';

import type { EntitySnapshot } from '../types.ts';

import {
  PROTOCOL_VERSION,
  InputMessageSchema,
  SnapshotMessageSchema,
  ClientMessageSchema,
  ServerMessageSchema,
  GameMessageSchema,
} from './schemas.ts';

import type {
  InputMessage,
  SnapshotMessage,
  GameMessage,
} from './schemas.ts';

export { PROTOCOL_VERSION };

export const MESSAGE_TYPES: {
  readonly INPUT: 'input';
  readonly SNAPSHOT: 'snapshot';
} = Object.freeze({
  INPUT: 'input',
  SNAPSHOT: 'snapshot',
});

interface InputOptions {
  seq?: number;
  tick?: number;
  thrust?: boolean;
  turn?: number;
  brake?: boolean;
  fire?: boolean;
  homingFire?: boolean;
  fireSeq?: number | null;
}

export const createInputMessage = ({
  seq = 0,
  tick = 0,
  thrust = false,
  turn = 0,
  brake = false,
  fire = false,
  homingFire = false,
  fireSeq,
}: InputOptions = {}): InputMessage => {
  const message: InputMessage = {
    v: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.INPUT,

    seq: toSeq(seq),
    tick: toTick(tick),

    thrust: Boolean(thrust),

    turn: Math.max(-1, Math.min(1, Number(turn) || 0)),

    brake: Boolean(brake),
    fire: Boolean(fire),
    homingFire: Boolean(homingFire),
  };

  if (fireSeq !== undefined && fireSeq !== null) {
    message.fireSeq = toSeq(fireSeq);
  }

  return message;
};

interface SerializableEntity {
  toJSON(): EntitySnapshot;
}

interface SnapshotOptions {
  tick?: number;
  lastProcessedSeq?: number;

  entities?: readonly (EntitySnapshot | SerializableEntity)[];

  score?: number;

  bounds?: Readonly<NonNullable<SnapshotMessage['bounds']>>;

  events?: readonly NonNullable<SnapshotMessage['events']>[number][];

  respawnSeconds?: number | null;
}

const serializeEntity = (
  entity: EntitySnapshot | SerializableEntity,
): EntitySnapshot => {
  if ('toJSON' in entity) {
    return entity.toJSON();
  }

  return entity;
};

export const createSnapshotMessage = ({
  tick = 0,
  lastProcessedSeq = 0,
  entities = [],
  score,
  bounds,
  events,
  respawnSeconds,
}: SnapshotOptions = {}): SnapshotMessage => {
  const snapshot = {
    v: PROTOCOL_VERSION,
    type: MESSAGE_TYPES.SNAPSHOT,

    tick: toTick(tick),
    lastProcessedSeq: toSeq(lastProcessedSeq),

    entities: entities.map(serializeEntity),
  };

  return SnapshotMessageSchema.parse({
    ...snapshot,

    ...(score !== undefined ? { score } : {}),
    ...(bounds !== undefined ? { bounds } : {}),
    ...(events !== undefined ? { events } : {}),

    ...(respawnSeconds !== undefined ? { respawnSeconds } : {}),
  });
};

export const isInputMessage = (message: unknown): message is InputMessage =>
  InputMessageSchema.safeParse(message).success;

export const isSnapshotMessage = (
  message: unknown,
): message is SnapshotMessage =>
  SnapshotMessageSchema.safeParse(message).success;

export const isValidMessage = (message: unknown): message is GameMessage =>
  GameMessageSchema.safeParse(message).success;

export const assertValidMessage = (message: unknown): GameMessage =>
  GameMessageSchema.parse(message);

export const parseClientMessage = (message: unknown) =>
  ClientMessageSchema.safeParse(message);

export const parseServerMessage = (message: unknown) =>
  ServerMessageSchema.safeParse(message);

