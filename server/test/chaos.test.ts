import { once } from 'node:events';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket, { type RawData } from 'ws';
import {
  PROTOCOL_VERSION,
  createInputMessage,
  getCodec,
  parseServerMessage,
  toSeq,
} from '@magicarena/shared';

import { MatchManager } from '../src/game/MatchManager.ts';
import { createLogger } from '../src/log/logger.ts';
import { rawDataToUtf8 } from '../src/network/rawData.ts';
import { ServerMetrics } from '../src/performance/ServerMetrics.ts';
import { RoomManager } from '../src/rooms.ts';
import { setupWebSocket } from '../src/ws.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rawToArrayBuffer = (data: RawData): ArrayBuffer => {
  if (data instanceof ArrayBuffer) {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy.buffer;
  }
  const combined = Buffer.concat(data);
  const copy = new Uint8Array(combined.byteLength);
  copy.set(combined);
  return copy.buffer;
};

interface TestPlayerClient {
  readonly socket: WebSocket;
  snapshotsReceived: number;
  latestTick: number;
  chatMessages: string[];
  disconnects: number;
  closeCleanly: () => Promise<void>;
}

const connectPlayerClient = async (
  wsUrl: string,
  roomId: string,
  name: string,
  sockets: WebSocket[],
): Promise<TestPlayerClient> => {
  const socket = new WebSocket(wsUrl);
  socket.binaryType = 'arraybuffer';
  sockets.push(socket);
  await once(socket, 'open');

  const codec = getCodec('binary');
  let intentionalClose = false;
  const client: TestPlayerClient = {
    socket,
    snapshotsReceived: 0,
    latestTick: 0,
    chatMessages: [],
    disconnects: 0,
    closeCleanly: () =>
      new Promise<void>((resolve) => {
        intentionalClose = true;
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
        socket.close(1000, 'test done');
      }),
  };

  const joined = new Promise<void>((resolve, reject) => {
    let settled = false;

    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) {
        const msg = codec.decode(rawToArrayBuffer(data));
        if (msg.type === 'snapshot') {
          client.snapshotsReceived += 1;
          client.latestTick = msg.tick;
        }
        return;
      }

      const parsedJson: unknown = JSON.parse(rawDataToUtf8(data));
      const parsed = parseServerMessage(parsedJson);
      if (!parsed.success) return;

      if (parsed.data.type === 'joined' && !settled) {
        settled = true;
        resolve();
      } else if (parsed.data.type === 'chat') {
        client.chatMessages.push(parsed.data.text);
      }
    };

    const onClose = (): void => {
      if (!intentionalClose) {
        client.disconnects += 1;
      }
      if (!settled) {
        settled = true;
        reject(new Error('Socket closed before joining'));
      }
    };

    const onError = (err: Error): void => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    socket.on('message', onMessage);
    socket.on('close', onClose);
    socket.on('error', onError);
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
  return client;
};

