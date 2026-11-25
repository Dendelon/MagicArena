import type { LoadedAssets } from '../types.ts';
import type { AssetManifest, AssetEntry } from './schemas.ts';

interface LoadOptions {
  signal?: AbortSignal;
}

interface RetryOptions extends LoadOptions {
  attempts?: number;
  baseMs?: number;
}

interface LoadAllOptions extends LoadOptions {
  audioContext?: AudioContext | null;

  onProgress?: (done: number, total: number) => void;
}

class AssetHttpError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`HTTP ${status}: ${url}`);

    this.name = 'AssetHttpError';
    this.status = status;
  }
}

const abortReason = (signal?: AbortSignal): unknown =>
  signal?.reason ?? new DOMException('Aborted', 'AbortError');

const assertNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortReason(signal);
};

export const fetchJson = async (
  url: string,
  { signal }: LoadOptions = {},
): Promise<unknown> => {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new AssetHttpError(response.status, url);
  }
  const data: unknown = await response.json();
  return data;
};

export const loadJson = (
  url: string,
  { signal }: LoadOptions = {},
): Promise<unknown> => fetchJson(url, { signal });

export const loadImage = async (
  url: string,
  { signal }: LoadOptions = {},
): Promise<ImageBitmap> => {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new AssetHttpError(response.status, url);
  }
  const blob = await response.blob();
  assertNotAborted(signal);
  const bitmap = await createImageBitmap(blob);
  if (signal?.aborted) {
    bitmap.close();
    throw abortReason(signal);
  }
  return bitmap;
};

export const loadAudio = async (
  audioContext: AudioContext | null,
  url: string,
  { signal }: LoadOptions = {},
): Promise<AudioBuffer> => {
  if (!audioContext) throw new Error('AudioContext is required for loadAudio');
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new AssetHttpError(response.status, url);
  }
  const data = await response.arrayBuffer();
  assertNotAborted(signal);
  const buffer = await audioContext.decodeAudioData(data);
  assertNotAborted(signal);
  return buffer;
};

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const withRetry = async <T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 250, signal }: RetryOptions = {},
): Promise<T> => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    assertNotAborted(signal);
    try {
      return await fn();
    } catch (error: unknown) {
      const clientError =
        error instanceof AssetHttpError &&
        error.status >= 400 &&
        error.status < 500;

      const interrupted =
        signal?.aborted ||
        (error instanceof Error &&
          (error.name === 'AbortError' || error.name === 'TimeoutError'));

      const invalidData = error instanceof SyntaxError;

      if (clientError || interrupted || invalidData || attempt === attempts - 1)
        throw error;

      const delay = baseMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
      await wait(delay, signal);
    }
  }
  throw new Error('No attempts configured');
};

type AssetTask = AssetEntry & {
  kind: 'sprites' | 'audio' | 'json';
};

export const loadAll = async (
  manifest: AssetManifest,
  { audioContext = null, onProgress = () => {}, signal }: LoadAllOptions = {},
): Promise<LoadedAssets> => {
  const result: LoadedAssets = {
    sprites: {},
    audio: {},
    json: {},
  };

  const entries: AssetTask[] = [
    ...(manifest.sprites ?? []).map(
      (asset): AssetTask => ({
        kind: 'sprites',
        ...asset,
      }),
    ),

    ...(manifest.audio ?? []).map(
      (asset): AssetTask => ({
        kind: 'audio',
        ...asset,
      }),
    ),

    ...(manifest.arena
      ? [
          {
            kind: 'json' as const,
            ...manifest.arena,
          },
        ]
      : []),
  ];

  let completed = 0;
  onProgress(completed, entries.length);

  const tasks = entries.map(async ({ kind, id, url }) => {
    switch (kind) {
      case 'sprites':
        result.sprites[id] = await withRetry(() => loadImage(url, { signal }), {
          signal,
        });
        break;

      case 'audio':
        result.audio[id] = await withRetry(
          () => loadAudio(audioContext, url, { signal }),
          { signal },
        );
        break;

      case 'json':
        result.json[id] = await withRetry(() => loadJson(url, { signal }), {
          signal,
        });
        break;

      default: {
        const exhaustive: never = kind;

        throw new Error(`Unknown asset kind: ${exhaustive}`);
      }
    }

    completed++;
    onProgress(completed, entries.length);
  });

  await Promise.all(tasks);
  return result;
};

