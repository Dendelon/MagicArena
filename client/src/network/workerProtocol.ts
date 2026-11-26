import type { ServerMessage } from '@magicarena/shared';
import type { WirePayload } from './decodeMessage.ts';

export type DecodeMode = 'main' | 'worker';

export interface DecodeRequest {
  readonly type: 'decode';
  readonly requestId: number;
  readonly data: WirePayload;
}

export interface WorkerReadyMessage {
  readonly type: 'ready';
}

export interface DecodeSuccessResponse {
  readonly type: 'decoded';
  readonly requestId: number;
  readonly message: ServerMessage;
  readonly durationMs: number;
  readonly isBinary: boolean;
}

export interface DecodeErrorResponse {
  readonly type: 'decodeError';
  readonly requestId: number;
  readonly error: string;
  readonly durationMs: number;
  readonly isBinary: boolean;
}

export type WorkerOutboundMessage = DecodeRequest;

export type WorkerInboundMessage =
  | WorkerReadyMessage
  | DecodeSuccessResponse
  | DecodeErrorResponse;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isServerMessageEnvelope = (value: unknown): value is ServerMessage =>
  isRecord(value) && typeof value.type === 'string';

export const isDecodeRequest = (value: unknown): value is DecodeRequest => {
  if (!isRecord(value)) return false;

  return (
    value.type === 'decode' &&
    typeof value.requestId === 'number' &&
    (typeof value.data === 'string' || value.data instanceof ArrayBuffer)
  );
};

export const isWorkerInboundMessage = (
  value: unknown,
): value is WorkerInboundMessage => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  if (value.type === 'ready') {
    return true;
  }

  if (value.type === 'decoded') {
    return (
      typeof value.requestId === 'number' &&
      typeof value.durationMs === 'number' &&
      typeof value.isBinary === 'boolean' &&
      isServerMessageEnvelope(value.message)
    );
  }

  if (value.type === 'decodeError') {
    return (
      typeof value.requestId === 'number' &&
      typeof value.error === 'string' &&
      typeof value.durationMs === 'number' &&
      typeof value.isBinary === 'boolean'
    );
  }

  return false;
};

