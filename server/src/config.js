import { resolve } from 'node:path';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST?.trim() || '127.0.0.1';
const logDir = process.env.LOG_DIR?.trim() || 'server/logs';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be between 1 and 65535');
}

if (!host || /[\s/\\]/.test(host)) {
  throw new Error('Invalid HOST');
}

if (!logDir || logDir.includes('\0')) {
  throw new Error('Invalid LOG_DIR');
}

export const config = {
  port,
  host,
  logDir: resolve(logDir),
};
