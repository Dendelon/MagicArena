import { assertNever } from '../assertNever.ts';
import { jsonCodec } from './json.ts';
import { binaryCodec } from './binary.ts';

import type {
  CodecMode,
  GameMessage,
} from '../protocol/schemas.ts';

import type { Codec } from './types.ts';

export const getCodec = (
  mode: CodecMode,
): Codec<GameMessage> => {
  switch (mode) {
    case 'json':
      return jsonCodec;

    case 'binary':
      return binaryCodec;

    default:
      return assertNever(mode, 'Unknown codec');
  }
};

