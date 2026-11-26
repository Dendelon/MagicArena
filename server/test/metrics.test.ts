import { once } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  createInputMessage,
  getCodec,
  toTick,
} from '@magicarena/shared';

import { z } from 'zod';
import { MatchManager } from '../src/game/MatchManager.ts';
import { createLogger } from '../src/log/logger.ts';
import { rawDataToUtf8 } from '../src/network/rawData.ts';
import {
  ServerMetrics,
  type EventLoopDelayReader,
} from '../src/performance/ServerMetrics.ts';
import { RoomManager } from '../src/rooms.ts';
import { setupWebSocket } from '../src/ws.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MetricsSnapshotSchema = z.object({
  status: z.enum(['ready', 'shutting-down']),
  uptimeSeconds: z.number(),
  runtime: z.object({
    version: z.string(),
    nodeVersion: z.string(),
    nodeEnv: z.string(),
    gitSha: z.string().nullable(),
    buildId: z.string().nullable(),
  }),
  rooms: z.object({
    active: z.number(),
    activePlayers: z.number(),
    activeConnections: z.number(),
  }),
  messages: z.object({
    windowMs: z.number(),
    receivedTotal: z.number(),
    sentTotal: z.number(),
    droppedTotal: z.number(),
    backpressureTotal: z.number(),
    receivedPerSec: z.number(),
    sentPerSec: z.number(),
    totalPerSec: z.number(),
  }),
  bytes: z.object({
    windowMs: z.number(),
    receivedTotal: z.number(),
    sentTotal: z.number(),
    receivedPerSec: z.number(),
    sentPerSec: z.number(),
    totalPerSec: z.number(),
  }),
  ticks: z.object({
    windowMs: z.number(),
    activeMatches: z.number(),
    targetHz: z.number(),
    ticksTotal: z.number(),
    ticksPerSec: z.number(),
    avgMatchTickRateHz: z.number(),
    durationMs: z.object({
      last: z.number(),
      avg: z.number(),
      max: z.number(),
    }),
  }),
  eventLoop: z.object({
    utilization: z.number(),
    activeMs: z.number(),
    idleMs: z.number(),
    delayMs: z.object({
      min: z.number(),
      mean: z.number(),
      p50: z.number(),
      p95: z.number(),
      p99: z.number(),
      max: z.number(),
    }),
  }),
  memory: z.object({
    rssBytes: z.number(),
    heapTotalBytes: z.number(),
    heapUsedBytes: z.number(),
    externalBytes: z.number(),
    arrayBuffersBytes: z.number(),
  }),
});

const parseJsonLines = (text: string): Array<Record<string, unknown>> =>
  text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error('Expected JSON log object');
      }
      const record: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        record[key] = value;
      }
      return record;
    });

const connectAndJoin = async (
  wsUrl: string,
  roomId: string,
  name: string,
  sockets: WebSocket[],
): Promise<WebSocket> => {
  const socket = new WebSocket(wsUrl);
  sockets.push(socket);
  await once(socket, 'open');

  const joined = new Promise<void>((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return;
      const parsed: unknown = JSON.parse(rawDataToUtf8(data));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        parsed.type === 'joined'
      ) {
        cleanup();
        resolve();
      }
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('Socket closed before joining'));
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
    socket.once('close', onClose);
    socket.once('error', onError);
  });

  socket.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'join',
      room: roomId,
      name,
    }),
  );
  await joined;
  return socket;
};

