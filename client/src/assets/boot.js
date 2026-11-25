import { loadJson, loadAll, withRetry } from './loader.js';
import { drawLoadingScreen } from '../render/loading.js';

export const bootGame = async ({ ctx, size, start, audioContext = null }) => {
  let removeRetryHandler = () => {};

  const run = async () => {
    removeRetryHandler();

    const controller = new AbortController();
    const params = new URLSearchParams(window.location.search);
    const isTimeoutTest = import.meta.env.DEV && params.get('lab03') === 'timeout';
    const timeoutMs = isTimeoutTest ? 1 : 15000;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);

    const onKeyDown = (event) => {
      if (event.code === 'KeyA') controller.abort();
    };
    window.addEventListener('keydown', onKeyDown);

    drawLoadingScreen(ctx, size, { done: 0, total: 1 });
    console.info('[Lab03] Loading started. Press A to abort.');

    try {
      // Deterministic demo of AbortSignal.timeout for ?lab03=timeout.
      if (isTimeoutTest) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (signal.aborted) throw signal.reason;
      }
      const manifest = await withRetry(
        () => loadJson('/assets/manifest.json', { signal }),
        { signal },
      );

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
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (signal.aborted) throw signal.reason;
      start(assets);
    } catch (error) {
      console.error('[Lab03] Loading failed:', error);
      drawLoadingScreen(ctx, size, {
        done: 0,
        total: 1,
        error: `${error.name}: ${error.message}`,
      });

      const onRetry = (event) => {
        if (event.code !== 'KeyR') return;
        window.removeEventListener('keydown', onRetry);
        void run();
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
