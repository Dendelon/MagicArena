import { afterEach, describe, expect, test, vi } from 'vitest';

import { createLoop } from '../src/loop.ts';
import {
  FRAME_BUDGET_MS,
  FrameProfiler,
  createMagicArenaProfileApi,
} from '../src/performance/FrameProfiler.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: false,
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
});

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
  };
};

describe('FrameProfiler', () => {
  test('does not record measurements while inactive', () => {
    const raf = spyRafCallbacks();
    const profiler = new FrameProfiler();
    const beginSpy = vi.spyOn(profiler, 'beginFrame');
    const endSpy = vi.spyOn(profiler, 'endFrame');

    const loop = createLoop({
      simulate: vi.fn(),
      render: vi.fn(),
      profiler,
    });

    loop.start();

    try {
      raf.flushNext(1000);
      raf.flushNext(1016);

      expect(profiler.isActive()).toBe(false);
      expect(profiler.getLastResult()).toBeNull();
      expect(beginSpy).not.toHaveBeenCalled();
      expect(endSpy).not.toHaveBeenCalled();
    } finally {
      loop.stop();
      profiler.dispose();
    }
  });

  test('measures frame intervals, summed simulation steps, render work, and missed budgets', async () => {
    vi.useFakeTimers();
    const raf = spyRafCallbacks();

    let perfClock = 1000;
    const perfNowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => perfClock);

    const markSpy = vi.spyOn(performance, 'mark');
    const measureSpy = vi.spyOn(performance, 'measure');
    const clearMeasuresSpy = vi.spyOn(performance, 'clearMeasures');
    const clearMarksSpy = vi.spyOn(performance, 'clearMarks');

    const profiler = new FrameProfiler({ now: () => perfClock });

    const loop = createLoop({
      simulate: () => {
        perfClock += 2;
      },
      render: () => {
        perfClock += 3;
      },
      step: 1 / 60,
      profiler,
    });

    loop.start();

    try {
      const runPromise = profiler.start(500);
      expect(profiler.isActive()).toBe(true);

      // Frame 1: sets initial RAF timestamp (dt=0, 0 simulation steps, 1 render = 3ms)
      raf.flushNext(1000);
      // Frame 2: +16ms (within 1000/60 budget, 0 simulation steps, 1 render = 3ms)
      raf.flushNext(1016);
      // Frame 3: +20ms (> 1000/60 budget -> overBudget=1; accumulator=36ms -> 2 sim steps = 4ms + render 3ms)
      raf.flushNext(1036);
      // Frame 4: +35ms (> 33ms & > budget -> overBudget=2, over33=1)
      raf.flushNext(1071);
      // Frame 5: +300ms (clamped to 250ms in loop, but profiler measures true 300ms > 50ms -> overBudget=3, over33=2, over50=1)
      raf.flushNext(1371);

      perfClock += 500;
      await vi.advanceTimersByTimeAsync(500);
      const result = await runPromise;

      // Controlled perfClock increments across 5 frames:
      // F1: 0 sim + 3 render = 3ms
      // F2: 0 sim + 3 render = 3ms
      // F3: 2*2 sim + 3 render = 7ms
      // F4: 2*2 sim + 3 render = 7ms
      // F5: 15*2 sim + 3 render = 33ms
      // Total frame work = 53ms + 500ms timer advance => 553ms actual recording duration.
      const expectedDurationMs = 3 + 3 + 7 + 7 + 33 + 500;

      expect(profiler.isActive()).toBe(false);
      expect(result.valid).toBe(true);
      expect(result.cancelledReason).toBeNull();
      expect(result.frames).toBe(5);
      expect(result.durationMs).toBe(expectedDurationMs);
      expect(result.fps).toBeCloseTo((5 * 1000) / expectedDurationMs, 6);

      // 5 callbacks produce 4 frame intervals: [16, 20, 35, 300] (unclamped!)
      expect(result.frameIntervalMs).toEqual({
        count: 4,
        min: 16,
        mean: (16 + 20 + 35 + 300) / 4,
        p50: 20,
        p95: 300,
        p99: 300,
        max: 300,
      });

      expect(FRAME_BUDGET_MS).toBeCloseTo(1000 / 60, 10);
      expect(result.framesOverBudget).toBe(3);
      expect(result.framesOver33Ms).toBe(2);
      expect(result.framesOver50Ms).toBe(1);

      // Frame 3 ran 2 simulation steps (2 * 2ms = 4ms); Frame 5 clamped to 250ms -> 15 steps (30ms)
      expect(result.simulationMs?.count).toBe(5);
      expect(result.simulationMs?.min).toBe(0);
      expect(result.simulationMs?.max).toBe(30);

      expect(result.renderMs?.count).toBe(5);
      expect(result.renderMs?.min).toBe(3);
      expect(result.renderMs?.max).toBe(3);

      expect(result.frameWorkMs?.count).toBe(5);
      expect(result.frameWorkMs?.min).toBe(3);
      expect(result.frameWorkMs?.max).toBe(33);

      expect(markSpy).toHaveBeenCalledWith('magic-arena:profile:start');
      expect(markSpy).toHaveBeenCalledWith('magic-arena:profile:end');
      expect(measureSpy).toHaveBeenCalledWith(
        'magic-arena:simulation',
        expect.any(Object),
      );
      expect(measureSpy).toHaveBeenCalledWith(
        'magic-arena:render',
        expect.any(Object),
      );
      expect(measureSpy).toHaveBeenCalledWith(
        'magic-arena:frame',
        expect.any(Object),
      );
      expect(clearMeasuresSpy).toHaveBeenCalled();
      expect(clearMarksSpy).toHaveBeenCalled();
      expect(perfNowSpy).toHaveBeenCalled();
    } finally {
      loop.stop();
      profiler.dispose();
    }
  });

  test('returns null summaries when no frames were captured', async () => {
    vi.useFakeTimers();
    const profiler = new FrameProfiler();

    const runPromise = profiler.start(200);
    await vi.advanceTimersByTimeAsync(200);
    const result = await runPromise;

    expect(result.frames).toBe(0);
    expect(result.fps).toBe(0);
    expect(result.frameIntervalMs).toBeNull();
    expect(result.frameWorkMs).toBeNull();
    expect(result.simulationMs).toBeNull();
    expect(result.renderMs).toBeNull();
  });

  test('rejects concurrent start calls and rejects invalid duration', async () => {
    vi.useFakeTimers();
    const profiler = new FrameProfiler();

    const activeRun = profiler.start(500);
    await expect(profiler.start(500)).rejects.toThrow(
      'Frame profiling is already running',
    );

    await vi.advanceTimersByTimeAsync(500);
    await activeRun;

    await expect(profiler.start(0)).rejects.toThrow(
      'Profile durationMs must be a positive number',
    );
  });

  test('marks measurement invalid when document becomes hidden and cleans up listeners', async () => {
    vi.useFakeTimers();
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const profiler = new FrameProfiler();

    const runPromise = profiler.start(1000);

    expect(addSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    const result = await runPromise;

    expect(result.valid).toBe(false);
    expect(result.cancelledReason).toBe('Document became hidden');
    expect(profiler.isActive()).toBe(false);
    expect(removeSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );

    profiler.dispose();
  });

  test('synchronizes server start/result and exports unified JSON report', async () => {
    vi.useFakeTimers();
    const profiler = new FrameProfiler();

    const serverReport = {
      durationMs: 250,
      ticks: 8,
      ticksOver33Ms: 1,
      tickMs: { count: 8, min: 1, mean: 2, p50: 2, p95: 4, p99: 4, max: 4 },
      worldStepMs: null,
      collisionMs: null,
      snapshotCreateMs: null,
      binaryEncodingMs: null,
      broadcastMs: null,
      gc: {
        count: 0,
        totalDurationMs: 0,
        p50Ms: null,
        p95Ms: null,
        p99Ms: null,
        maxMs: null,
      },
      memory: {
        heapUsedBefore: 1000,
        heapUsedAfter: 1200,
        rssBefore: 5000,
        rssAfter: 5200,
      },
      entities: { avg: 12, max: 14 },
      players: 9,
    };

    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (url === '/api/profile/start') {
        return new Response(JSON.stringify({ status: 'running', durationMs: 250 }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({ status: 'completed', result: serverReport }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    const api = createMagicArenaProfileApi({
      profiler,
      fetchImpl: fetchMock,
      getContext: () => ({
        roomId: 'profiling',
        roomName: 'Performance Arena',
        playerCount: 9,
        codec: 'binary',
        netSim: { delayMs: 0, jitterMs: 0, dropRate: 0 },
        bounds: { width: 960, height: 640 },
      }),
    });

    expect(api.result()).toBeNull();
    expect(api.download()).toBe(false);

    const startPromise = api.start(250);
    await vi.advanceTimersByTimeAsync(250);
    const report = await startPromise;

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/profile/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ durationMs: 250 }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/profile/result',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(report.players).toEqual({
      clientRoom: 9,
      serverRoom: 9,
    });
    expect(report.experiment.roomId).toBe('profiling');
    expect(report.experiment.codec).toBe('binary');
    expect(report.server).toEqual(serverReport);
    expect(api.result()).toEqual(report);

    const createObjectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:profile-test');
    const revokeObjectUrlSpy = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    expect(api.download('baseline.json')).toBe(true);
    expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrlSpy).toHaveBeenCalledWith('blob:profile-test');
  });

  test('prevents starting client profiler when server start fails', async () => {
    const profiler = new FrameProfiler();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({ error: 'Server profiling is already running' }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });

    const api = createMagicArenaProfileApi({
      profiler,
      fetchImpl: fetchMock,
      getContext: () => ({
        roomId: null,
        roomName: null,
        playerCount: null,
        codec: null,
        netSim: null,
        bounds: null,
      }),
    });

    await expect(api.start(1000)).rejects.toThrow(
      'Server profiling is already running',
    );
    expect(profiler.isActive()).toBe(false);
    expect(api.result()).toBeNull();
  });
});

