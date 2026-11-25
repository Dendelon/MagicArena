import type { RawData } from 'ws';

import {
  decodeInput,
  isInputMessage,
  parseClientMessage,
} from '@magicarena/shared';

import type { ClientMessage, CodecMode } from '@magicarena/shared';

export const MAX_MESSAGE_SIZE = 4096;

export class ProtocolError extends Error {
  readonly closeCode: number;

  constructor(message: string, closeCode = 1008) {
    super(message);
    this.name = 'ProtocolError';
    this.closeCode = closeCode;
  }
}

const getByteLength = (data: RawData): number => {
  if (Array.isArray(data)) {
    let total = 0;

    for (const chunk of data) {
      total += chunk.byteLength;
    }

    return total;
  }

  return data.byteLength;
};

const toBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);

  return Buffer.from(data);
};

export const parseMessage = (
  data: RawData,
  isBinary = false,
  codec: CodecMode = 'json',
): ClientMessage => {
  if (getByteLength(data) > MAX_MESSAGE_SIZE) {
    throw new ProtocolError('Message too large', 1009);
  }

  if (isBinary) {
    if (codec !== 'binary') {
      throw new ProtocolError('Binary messages are disabled', 1003);
    }

    let decoded: unknown;

    try {
      decoded = decodeInput(toBuffer(data));
    } catch {
      throw new ProtocolError('Invalid binary input', 1007);
    }

    if (!isInputMessage(decoded)) {
      throw new ProtocolError('Invalid input message');
    }

    return decoded;
  }

  let raw: unknown;

  try {
    raw = JSON.parse(toBuffer(data).toString('utf8'));
  } catch {
    throw new ProtocolError('Invalid JSON', 1007);
  }

  const parsed = parseClientMessage(raw);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProtocolError(issue?.message ?? 'Invalid message');
  }

  const message = parsed.data;

  if (message.type === 'input' && codec !== 'json') {
    throw new ProtocolError('Binary input required', 1003);
  }

  return message;
};

