import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION } from '@magicarena/shared';

import {
  createHealthPayload,
  createServerLifecycle,
} from '../src/lifecycle.ts';
import { createLogger, serializeLogError } from '../src/log/logger.ts';
import { rawDataToUtf8 } from '../src/network/rawData.ts';
import { RoomManager } from '../src/rooms.ts';
import { setupWebSocket } from '../src/ws.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const parseJsonLines = (text: string): Array<Record<string, unknown>> =>
  text
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Expected JSON log object');
      }
      const record: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        record[key] = value;
      }
      return record;
    });

describe('Logger and readiness/lifecycle transitions', () => {
  test('pino logger emits JSON lines to stream and respects LOG_LEVEL', () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });

    const logger = createLogger({ level: 'warn', destination: stream });
    logger.info({ event: 'server.started' }, 'server.started');
    logger.fatal(
      { event: 'server.fatal', err: serializeLogError(new Error('boom')) },
      'server.fatal',
    );
    logger.flush();

    const records = parseJsonLines(chunks.join(''));
    expect(records.length).toBe(1);
    const record = records[0];
    expect(record?.level).toBe('fatal');
    expect(record?.event).toBe('server.fatal');
    expect(record?.err).toMatchObject({
      name: 'Error',
      message: 'boom',
    });
  });

  test('tracks /health vs /ready across startup, production build check, and shutdown', async () => {
    const httpServer = createServer();
    const logger = createLogger({ level: 'silent' });
    let buildPresent = false;

    const lifecycle = createServerLifecycle({
      server: httpServer,
      logger,
      isProduction: true,
      clientIndexPath: '/virtual/client/dist/index.html',
      checkFileExists: () => Promise.resolve(buildPresent),
      stopBackgroundServices: () => {},
      shutdownBots: () => Promise.resolve(),
      shutdownWebSocket: () => Promise.resolve(),
      shutdownLogs: () => Promise.resolve(),
    });

    expect(await lifecycle.isReady()).toBe(false);

    lifecycle.markReady();
    expect(await lifecycle.isReady()).toBe(false);

    buildPresent = true;
    expect(await lifecycle.isReady()).toBe(true);

    const exitCode = await lifecycle.shutdown('manual');
    expect(exitCode).toBe(0);
    expect(await lifecycle.isReady()).toBe(false);
    expect(lifecycle.isShuttingDown()).toBe(true);
  });

  test('shutdown is idempotent, clears timers, and handles deadline overrun cleanly', async () => {
    vi.useFakeTimers();

    const httpServer = createServer();
    const logStream = new PassThrough();
    const logChunks: string[] = [];
    logStream.on('data', (chunk: Buffer | string) => {
      logChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    const logger = createLogger({ level: 'info', destination: logStream });

    const exitSpy = vi.fn<(code: number) => void>();
    const stopSpy = vi.fn();
    let botsShutdownCalls = 0;

    const lifecycle = createServerLifecycle({
      server: httpServer,
      logger,
      shutdownDeadlineMs: 2000,
      stopBackgroundServices: stopSpy,
      shutdownBots: () => {
        botsShutdownCalls += 1;
        return Promise.resolve();
      },
      shutdownWebSocket: () => Promise.resolve(),
      shutdownLogs: () => Promise.resolve(),
      onExit: exitSpy,
    });

    lifecycle.markReady();
    const first = lifecycle.shutdown('signal', 'SIGTERM');
    const second = lifecycle.shutdown('signal', 'SIGINT');

    expect(first).toBe(second);
    expect(await first).toBe(0);
    expect(await second).toBe(0);
    expect(botsShutdownCalls).toBe(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);

    // Hung resource triggers deadline timeout and exits with non-zero code 1
    const timeoutExitSpy = vi.fn<(code: number) => void>();
    const forceCleanupSpy = vi.fn();
    const hangingLifecycle = createServerLifecycle({
      server: httpServer,
      logger,
      shutdownDeadlineMs: 150,
      stopBackgroundServices: () => {},
      shutdownBots: () => new Promise<void>(() => {}),
      shutdownWebSocket: () => Promise.resolve(),
      shutdownLogs: () => Promise.resolve(),
      forceCleanup: forceCleanupSpy,
      onExit: timeoutExitSpy,
    });

    hangingLifecycle.markReady();
    const timeoutPromise = hangingLifecycle.shutdown('signal', 'SIGTERM');
    await vi.advanceTimersByTimeAsync(200);
    const timedOutCode = await timeoutPromise;

    expect(timedOutCode).toBe(1);
    expect(forceCleanupSpy).toHaveBeenCalledTimes(1);
    expect(timeoutExitSpy).toHaveBeenCalledWith(1);

    const logEvents = parseJsonLines(logChunks.join('')).map((r) => r.event);
    expect(logEvents).toContain('server.shutdown.started');
    expect(logEvents).toContain('server.shutdown.completed');
    expect(logEvents).toContain('server.shutdown.timeout');
  });

  test('handleFatal logs unknown rejections and errors with exit code 1', async () => {
    const httpServer = createServer();
    const logStream = new PassThrough();
    const logChunks: string[] = [];
    logStream.on('data', (chunk: Buffer | string) => {
      logChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    const logger = createLogger({ level: 'info', destination: logStream });
    const exitSpy = vi.fn<(code: number) => void>();

    const lifecycle = createServerLifecycle({
      server: httpServer,
      logger,
      stopBackgroundServices: () => {},
      shutdownBots: () => Promise.resolve(),
      shutdownWebSocket: () => Promise.resolve(),
      shutdownLogs: () => Promise.resolve(),
      onExit: exitSpy,
    });

    const code = await lifecycle.handleFatal(
      'unhandledRejection',
      'non-error rejection payload',
    );

    expect(code).toBe(1);
    expect(exitSpy).toHaveBeenCalledWith(1);

    const records = parseJsonLines(logChunks.join(''));
    const fatalLog = records.find((r) => r.event === 'server.fatal');
    expect(fatalLog).toBeDefined();
    expect(fatalLog?.source).toBe('unhandledRejection');
    expect(fatalLog?.err).toMatchObject({
      message: 'non-error rejection payload',
    });
  });
});

describe('WebSocket shutdown behavior and /health + /ready integration', () => {
  test('sends shutdown control message before close code 1001 and blocks new upgrades during shutdown', async () => {
    const rooms = new RoomManager();
    rooms.create({ id: 'arcane', name: 'Arcane Ruins', obstacleCount: 0 });

    let shuttingDown = false;
    const httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      if (req.url === '/ready') {
        res.writeHead(shuttingDown ? 503 : 200, {
          'Content-Type': 'application/json',
        });
        res.end(
          JSON.stringify({ status: shuttingDown ? 'not-ready' : 'ready' }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const wsControl = setupWebSocket(httpServer, rooms, { codec: 'binary' });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

    const healthRes = await fetch(`${baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const readyRes = await fetch(`${baseUrl}/ready`);
    expect(readyRes.status).toBe(200);

    const client = new WebSocket(wsUrl);
    await once(client, 'open');

    const frames: string[] = [];
    let closedEvent: { readonly code: number; readonly reason: string } | null =
      null;
    const joinedDone = new Promise<void>((resolve) => {
      client.on('message', (data) => {
        const text = rawDataToUtf8(data);
        frames.push(text);
        const parsed: unknown = JSON.parse(text);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'type' in parsed &&
          parsed.type === 'joined'
        ) {
          resolve();
        }
      });
    });
    const closeDone = new Promise<void>((resolve) => {
      client.once('close', (code, reason) => {
        closedEvent = { code, reason: reason.toString('utf8') };
        resolve();
      });
    });

    client.send(
      JSON.stringify({
        v: PROTOCOL_VERSION,
        type: 'join',
        room: 'arcane',
        name: 'PlayerOne',
      }),
    );
    await joinedDone;

    // Begin shutdown -> mark not ready, notify active client, reject new WS upgrades
    shuttingDown = true;
    const readyDuringShutdown = await fetch(`${baseUrl}/ready`);
    expect(readyDuringShutdown.status).toBe(503);

    const shutdownPromise = wsControl.shutdown();

    const rejectedUpgrade = new Promise<boolean>((resolve) => {
      const lateClient = new WebSocket(wsUrl);
      lateClient.once('error', () => resolve(true));
      lateClient.once('unexpected-response', () => resolve(true));
      lateClient.once('close', () => resolve(true));
    });

    await Promise.all([shutdownPromise, closeDone]);
    expect(await rejectedUpgrade).toBe(true);

    const shutdownFrame = frames
      .map((raw): unknown => JSON.parse(raw))
      .find(
        (msg): msg is { v: number; type: string; reason: string } =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'shutdown',
      );
    expect(shutdownFrame).toEqual({
      v: PROTOCOL_VERSION,
      type: 'shutdown',
      reason: 'Server is shutting down',
    });
    expect(closedEvent).toEqual({
      code: 1001,
      reason: 'Server shutting down',
    });

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  test('server child process exits with non-zero code on fatal startup error (EADDRINUSE)', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, '127.0.0.1', () => resolve());
    });

    const address = blocker.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }

    const child = spawn(process.execPath, ['server/src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(address.port),
        LOG_LEVEL: 'info',
        LOG_DIR: 'server/logs/test-fatal',
        ENABLE_BOTS: '0',
        ENABLE_PROFILE: '0',
        ENABLE_LOAD_TEST: '0',
        RSS_PROFILE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: string[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(
        typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
      );
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });

    await new Promise<void>((resolve) => blocker.close(() => resolve()));

    expect(exitCode).toBe(1);
    const logs = parseJsonLines(stdoutChunks.join(''));
    const fatalRecord = logs.find((entry) => entry.event === 'server.fatal');
    expect(fatalRecord).toBeDefined();
    expect(fatalRecord?.source).toBe('startup');
  });

  test('exposes version, gitSha, and buildId on /health payload', async () => {
    expect(
      createHealthPayload({
        version: '1.0.0',
        gitSha: 'abc1234',
        buildId: 'v1.0.0-42',
      }),
    ).toEqual({
      status: 'ok',
      version: '1.0.0',
      gitSha: 'abc1234',
      buildId: 'v1.0.0-42',
    });

    expect(
      createHealthPayload({
        version: '1.0.0',
        gitSha: null,
        buildId: null,
      }),
    ).toEqual({
      status: 'ok',
      version: '1.0.0',
      gitSha: null,
      buildId: null,
    });

    const probe = createServer();
    await new Promise<void>((resolve) => {
      probe.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = probe.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Expected TCP port');
    }
    const port = addr.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const child = spawn(process.execPath, ['server/src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        GIT_SHA: 'deadbeefcafebabe',
        BUILD_ID: 'v1.0.0-99',
        LOG_LEVEL: 'info',
        LOG_DIR: 'server/logs/test-health',
        ENABLE_BOTS: '0',
        ENABLE_PROFILE: '0',
        ENABLE_LOAD_TEST: '0',
        RSS_PROFILE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: string[] = [];
    let resolvedStarted = false;
    let markStarted: (() => void) | null = null;
    const startedPromise = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stdoutChunks.push(text);
      if (!resolvedStarted && stdoutChunks.join('').includes('server.started')) {
        resolvedStarted = true;
        markStarted?.();
      }
    });

    try {
      await Promise.race([
        startedPromise,
        new Promise<never>((_, reject) => {
          child.once('exit', (code) => {
            reject(new Error(`Server exited early with code ${String(code)}`));
          });
        }),
      ]);

      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      const body: unknown = await healthRes.json();
      expect(body).toEqual({
        status: 'ok',
        version: '1.0.0',
        gitSha: 'deadbeefcafebabe',
        buildId: 'v1.0.0-99',
      });
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    }
  });
});
