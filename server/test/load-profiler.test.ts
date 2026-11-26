import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import {
  PROTOCOL_VERSION,
  createInputMessage,
  getCodec,
  parseServerMessage,
} from '@magicarena/shared';

import { HttpError } from '../src/errors.ts';
import { MatchManager } from '../src/game/MatchManager.ts';
import {
  LoadProfiler,
  computeEluMetrics,
  computeNetworkThroughput,
} from '../src/performance/LoadProfiler.ts';
import { RoomManager } from '../src/rooms.ts';
import { setupWebSocket } from '../src/ws.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const connectAndJoin = async (
  wsUrl: string,
  roomId: string,
  name: string,
  sockets: WebSocket[],
): Promise<{
  readonly socket: WebSocket;
  readonly joined: boolean;
}> => {
  const socket = new WebSocket(wsUrl);
  sockets.push(socket);
  await once(socket, 'open');

  return new Promise((resolve, reject) => {
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) {
        return;
      }
      const text = Buffer.isBuffer(data)
        ? data.toString('utf8')
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : Buffer.concat(data).toString('utf8');
      const parsedJson: unknown = JSON.parse(text);
      const parsed = parseServerMessage(parsedJson);
      if (!parsed.success) {
        return;
      }
      if (parsed.data.type === 'joined') {
        cleanup();
        resolve({ socket, joined: true });
      } else if (parsed.data.type === 'notice' && parsed.data.text.toLowerCase().includes('full')) {
        cleanup();
        resolve({ socket, joined: false });
      }
    };

    const onClose = (): void => {
      cleanup();
      resolve({ socket, joined: false });
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
    };

    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onError);

    socket.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'join',
        room: roomId,
        name,
      }),
    );
  });
};

