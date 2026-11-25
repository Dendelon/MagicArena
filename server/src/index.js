import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { RoomManager } from './rooms.js';
import { setupWebSocket } from './ws.js';

const distDir = resolve(fileURLToPath(new URL('../../client/dist/', import.meta.url)));

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

const mimeTypes = {
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

const sendJson = (res, status, data) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });

  res.end(JSON.stringify(data));
};

const readJsonBody = async (req) => {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;

    if (total > 16 * 1024) {
      const error = new Error('Request body too large');
      error.status = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON');
    error.status = 400;
    throw error;
  }
};

const serveStatic = async (pathname, req, res) => {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);

  const filePath = resolve(distDir, relativePath);

  // Захист від виходу за межі client/dist
  if (!filePath.startsWith(`${distDir}${sep}`)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  let info;

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
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  await pipeline(createReadStream(filePath), res);
};

const handleRequest = async (req, res) => {
  const rawPath = (req.url ?? '/').split('?')[0];

  let decodedPath;

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

  if (pathname === '/api/rooms' && req.method === 'GET') {
    sendJson(res, 200, {
      rooms: rooms.list(),
    });
    return;
  }

  if (pathname === '/api/rooms' && req.method === 'POST') {
    const body = await readJsonBody(req);

    if (
      !body ||
      typeof body.name !== 'string' ||
      body.name.trim().length < 2 ||
      body.name.trim().length > 40 ||
      !Number.isInteger(body.obstacleCount) ||
      body.obstacleCount < 0 ||
      body.obstacleCount > 3
    ) {
      sendJson(res, 400, {
        error: 'Invalid room data',
      });
      return;
    }

    const room = rooms.create({
      name: body.name.trim(),
      obstacleCount: body.obstacleCount,
      maxPlayers: 4,
    });

    sendJson(res, 201, room.getInfo());
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
  void handleRequest(req, res).catch((error) => {
    console.error('HTTP error:', error);

    if (res.destroyed || res.headersSent) {
      res.destroy();
      return;
    }

    sendJson(res, error.status ?? 500, {
      error: error.status ? error.message : 'Internal server error',
    });
  });
});

const websocket = setupWebSocket(server, rooms);

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exitCode = 1;
});

// Завершення без різкого обриву HTTP-запитів
let stopping = false;

const shutdown = () => {
  if (stopping) return;
  stopping = true;

  console.log('Shutting down server...');

  websocket.shutdown();

  server.close((error) => {
    process.exitCode = error ? 1 : 0;
    if (error) console.error(error);
  });

  server.closeIdleConnections();

  setTimeout(() => {
    server.closeAllConnections();
  }, 5000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await mkdir(config.logDir, { recursive: true });

server.listen(config.port, config.host, () => {
  console.log(`Magic Arena server: http://${config.host}:${config.port}`);
});
