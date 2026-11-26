import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
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
import { collectLiveServerStats } from './performance/serverStats.ts';
import { setupMatchLogs } from './log/matchlog.ts';
import { getReplayPath, listReplays } from './log/replay.ts';
import { startRssProfiler } from './log/rss.ts';

const distDir = resolve(
  fileURLToPath(new URL('../../client/dist/', import.meta.url)),
);

const rooms = new RoomManager();

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

await mkdir(config.logDir, { recursive: true });

const matchLogs = setupMatchLogs(rooms, config.logDir);

const rssProfiler = config.rssProfile
  ? await startRssProfiler(config.logDir)
  : null;

if (rssProfiler) {
  console.log(`RSS log: ${rssProfiler.filePath}`);
}

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
    console.error('HTTP error:', error);

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
});

server.on('error', (error: Error) => {
  console.error('Server error:', error);
  process.exitCode = 1;
});

// Завершення без різкого обриву HTTP-запитів
let stopping = false;

const shutdown = (): void => {
  if (stopping) return;
  stopping = true;

  console.log('Shutting down server...');

  (async () => {
    serverProfiler.shutdown();
    loadProfiler.shutdown();
    await botManager.shutdown();

    const httpClosed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    server.closeIdleConnections();

    matchManager.shutdown();
    const websocketClosed = websocket
      ? websocket.shutdown()
      : Promise.resolve();

    const forceCloseTimer = setTimeout(() => {
      server.closeAllConnections();
    }, 5000);

    forceCloseTimer.unref();

    // Очікуємо завершення HTTP та WebSocket
    await Promise.all([httpClosed, websocketClosed]);

    clearTimeout(forceCloseTimer);

    // Дозаписуємо NDJSON-файли
    await matchLogs.shutdown();
    await rssProfiler?.stop();

    console.log('Server stopped gracefully');
    process.exitCode = 0;
  })().catch((error: unknown) => {
    console.error('Shutdown error:', error);
    process.exitCode = 1;
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(config.port, config.host, () => {
  console.log(`Magic Arena server: http://${config.host}:${config.port}`);
});

