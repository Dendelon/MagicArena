import { describe, expect, test } from 'vitest';

import {
  PROTOCOL_VERSION,
  ServerMessageSchema,
  ShutdownMessageSchema,
  parseServerMessage,
} from '../src/index.ts';

describe('Shutdown protocol message schema', () => {
  test('validates canonical server shutdown control message', () => {
    const validMessage = {
      v: PROTOCOL_VERSION,
      type: 'shutdown',
      reason: 'Server is shutting down',
    };

    const direct = ShutdownMessageSchema.safeParse(validMessage);
    expect(direct.success).toBe(true);

    const parsed = parseServerMessage(validMessage);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(validMessage);
    }

    expect(ServerMessageSchema.safeParse(validMessage).success).toBe(true);
  });

  test('rejects malformed shutdown messages with wrong version, missing reason, or extra fields', () => {
    expect(
      ShutdownMessageSchema.safeParse({
        v: PROTOCOL_VERSION + 1,
        type: 'shutdown',
        reason: 'Server is shutting down',
      }).success,
    ).toBe(false);

    expect(
      ShutdownMessageSchema.safeParse({
        v: PROTOCOL_VERSION,
        type: 'shutdown',
      }).success,
    ).toBe(false);

    expect(
      ShutdownMessageSchema.safeParse({
        v: PROTOCOL_VERSION,
        type: 'shutdown',
        reason: 'Server is shutting down',
        extra: true,
      }).success,
    ).toBe(false);
  });
});

