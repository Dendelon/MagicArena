import { loadJson, loadAll, withRetry } from './loader.ts';
import { AssetManifestSchema } from './schemas.ts';
import { drawLoadingScreen } from '../render/loading.ts';

import type { CanvasSize, LoadedAssets } from '../types.ts';

interface BootOptions {
  ctx: CanvasRenderingContext2D;
  size: CanvasSize;

  start: (assets: LoadedAssets) => void;

  audioContext?: AudioContext | null;
}

const toAbortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');

export const bootGame = async ({
  ctx,
  size,
  start,
  audioContext = null,
}: BootOptions): Promise<void> => {
  let removeRetryHandler = (): void => {};

  const run = async (): Promise<void> => {
    removeRetryHandler();

    const controller = new AbortController();
    const params = new URLSearchParams(window.location.search);
    const isTimeoutTest = import.meta.env.DEV && params.get('lab03') === 'timeout';
    const timeoutMs = isTimeoutTest ? 1 : 15000;
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(timeoutMs),
    ]);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code === 'KeyA') controller.abort();
    };
    window.addEventListener('keydown', onKeyDown);

    drawLoadingScreen(ctx, size, { done: 0, total: 1 });
    console.info('[Lab03] Loading started. Press A to abort.');

    try {
      // Deterministic demo of AbortSignal.timeout for ?lab03=timeout.
      if (isTimeoutTest) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        if (signal.aborted) throw toAbortError(signal);
      }

      const rawManifest = await withRetry(
        () => loadJson('/assets/manifest.json', { signal }),
        { signal },
      );

      const manifest = AssetManifestSchema.parse(rawManifest);

      const assets = await loadAll(manifest, {
        audioContext,
        signal,
        onProgress: (done, total) => {
          drawLoadingScreen(ctx, size, { done, total });
        },
      });

      console.info('[Lab03] All assets loaded successfully.');

      // Keep the loading screen visible briefly for the lab demonstration.
      if (import.meta.env.DEV) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      }
      if (signal.aborted) throw toAbortError(signal);
      start(assets);
    } catch (error: unknown) {
      console.error('[Lab03] Loading failed:', error);
      drawLoadingScreen(ctx, size, {
        done: 0,
        total: 1,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error),
      });

      const onRetry = (event: KeyboardEvent): void => {
        if (event.code !== 'KeyR') return;
        window.removeEventListener('keydown', onRetry);
        run().catch((retryError: unknown) => {
          console.error('[Lab03] Retry failed:', retryError);
        });
      };

      window.addEventListener('keydown', onRetry);
      removeRetryHandler = () => {
        window.removeEventListener('keydown', onRetry);
      };
    } finally {
      window.removeEventListener('keydown', onKeyDown);
    }
  };

  await run();
};

