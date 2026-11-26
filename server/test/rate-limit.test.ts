import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';
import type { RawData } from 'ws';

import { RoomManager } from '../src/rooms.ts';
import { setupWebSocket } from '../src/ws.ts';
import {
  BUCKET_CAPACITY,
  CHAT_BUCKET_CAPACITY,
  CHAT_RATE_PER_SECOND,
  RATE_PER_SECOND,
  consumeToken,
} from '../src/network/rateLimit.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const startTestWsServer = async () => {
  const server = createServer();
  const rooms = new RoomManager();
  for (const id of ['chat-room', 'flood-room', 'invalid-room']) {
    rooms.create({
      id,
      name: id,
      obstacleCount: 0,
    });
  }
  const ws = setupWebSocket(server, rooms, { codec: 'json' });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }

  const url = `ws://127.0.0.1:${address.port}/ws`;

  const close = async (): Promise<void> => {
    await ws.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  return { url, close };
};

const joinRoom = async (
  url: string,
  name: string,
  roomId: string,
  clients: WebSocket[],
): Promise<WebSocket> => {
  const client = new WebSocket(url);

  clients.push(client);

  await once(client, 'open');

  const joined = new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      client.off('message', onMessage);
      client.off('close', onClose);
      client.off('error', onError);
    };

    const onMessage = (raw: RawData): void => {
      try {
        const parsed: unknown = JSON.parse(raw.toString());

        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'type' in parsed &&
          parsed.type === 'joined'
        ) {
          cleanup();
          resolve();
        }
      } catch (error: unknown) {
        cleanup();
        reject(error);
      }
    };

    const onClose = (code: number, reason: Buffer): void => {
      cleanup();

      reject(
        new Error(`Join failed: ${code} ${reason.toString('utf8')}`),
      );
    };

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    client.on('message', onMessage);
    client.once('close', onClose);
    client.once('error', onError);
  });

  client.send(
    JSON.stringify({
      v: 1,
      type: 'join',
      room: roomId,
      name,
    }),
  );

  await joined;

  return client;
};

describe('Token bucket rate limiting', () => {
  test('Initial bucket allows up to BUCKET_CAPACITY messages and rejects the next', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    let tokens = BUCKET_CAPACITY;
    let lastRefill = Date.now();
    const cfg = {
      capacity: BUCKET_CAPACITY,
      ratePerSecond: RATE_PER_SECOND,
    };

    for (let i = 0; i < BUCKET_CAPACITY; i++) {
      const res = consumeToken(tokens, lastRefill, Date.now(), cfg);
      expect(res.allowed).toBe(true);
      tokens = res.tokens;
      lastRefill = res.lastRefill;
    }

    const rejected = consumeToken(tokens, lastRefill, Date.now(), cfg);
    expect(rejected.allowed).toBe(false);
    expect(rejected.tokens).toBe(0);
  });

  test('Tokens refill over time without exceeding capacity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    const cfg = {
      capacity: BUCKET_CAPACITY,
      ratePerSecond: RATE_PER_SECOND,
    };

    // Start empty.
    let tokens = 0;
    let lastRefill = Date.now();

    // Advance 500ms -> refills 30 tokens, consumes 1 -> 29 remaining.
    vi.setSystemTime(1_000_500);
    const halfSec = consumeToken(tokens, lastRefill, Date.now(), cfg);
    expect(halfSec.allowed).toBe(true);
    expect(halfSec.tokens).toBe(29);
    tokens = halfSec.tokens;
    lastRefill = halfSec.lastRefill;

    // Advance 10 seconds -> capped at BUCKET_CAPACITY (60) - 1 = 59.
    vi.setSystemTime(1_010_500);
    const full = consumeToken(tokens, lastRefill, Date.now(), cfg);
    expect(full.allowed).toBe(true);
    expect(full.tokens).toBe(BUCKET_CAPACITY - 1);
  });

  test('Chat rate limit uses independent bucket capacity and refill rate', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);

    let chatTokens = CHAT_BUCKET_CAPACITY;
    let chatLastRefill = Date.now();
    const chatCfg = {
      capacity: CHAT_BUCKET_CAPACITY,
      ratePerSecond: CHAT_RATE_PER_SECOND,
    };

    for (let i = 0; i < CHAT_BUCKET_CAPACITY; i++) {
      const res = consumeToken(chatTokens, chatLastRefill, Date.now(), chatCfg);
      expect(res.allowed).toBe(true);
      chatTokens = res.tokens;
      chatLastRefill = res.lastRefill;
    }

    expect(
      consumeToken(chatTokens, chatLastRefill, Date.now(), chatCfg).allowed,
    ).toBe(false);

    // Advance 200ms at 5/s -> 1 chat token refilled.
    vi.setSystemTime(2_000_200);
    const refilled = consumeToken(
      chatTokens,
      chatLastRefill,
      Date.now(),
      chatCfg,
    );
    expect(refilled.allowed).toBe(true);
    expect(refilled.tokens).toBe(0);
  });

  test('WebSocket enforces message rate limit, independent chat limit, and invalid payload policy', async ({
    onTestFinished,
  }) => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000_000);

    const server = await startTestWsServer();
    const clients: WebSocket[] = [];

    onTestFinished(async () => {
      for (const client of clients) {
        client.terminate();
      }
      await server.close();
    });

    // 1. Exhaust chat bucket without hitting input rate limit (15 inputs + 11 chats).
    const chatClient = await joinRoom(
      server.url,
      'Chatter',
      'chat-room',
      clients,
    );

    for (let i = 1; i <= 15; i++) {
      chatClient.send(
        JSON.stringify({
          v: 1,
          type: 'input',
          seq: i,
          tick: i,
          thrust: false,
          turn: 0,
          brake: false,
          fire: false,
          homingFire: false,
        }),
      );
    }

    const chatClosed = once(chatClient, 'close');
    for (let i = 0; i < CHAT_BUCKET_CAPACITY + 1; i++) {
      chatClient.send(
        JSON.stringify({
          v: 1,
          type: 'chat',
          text: `msg ${i}`,
        }),
      );
    }

    const [chatCloseCode] = await chatClosed;
    expect(chatCloseCode).toBe(4008);

    // 2. Exceed global message bucket (join uses 1 token; sending 65 pings closes with 4008).
    const floodClient = await joinRoom(
      server.url,
      'Flooder',
      'flood-room',
      clients,
    );

    const floodClosed = once(floodClient, 'close');
    for (let i = 0; i < BUCKET_CAPACITY + 5; i++) {
      floodClient.send(
        JSON.stringify({
          v: 1,
          type: 'ping',
          id: i,
          clientTime: i,
        }),
      );
    }

    const [floodCloseCode] = await floodClosed;
    expect(floodCloseCode).toBe(4008);

    // 3. Invalid JSON closes with 1007.
    const badClient = await joinRoom(
      server.url,
      'Invalid',
      'invalid-room',
      clients,
    );

    const badClosed = once(badClient, 'close');
    badClient.send('{not-json');

    const [badCloseCode] = await badClosed;
    expect(badCloseCode).toBe(1007);
  });
});

