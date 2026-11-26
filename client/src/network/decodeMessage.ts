import { getCodec, parseServerMessage } from '@magicarena/shared';
import type { ServerMessage } from '@magicarena/shared';

export type WirePayload = string | ArrayBuffer;

export type DecodeResult =
  | {
      readonly ok: true;
      readonly message: ServerMessage;
      readonly isBinary: boolean;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly isBinary: boolean;
    };

export const decodeServerMessage = (rawData: WirePayload): DecodeResult => {
  const isBinary = typeof rawData !== 'string';

  try {
    const decoded: unknown = isBinary
      ? getCodec('binary').decode(rawData)
      : JSON.parse(rawData);

    const parsed = parseServerMessage(decoded);

    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];

      return {
        ok: false,
        error: firstIssue?.message ?? 'Invalid server message',
        isBinary,
      };
    }

    return {
      ok: true,
      message: parsed.data,
      isBinary,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      isBinary,
    };
  }
};

