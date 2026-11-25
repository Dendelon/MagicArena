export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = Object.freeze({
  INPUT: 'input',
  SNAPSHOT: 'snapshot',
});

const isNonNegativeInt = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value);

export const createInputMessage = ({
  seq = 0,
  tick = 0,
  thrust = false,
  turn = 0,
  brake = false,
  fire = false,
  homingFire = false,
} = {}) => ({
  v: PROTOCOL_VERSION,
  type: MESSAGE_TYPES.INPUT,
  seq,
  tick,
  thrust: Boolean(thrust),
  turn: Math.max(-1, Math.min(1, Number(turn) || 0)),
  brake: Boolean(brake),
  fire: Boolean(fire),
  homingFire: Boolean(homingFire),
});

export const createSnapshotMessage = ({
  tick = 0,
  lastProcessedSeq = 0,
  entities = [],
} = {}) => ({
  v: PROTOCOL_VERSION,
  type: MESSAGE_TYPES.SNAPSHOT,
  tick,
  lastProcessedSeq,
  entities: entities.map((entity) =>
    typeof entity?.toJSON === 'function' ? entity.toJSON() : entity,
  ),
});

export const isInputMessage = (message) =>
  Boolean(
    message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      message.v === PROTOCOL_VERSION &&
      message.type === MESSAGE_TYPES.INPUT &&
      isNonNegativeInt(message.seq) &&
      isNonNegativeInt(message.tick) &&
      typeof message.thrust === 'boolean' &&
      isFiniteNumber(message.turn) &&
      message.turn >= -1 &&
      message.turn <= 1 &&
      typeof message.brake === 'boolean' &&
      typeof message.fire === 'boolean' &&
      typeof message.homingFire === 'boolean',
  );

export const isSnapshotMessage = (message) =>
  Boolean(
    message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      message.v === PROTOCOL_VERSION &&
      message.type === MESSAGE_TYPES.SNAPSHOT &&
      isNonNegativeInt(message.tick) &&
      isNonNegativeInt(message.lastProcessedSeq) &&
      Array.isArray(message.entities) &&
      message.entities.every(
        (entity) =>
          entity &&
          typeof entity === 'object' &&
          !Array.isArray(entity) &&
          entity.id !== undefined &&
          entity.id !== null &&
          typeof entity.kind === 'string',
      ),
  );

export const isValidMessage = (message) =>
  isInputMessage(message) || isSnapshotMessage(message);

export const assertValidMessage = (message) => {
  if (!isValidMessage(message)) {
    throw new Error('Invalid protocol message');
  }

  return message;
};

