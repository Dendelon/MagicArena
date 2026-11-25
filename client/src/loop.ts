import type { FrameStats } from './types.ts';

interface LoopOptions {
  simulate: (dt: number) => void;

  render: (alpha: number, stats: FrameStats) => void;

  step?: number;
}

export const createLoop = ({
  simulate,
  render,
  step = 1 / 60,
}: LoopOptions) => {
  let running = false;
  let frameId: number | null = null;

  let lastTime: number | null = null;
  let accumulator = 0;

  let statsStart: number | null = null;
  let frameCount = 0;
  let stepCount = 0;

  let fps = 0;
  let sps = 0;

  const frame = (now: number): void => {
    if (!running) return;

    // Час між поточним і попереднім кадром
    const dt = lastTime === null ? 0 : (now - lastTime) / 1000;
    lastTime = now;

    // Накопичуємо час, але обмежуємо великі затримки
    accumulator += Math.min(dt, 0.25);

    // Фізика завжди виконується з фіксованим кроком
    while (accumulator >= step) {
      simulate(step);
      accumulator -= step;
      stepCount++;
    }

    frameCount++;

    // Оновлення статистики приблизно раз на секунду
    if (statsStart === null) statsStart = now;

    const elapsed = (now - statsStart) / 1000;

    if (elapsed >= 1) {
      fps = Math.round(frameCount / elapsed);
      sps = Math.round(stepCount / elapsed);

      frameCount = 0;
      stepCount = 0;
      statsStart = now;
    }

    // Малювання з коефіцієнтом інтерполяції
    render(accumulator / step, {
      fps,
      sps,
      frameTimeMs: dt * 1000,
    });

    frameId = requestAnimationFrame(frame);
  };

  const start = (): void => {
    if (running) return;

    running = true;
    lastTime = null;
    accumulator = 0;
    statsStart = null;
    frameCount = 0;
    stepCount = 0;
    fps = 0;
    sps = 0;

    frameId = requestAnimationFrame(frame);
  };

  const stop = (): void => {
    running = false;

    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
  };

  return { start, stop };
};

