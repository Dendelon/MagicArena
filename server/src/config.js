import { resolve } from 'node:path';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST?.trim() || '127.0.0.1';
const logDir = process.env.LOG_DIR?.trim() || 'server/logs';
const rawNetDelay = process.env.NET_DELAY_MS?.trim();
const netDelayMs = rawNetDelay === undefined || rawNetDelay === '' ? 0 : Number(rawNetDelay);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be between 1 and 65535');
}

if (!host || /[\s/\\]/.test(host)) {
  throw new Error('Invalid HOST');
}

if (!logDir || logDir.includes('\0')) {
  throw new Error('Invalid LOG_DIR');
}

if (!Number.isFinite(netDelayMs) || netDelayMs < 0 || netDelayMs > 1000) {
  throw new Error('NET_DELAY_MS must be a finite number between 0 and 1000');
}

export const config = {
  port,
  host,
  logDir: resolve(logDir),
  netDelayMs,
};
