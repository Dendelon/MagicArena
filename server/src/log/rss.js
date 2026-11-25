import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const startRssProfiler = async (logDir) => {
  const filePath = join(logDir, `rss-${Date.now()}.csv`);

  await writeFile(filePath, 'seconds,rss_mb\n');

  const started = performance.now();
  let pending = Promise.resolve();
  let stopped = false;

  const capture = () => {
    const seconds = ((performance.now() - started) / 1000).toFixed(1);

    const rssMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(2);

    pending = pending
      .then(() => appendFile(filePath, `${seconds},${rssMb}\n`))
      .catch((error) => {
        console.error('RSS sampling error:', error);
      });
  };

  capture();

  const timer = setInterval(capture, 1000);
  timer.unref();

  const stop = async () => {
    if (stopped) return;

    stopped = true;
    clearInterval(timer);

    capture();
    await pending;
  };

  return { filePath, stop };
};
