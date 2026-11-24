import { loadJson, loadAll, withRetry } from './loader.js';
import { drawLoadingScreen } from '../render/loading.js';

export const bootGame = async ({ ctx, size, start, audioContext = null }) => {
  const run = async () => {
    drawLoadingScreen(ctx, size, { done: 0, total: 1 });

    try {
      const manifest = await withRetry(() => loadJson('/assets/manifest.json'));
      const assets = await loadAll(manifest, {
        audioContext,
        onProgress: (done, total) => drawLoadingScreen(ctx, size, { done, total }),
      });
      start(assets);
    } catch (error) {
      console.error('Asset loading failed:', error);
      drawLoadingScreen(ctx, size, {
        done: 0,
        total: 1,
        error: error.message,
      });

      const retry = (event) => {
        if (event.code !== 'KeyR') return;
        window.removeEventListener('keydown', retry);
        void run();
      };
      window.addEventListener('keydown', retry);
    }
  };
  await run();
};
