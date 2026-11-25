import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const createMatchLog = (room, logDir) => {
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

    transform(event, _encoding, callback) {
      try {
        callback(null, `${JSON.stringify(event)}\n`);
      } catch (error) {
        callback(error);
      }
    },
  });

  const done = pipeline(source, toNdjson, createWriteStream(filePath));

  let closed = false;
  room.logBackpressured = false;

  const onEvent = (event) => {
    if (closed) return;

    if (!source.write(event)) {
      room.logBackpressured = true;
    }
  };

  source.on('drain', () => {
    room.logBackpressured = false;
  });

  const close = () => {
    if (closed) return;

    closed = true;
    room.off('event', onEvent);
    source.end();
  };

  room.on('event', onEvent);
  room.once('empty', close);

  // Обробка помилки без unhandled rejection
  void done
    .catch((error) => {
      console.error(`Log error (${id}):`, error);
      room.emit('error', error);
    })
    .finally(() => {
      room.off('empty', close);
      room.logBackpressured = false;
    });

  return { id, filePath, close, done };
};

export const setupMatchLogs = (roomManager, logDir) => {
  const active = new Map();

  const register = (room) => {
    const log = createMatchLog(room, logDir);
    active.set(room.id, log);

    void log.done.then(
      () => active.delete(room.id),
      () => active.delete(room.id),
    );
  };

  // Кімнати, створені при запуску сервера
  for (const room of roomManager.rooms.values()) {
    register(room);
  }

  // Нові кімнати, створені через POST /api/rooms
  roomManager.on('created', register);

  const shutdown = async () => {
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
