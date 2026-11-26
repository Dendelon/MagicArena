import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

import { config } from './config.ts';
import { HttpError, hasErrorCode } from './errors.ts';
import { RoomManager } from './rooms.ts';
import { MatchManager } from './game/MatchManager.ts';
import { setupWebSocket } from './ws.ts';
import { BotManager } from './bots/BotManager.ts';
import { ServerProfiler } from './performance/ServerProfiler.ts';
import { LoadProfiler } from './performance/LoadProfiler.ts';
import { ServerMetrics } from './performance/ServerMetrics.ts';
import { collectLiveServerStats } from './performance/serverStats.ts';
import { createLogger, serializeLogError } from './log/logger.ts';
import { setupMatchLogs } from './log/matchlog.ts';
import { getReplayPath, listReplays } from './log/replay.ts';
import { startRssProfiler } from './log/rss.ts';
import { createServerLifecycle } from './lifecycle.ts';

const readServerPackageVersion = (): string => {
  try {
    const raw = readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    );
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
  } catch {
    // Fallback when package.json cannot be read.
  }
  return '0.0.0';
};

const logger = createLogger({ level: config.logLevel });
const serverVersion = readServerPackageVersion();

const distDir = resolve(
  fileURLToPath(new URL('../../client/dist/', import.meta.url)),
);
const clientIndexPath = join(distDir, 'index.html');

const rooms = new RoomManager({ logger });

rooms.create({
  id: 'arcane',
  name: 'Arcane Ruins',
  obstacleCount: 3,
  maxPlayers: 4,
});

rooms.create({
  id: 'training',
  name: 'Training Grounds',
  obstacleCount: 2,
  maxPlayers: 4,
});

if (config.enableBots) {
  rooms.create({
    id: 'profiling',
    name: 'Performance Arena',
    obstacleCount: 3,
    maxPlayers: 9,
  });
}

if (config.enableLoadTest) {
  rooms.create({
    id: 'load-test',
    name: 'Load Test Arena',
    obstacleCount: 3,
    maxPlayers: 128,
  });
}

let matchLogs: ReturnType<typeof setupMatchLogs> | null = null;
let rssProfiler: Awaited<ReturnType<typeof startRssProfiler>> | null = null;

const mimeTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

const sendJson = (
  res: ServerResponse,
  status: number,
  data: unknown,
): void => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  res.end(JSON.stringify(data));
};

const readJsonBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const raw of req) {
    const chunk: unknown = raw;

    if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
      throw new HttpError('Invalid request body', 400);
    }

    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;

    total += buffer.byteLength;

    if (total > 16 * 1024) {
      throw new HttpError('Request body too large', 413);
    }

    chunks.push(buffer);
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.concat(chunks).toString('utf8'),
    );

    return parsed;
  } catch {
    throw new HttpError('Invalid JSON', 400);
  }
};

const CreateRoomSchema = z.object({
  name: z.string().trim().min(2).max(40),
  obstacleCount: z.number().int().min(0).max(3),
});

const CreateBotsSchema = z.strictObject({
  count: z.number().int().min(1).max(8),
  seed: z.number().int().min(0).max(0xffffffff).default(1337),
});

const ProfileStartSchema = z.strictObject({
  durationMs: z.number().int().min(100).max(300_000).default(30_000),
});

const LoadTestStartSchema = z.strictObject({
  durationMs: z.number().int().min(1000).max(600_000).default(60_000),
  expectedClients: z.number().int().min(1).max(128),
});

