import { once } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@magicarena/shared';

import { HttpError } from '../src/errors.ts';
import { createLogger } from '../src/log/logger.ts';
import {
  IpConnectionLimiter,
  normalizeClientIp,
} from '../src/network/ipLimit.ts';
import {
  normalizeAllowedOrigin,
  validateWebSocketOrigin,
} from '../src/network/origin.ts';
import { rawDataToUtf8 } from '../src/network/rawData.ts';
import { RoomManager } from '../src/rooms.ts';
import { setupWebSocket } from '../src/ws.ts';

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

const expectUpgradeRejected = (
  wsUrl: string,
  headers?: Record<string, string>,
): Promise<number | null> =>
  new Promise((resolve, reject) => {
    const client = new WebSocket(
      wsUrl,
      headers !== undefined ? { headers } : undefined,
    );
    let settled = false;

    client.once('unexpected-response', (_req, res) => {
      if (settled) return;
      settled = true;
      client.terminate();
      resolve(res.statusCode ?? null);
    });
    client.once('open', () => {
      if (settled) return;
      settled = true;
      client.terminate();
      reject(new Error('Expected WebSocket handshake to be rejected'));
    });
    client.once('error', () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
  });

const joinWsPlayer = async (
  wsUrl: string,
  roomId: string,
  name: string,
  headers?: Record<string, string>,
): Promise<{
  readonly socket: WebSocket;
  readonly joined: boolean;
  readonly closeCode: number | null;
}> => {
  const socket = new WebSocket(
    wsUrl,
    headers !== undefined ? { headers } : undefined,
  );
  await once(socket, 'open');

  return new Promise((resolve, reject) => {
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
        resolve({ socket, joined: true, closeCode: null });
      }
    };
    const onClose = (code: number): void => {
      cleanup();
      resolve({ socket, joined: false, closeCode: code });
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

describe('Origin normalization and IPv4/IPv6 normalization', () => {
  test('enforces exact Origin match and rejects prefix/path/wildcard tricks', () => {
    expect(normalizeAllowedOrigin('*')).toBeNull();
    expect(normalizeAllowedOrigin('https://arena.example.com/app')).toBeNull();
    expect(normalizeAllowedOrigin('https://arena.example.com/')).toBeNull();
    expect(normalizeAllowedOrigin('HTTP://Arena.Example.com:8443')).toBe(
      'http://arena.example.com:8443',
    );

    const allowlist = new Set(['http://localhost:5173']);
    expect(
      validateWebSocketOrigin('http://localhost:5173', allowlist, false)
        .allowed,
    ).toBe(true);
    expect(
      validateWebSocketOrigin('http://localhost:5173.evil.com', allowlist, false)
        .allowed,
    ).toBe(false);
    expect(
      validateWebSocketOrigin('http://localhost:51730', allowlist, false)
        .allowed,
    ).toBe(false);
    expect(
      validateWebSocketOrigin('https://localhost:5173', allowlist, false)
        .allowed,
    ).toBe(false);
    expect(validateWebSocketOrigin(undefined, allowlist, false)).toEqual({
      allowed: false,
      reason: 'missing_origin',
      origin: null,
    });
    expect(validateWebSocketOrigin(undefined, allowlist, true)).toEqual({
      allowed: true,
      origin: null,
    });
  });

  test('normalizes IPv4-mapped IPv6 addresses into canonical IPv4 bucket', () => {
    expect(normalizeClientIp('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeClientIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeClientIp('::FFFF:10.0.0.42')).toBe('10.0.0.42');
    expect(normalizeClientIp('2001:DB8::1%eth0')).toBe('2001:db8::1');
    expect(normalizeClientIp('not-an-ip')).toBeNull();

    const limiter = new IpConnectionLimiter(2);
    expect(limiter.tryAcquire('127.0.0.1')).toBe(true);
    expect(limiter.tryAcquire('127.0.0.1')).toBe(true);
    expect(limiter.tryAcquire('127.0.0.1')).toBe(false);
    limiter.release('127.0.0.1');
    limiter.release('127.0.0.1');
    expect(limiter.totalTrackedIps()).toBe(0);
  });
});

describe('WebSocket Origin, IP connection limit, and Room/Player limits integration', () => {
  test('enforces Origin allowlist, IP connection limit without counter leaks, and logs security events', async () => {
    const logStream = new PassThrough();
    const logChunks: string[] = [];
    logStream.on('data', (chunk: Buffer | string) => {
      logChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    const logger = createLogger({ level: 'info', destination: logStream });
    const rooms = new RoomManager({ logger });
    rooms.create({ id: 'sec-room', name: 'Security Arena', obstacleCount: 0 });

    const httpServer = createServer();
    const wsControl = setupWebSocket(httpServer, rooms, {
      codec: 'binary',
      logger,
      allowedOrigins: ['http://localhost:5173'],
      allowMissingOrigin: false,
      maxConnectionsPerIp: 2,
    });

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
      // 1. Disallowed, prefix-spoofed, and missing Origin rejected with HTTP 403 before WS connection state
      expect(
        await expectUpgradeRejected(wsUrl, { Origin: 'https://evil.example' }),
      ).toBe(403);
      expect(
        await expectUpgradeRejected(wsUrl, {
          Origin: 'http://localhost:5173.evil.example',
        }),
      ).toBe(403);
      expect(await expectUpgradeRejected(wsUrl)).toBe(403);
      expect(wsControl.getActiveIpCount('127.0.0.1')).toBe(0);

      // 2. Allowed Origin connections up to IP limit = 2 (spoofing X-Forwarded-For must NOT bypass)
      const c1 = await joinWsPlayer(wsUrl, 'sec-room', 'P1', {
        Origin: 'http://localhost:5173',
        'X-Forwarded-For': '203.0.113.10',
      });
      sockets.push(c1.socket);
      expect(c1.joined).toBe(true);

      const c2 = await joinWsPlayer(wsUrl, 'sec-room', 'P2', {
        Origin: 'http://localhost:5173',
        'X-Forwarded-For': '203.0.113.11',
      });
      sockets.push(c2.socket);
      expect(c2.joined).toBe(true);
      expect(wsControl.getActiveIpCount('::ffff:127.0.0.1')).toBe(2);

      // 3rd concurrent connection from same IP exceeds limit -> HTTP 429
      expect(
        await expectUpgradeRejected(wsUrl, {
          Origin: 'http://localhost:5173',
          'X-Forwarded-For': '203.0.113.12',
        }),
      ).toBe(429);
      expect(wsControl.getActiveIpCount('127.0.0.1')).toBe(2);

      // 3. Releasing one connection frees slot for a replacement connection
      await new Promise<void>((resolve) => {
        c1.socket.once('close', () => resolve());
        c1.socket.close(1000, 'disconnect');
      });
      await vi.waitFor(
        () => {
          expect(wsControl.getActiveIpCount('127.0.0.1')).toBe(1);
        },
        { timeout: 2000, interval: 10 },
      );

      const c3 = await joinWsPlayer(wsUrl, 'sec-room', 'P3', {
        Origin: 'http://localhost:5173',
      });
      sockets.push(c3.socket);
      expect(c3.joined).toBe(true);
      expect(wsControl.getActiveIpCount('127.0.0.1')).toBe(2);

      // Clean close / abrupt terminate leaves zero leaked IP counts
      await new Promise<void>((resolve) => {
        c2.socket.once('close', () => resolve());
        c2.socket.terminate();
      });
      await new Promise<void>((resolve) => {
        c3.socket.once('close', () => resolve());
        c3.socket.close(1000, 'done');
      });
      await vi.waitFor(
        () => {
          expect(wsControl.getActiveIpCount('127.0.0.1')).toBe(0);
        },
        { timeout: 2000, interval: 10 },
      );

      logger.flush();
      const events = parseJsonLines(logChunks.join('')).map(
        (entry) => entry.event,
      );
      expect(events).toContain('connection.origin.rejected');
      expect(events).toContain('connection.ip.limit.reached');
    } finally {
      for (const s of sockets) {
        if (s.readyState !== WebSocket.CLOSED) {
          s.terminate();
        }
      }
      await wsControl.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  test('enforces configured room limit, per-room player limit, and server-wide maxTotalPlayers', async () => {
    const logStream = new PassThrough();
    const logChunks: string[] = [];
    logStream.on('data', (chunk: Buffer | string) => {
      logChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    const logger = createLogger({ level: 'info', destination: logStream });
    const rooms = new RoomManager({
      maxRooms: 2,
      defaultMaxPlayersPerRoom: 2,
      maxTotalPlayers: 3,
      logger,
    });

    rooms.create({ id: 'room-a', name: 'Room A', obstacleCount: 0 });
    rooms.create({ id: 'room-b', name: 'Room B', obstacleCount: 0 });

    expect(() =>
      rooms.create({ id: 'room-c', name: 'Room C', obstacleCount: 0 }),
    ).toThrow(HttpError);

    const httpServer = createServer();
    const wsControl = setupWebSocket(httpServer, rooms, {
      codec: 'binary',
      logger,
      allowMissingOrigin: true,
      maxConnectionsPerIp: 10,
    });

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
      const a1 = await joinWsPlayer(wsUrl, 'room-a', 'A1');
      const a2 = await joinWsPlayer(wsUrl, 'room-a', 'A2');
      sockets.push(a1.socket, a2.socket);
      expect(a1.joined && a2.joined).toBe(true);

      // Per-room cap = 2 rejects 3rd player in room-a
      const a3 = await joinWsPlayer(wsUrl, 'room-a', 'A3');
      sockets.push(a3.socket);
      expect(a3.joined).toBe(false);
      expect(a3.closeCode).toBe(4003);

      // Server total cap = 3 allows 1st player in room-b, rejects 2nd player in room-b (total=4 > 3)
      const b1 = await joinWsPlayer(wsUrl, 'room-b', 'B1');
      sockets.push(b1.socket);
      expect(b1.joined).toBe(true);

      const b2 = await joinWsPlayer(wsUrl, 'room-b', 'B2');
      sockets.push(b2.socket);
      expect(b2.joined).toBe(false);
      expect(b2.closeCode).toBe(4003);

      logger.flush();
      const events = parseJsonLines(logChunks.join('')).map(
        (entry) => entry.event,
      );
      expect(events).toContain('room.limit.reached');
      expect(events).toContain('room.player.limit.reached');
    } finally {
      for (const s of sockets) {
        if (s.readyState !== WebSocket.CLOSED) {
          s.terminate();
        }
      }
      await wsControl.shutdown();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

