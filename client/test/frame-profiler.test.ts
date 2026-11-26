import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  PROTOCOL_VERSION,
  createSnapshotMessage,
  getCodec,
  toSeq,
  toTick,
} from '@magicarena/shared';

import { createLoop } from '../src/loop.ts';
import { createConnection } from '../src/network/connection.ts';
import { processDecodeRequest } from '../src/network/decoder.worker.ts';
import type { DecoderWorkerLike } from '../src/network/workerDecoder.ts';
import type {
  WorkerInboundMessage,
  WorkerOutboundMessage,
} from '../src/network/workerProtocol.ts';
import { DecodeProfiler } from '../src/performance/DecodeProfiler.ts';
import {
  FRAME_BUDGET_MS,
  FrameProfiler,
  createMagicArenaProfileApi,
} from '../src/performance/FrameProfiler.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

    const fetchMock = vi.fn<typeof fetch>((url) => {
      if (url === '/api/profile/start') {
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'running', durationMs: 250 }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({ status: 'completed', result: serverReport }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
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
        pools: {
          world: {
            bullets: {
              created: 8,
              acquired: 20,
              reused: 12,
              released: 18,
              discarded: 0,
              active: 2,
              available: 6,
              peakActive: 8,
            },
            particles: {
              created: 40,
              acquired: 80,
              reused: 40,
              released: 80,
              discarded: 0,
              active: 0,
              available: 40,
              peakActive: 20,
            },
          },
          localBullets: {
            created: 2,
            acquired: 5,
            reused: 3,
            released: 5,
            discarded: 0,
            active: 0,
            available: 2,
            peakActive: 2,
          },
        },
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
    expect(report.pools.clientWorld?.bullets.after.created).toBe(8);
    expect(report.pools.clientWorld?.particles.after.reused).toBe(40);
    expect(report.pools.localPredictedBullets?.after.peakActive).toBe(2);
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
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: 'Server profiling is already running' }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      ),
    );

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

  test('includes real decodeExperiment metrics in result() and downloaded JSON for main and worker modes', async () => {
    vi.useFakeTimers();

    type SocketListenerArgs =
      | ['open', (event: Event) => void]
      | ['message', (event: MessageEvent<string | ArrayBuffer>) => void]
      | ['close', (event: CloseEvent) => void]
      | ['error', (event: Event) => void];

    class FakeSocket {
      static latest: FakeSocket | null = null;
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly #openListeners = new Set<(event: Event) => void>();
      readonly #messageListeners = new Set<
        (event: MessageEvent<string | ArrayBuffer>) => void
      >();
      readonly #closeListeners = new Set<(event: CloseEvent) => void>();
      readonly #errorListeners = new Set<(event: Event) => void>();

      readyState = FakeSocket.OPEN;
      binaryType = 'arraybuffer';

      constructor(_url: string) {
        FakeSocket.latest = this;
      }

      addEventListener(...args: SocketListenerArgs): void {
        const [type, listener] = args;
        if (type === 'open') this.#openListeners.add(listener);
        else if (type === 'message') this.#messageListeners.add(listener);
        else if (type === 'close') this.#closeListeners.add(listener);
        else this.#errorListeners.add(listener);
      }

      send(_data: string | ArrayBuffer): void {}

      close(): void {
        this.readyState = FakeSocket.CLOSED;
        const ev = new CloseEvent('close', { code: 1000, wasClean: true });
        for (const listener of this.#closeListeners) listener(ev);
      }

      triggerMessage(data: string | ArrayBuffer): void {
        const ev = new MessageEvent<string | ArrayBuffer>('message', { data });
        for (const listener of this.#messageListeners) listener(ev);
      }

      get messageListenerCount(): number {
        return this.#messageListeners.size;
      }
    }

    const requireLatestSocket = (): FakeSocket => {
      const socket = FakeSocket.latest;

      if (socket === null) {
        throw new Error('Expected a connected FakeSocket');
      }

      return socket;
    };

    type WorkerListenerArgs =
      | ['message', (event: MessageEvent<unknown>) => void]
      | ['error', (event: Event) => void]
      | ['messageerror', (event: Event) => void];

    class InlineTestWorker implements DecoderWorkerLike {
      readonly #messageListeners = new Set<
        (event: MessageEvent<unknown>) => void
      >();
      #terminated = false;

      addEventListener(...args: WorkerListenerArgs): void {
        const [type, listener] = args;
        if (type === 'message') this.#messageListeners.add(listener);
      }

      removeEventListener(...args: WorkerListenerArgs): void {
        const [type, listener] = args;
        if (type === 'message') this.#messageListeners.delete(listener);
      }

      emitReady(): void {
        if (this.#terminated) return;
        const ev = new MessageEvent<unknown>('message', {
          data: { type: 'ready' } satisfies WorkerInboundMessage,
        });
        for (const listener of this.#messageListeners) listener(ev);
      }

      postMessage(message: WorkerOutboundMessage): void {
        queueMicrotask(() => {
          if (this.#terminated) return;
          const response = processDecodeRequest(message);
          if (!response) return;

          const ev = new MessageEvent<unknown>('message', { data: response });
          for (const listener of this.#messageListeners) {
            listener(ev);
          }
        });
      }

      terminate(): void {
        this.#terminated = true;
      }
    }

    vi.stubGlobal('WebSocket', FakeSocket);

    const makeServerFetch = (): typeof fetch =>
      vi.fn<typeof fetch>((url) => {
        if (url === '/api/profile/start') {
          return Promise.resolve(
            new Response(
              JSON.stringify({ status: 'running', durationMs: 250 }),
              { status: 202, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ status: 'idle' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      });

    const joinedPayload = JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'joined',
      room: {
        id: 'profiling',
        name: 'Performance Arena',
        obstacleCount: 3,
        maxPlayers: 9,
        players: 9,
      },
      player: { id: 'p1', name: 'Tester', entityId: 1 },
      entityId: 1,
      bounds: { width: 960, height: 640 },
      codec: 'binary',
      netSim: { delayMs: 0, jitterMs: 0, dropRate: 0 },
    });

    const binarySnapshot = getCodec('binary').encode(
      createSnapshotMessage({
        tick: toTick(1),
        lastProcessedSeq: toSeq(0),
        entities: [],
      }),
    );

    if (!(binarySnapshot instanceof ArrayBuffer)) {
      throw new Error('Expected binary ArrayBuffer snapshot');
    }

    const createObjectUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:decode-regression');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    // 1. Main decode mode
    FakeSocket.latest = null;
    const mainFrameProfiler = new FrameProfiler();
    const mainDecodeProfiler = new DecodeProfiler();
    const mainConn = createConnection({
      name: 'Tester',
      roomId: 'profiling',
      decodeMode: 'main',
      decodeProfiler: mainDecodeProfiler,
    });
    mainConn.connect();

    const mainSocket = requireLatestSocket();
    expect(mainSocket.messageListenerCount).toBe(1);

    const mainApi = createMagicArenaProfileApi({
      profiler: mainFrameProfiler,
      decodeProfiler: mainDecodeProfiler,
      fetchImpl: makeServerFetch(),
      getContext: () => ({
        roomId: 'profiling',
        roomName: 'Performance Arena',
        playerCount: 9,
        codec: 'binary',
        netSim: { delayMs: 0, jitterMs: 0, dropRate: 0 },
        bounds: { width: 960, height: 640 },
        decode: mainConn.getDecodeDiagnostics(),
      }),
    });

    const readBlobText = (blob: Blob): Promise<string> =>
      new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
          if (typeof reader.result === 'string') {
            resolve(reader.result);
          } else {
            reject(new Error('Expected Blob text'));
          }
        };

        reader.onerror = () => {
          reject(reader.error ?? new Error('Failed to read Blob'));
        };

        reader.onabort = () => {
          reject(new Error('Blob reading aborted'));
        };

        reader.readAsText(blob);
      });

    const readDownloadedJson = async (blob: Blob): Promise<unknown> => {
      const [text] = await Promise.all([
        readBlobText(blob),
        vi.advanceTimersByTimeAsync(50),
      ]);
      const parsed: unknown = JSON.parse(text);
      return parsed;
    };

    const mainRun = mainApi.start(250);
    await vi.advanceTimersByTimeAsync(0);
    expect(mainFrameProfiler.isActive()).toBe(true);
    expect(mainDecodeProfiler.isActive()).toBe(true);

    mainSocket.triggerMessage(joinedPayload);
    mainSocket.triggerMessage(binarySnapshot.slice(0));
    await vi.advanceTimersByTimeAsync(250);
    const mainResult = await mainRun;

    expect(mainApi.download('main-test.json')).toBe(true);
    const mainBlobArg = createObjectUrlSpy.mock.calls.at(-1)?.[0];
    if (!(mainBlobArg instanceof Blob)) {
      throw new Error('Expected downloaded main Blob');
    }
    const mainDownloaded = await readDownloadedJson(mainBlobArg);

    expect(mainResult.decodeExperiment).toMatchObject({
      requestedMode: 'main',
      actualMode: 'main',
      messageCount: 2,
      textMessages: 1,
      binaryMessages: 1,
      messageTypes: { joined: 1, snapshot: 1 },
      transferredBuffers: 0,
      errors: 0,
      fallbacks: 0,
      valid: true,
      workerDecodeMs: null,
      roundTripMs: null,
      estimatedOverheadMs: null,
    });
    expect(mainResult.decodeExperiment?.decodeMs?.count).toBe(2);
    expect(mainResult.decodeExperiment?.mainThreadWorkMs?.count).toBe(2);
    expect(mainResult.decodeExperiment?.mainThreadTotalMs).not.toBeNull();
    expect(mainDownloaded).toMatchObject({
      decodeExperiment: mainResult.decodeExperiment,
    });
    mainConn.close();

    // 2. Worker decode mode
    FakeSocket.latest = null;
    const workerFrameProfiler = new FrameProfiler();
    const workerDecodeProfiler = new DecodeProfiler();
    const inlineWorker = new InlineTestWorker();

    const workerConn = createConnection({
      name: 'Tester',
      roomId: 'profiling',
      decodeMode: 'worker',
      decodeProfiler: workerDecodeProfiler,
      createWorker: () => inlineWorker,
    });
    workerConn.connect();

    const workerSocket = requireLatestSocket();
    expect(workerSocket.messageListenerCount).toBe(1);

    inlineWorker.emitReady();
    await vi.advanceTimersByTimeAsync(0);
    expect(workerConn.getDecodeDiagnostics().worker?.ready).toBe(true);

    const workerApi = createMagicArenaProfileApi({
      profiler: workerFrameProfiler,
      decodeProfiler: workerDecodeProfiler,
      fetchImpl: makeServerFetch(),
      getContext: () => ({
        roomId: 'profiling',
        roomName: 'Performance Arena',
        playerCount: 9,
        codec: 'binary',
        netSim: { delayMs: 0, jitterMs: 0, dropRate: 0 },
        bounds: { width: 960, height: 640 },
        decode: workerConn.getDecodeDiagnostics(),
      }),
    });

    const workerRun = workerApi.start(250);
    await vi.advanceTimersByTimeAsync(0);
    expect(workerFrameProfiler.isActive()).toBe(true);
    expect(workerDecodeProfiler.isActive()).toBe(true);

    workerSocket.triggerMessage(joinedPayload);
    await vi.advanceTimersByTimeAsync(0);

    workerSocket.triggerMessage(binarySnapshot.slice(0));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(250);
    const workerResult = await workerRun;

    expect(workerApi.download('worker-test.json')).toBe(true);
    const workerBlobArg = createObjectUrlSpy.mock.calls.at(-1)?.[0];
    if (!(workerBlobArg instanceof Blob)) {
      throw new Error('Expected downloaded worker Blob');
    }
    const workerDownloaded = await readDownloadedJson(workerBlobArg);

    expect(workerResult.decodeExperiment).toMatchObject({
      requestedMode: 'worker',
      actualMode: 'worker',
      messageCount: 2,
      textMessages: 1,
      binaryMessages: 1,
      messageTypes: { joined: 1, snapshot: 1 },
      transferredBuffers: 1,
      maxPending: 1,
      errors: 0,
      fallbacks: 0,
      valid: true,
      decodeMs: null,
    });
    expect(workerResult.decodeExperiment?.workerDecodeMs?.count).toBe(2);
    expect(workerResult.decodeExperiment?.roundTripMs?.count).toBe(2);
    expect(workerResult.decodeExperiment?.estimatedOverheadMs?.count).toBe(2);
    expect(workerResult.decodeExperiment?.mainThreadWorkMs?.count).toBe(2);
    expect(workerDownloaded).toMatchObject({
      decodeExperiment: workerResult.decodeExperiment,
    });
    workerConn.close();
  });
});

