export const TARGET_TICK_RATE = 30;
export const FIXED_DT = 1 / TARGET_TICK_RATE;
export const TICK_INTERVAL_MS = 1000 / TARGET_TICK_RATE;

export interface TickLoopOptions {
  hz?: number;
  maxCatchUpSteps?: number;
  windowSize?: number;

  onTick: (dt: number) => void;

  onAfterTick?: ((tick: number) => void) | null;
}

export const createTickLoop = ({
  hz = TARGET_TICK_RATE,
  maxCatchUpSteps = 3,
  windowSize = 60,
  onTick,
  onAfterTick = null,
}: TickLoopOptions) => {
  const stepMs = 1000 / hz;
  const fixedDt = 1 / hz;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tick = 0;
  let nextTickAt = 0;

  const stepDurations: number[] = [];
  const jitters: number[] = [];
  let lastStepMs = 0;
  let lastJitterMs = 0;

  const pushSample = (list: number[], value: number): void => {
    list.push(value);

    if (list.length > windowSize) {
      list.shift();
    }
  };

  const average = (list: readonly number[]): number => {
    if (list.length === 0) return 0;

    let sum = 0;

    for (const value of list) {
      sum += value;
    }

    return sum / list.length;
  };

  const scheduleNext = (): void => {
    if (!running) return;

    const delay = Math.max(0, nextTickAt - performance.now());
    timer = setTimeout(runStep, delay);
  };

  const runStep = (): void => {
    timer = null;
    if (!running) return;

    const now = performance.now();

    if (now + 0.5 < nextTickAt) {
      scheduleNext();
      return;
    }

    lastJitterMs = now - nextTickAt;
    pushSample(jitters, Math.abs(lastJitterMs));

    let steps = 0;

    do {
      const stepStart = performance.now();
      onTick(fixedDt);
      lastStepMs = performance.now() - stepStart;
      pushSample(stepDurations, lastStepMs);

      tick += 1;
      steps += 1;
      nextTickAt += stepMs;

      onAfterTick?.(tick);
    } while (
      running &&
      performance.now() >= nextTickAt &&
      steps < maxCatchUpSteps
    );

    if (running && performance.now() - nextTickAt > stepMs * maxCatchUpSteps) {
      nextTickAt = performance.now() + stepMs;
    }

    scheduleNext();
  };

  const start = (): void => {
    if (running) return;

    running = true;
    nextTickAt = performance.now() + stepMs;
    scheduleNext();
  };

  const stop = (): void => {
    if (!running) return;

    running = false;

    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const getStats = () => ({
    tick,
    targetHz: hz,
    lastStepMs: Number(lastStepMs.toFixed(3)),
    avgStepMs: Number(average(stepDurations).toFixed(3)),
    lastJitterMs: Number(lastJitterMs.toFixed(3)),
    avgJitterMs: Number(average(jitters).toFixed(3)),
  });

  return { start, stop, getStats };
};

