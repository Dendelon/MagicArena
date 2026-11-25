import { assertValidMessage } from '../protocol/messages.ts';

const rawToString = (raw) => {
  if (typeof raw === 'string') {
    return raw;
  }

  if (
    typeof globalThis.TextDecoder === 'function' &&
    (ArrayBuffer.isView(raw) || raw instanceof ArrayBuffer)
  ) {
    return new globalThis.TextDecoder().decode(raw);
  }

  throw new TypeError('Expected JSON string or binary buffer');
};

export const encodeMessage = (message) =>
  JSON.stringify(assertValidMessage(message));

export const decodeMessage = (raw) => {
  const text = rawToString(raw);
  let parsed;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON message');
  }

  return assertValidMessage(parsed);
};

