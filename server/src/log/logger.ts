import { pino } from 'pino';
import type { DestinationStream, Logger } from 'pino';

import type { LogLevel } from '../config.ts';

export interface SerializedLogError {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
}

export interface CreateLoggerOptions {
  readonly level?: LogLevel;
  readonly destination?: DestinationStream;
}

export type AppLogger = Logger;

const DEFAULT_FLUSH_TIMEOUT_MS = 500;

/**
 * Safely serializes an unknown thrown value into structured `message`, `name`, and `stack` fields.
 */
export const serializeLogError = (error: unknown): SerializedLogError => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }

  let message: string;
  if (typeof error === 'string') {
    message = error;
  } else {
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }

  return { message };
};

/**
 * Creates a structured stdout JSON-lines pino logger for server lifecycle events.
 */
export const createLogger = ({
  level = 'info',
  destination,
}: CreateLoggerOptions = {}): AppLogger => {
  const stream = destination ?? pino.destination({ dest: 1, sync: false });

  return pino(
    {
      level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label: string) => ({ level: label }),
      },
    },
    stream,
  );
};

/**
 * Flushes buffered pino log records before process termination, bounded by a timeout.
 */
export const flushLogger = (
  logger: Pick<AppLogger, 'flush'>,
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
): Promise<void> =>
  new Promise<void>((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, timeoutMs);
    timer.unref();

    logger.flush(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });

