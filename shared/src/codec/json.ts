import {
  assertValidMessage,
} from '../protocol/messages.ts';

import type {
  GameMessage,
} from '../protocol/schemas.ts';

import type { Codec } from './types.ts';

const rawToString = (raw: unknown): string => {
  if (typeof raw === 'string') {
    return raw;
  }

  if (
    ArrayBuffer.isView(raw) ||
    raw instanceof ArrayBuffer
  ) {
    return new TextDecoder().decode(raw);
  }

  throw new TypeError(
    'Expected JSON string or binary buffer',
  );
};

export const encodeMessage = (
  message: GameMessage,
): string =>
  JSON.stringify(assertValidMessage(message));

export const decodeMessage = (
  raw: unknown,
): GameMessage => {
  const text = rawToString(raw);

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON message');
  }

  return assertValidMessage(parsed);
};

export const jsonCodec: Codec<
  GameMessage,
  string
> = {
  name: 'json',
  encode: encodeMessage,
  decode: decodeMessage,
};

