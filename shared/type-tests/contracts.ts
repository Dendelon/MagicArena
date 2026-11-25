import {
  Vector2,
  toEntityId,
  toSeq,
  toTick,
} from '../src/index.ts';

import type {
  EntityId,
  Seq,
  Tick,
  EntitySnapshot,
  InputMessage,
} from '../src/index.ts';

const acceptEntityId = (_value: EntityId): void => {};

const acceptSeq = (_value: Seq): void => {};

const acceptTick = (_value: Tick): void => {};

export const checkBrandedTypes = (): void => {
  const id = toEntityId(1);
  const seq = toSeq(1);
  const tick = toTick(1);

  acceptEntityId(id);
  acceptSeq(seq);
  acceptTick(tick);

  // @ts-expect-error: A sequence is not an entity identifier.
  acceptEntityId(seq);

  // @ts-expect-error: A tick is not an input sequence.
  acceptSeq(tick);

  // @ts-expect-error: An entity identifier is not a tick.
  acceptTick(id);

  // @ts-expect-error: An ordinary number is not a branded sequence.
  acceptSeq(1);
};

export const checkReadonlyVector = (): void => {
  const vector = new Vector2(10, 20);

  // @ts-expect-error: Vector coordinates are immutable.
  vector.x = 30;

  // @ts-expect-error: Vector coordinates are immutable.
  vector.y = 40;
};

export const checkReadonlySnapshot = (snapshot: EntitySnapshot): void => {
  // @ts-expect-error: Snapshot coordinates are readonly.
  snapshot.pos.x = 100;

  // @ts-expect-error: Snapshot state is readonly.
  snapshot.alive = false;
};

export const checkUnknown = (message: unknown): void => {
  // @ts-expect-error: Unvalidated data must be narrowed first.
  void message.type;
};

export const checkInput = (input: InputMessage): Seq => input.seq;

type TestMessage =
  | {
      type: 'join';
      name: string;
    }
  | {
      type: 'input';
      thrust: boolean;
    }
  | {
      type: 'chat';
      text: string;
    };

export const checkExhaustiveness = (message: TestMessage): string => {
  switch (message.type) {
    case 'join':
      return message.name;

    case 'input':
      return String(message.thrust);

    case 'chat':
      return message.text;

    default: {
      const exhaustive: never = message;

      return exhaustive;
    }
  }
};

type ExtendedMessage =
  | TestMessage
  | {
      type: 'ping';
      id: number;
    };

export const checkMissingCase = (message: ExtendedMessage): string => {
  switch (message.type) {
    case 'join':
      return message.name;

    case 'input':
      return String(message.thrust);

    case 'chat':
      return message.text;

    default: {
      // @ts-expect-error: Missing ping handler must cause a compiler error.
      const exhaustive: never = message;

      return exhaustive;
    }
  }
};

