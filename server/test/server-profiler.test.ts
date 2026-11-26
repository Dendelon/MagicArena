import { once } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';

import { HttpError } from '../src/errors.ts';
import { Match } from '../src/game/Match.ts';
import { RoomManager } from '../src/rooms.ts';
import { ServerProfiler } from '../src/performance/ServerProfiler.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ServerProfiler', () => {
  test('starts idle, records controlled timing and GC samples, and summarizes accurately', async () => {
    vi.useFakeTimers();

    let clock = 500;
    let memCall = 0;

    const profiler = new ServerProfiler({
      enableGcObserver: false,
      now: () => clock,
      memoryUsage: () => {
        memCall += 1;
        return memCall === 1
          ? { heapUsed: 10_000_000, rss: 50_000_000 }
          : { heapUsed: 12_500_000, rss: 54_000_000 };
      },
    });

    expect(profiler.getState()).toEqual({ status: 'idle' });

    // Ignored before start
    profiler.recordTick(99);

    profiler.start(1000);
    expect(profiler.isRunning()).toBe(true);
    expect(profiler.getState()).toMatchObject({
      status: 'running',
      durationMs: 1000,
    });

    // Reject concurrent start
    expect(() => profiler.start(1000)).toThrow(HttpError);

    profiler.recordTick(5);
    profiler.recordTick(12);
    profiler.recordTick(40); // > 33ms
    profiler.recordWorldStep(2.5);
    profiler.recordWorldStep(8.5);
    profiler.recordCollision(1.1);
    profiler.recordCollision(3.3);
    profiler.recordSnapshotCreate(0.9);
    profiler.recordBinaryEncode(0.4);
    profiler.recordBroadcast(2.2);
    profiler.recordEntities(10);
    profiler.recordEntities(20);
    profiler.recordPlayers(9);

    // Out-of-window GC pause before startedAt must be excluded
    profiler.recordGcPause(15, 400);
    // In-window GC pauses
    profiler.recordGcPause(1.5, 600);
    profiler.recordGcPause(4.5, 900);

    clock = 1500;
    await vi.advanceTimersByTimeAsync(1000);

    const state = profiler.getState();
    expect(state.status).toBe('completed');
    if (state.status !== 'completed') {
      throw new Error('Expected completed profiler state');
    }

    const { result } = state;

    expect(result.durationMs).toBe(1000);
    expect(result.ticks).toBe(3);
    expect(result.ticksOver33Ms).toBe(1);
    expect(result.tickMs).toEqual({
      count: 3,
      min: 5,
      mean: 19,
      p50: 12,
      p95: 40,
      p99: 40,
      max: 40,
    });
    expect(result.worldStepMs?.mean).toBe(5.5);
    expect(result.collisionMs?.mean).toBe(2.2);
    expect(result.snapshotCreateMs?.p50).toBe(0.9);
    expect(result.binaryEncodingMs?.p50).toBe(0.4);
    expect(result.broadcastMs?.p50).toBe(2.2);
    expect(result.gc).toEqual({
      count: 2,
      totalDurationMs: 6,
      p50Ms: 1.5,
      p95Ms: 4.5,
      p99Ms: 4.5,
      maxMs: 4.5,
    });
    expect(result.memory).toEqual({
      heapUsedBefore: 10_000_000,
      heapUsedAfter: 12_500_000,
      rssBefore: 50_000_000,
      rssAfter: 54_000_000,
    });
    expect(result.entities).toEqual({
      avg: 15,
      max: 20,
    });
    expect(result.players).toBe(9);
  });

  test('returns null summaries when no samples were collected', async () => {
    vi.useFakeTimers();
    const profiler = new ServerProfiler({ enableGcObserver: false });

    profiler.start(200);
    await vi.advanceTimersByTimeAsync(200);

    const state = profiler.getState();
    expect(state.status).toBe('completed');
    if (state.status !== 'completed') {
      throw new Error('Expected completed profiler state');
    }

    expect(state.result.ticks).toBe(0);
    expect(state.result.tickMs).toBeNull();
    expect(state.result.worldStepMs).toBeNull();
    expect(state.result.collisionMs).toBeNull();
    expect(state.result.gc).toEqual({
      count: 0,
      totalDurationMs: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
    });
    expect(state.result.entities).toEqual({ avg: null, max: null });
    expect(state.result.players).toBeNull();
  });

  test('validates durationMs and cleans up on shutdown', () => {
    const profiler = new ServerProfiler();

    expect(() => profiler.start(0)).toThrow(HttpError);

    profiler.start(10000);
    expect(profiler.isRunning()).toBe(true);

    profiler.shutdown();
    expect(profiler.isRunning()).toBe(false);
    expect(profiler.getState().status).toBe('completed');
  });

  test('instruments active Match.step world and collision timings without affecting idle matches', async ({
    onTestFinished,
  }) => {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
    });
    const clients: WebSocket[] = [];

    onTestFinished(async () => {
      for (const client of clients) {
        client.terminate();
      }

      for (const socket of wss.clients) {
        socket.terminate();
      }

      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });

    await once(wss, 'listening');

    const address = wss.address();
    if (!address || typeof address === 'string') {
      throw new Error('Invalid test server address');
    }

    const accepted = new Promise<WebSocket>((resolve) => {
      wss.once('connection', resolve);
    });

    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    clients.push(client);

    const [serverSocket] = await Promise.all([accepted, once(client, 'open')]);

    const profiler = new ServerProfiler({ enableGcObserver: false });
    const rooms = new RoomManager();
    const activeRoom = rooms.create({
      id: 'active',
      name: 'Active',
      obstacleCount: 2,
      maxPlayers: 4,
    });
    const idleRoom = rooms.create({
      id: 'idle',
      name: 'Idle',
      obstacleCount: 2,
      maxPlayers: 4,
    });

    const activeMatch = new Match(activeRoom, { profiler });
    const idleMatch = new Match(idleRoom, { profiler });

    activeMatch.addPlayer({
      id: 'p1',
      name: 'Mage',
      socket: serverSocket,
    });

    profiler.start(5000);
    idleMatch.step();
    activeMatch.step();
    activeMatch.step();
    const result = profiler.stop();

    idleMatch.stop();
    activeMatch.stop();

    expect(result?.worldStepMs?.count).toBe(2);
    expect(result?.collisionMs?.count).toBe(2);
    expect(result?.players).toBe(1);
    expect(result?.entities.max).toBeGreaterThanOrEqual(4);
  });

  test('records before, after, and delta pool metrics when getPoolStats is provided', async () => {
    vi.useFakeTimers();
    let stage = 0;

    const profiler = new ServerProfiler({
      enableGcObserver: false,
      getPoolStats: () => {
        stage += 1;
        return stage === 1
          ? {
              bullets: {
                created: 10,
                acquired: 10,
                reused: 0,
                released: 5,
                discarded: 0,
                active: 5,
                available: 5,
                peakActive: 6,
              },
              particles: {
                created: 20,
                acquired: 20,
                reused: 0,
                released: 20,
                discarded: 0,
                active: 0,
                available: 20,
                peakActive: 20,
              },
            }
          : {
              bullets: {
                created: 12,
                acquired: 50,
                reused: 38,
                released: 48,
                discarded: 0,
                active: 2,
                available: 10,
                peakActive: 12,
              },
              particles: {
                created: 25,
                acquired: 120,
                reused: 95,
                released: 120,
                discarded: 0,
                active: 0,
                available: 25,
                peakActive: 25,
              },
            };
      },
    });

    profiler.start(500);
    await vi.advanceTimersByTimeAsync(500);

    const state = profiler.getState();
    if (state.status !== 'completed') {
      throw new Error('Expected completed state');
    }

    expect(state.result.pools?.bullets.delta).toEqual({
      created: 2,
      acquired: 40,
      reused: 38,
      released: 43,
      discarded: 0,
    });
    expect(state.result.pools?.particles.delta).toEqual({
      created: 5,
      acquired: 100,
      reused: 95,
      released: 100,
      discarded: 0,
    });
    expect(state.result.pools?.bullets.after.peakActive).toBe(12);
  });
});