describe('LoadProfiler metrics and lifecycle', () => {
  test('computeEluMetrics and computeNetworkThroughput normalize bounds and rates', () => {
    const elu = computeEluMetrics({ idle: 1000, active: 250, utilization: 1.4 });
    expect(elu).toEqual({
      utilization: 1,
      utilizationPercent: 100,
      activeMs: 250,
      idleMs: 1000,
    });

    const network = computeNetworkThroughput(
      {
        receivedBytes: 2048,
        sentBytes: 8192,
        receivedMessages: 20,
        sentMessages: 40,
        droppedMessages: 1,
        backpressureEvents: 2,
      },
      2000,
    );

    expect(network.receivedBytesPerSecond).toBe(1024);
    expect(network.sentBytesPerSecond).toBe(4096);
    expect(network.totalBytesPerSecond).toBe(5120);
    expect(network.droppedMessages).toBe(1);
    expect(network.backpressureEvents).toBe(2);
    expect(network.scopeNote).toContain('WebSocket application payload');
  });

  test('records ticks, over-33ms share, memory RSS peaks, ELU, and cleans timers cleanly', () => {
    vi.useFakeTimers();

    let nowMs = 100;
    let rssSampleIndex = 0;
    const rssSamples = [
      { rss: 100_000_000, heapUsed: 30_000_000 },
      { rss: 145_000_000, heapUsed: 35_000_000 },
      { rss: 118_000_000, heapUsed: 32_000_000 },
    ];
    let eluCall = 0;

    const profiler = new LoadProfiler({
      now: () => nowMs,
      rssSampleIntervalMs: 1000,
      memoryUsage: () => {
        const sample = rssSamples[Math.min(rssSampleIndex, rssSamples.length - 1)];
        rssSampleIndex += 1;
        return sample ?? { rss: 100_000_000, heapUsed: 30_000_000 };
      },
      eventLoopUtilization: () => {
        eluCall += 1;
        return eluCall === 1
          ? { idle: 0, active: 0, utilization: 0 }
          : { idle: 1500, active: 500, utilization: 0.25 };
      },
    });

    expect(profiler.getState().status).toBe('idle');

    profiler.start(2000, 32);
    expect(profiler.isRunning()).toBe(true);
    expect(() => profiler.start(2000, 32)).toThrow(HttpError);

    nowMs = 1100;
    vi.advanceTimersByTime(1000);

    profiler.recordTick(4.0, 40, 32);
    profiler.recordTick(36.5, 44, 32);
    profiler.recordTick(8.0, 42, 32);
    profiler.recordReceived(600);
    profiler.recordSent(2400);
    profiler.recordDropped();
    profiler.recordBackpressure();

    nowMs = 2100;
    vi.advanceTimersByTime(1000);

    expect(profiler.isRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    const state = profiler.getState();
    expect(state.status).toBe('completed');
    if (state.status !== 'completed') {
      throw new Error('Expected completed state');
    }

    const { result } = state;
    expect(result.durationMs).toBe(2000);
    expect(result.expectedClients).toBe(32);
    expect(result.ticks).toBe(3);
    expect(result.actualTickRateHz).toBeCloseTo(1.5, 5);
    expect(result.ticksOver33Ms).toBe(1);
    expect(result.over33MsShare).toBeCloseTo(1 / 3, 5);
    expect(result.tickMs?.p99).toBe(36.5);
    expect(result.memory.rssStartBytes).toBe(100_000_000);
    expect(result.memory.rssPeakBytes).toBe(145_000_000);
    expect(result.memory.rssEndBytes).toBe(118_000_000);
    expect(result.network.receivedBytes).toBe(600);
    expect(result.network.sentBytes).toBe(2400);
    expect(result.network.droppedMessages).toBe(1);
    expect(result.network.backpressureEvents).toBe(1);
    expect(result.entities.avg).toBeCloseTo(42, 5);
    expect(result.entities.max).toBe(44);
    expect(result.players).toBe(32);

    profiler.shutdown();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Load-test room isolation and capacity preservation', () => {
  test('isolates LoadProfiler WS/Match tracking to load-test room and preserves default maxPlayers=4', async () => {
    const httpServer = createServer();
    const rooms = new RoomManager();
    const normalRoom = rooms.create({
      id: 'normal-room',
      name: 'Normal Arena',
      obstacleCount: 0,
    });

    expect(normalRoom.maxPlayers).toBe(4);

    const loadProfiler = new LoadProfiler();
    const recordTickSpy = vi.spyOn(loadProfiler, 'recordTick');
    let wsControlRef: ReturnType<typeof setupWebSocket> | null = null;
    const matchManager = new MatchManager(rooms, {
      onSnapshot: (match) => {
        wsControlRef?.broadcastSnapshot(match);
      },
      loadProfiler,
    });

    const wsControl = setupWebSocket(httpServer, rooms, {
      matchManager,
      codec: 'binary',
      loadProfiler,
    });
    wsControlRef = wsControl;

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }
    const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
    const sockets: WebSocket[] = [];

    try {
      // 1. Default room enforces maxPlayers = 4
      const normalJoins = await Promise.all([
        connectAndJoin(wsUrl, 'normal-room', 'P1', sockets),
        connectAndJoin(wsUrl, 'normal-room', 'P2', sockets),
        connectAndJoin(wsUrl, 'normal-room', 'P3', sockets),
        connectAndJoin(wsUrl, 'normal-room', 'P4', sockets),
      ]);
      expect(normalJoins.every((item) => item.joined)).toBe(true);

      const fifthNormal = await connectAndJoin(wsUrl, 'normal-room', 'P5', sockets);
      expect(fifthNormal.joined).toBe(false);

      // While only normal-room ticks and exchanges WS traffic, LoadProfiler must record nothing
      loadProfiler.start(5000, 1);
      const binaryCodec = getCodec('binary');
      const normalInput = binaryCodec.encode(createInputMessage({ seq: 1, thrust: true }));
      const p1 = normalJoins[0];
      if (p1 !== undefined) {
        p1.socket.send(normalInput);
      }
      await new Promise((resolve) => setTimeout(resolve, 80));

      const beforeLoadRoom = loadProfiler.stop();
      expect(recordTickSpy).not.toHaveBeenCalled();
      expect(beforeLoadRoom?.network.receivedBytes).toBe(0);
      expect(beforeLoadRoom?.network.sentBytes).toBe(0);
      expect(beforeLoadRoom?.ticks).toBe(0);

      // 2. Create load-test room (maxPlayers = 128), join > 4 players, and verify tracked metrics
      const loadRoom = rooms.create({
        id: 'load-test',
        name: 'Load Test Arena',
        obstacleCount: 1,
        maxPlayers: 128,
      });
      expect(loadRoom.maxPlayers).toBe(128);

      const loadClients = [];
      for (let i = 1; i <= 5; i += 1) {
        loadClients.push(await connectAndJoin(wsUrl, 'load-test', `L${i}`, sockets));
      }
      expect(loadClients.every((item) => item.joined)).toBe(true);

      recordTickSpy.mockClear();
      loadProfiler.start(5000, 5);
      const firstLoad = loadClients[0];
      if (firstLoad !== undefined) {
        firstLoad.socket.send(binaryCodec.encode(createInputMessage({ seq: 1, thrust: true })));
      }
      await new Promise((resolve) => setTimeout(resolve, 80));

      const afterLoadRoom = loadProfiler.stop();
      expect(recordTickSpy).toHaveBeenCalled();
      expect(afterLoadRoom?.ticks).toBeGreaterThanOrEqual(1);
      expect(afterLoadRoom?.players).toBe(5);
      expect(afterLoadRoom?.network.receivedMessages).toBeGreaterThanOrEqual(1);
      expect(afterLoadRoom?.network.receivedBytes).toBeGreaterThan(0);
      expect(afterLoadRoom?.network.sentMessages).toBeGreaterThanOrEqual(1);
      expect(afterLoadRoom?.network.sentBytes).toBeGreaterThan(0);
    } finally {
      for (const socket of sockets) {
        socket.terminate();
      }
      loadProfiler.shutdown();
      matchManager.shutdown();
      await wsControl.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