const createGameTestStack = async (options: {
  readonly port?: number;
  readonly maxConnectionsPerIp?: number;
} = {}) => {
  const logger = createLogger({ level: 'silent' });
  const rooms = new RoomManager({ logger, maxRooms: 10 });
  const metrics = new ServerMetrics({
    runtime: {
      version: '1.0.0',
      nodeVersion: process.version,
      nodeEnv: 'test',
      gitSha: null,
      buildId: null,
    },
    sampleIntervalMs: 0,
    enableEventLoopDelay: false,
  });

  let wsRef: ReturnType<typeof setupWebSocket> | null = null;
  const matchManager = new MatchManager(rooms, {
    onSnapshot: (match) => {
      wsRef?.broadcastSnapshot(match);
    },
    metrics,
  });

  const httpServer = createServer();
  const wsControl = setupWebSocket(httpServer, rooms, {
    matchManager,
    codec: 'binary',
    metrics,
    logger,
    allowMissingOrigin: true,
    maxConnectionsPerIp: options.maxConnectionsPerIp ?? 32,
  });
  wsRef = wsControl;

  await new Promise<void>((resolve) => {
    httpServer.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address');
  }

  return {
    port: address.port,
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    rooms,
    matchManager,
    metrics,
    wsControl,
    httpServer,
    shutdown: async (): Promise<void> => {
      metrics.shutdown();
      matchManager.shutdown();
      await wsControl.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
};

describe('Server chaos & resilience testing (M2.2)', () => {
  test('recovers room state, match cleanup, and IP counters after abrupt client disconnects', async () => {
    const stack = await createGameTestStack();
    const sockets: WebSocket[] = [];

    try {
      stack.rooms.create({
        id: 'chaos-disconnect',
        name: 'Chaos Disconnect',
        obstacleCount: 0,
      });

      const p1 = await connectPlayerClient(
        stack.wsUrl,
        'chaos-disconnect',
        'P1',
        sockets,
      );
      const p2 = await connectPlayerClient(
        stack.wsUrl,
        'chaos-disconnect',
        'P2',
        sockets,
      );

      expect(stack.wsControl.getActiveIpCount('127.0.0.1')).toBe(2);

      // Abruptly sever P1 socket -> P2 keeps receiving snapshots cleanly
      p1.socket.terminate();
      await vi.waitFor(
        () => {
          expect(stack.wsControl.getActiveIpCount('127.0.0.1')).toBe(1);
        },
        { timeout: 2000, interval: 10 },
      );

      const ticksBefore = p2.snapshotsReceived;
      await vi.waitFor(
        () => {
          expect(p2.snapshotsReceived).toBeGreaterThan(ticksBefore + 1);
        },
        { timeout: 2000, interval: 15 },
      );

      await p2.closeCleanly();

      await vi.waitFor(
        () => {
          expect(stack.wsControl.getActiveIpCount('127.0.0.1')).toBe(0);
          expect(stack.rooms.get('chaos-disconnect')).toBeUndefined();
          expect(stack.rooms.getTotalPlayers()).toBe(0);
          expect(stack.matchManager.getStats()).toEqual([]);
        },
        { timeout: 2000, interval: 15 },
      );
    } finally {
      for (const s of sockets) {
        if (s.readyState !== WebSocket.CLOSED) s.terminate();
      }
      await stack.shutdown();
    }
  });

  test('detects abrupt server death and re-establishes multiplayer session after server recovery', async () => {
    const serverA = await createGameTestStack();
    serverA.rooms.create({ id: 'arcane', name: 'Arcane Ruins', obstacleCount: 0 });

    const port = serverA.port;
    const sockets: WebSocket[] = [];

    const client1 = await connectPlayerClient(
      serverA.wsUrl,
      'arcane',
      'Survivor',
      sockets,
    );

    await vi.waitFor(
      () => {
        expect(client1.snapshotsReceived).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000, interval: 15 },
    );

    // Simulate sudden server crash/death without graceful shutdown notification
    const dropObserved = new Promise<number>((resolve) => {
      client1.socket.once('close', (code: number) => resolve(code));
    });
    serverA.metrics.shutdown();
    serverA.matchManager.shutdown();
    client1.socket.terminate();
    serverA.httpServer.closeAllConnections();
    await serverA.wsControl.shutdown();
    await new Promise<void>((resolve) =>
      serverA.httpServer.close(() => resolve()),
    );

    const dropCode = await dropObserved;
    expect(dropCode).not.toBe(1000);

    // Recover fresh server on same port and verify client reconnects & exchanges game traffic
    const serverB = await createGameTestStack({ port });
    serverB.rooms.create({ id: 'arcane', name: 'Arcane Ruins', obstacleCount: 0 });

    try {
      const clientReconnected = await connectPlayerClient(
        serverB.wsUrl,
        'arcane',
        'Survivor',
        sockets,
      );
      const binaryCodec = getCodec('binary');
      clientReconnected.socket.send(
        binaryCodec.encode(createInputMessage({ seq: toSeq(1), thrust: true })),
      );

      await vi.waitFor(
        () => {
          expect(clientReconnected.snapshotsReceived).toBeGreaterThanOrEqual(2);
        },
        { timeout: 2000, interval: 15 },
      );

      await clientReconnected.closeCleanly();
    } finally {
      for (const s of sockets) {
        if (s.readyState !== WebSocket.CLOSED) s.terminate();
      }
      await serverB.shutdown();
    }
  });

  test('isolates ~1000/s malformed-frame flood: disconnects attackers without degrading healthy room ticks or leaking resources', async () => {
    const stack = await createGameTestStack({ maxConnectionsPerIp: 40 });
    const sockets: WebSocket[] = [];

    try {
      stack.rooms.create({
        id: 'attacked-room',
        name: 'Attacked Room',
        obstacleCount: 0,
      });
      stack.rooms.create({
        id: 'healthy-room',
        name: 'Healthy Room',
        obstacleCount: 0,
      });

      const h1 = await connectPlayerClient(
        stack.wsUrl,
        'healthy-room',
        'HealthyOne',
        sockets,
      );
      const h2 = await connectPlayerClient(
        stack.wsUrl,
        'healthy-room',
        'HealthyTwo',
        sockets,
      );

      // Drive periodic legitimate inputs in healthy-room throughout the chaos window
      const binaryCodec = getCodec('binary');
      let healthySeq = 0;
      const healthyInputInterval = setInterval(() => {
        if (h1.socket.readyState === WebSocket.OPEN) {
          healthySeq += 1;
          h1.socket.send(
            binaryCodec.encode(
              createInputMessage({ seq: toSeq(healthySeq), thrust: true }),
            ),
          );
        }
      }, 33);

      try {
        await vi.waitFor(
          () => {
            expect(h1.snapshotsReceived).toBeGreaterThanOrEqual(3);
            expect(h2.snapshotsReceived).toBeGreaterThanOrEqual(3);
          },
          { timeout: 2000, interval: 15 },
        );

        const baselineTick = h1.latestTick;
        const baselineSnapshots = h2.snapshotsReceived;

        // Launch ~1000+ malformed frames/sec across pre-join & joined attacker sockets
        const attackerCount = 10;
        const framesPerAttacker = 50;
        const attackerSockets: WebSocket[] = [];
        const attackerCloses: Array<Promise<number>> = [];

        const joinedAttacker = await connectPlayerClient(
          stack.wsUrl,
          'attacked-room',
          'BadActor',
          sockets,
        );
        attackerSockets.push(joinedAttacker.socket);
        attackerCloses.push(
          new Promise<number>((resolve) => {
            joinedAttacker.socket.once('close', (code: number) => resolve(code));
          }),
        );

        for (let i = 1; i < attackerCount; i += 1) {
          const attacker = new WebSocket(stack.wsUrl);
          sockets.push(attacker);
          attackerSockets.push(attacker);
          attackerCloses.push(
            new Promise<number>((resolve) => {
              attacker.once('close', (code: number) => resolve(code));
            }),
          );
          await once(attacker, 'open');
        }

        const malformedPayloads: Array<string | Uint8Array> = [
          '{broken-json',
          JSON.stringify({ v: 99, type: 'join', room: 'attacked-room', name: 'Bad' }),
          new Uint8Array([99, 1, 2, 3, 4, 5]),
          new Uint8Array([2, 1, 255, 255]),
        ];

        const floodStart = performance.now();
        let sentMalformedFrames = 0;

        for (let round = 0; round < framesPerAttacker; round += 1) {
          for (let i = 0; i < attackerSockets.length; i += 1) {
            const attacker = attackerSockets[i];
            const payload = malformedPayloads[(round + i) % malformedPayloads.length];
            if (
              attacker &&
              payload !== undefined &&
              attacker.readyState === WebSocket.OPEN
            ) {
              try {
                attacker.send(payload);
                sentMalformedFrames += 1;
              } catch {
                // Socket may already be closing after initial malformed frame.
              }
            }
          }
        }
        const floodDurationMs = Math.max(1, performance.now() - floodStart);
        const attemptRatePerSec = (sentMalformedFrames * 1000) / floodDurationMs;
        expect(sentMalformedFrames).toBeGreaterThanOrEqual(300);
        expect(attemptRatePerSec).toBeGreaterThanOrEqual(1000);

        // Verify ALL attackers are disconnected cleanly by server policy (1007/1008/1003/4008)
        const closeCodes = await Promise.all(attackerCloses);
        for (const code of closeCodes) {
          expect([1003, 1007, 1008, 4008]).toContain(code);
        }

        // Verify healthy-room continued advancing ticks, delivering snapshots & chat without drops
        h1.socket.send(
          JSON.stringify({
            v: PROTOCOL_VERSION,
            type: 'chat',
            text: 'still alive during flood',
          }),
        );

        await vi.waitFor(
          () => {
            expect(h1.latestTick).toBeGreaterThan(baselineTick + 3);
            expect(h2.snapshotsReceived).toBeGreaterThan(baselineSnapshots + 3);
            expect(h2.chatMessages).toContain('still alive during flood');
          },
          { timeout: 2500, interval: 20 },
        );

        expect(h1.disconnects).toBe(0);
        expect(h2.disconnects).toBe(0);

        const healthyMatchStats = stack.matchManager
          .getStats()
          .find((m) => m.roomId === 'healthy-room');
        expect(healthyMatchStats).toBeDefined();
        expect(healthyMatchStats?.players).toBe(2);
        expect(healthyMatchStats?.avgStepMs ?? 999).toBeLessThan(15);
        expect(healthyMatchStats?.avgJitterMs ?? 999).toBeLessThan(20);
      } finally {
        clearInterval(healthyInputInterval);
      }

      // Cleanup remaining healthy players and verify zero leaked resources/counters
      await Promise.all([h1.closeCleanly(), h2.closeCleanly()]);
      await vi.waitFor(
        () => {
          expect(stack.wsControl.getActiveIpCount('127.0.0.1')).toBe(0);
          expect(stack.rooms.getTotalPlayers()).toBe(0);
          expect(stack.matchManager.getStats()).toEqual([]);
        },
        { timeout: 2000, interval: 15 },
      );
    } finally {
      for (const s of sockets) {
        if (s.readyState !== WebSocket.CLOSED) s.terminate();
      }
      await stack.shutdown();
    }
  });
});
