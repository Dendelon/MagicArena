import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import type { TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { getErrorMessage } from '../errors.ts';
import type { Room, RoomManager } from '../rooms.ts';
import type { RoomLogEvent } from '../types.ts';

export const createMatchLog = (room: Room, logDir: string) => {
  const id = `${room.id}-${Date.now()}`;
  const filePath = join(logDir, `${id}.ndjson`);

  // Джерело подій у вигляді об'єктів
  const source = new PassThrough({
    objectMode: true,
    highWaterMark: 32,
  });

  // Перетворення об'єкта на рядок JSON
  const toNdjson = new Transform({
    writableObjectMode: true,

    transform(
      event: unknown,
      _encoding: BufferEncoding,
      callback: TransformCallback,
    ): void {
      try {
        callback(null, `${JSON.stringify(event)}\n`);
      } catch (error: unknown) {
        callback(
          error instanceof Error ? error : new Error(getErrorMessage(error)),
        );
      }
    },
  });

  const done = pipeline(source, toNdjson, createWriteStream(filePath));

  let closed = false;
  room.logBackpressured = false;

  const onEvent = (event: RoomLogEvent): void => {
    if (closed) return;

    if (!source.write(event)) {
      room.logBackpressured = true;
    }
  };

  source.on('drain', () => {
    room.logBackpressured = false;
  });

  const close = (): void => {
    if (closed) return;

    closed = true;
    room.off('event', onEvent);
    source.end();
  };

  room.on('event', onEvent);
  room.once('empty', close);

  // Обробка помилки без unhandled rejection
  done
    .finally(() => {
      room.off('empty', close);
      room.logBackpressured = false;
    })
    .catch((error: unknown) => {
      console.error(`Log error (${id}):`, error);
      room.emit('error', error);
    });

  return { id, filePath, close, done };
};

export const setupMatchLogs = (roomManager: RoomManager, logDir: string) => {
  const active = new Map<string, ReturnType<typeof createMatchLog>>();

  const register = (room: Room): void => {
    const log = createMatchLog(room, logDir);
    active.set(room.id, log);

    log.done.then(
      () => {
        active.delete(room.id);
      },
      () => {
        active.delete(room.id);
      },
    );
  };

  // Кімнати, створені при запуску сервера
  for (const room of roomManager.rooms.values()) {
    register(room);
  }

  // Нові кімнати, створені через POST /api/rooms
  roomManager.on('created', register);

  const shutdown = async (): Promise<void> => {
    roomManager.off('created', register);

    const logs = [...active.values()];

    for (const log of logs) {
      log.close();
    }

    // Чекаємо завершення запису всіх файлів
    await Promise.all(logs.map((log) => log.done));
  };

  return { shutdown };
};

