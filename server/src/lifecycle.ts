import { stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';

import { flushLogger, serializeLogError, type AppLogger } from './log/logger.ts';

export const DEFAULT_SHUTDOWN_DEADLINE_MS = 8000;

export interface HealthMetadata {
  readonly version: string;
  readonly gitSha: string | null;
  readonly buildId: string | null;
}

export interface HealthPayload extends HealthMetadata {
  readonly status: 'ok';
}

export const createHealthPayload = (metadata: HealthMetadata): HealthPayload => ({
  status: 'ok',
  version: metadata.version,
  gitSha: metadata.gitSha,
  buildId: metadata.buildId,
});

export type ShutdownTrigger = 'signal' | 'fatal' | 'manual';
export type FatalSource =
  | 'uncaughtException'
  | 'unhandledRejection'
  | 'httpServer'
  | 'startup';

export interface ServerLifecycleOptions {
  readonly server: Pick<
    Server,
    'listening' | 'close' | 'closeIdleConnections' | 'closeAllConnections'
  >;
  readonly logger: Pick<AppLogger, 'info' | 'warn' | 'error' | 'fatal' | 'flush'>;
  readonly isProduction?: boolean;
  readonly clientIndexPath?: string;
  readonly checkFileExists?: (filePath: string) => Promise<boolean>;
  readonly shutdownDeadlineMs?: number;
  readonly onStopAccepting?: () => void;
  readonly stopBackgroundServices: () => void;
  readonly shutdownBots: () => Promise<void>;
  readonly shutdownWebSocket: () => Promise<void>;
  readonly shutdownLogs: () => Promise<void>;
  readonly forceCleanup?: () => void;
  readonly onExit?: (code: number) => void;
}

export interface ServerLifecycle {
  readonly markReady: () => void;
  readonly markNotReady: () => void;
  readonly isShuttingDown: () => boolean;
  readonly isReady: () => Promise<boolean>;
  readonly shutdown: (
    trigger: ShutdownTrigger,
    signal?: NodeJS.Signals,
  ) => Promise<number>;
  readonly handleFatal: (
    source: FatalSource,
    error: unknown,
  ) => Promise<number>;
}

const defaultCheckFileExists = async (filePath: string): Promise<boolean> => {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
};

/**
 * Coordinates server readiness state, idempotent time-bounded graceful shutdown,
 * and fatal error handling independently of global `process.exit()` calls.
 */
export const createServerLifecycle = (
  options: ServerLifecycleOptions,
): ServerLifecycle => {
  const {
    server,
    logger,
    isProduction = false,
    clientIndexPath = '',
    checkFileExists = defaultCheckFileExists,
    shutdownDeadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS,
    onStopAccepting,
    stopBackgroundServices,
    shutdownBots,
    shutdownWebSocket,
    shutdownLogs,
    forceCleanup,
    onExit,
  } = options;

  let ready = false;
  let shuttingDown = false;
  let fatalTriggered = false;
  let fatalLogged = false;
  let exitCalled = false;
  let activeShutdown: Promise<number> | null = null;

  const invokeExitOnce = (code: number): number => {
    if (!exitCalled) {
      exitCalled = true;
      onExit?.(code);
    }
    return code;
  };

  const closeHttpServer = (): Promise<void> => {
    if (!server.listening) {
      return Promise.resolve();
    }

    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    server.closeIdleConnections();
    return closed;
  };

  const shutdown = (
    trigger: ShutdownTrigger,
    signal?: NodeJS.Signals,
  ): Promise<number> => {
    if (activeShutdown !== null) {
      return activeShutdown;
    }

    const startedAt = performance.now();
    shuttingDown = true;
    ready = false;
    onStopAccepting?.();

    logger.info(
      {
        event: 'server.shutdown.started',
        trigger,
        ...(signal !== undefined ? { signal } : {}),
      },
      'server.shutdown.started',
    );

    const runShutdown = async (): Promise<number> => {
      let finished = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;

      const deadlinePromise = new Promise<number>((resolve) => {
        deadlineTimer = setTimeout(() => {
          if (finished) return;
          finished = true;

          try {
            server.closeAllConnections();
          } catch {
            // Ignore connection teardown errors during deadline overrun.
          }
          try {
            forceCleanup?.();
          } catch {
            // Ignore forced cleanup errors during deadline overrun.
          }

          logger.error(
            {
              event: 'server.shutdown.timeout',
              deadlineMs: shutdownDeadlineMs,
              durationMs: Math.round(performance.now() - startedAt),
            },
            'server.shutdown.timeout',
          );

          flushLogger(logger).then(
            () => {
              resolve(invokeExitOnce(1));
            },
            () => {
              resolve(invokeExitOnce(1));
            },
          );
        }, shutdownDeadlineMs);
      });

      const gracefulPromise = (async (): Promise<number> => {
        try {
          // Stop accepting new HTTP connections and block WS upgrades immediately.
          const httpClosed = closeHttpServer();
          const websocketClosed = shutdownWebSocket();

          stopBackgroundServices();

          await Promise.all([httpClosed, websocketClosed, shutdownBots()]);
          await shutdownLogs();

          if (finished) {
            return 1;
          }
          finished = true;
          if (deadlineTimer !== null) {
            clearTimeout(deadlineTimer);
            deadlineTimer = null;
          }

          const exitCode = fatalTriggered ? 1 : 0;
          logger.info(
            {
              event: 'server.shutdown.completed',
              durationMs: Math.round(performance.now() - startedAt),
              exitCode,
            },
            'server.shutdown.completed',
          );

          await flushLogger(logger);
          return invokeExitOnce(exitCode);
        } catch (error: unknown) {
          if (finished) {
            return 1;
          }
          finished = true;
          if (deadlineTimer !== null) {
            clearTimeout(deadlineTimer);
            deadlineTimer = null;
          }

          try {
            server.closeAllConnections();
          } catch {
            // Ignore forced HTTP termination error during failed shutdown.
          }
          try {
            forceCleanup?.();
          } catch {
            // Ignore forced cleanup error during failed shutdown.
          }

          logger.error(
            {
              event: 'server.shutdown.failed',
              durationMs: Math.round(performance.now() - startedAt),
              err: serializeLogError(error),
            },
            'server.shutdown.failed',
          );

          await flushLogger(logger);
          return invokeExitOnce(1);
        }
      })();

      return Promise.race([gracefulPromise, deadlinePromise]);
    };

    activeShutdown = runShutdown();
    return activeShutdown;
  };

  const handleFatal = async (
    source: FatalSource,
    error: unknown,
  ): Promise<number> => {
    fatalTriggered = true;
    ready = false;

    if (!fatalLogged) {
      fatalLogged = true;
      logger.fatal(
        {
          event: 'server.fatal',
          source,
          err: serializeLogError(error),
        },
        'server.fatal',
      );
    }

    const code = await shutdown('fatal');
    if (code === 0) {
      await flushLogger(logger);
      return invokeExitOnce(1);
    }
    return code;
  };

  return {
    markReady: () => {
      if (!shuttingDown && !fatalTriggered) {
        ready = true;
      }
    },
    markNotReady: () => {
      ready = false;
    },
    isShuttingDown: () => shuttingDown,
    isReady: async (): Promise<boolean> => {
      if (!ready || shuttingDown || fatalTriggered) {
        return false;
      }
      if (isProduction) {
        return checkFileExists(clientIndexPath);
      }
      return true;
    },
    shutdown,
    handleFatal,
  };
};
