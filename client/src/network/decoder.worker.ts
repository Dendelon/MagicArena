import { decodeServerMessage } from './decodeMessage.ts';
import { isDecodeRequest } from './workerProtocol.ts';
import type { WorkerInboundMessage } from './workerProtocol.ts';

interface WorkerScope {
  postMessage(message: WorkerInboundMessage): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}

const isWorkerScope = (value: unknown): value is WorkerScope =>
  typeof value === 'object' &&
  value !== null &&
  'postMessage' in value &&
  typeof value.postMessage === 'function' &&
  'addEventListener' in value &&
  typeof value.addEventListener === 'function';

export const processDecodeRequest = (rawPayload: unknown): WorkerInboundMessage | null => {
  if (!isDecodeRequest(rawPayload)) {
    return null;
  }

  const startedAt = performance.now();
  const result = decodeServerMessage(rawPayload.data);
  const durationMs = Math.max(0, performance.now() - startedAt);

  if (result.ok) {
    return {
      type: 'decoded',
      requestId: rawPayload.requestId,
      message: result.message,
      durationMs,
      isBinary: result.isBinary,
    };
  }

  return {
    type: 'decodeError',
    requestId: rawPayload.requestId,
    error: result.error,
    durationMs,
    isBinary: result.isBinary,
  };
};

// Auto-register only inside real Web Worker execution context (no DOM document).
const globalCandidate: unknown = globalThis;
if (typeof document === 'undefined' && isWorkerScope(globalCandidate)) {
  const scope = globalCandidate;

  scope.addEventListener('message', (event) => {
    const response = processDecodeRequest(event.data);
    if (response) {
      scope.postMessage(response);
    }
  });

  scope.postMessage({ type: 'ready' });
}

