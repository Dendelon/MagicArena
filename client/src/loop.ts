import type { FrameStats } from './types.ts';

export interface LoopFrameTiming {
  readonly frameStart: number;
  readonly frameEnd: number;
  readonly simStart: number;
  readonly simEnd: number;
  readonly renderStart: number;
  readonly renderEnd: number;
  readonly simulationMs: number;
  readonly renderMs: number;
  readonly frameWorkMs: number;
}

export interface LoopProfiler {
  isActive(): boolean;
  beginFrame(rafNow: number): void;
  endFrame(timing: LoopFrameTiming): void;
}

interface LoopOptions {
  simulate: (dt: number) => void;

  render: (alpha: number, stats: FrameStats) => void;

  step?: number;

  profiler?: LoopProfiler | null;
}

export const createLoop = ({
  simulate,
  render,
  step = 1 / 60,
  profiler = null,
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

    const profiling = profiler?.isActive() ?? false;
    const frameStart = profiling ? performance.now() : 0;

    if (profiling) {
      profiler?.beginFrame(now);
    }

    // Час між поточним і попереднім кадром
    const dt = lastTime === null ? 0 : (now - lastTime) / 1000;
    lastTime = now;

    // Накопичуємо час, але обмежуємо великі затримки
    accumulator += Math.min(dt, 0.25);

    // Фізика завжди викоється з фіксованим кроком
    let simulationMs = 0;
    const simStart = profiling ? performance.now() : 0;

    while (accumulator >= step) {
      if (profiling) {
        const stepStart = performance.now();
        simulate(step);
        simulationMs += performance.now() - stepStart;
      } else {
        simulate(step);
      }

      accumulator -= step;
      stepCount++;
    }

    const simEnd = profiling ? performance.now() : 0;

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
    const renderStart = profiling ? performance.now() : 0;
    render(accumulator / step, {
      fps,
      sps,
      frameTimeMs: dt * 1000,
    });
    const renderEnd = profiling ? performance.now() : 0;

    if (profiling && profiler?.isActive()) {
      const frameEnd = performance.now();
      profiler.endFrame({
        frameStart,
        frameEnd,
        simStart,
        simEnd,
        renderStart,
        renderEnd,
        simulationMs,
        renderMs: renderEnd - renderStart,
        frameWorkMs: frameEnd - frameStart,
      });
    }

    if (running) {
      frameId = requestAnimationFrame(frame);
    }
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