describe('ServerMetrics collector', () => {
  test('computes message, byte, tick rates, ELU/ELD, memory, metadata, and cleans timers on shutdown', () => {
    vi.useFakeTimers();

    let clockMs = 1000;
    let enabled = false;
    let disabled = false;
    let count = 0;

    const fakeMonitor: EventLoopDelayReader = {
      enable: () => {
        enabled = true;
      },
      disable: () => {
        disabled = true;
      },
      get count() {
        return count;
      },
      min: 1_000_000,
      mean: 2_500_000,
      max: 8_000_000,
      percentile: (p: number) => p * 100_000,
    };

    const metrics = new ServerMetrics({
      runtime: {
        version: '1.0.0',
        nodeVersion: 'v24.0.0',
        nodeEnv: 'production',
        gitSha: 'deadbeef',
        buildId: 'ci-77',
      },
      sampleIntervalMs: 1000,
      now: () => clockMs,
      memoryUsage: () => ({
        rss: 120_000_000,
        heapTotal: 64_000_000,
        heapUsed: 40_000_000,
        external: 3_000_000,
        arrayBuffers: 1_000_000,
      }),
      eventLoopUtilization: () => ({
        utilization: 0.25,
        active: 250,
        idle: 750,
      }),
      createDelayMonitor: () => fakeMonitor,
    });

    expect(enabled).toBe(true);

    const rooms = new RoomManager();
    const room = rooms.create({ id: 'test-room', name: 'Test Arena' });

    // Before first ELD sample arrives, quantiles remain safe 0s instead of MAX_SAFE_INTEGER.
    const initial = metrics.getMetrics({
      shuttingDown: false,
      matches: [],
      roomManager: rooms,
    });
    expect(initial.eventLoop.delayMs).toEqual({
      min: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    });

    // Simulate 1s window traffic
    count = 10;
    metrics.recordConnectionOpened();
    metrics.recordIncomingMessage(150);
    metrics.recordIncomingMessage(250);
    metrics.recordOutgoingMessage(1000);
    metrics.recordDroppedMessage();
    metrics.recordBackpressure();
    metrics.recordTick(2.5);
    metrics.recordTick(4.5);

    clockMs = 2000;
    vi.advanceTimersByTime(1000);

    const afterWindow = metrics.getMetrics({
      shuttingDown: false,
      matches: [
        {
          roomId: room.id,
          tick: toTick(2),
          targetHz: 30,
          lastStepMs: 4.5,
          avgStepMs: 3.5,
          lastJitterMs: 0.2,
          avgJitterMs: 0.1,
          players: 1,
        },
      ],
      roomManager: rooms,
    });

    expect(afterWindow.status).toBe('ready');
    expect(afterWindow.runtime).toEqual({
      version: '1.0.0',
      nodeVersion: 'v24.0.0',
      nodeEnv: 'production',
      gitSha: 'deadbeef',
      buildId: 'ci-77',
    });
    expect(afterWindow.rooms.active).toBe(1);
    expect(afterWindow.rooms.activeConnections).toBe(1);
    expect(afterWindow.messages.receivedPerSec).toBe(2);
    expect(afterWindow.messages.sentPerSec).toBe(1);
    expect(afterWindow.messages.totalPerSec).toBe(3);
    expect(afterWindow.messages.droppedTotal).toBe(1);
    expect(afterWindow.messages.backpressureTotal).toBe(1);
    expect(afterWindow.bytes.receivedPerSec).toBe(400);
    expect(afterWindow.bytes.sentPerSec).toBe(1000);
    expect(afterWindow.bytes.totalPerSec).toBe(1400);
    expect(afterWindow.ticks.ticksTotal).toBe(2);
    expect(afterWindow.ticks.ticksPerSec).toBe(2);
    expect(afterWindow.ticks.avgMatchTickRateHz).toBe(2);
    expect(afterWindow.ticks.durationMs).toEqual({
      last: 4.5,
      avg: 3.5,
      max: 4.5,
    });
    expect(afterWindow.eventLoop.utilization).toBe(0.25);
    expect(afterWindow.eventLoop.delayMs.p95).toBe(9.5);
    expect(afterWindow.memory.rssBytes).toBe(120_000_000);

    // Next quiet 1s window drops per-sec rates to 0 while totals remain cumulative.
    clockMs = 3000;
    vi.advanceTimersByTime(1000);
    const quietWindow = metrics.getMetrics({
      shuttingDown: true,
      matches: [],
      roomManager: rooms,
    });
    expect(quietWindow.status).toBe('shutting-down');
    expect(quietWindow.messages.receivedPerSec).toBe(0);
    expect(quietWindow.messages.receivedTotal).toBe(2);
    expect(quietWindow.bytes.sentTotal).toBe(1000);

    metrics.shutdown();
    expect(disabled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('handles missing GIT_SHA and BUILD_ID gracefully without throwing', () => {
    const metrics = new ServerMetrics({
      runtime: {
        version: '1.0.0',
        nodeVersion: process.version,
        nodeEnv: 'development',
        gitSha: null,
        buildId: null,
      },
      sampleIntervalMs: 0,
      enableEventLoopDelay: false,
    });

    const rooms = new RoomManager();
    const snapshot = metrics.getMetrics({
      shuttingDown: false,
      matches: [],
      roomManager: rooms,
    });

    expect(snapshot.runtime.gitSha).toBeNull();
    expect(snapshot.runtime.buildId).toBeNull();
    metrics.shutdown();
  });
});

describe('/metrics endpoint and structured room/player logging integration', () => {
  test('serves live metrics, logs lifecycle/room/player JSON events without secret leakage, and transitions cleanly on shutdown', async () => {
    const logStream = new PassThrough();
    const logChunks: string[] = [];
    logStream.on('data', (chunk: Buffer | string) => {
      logChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    const logger = createLogger({ level: 'info', destination: logStream });
    const rooms = new RoomManager({ logger });
    const metrics = new ServerMetrics({
      runtime: {
        version: '1.0.0',
        nodeVersion: process.version,
        nodeEnv: 'test',
        gitSha: 'test-sha',
        buildId: null,
      },
      sampleIntervalMs: 100,
    });

    let shuttingDown = false;
    let wsRef: ReturnType<typeof setupWebSocket> | null = null;
    const matchManager = new MatchManager(rooms, {
      onSnapshot: (match) => {
        wsRef?.broadcastSnapshot(match);
      },
      metrics,
    });

    const httpServer = createServer((req, res) => {
      if (req.url === '/metrics' && req.method === 'GET') {
        const body = metrics.getMetrics({
          shuttingDown,
          matches: matchManager.getStats(),
          roomManager: rooms,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    wsRef = setupWebSocket(httpServer, rooms, {
      matchManager,
      codec: 'binary',
      metrics,
      logger,
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
    const sockets: WebSocket[] = [];

    try {
      rooms.create({
        id: 'obs-room',
        name: 'Observability Arena',
        obstacleCount: 0,
      });

      const s1 = await connectAndJoin(wsUrl, 'obs-room', 'Alpha', sockets);
      const s2 = await connectAndJoin(wsUrl, 'obs-room', 'Beta', sockets);

      const binaryCodec = getCodec('binary');
      s1.send(binaryCodec.encode(createInputMessage({ seq: 1, thrust: true })));
      s2.send(
        JSON.stringify({
          v: PROTOCOL_VERSION,
          type: 'chat',
          text: 'SECRET_TOKEN_XYZ_DO_NOT_LOG',
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 120));

      const metricsRes = await fetch(`${baseUrl}/metrics`);
      expect(metricsRes.status).toBe(200);
      const payload: unknown = await metricsRes.json();
      const live = MetricsSnapshotSchema.parse(payload);

      expect(live.status).toBe('ready');
      expect(live.runtime.gitSha).toBe('test-sha');
      expect(live.runtime.nodeVersion).toBe(process.version);
      expect(live.rooms.active).toBe(1);
      expect(live.rooms.activePlayers).toBe(2);
      expect(live.rooms.activeConnections).toBe(2);
      expect(live.messages.receivedTotal).toBeGreaterThanOrEqual(4);
      expect(live.messages.sentTotal).toBeGreaterThanOrEqual(2);
      expect(live.bytes.receivedTotal).toBeGreaterThan(0);
      expect(live.bytes.sentTotal).toBeGreaterThan(0);
      expect(live.ticks.ticksTotal).toBeGreaterThanOrEqual(1);
      expect(live.memory.rssBytes).toBeGreaterThan(0);
      expect(live.memory.heapUsedBytes).toBeGreaterThan(0);
      expect(live.eventLoop.utilization).toBeGreaterThanOrEqual(0);
      expect(live.eventLoop.utilization).toBeLessThanOrEqual(1);

      // Disconnect all clients -> room empties and emits room.closed
      await Promise.all([
        new Promise<void>((resolve) => {
          s1.once('close', () => resolve());
          s1.close(1000, 'done');
        }),
        new Promise<void>((resolve) => {
          s2.once('close', () => resolve());
          s2.close(1000, 'done');
        }),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 25));

      // Verify /metrics during shutdown reports shutting-down status cleanly
      shuttingDown = true;
      const shutdownRes = await fetch(`${baseUrl}/metrics`);
      expect(shutdownRes.status).toBe(200);
      const shutdownJson: unknown = await shutdownRes.json();
      expect(shutdownJson).toMatchObject({
        status: 'shutting-down',
        rooms: { active: 0, activePlayers: 0 },
      });

      logger.flush();
      const rawLogText = logChunks.join('');
      expect(rawLogText).not.toContain('SECRET_TOKEN_XYZ_DO_NOT_LOG');

      const logEvents = parseJsonLines(rawLogText).map((entry) => entry.event);
      expect(logEvents).toContain('room.created');
      expect(logEvents).toContain('player.connected');
      expect(logEvents).toContain('room.player.joined');
      expect(logEvents).toContain('player.disconnected');
      expect(logEvents).toContain('room.player.left');
      expect(logEvents).toContain('room.closed');
    } finally {
      for (const s of sockets) {
        if (s.readyState !== WebSocket.CLOSED) {
          s.terminate();
        }
      }
      metrics.shutdown();
      matchManager.shutdown();
      await wsRef.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
