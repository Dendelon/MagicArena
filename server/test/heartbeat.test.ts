import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';

import { RoomManager } from '../src/rooms.ts';
import { setupWebSocket } from '../src/ws.ts';
import { rawDataToUtf8 } from '../src/network/rawData.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const connectAndJoin = async (
  url: string,
  name: string,
  autoPong = true,
): Promise<WebSocket> => {
  const client = new WebSocket(url, { autoPong });
  await once(client, 'open');

  const joined = new Promise<void>((resolve) => {
    client.on('message', (raw) => {
      const parsed: unknown = JSON.parse(rawDataToUtf8(raw));
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

  client.send(
    JSON.stringify({
      v: 1,
      type: 'join',
      room: 'hb-room',
      name,
    }),
  );

  await joined;
  return client;
};

describe('WebSocket heartbeat', () => {
  test('Active client responding with pong stays connected and silent client is terminated after missed pongs', async ({
    onTestFinished,
  }) => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
    });

    const server = createServer();
    const rooms = new RoomManager();
    rooms.create({ id: 'hb-room', name: 'Heartbeat Room', obstacleCount: 0 });

    const ws = setupWebSocket(server, rooms);
    const clients: WebSocket[] = [];

    onTestFinished(async () => {
      for (const client of clients) {
        client.terminate();
      }
      await ws.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }

    const url = `ws://127.0.0.1:${address.port}/ws`;

    const activeClient = await connectAndJoin(url, 'Active', true);
    const silentClient = await connectAndJoin(url, 'Silent', false);
    clients.push(activeClient, silentClient);

    let activePings = 0;
    activeClient.on('ping', () => {
      activePings += 1;
    });

    const silentClosed = once(silentClient, 'close');

    // Sweep 1: missedPongs -> 1, pings sent; activeClient auto-pongs -> resets to 0.
    vi.advanceTimersByTime(15_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    // Sweep 2: silentClient missedPongs -> 2; activeClient resets to 0.
    vi.advanceTimersByTime(15_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    // Sweep 3: silentClient has missedPongs >= 2 -> terminated.
    vi.advanceTimersByTime(15_000);
    await silentClosed;

    expect(activePings).toBeGreaterThanOrEqual(3);
    expect(activeClient.readyState).toBe(WebSocket.OPEN);
    expect(silentClient.readyState).toBe(WebSocket.CLOSED);
  });

  test('shutdown clears heartbeat interval', async ({ onTestFinished }) => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'Date'],
    });

    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const server = createServer();
    const rooms = new RoomManager();
    const ws = setupWebSocket(server, rooms);

    onTestFinished(async () => {
      await ws.shutdown();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    await ws.shutdown();

    expect(clearIntervalSpy).toHaveBeenCalled();

    // Advancing timers after shutdown should have zero active heartbeat sweeps.
    vi.advanceTimersByTime(60_000);
  });
});

