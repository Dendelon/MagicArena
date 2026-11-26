import { afterEach, describe, expect, test, vi } from 'vitest';

import { createLoop } from '../src/loop.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const useLoopFakeTimers = (): void => {
  vi.useFakeTimers({
    toFake: ['performance', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
};

const spyRafCallbacks = () => {
  const callbacks: FrameRequestCallback[] = [];

  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
    (callback: FrameRequestCallback): number => {
      callbacks.push(callback);
      return callbacks.length;
    },
  );

  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

  return {
    flushNext: (now: number): void => {
      const next = callbacks.shift();
      if (!next) throw new Error('Expected scheduled animation frame');
      next(now);
    },
    get scheduledCount(): number {
      return callbacks.length;
    },
  };
};

describe('Client game loop', () => {
  test('Starts rendering frames', () => {
    useLoopFakeTimers();

    const simulate = vi.fn();
    const render = vi.fn();

    const loop = createLoop({
      simulate,
      render,
      step: 1 / 60,
    });

    loop.start();

    try {
      vi.advanceTimersByTime(100);

      expect(render).toHaveBeenCalled();
      expect(simulate).toHaveBeenCalled();
    } finally {
      loop.stop();
    }
  });

  test('Executes simulation with fixed dt = 1/60', () => {
    useLoopFakeTimers();

    const simulate = vi.fn();
    const render = vi.fn();
    const step = 1 / 60;

    const loop = createLoop({
      simulate,
      render,
      step,
    });

    loop.start();

    try {
      vi.advanceTimersByTime(100);

      expect(simulate.mock.calls.length).toBeGreaterThan(0);

      for (const [dt] of simulate.mock.calls) {
        expect(dt).toBe(step);
      }
    } finally {
      loop.stop();
    }
  });

  test('Accumulates frame deltas across frames to execute expected simulation steps', () => {
    const raf = spyRafCallbacks();
    const simulate = vi.fn();
    const render = vi.fn();

    const loop = createLoop({
      simulate,
      render,
      step: 1 / 60,
    });

    loop.start();

    try {
      raf.flushNext(1000);
      expect(simulate).toHaveBeenCalledTimes(0);

      raf.flushNext(1010);
      expect(simulate).toHaveBeenCalledTimes(0);

      raf.flushNext(1020);
      expect(simulate).toHaveBeenCalledTimes(1);

      raf.flushNext(1040);
      expect(simulate).toHaveBeenCalledTimes(2);
    } finally {
      loop.stop();
    }
  });

  test('Repeated start does not create a second parallel RAF loop', () => {
    useLoopFakeTimers();

    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');

    const loop = createLoop({
      simulate: vi.fn(),
      render: vi.fn(),
      step: 1 / 60,
    });

    loop.start();
    loop.start();

    try {
      expect(rafSpy).toHaveBeenCalledTimes(1);
    } finally {
      loop.stop();
    }
  });

  test('No new frames run after stop', () => {
    useLoopFakeTimers();

    const simulate = vi.fn();
    const render = vi.fn();

    const loop = createLoop({
      simulate,
      render,
      step: 1 / 60,
    });

    loop.start();
    vi.advanceTimersByTime(100);
    loop.stop();

    const simCallsAfterStop = simulate.mock.calls.length;
    const renderCallsAfterStop = render.mock.calls.length;

    vi.advanceTimersByTime(200);

    expect(simulate).toHaveBeenCalledTimes(simCallsAfterStop);
    expect(render).toHaveBeenCalledTimes(renderCallsAfterStop);
  });

  test('Passes interpolation alpha to render', () => {
    const raf = spyRafCallbacks();
    const simulate = vi.fn();
    const render = vi.fn();

    const loop = createLoop({
      simulate,
      render,
      step: 1 / 60,
    });

    loop.start();

    try {
      raf.flushNext(1000);
      raf.flushNext(1025);

      expect(simulate).toHaveBeenCalledTimes(1);

      const lastRenderCall = render.mock.calls.at(-1);
      expect(lastRenderCall).toBeDefined();
      expect(lastRenderCall?.[0]).toBeCloseTo(0.5);
    } finally {
      loop.stop();
    }
  });

  test('Clamps large frame hitch to prevent unbounded catch-up', () => {
    const raf = spyRafCallbacks();
    const simulate = vi.fn();
    const render = vi.fn();

    const loop = createLoop({
      simulate,
      render,
      step: 1 / 60,
    });

    loop.start();

    try {
      raf.flushNext(1000);
      raf.flushNext(3000);

      // Accumulator clamps dt to 0.25s => max 15 steps at 60 Hz instead of 120.
      expect(simulate).toHaveBeenCalledTimes(15);
    } finally {
      loop.stop();
    }
  });
});

