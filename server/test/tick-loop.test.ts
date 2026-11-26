import { afterEach, describe, expect, test, vi } from 'vitest';

import { FIXED_DT, TARGET_TICK_RATE, createTickLoop } from '../src/game/tickLoop.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const useTickLoopFakeTimers = (): void => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'performance'],
  });
};

describe('Server tick loop', () => {
  test('Uses fixed timestep 1/30', () => {
    useTickLoopFakeTimers();

    expect(TARGET_TICK_RATE).toBe(30);
    expect(FIXED_DT).toBe(1 / 30);

    const onTick = vi.fn();
    const loop = createTickLoop({ onTick });

    loop.start();

    try {
      vi.advanceTimersByTime(120);

      expect(onTick).toHaveBeenCalled();

      for (const [dt] of onTick.mock.calls) {
        expect(dt).toBe(1 / 30);
      }
    } finally {
      loop.stop();
    }
  });

  test('Repeated start does not create a parallel timer', () => {
    useTickLoopFakeTimers();

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const loop = createTickLoop({ onTick: vi.fn() });

    loop.start();
    loop.start();

    try {
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      loop.stop();
    }
  });

  test('stop cancels scheduled executions', () => {
    useTickLoopFakeTimers();

    const onTick = vi.fn();
    const loop = createTickLoop({ onTick });

    loop.start();
    vi.advanceTimersByTime(100);
    loop.stop();

    const ticksAtStop = onTick.mock.calls.length;
    vi.advanceTimersByTime(500);

    expect(onTick).toHaveBeenCalledTimes(ticksAtStop);
  });

  test('Catch-up steps do not exceed maxCatchUpSteps', () => {
    useTickLoopFakeTimers();

    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);

    const onTick = vi.fn();
    const loop = createTickLoop({
      hz: 30,
      maxCatchUpSteps: 3,
      onTick,
    });

    loop.start();

    try {
      // Advance directly to a huge lag (500ms after scheduled tick) before flushing single timer.
      nowMs = 1600;
      vi.advanceTimersToNextTimer();

      expect(onTick).toHaveBeenCalledTimes(3);
    } finally {
      loop.stop();
    }
  });

  test('Updates tick count and step duration stats', () => {
    useTickLoopFakeTimers();

    const onAfterTick = vi.fn();
    const loop = createTickLoop({
      onTick: () => {},
      onAfterTick,
    });

    loop.start();

    try {
      vi.advanceTimersByTime(110);

      const stats = loop.getStats();
      expect(stats.tick).toBeGreaterThanOrEqual(3);
      expect(stats.targetHz).toBe(30);
      expect(Number.isFinite(stats.lastStepMs)).toBe(true);
      expect(Number.isFinite(stats.avgStepMs)).toBe(true);
      expect(onAfterTick).toHaveBeenCalledTimes(stats.tick);
    } finally {
      loop.stop();
    }
  });
});