const serveStatic = async (
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);

  const filePath = resolve(distDir, relativePath);

  // Захист від виходу за межі client/dist
  if (!filePath.startsWith(`${distDir}${sep}`)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  let info: Stats;

  try {
    info = await stat(filePath);
  } catch {
    sendJson(res, 404, { error: 'File not found' });
    return;
  }

  if (!info.isFile()) {
    sendJson(res, 404, { error: 'File not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    ...(extname(filePath) === '.html' ? { 'Cache-Control': 'no-store' } : {}),
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  await pipeline(createReadStream(filePath), res);
};

const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const rawPath = (req.url ?? '/').split('?')[0] ?? '/';

  let decodedPath: string;

  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    sendJson(res, 400, { error: 'Invalid URL' });
    return;
  }

  // Перевіряємо шлях до нормалізації URL
  const segments = decodedPath.replaceAll('\\', '/').split('/');

  if (segments.includes('..') || decodedPath.includes('\0')) {
    sendJson(res, 403, { error: 'Forbidden path' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/health' && req.method === 'GET') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (pathname === '/ready' && req.method === 'GET') {
    const readyNow = await lifecycle.isReady();
    sendJson(res, readyNow ? 200 : 503, {
      status: readyNow ? 'ready' : 'not-ready',
    });
    return;
  }

  // Лише для демонстрації Event Loop у ЛР №4
  if (
    pathname === '/api/slow' &&
    req.method === 'GET' &&
    config.enableSlowDemo
  ) {
    const started = performance.now();

    // Навмисне синхронне блокування на 300 мс
    while (performance.now() - started < 300) {
      // Busy loop
    }

    sendJson(res, 200, {
      blockedMs: Math.round(performance.now() - started),
    });

    return;
  }

  if (pathname === '/api/rooms' && req.method === 'GET') {
    sendJson(res, 200, {
      rooms: rooms.list(),
    });
    return;
  }

  if (pathname === '/api/stats' && req.method === 'GET') {
    // Returns matches plus current memoryUsage() and process-cumulative ELU.
    sendJson(res, 200, collectLiveServerStats(matchManager.getStats()));
    return;
  }

  if (pathname === '/metrics' && req.method === 'GET') {
    sendJson(
      res,
      200,
      metrics.getMetrics({
        shuttingDown: lifecycle.isShuttingDown(),
        matches: matchManager.getStats(),
        roomManager: rooms,
      }),
    );
    return;
  }

  if (pathname === '/api/rooms' && req.method === 'POST') {
    const body = await readJsonBody(req);

    const result = CreateRoomSchema.safeParse(body);

    if (!result.success) {
      sendJson(res, 400, {
        error: 'Invalid room data',
      });
      return;
    }

    const room = rooms.create({
      name: result.data.name,
      obstacleCount: result.data.obstacleCount,
      maxPlayers: 4,
    });

    sendJson(res, 201, room.getInfo());
    return;
  }

  // Отримати список збережених матчів
  if (pathname === '/api/replays' && req.method === 'GET') {
    const replays = await listReplays(config.logDir);

    sendJson(res, 200, { replays });
    return;
  }

  // Завантажити NDJSON-файл потоком
  if (pathname.startsWith('/api/replays/') && req.method === 'GET') {
    const id = pathname.slice('/api/replays/'.length);
    const filePath = getReplayPath(config.logDir, id);

    if (!filePath) {
      sendJson(res, 400, { error: 'Invalid replay ID' });
      return;
    }

    let info: Stats;

    try {
      info = await stat(filePath);
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        sendJson(res, 404, { error: 'Replay not found' });
        return;
      }

      throw error instanceof Error ? error : new Error(String(error));
    }

    if (!info.isFile()) {
      sendJson(res, 404, { error: 'Replay not found' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    });

    if (info.size === 0) {
      res.end();
      return;
    }

    await pipeline(
      createReadStream(filePath, {
        end: info.size - 1,
      }),
      res,
    );

    return;
  }

  const botsMatch = /^\/api\/rooms\/([^/]+)\/bots$/.exec(pathname);

  if (botsMatch?.[1]) {
    if (!config.enableBots) {
      sendJson(res, 404, { error: 'Bots API is disabled' });
      return;
    }

    const roomId = decodeURIComponent(botsMatch[1]);

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = CreateBotsSchema.safeParse(body);

      if (!result.success) {
        sendJson(res, 400, { error: 'Invalid bots payload' });
        return;
      }

      const bots = await botManager.addBots(
        roomId,
        result.data.count,
        result.data.seed,
      );
      sendJson(res, 201, { roomId, bots });
      return;
    }

    if (req.method === 'GET') {
      const bots = botManager.listBots(roomId);
      sendJson(res, 200, { roomId, bots });
      return;
    }

    if (req.method === 'DELETE') {
      const removed = await botManager.removeBots(roomId);
      sendJson(res, 200, { roomId, removed });
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (pathname === '/api/profile/start' && req.method === 'POST') {
    if (!config.enableProfile) {
      sendJson(res, 404, { error: 'Profiling API is disabled' });
      return;
    }

    const body = await readJsonBody(req);
    const result = ProfileStartSchema.safeParse(body);

    if (!result.success) {
      sendJson(res, 400, { error: 'Invalid profile start payload' });
      return;
    }

    serverProfiler.start(result.data.durationMs);
    sendJson(res, 202, {
      status: 'running',
      durationMs: result.data.durationMs,
    });
    return;
  }

  if (pathname === '/api/profile/result' && req.method === 'GET') {
    if (!config.enableProfile) {
      sendJson(res, 404, { error: 'Profiling API is disabled' });
      return;
    }

    sendJson(res, 200, serverProfiler.getState());
    return;
  }

  if (pathname === '/api/load-test/start' && req.method === 'POST') {
    if (!config.enableLoadTest) {
      sendJson(res, 404, { error: 'Load test API is disabled' });
      return;
    }

    if (config.host !== '127.0.0.1') {
      sendJson(res, 403, { error: 'Load test requires loopback host' });
      return;
    }

    const loadRoom = rooms.get('load-test');
    if (!loadRoom) {
      sendJson(res, 404, { error: 'Load test room not found' });
      return;
    }

    const body = await readJsonBody(req);
    const result = LoadTestStartSchema.safeParse(body);

    if (!result.success) {
      sendJson(res, 400, { error: 'Invalid load test start payload' });
      return;
    }

    if (loadRoom.players.size !== result.data.expectedClients) {
      sendJson(res, 409, {
        error: `Expected ${result.data.expectedClients} connected clients, found ${loadRoom.players.size}`,
      });
      return;
    }

    loadProfiler.start(result.data.durationMs, result.data.expectedClients);
    sendJson(res, 202, {
      status: 'running',
      durationMs: result.data.durationMs,
      expectedClients: result.data.expectedClients,
    });
    return;
  }

  if (pathname === '/api/load-test/result' && req.method === 'GET') {
    if (!config.enableLoadTest) {
      sendJson(res, 404, { error: 'Load test API is disabled' });
      return;
    }

    sendJson(res, 200, loadProfiler.getState());
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Unknown API route' });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  await serveStatic(decodedPath, req, res);
};

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error: unknown) => {
    if (error instanceof HttpError && error.status < 500) {
      logger.warn(
        {
          event: 'http.request.rejected',
          status: error.status,
          method: req.method ?? null,
          path: (req.url ?? '/').split('?')[0] ?? '/',
          message: error.message,
        },
        'http.request.rejected',
      );
    } else {
      logger.error(
        {
          event: 'http.error',
          method: req.method ?? null,
          path: (req.url ?? '/').split('?')[0] ?? '/',
          err: serializeLogError(error),
        },
        'http.error',
      );
    }

    if (res.destroyed || res.headersSent) {
      res.destroy();
      return;
    }

    const status = error instanceof HttpError ? error.status : 500;

    sendJson(res, status, {
      error:
        error instanceof HttpError ? error.message : 'Internal server error',
    });
  });
});

let websocket: ReturnType<typeof setupWebSocket> | null = null;
let matchManagerRef: MatchManager | null = null;

const serverProfiler = new ServerProfiler({
  getPoolStats: () => matchManagerRef?.getPoolStats() ?? null,
});
const loadProfiler = new LoadProfiler();
const metrics = new ServerMetrics({
  runtime: {
    version: serverVersion,
    nodeVersion: process.version,
    nodeEnv: config.nodeEnv,
    gitSha: config.gitSha,
    buildId: config.buildId,
  },
});

const botManager = new BotManager({
  roomManager: rooms,
  getWsUrl: () => {
    const address = server.address();
    const port =
      address && typeof address !== 'string' ? address.port : config.port;
    return `ws://${config.host}:${port}/ws`;
  },
});

const matchManager = new MatchManager(rooms, {
  onSnapshot: (match) => {
    websocket?.broadcastSnapshot(match);
  },
  profiler: serverProfiler,
  loadProfiler,
  metrics,
});
matchManagerRef = matchManager;

websocket = setupWebSocket(server, rooms, {
  matchManager,
  delayMs: config.netDelayMs,
  jitterMs: config.netJitterMs,
  dropRate: config.netDropRate,
  codec: config.netCodec,
  profiler: serverProfiler,
  loadProfiler,
  metrics,
  logger,
});

const lifecycle = createServerLifecycle({
  server,
  logger,
  isProduction: config.isProduction,
  clientIndexPath,
  stopBackgroundServices: () => {
    serverProfiler.shutdown();
    loadProfiler.shutdown();
    metrics.shutdown();
    matchManager.shutdown();
  },
  shutdownBots: () => botManager.shutdown(),
  shutdownWebSocket: () => (websocket ? websocket.shutdown() : Promise.resolve()),
  shutdownLogs: async () => {
    await matchLogs?.shutdown();
    await rssProfiler?.stop();
  },
  forceCleanup: () => {
    serverProfiler.shutdown();
    loadProfiler.shutdown();
    metrics.shutdown();
    matchManager.shutdown();
  },
  onExit: (code) => {
    process.exit(code);
  },
});

const triggerShutdown = (signal: NodeJS.Signals): void => {
  lifecycle.shutdown('signal', signal).catch((error: unknown) => {
    console.error('Unhandled shutdown error:', error);
    process.exit(1);
  });
};

const triggerFatal = (
  source: 'uncaughtException' | 'unhandledRejection' | 'httpServer' | 'startup',
  error: unknown,
): void => {
  lifecycle.handleFatal(source, error).catch((fatalError: unknown) => {
    console.error('Fatal handler failed:', fatalError);
    process.exit(1);
  });
};

const attachRuntimeHttpErrorHandler = (): void => {
  server.on('error', (error: Error) => {
    triggerFatal('httpServer', error);
  });
};

process.on('SIGINT', () => {
  triggerShutdown('SIGINT');
});
process.on('SIGTERM', () => {
  triggerShutdown('SIGTERM');
});
process.on('uncaughtException', (error: Error) => {
  triggerFatal('uncaughtException', error);
});
process.on('unhandledRejection', (reason: unknown) => {
  triggerFatal('unhandledRejection', reason);
});

const startServer = async (): Promise<void> => {
  await mkdir(config.logDir, { recursive: true });
  matchLogs = setupMatchLogs(rooms, config.logDir, logger);
  rssProfiler = config.rssProfile ? await startRssProfiler(config.logDir) : null;

  await new Promise<void>((resolveListen, rejectListen) => {
    const onListenError = (err: Error): void => {
      server.off('listening', onListening);
      rejectListen(err);
    };
    const onListening = (): void => {
      server.off('error', onListenError);
      attachRuntimeHttpErrorHandler();
      resolveListen();
    };
    server.once('error', onListenError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });

  lifecycle.markReady();
  logger.info(
    {
      event: 'server.started',
      host: config.host,
      port: config.port,
      nodeEnv: config.nodeEnv,
      logLevel: config.logLevel,
    },
    'server.started',
  );
};

try {
  await startServer();
} catch (error: unknown) {
  await lifecycle.handleFatal('startup', error);
}

