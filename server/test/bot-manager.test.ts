import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, onTestFinished, test } from 'vitest';
import WebSocket from 'ws';
import type { RawData } from 'ws';

import {
  PROTOCOL_VERSION,
  getCodec,
  parseServerMessage,
} from '@magicarena/shared';
import type {
  CodecMode,
  PlayerId,
  SnapshotMessage,
  SwordSnapshot,
} from '@magicarena/shared';

import { BotManager } from '../src/bots/BotManager.ts';
import { HttpError } from '../src/errors.ts';
import { MatchManager } from '../src/game/MatchManager.ts';
import { RoomManager } from '../src/rooms.ts';
import { setupWebSocket } from '../src/ws.ts';

const rawToBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};

interface HumanSpectator {
  socket: WebSocket;
  playerId: PlayerId;
  codec: CodecMode;
  snapshots: SnapshotMessage[];
  close: () => Promise<void>;
}

const joinHuman = async (
  wsUrl: string,
  roomId: string,
  name: string,
): Promise<HumanSpectator> => {
  const socket = new WebSocket(wsUrl);
  const snapshots: SnapshotMessage[] = [];

  await once(socket, 'open');

  let activeCodec: CodecMode | null = null;

  const joined = new Promise<{ playerId: PlayerId; codec: CodecMode }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting to join ${roomId}`));
      }, 3000);

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('close', onCloseBeforeJoin);
        socket.off('error', onErrorBeforeJoin);
      };

      const onCloseBeforeJoin = (code: number, reason: Buffer): void => {
        cleanup();
        reject(
          new Error(
            `Socket closed before join (${code}): ${reason.toString()}`,
          ),
        );
      };

      const onErrorBeforeJoin = (error: Error): void => {
        cleanup();
        reject(error);
      };

      socket.on('close', onCloseBeforeJoin);
      socket.on('error', onErrorBeforeJoin);

      socket.on('message', (raw: RawData, isBinary: boolean) => {
        try {
          const buffer = rawToBuffer(raw);
          const decoded: unknown = !isBinary
            ? JSON.parse(buffer.toString('utf8'))
            : getCodec(activeCodec ?? 'binary').decode(buffer);

          const parsed = parseServerMessage(decoded);

          if (!parsed.success) return;

          const message = parsed.data;

          if (message.type === 'joined') {
            activeCodec = message.codec;
            cleanup();
            resolve({
              playerId: message.player.id,
              codec: message.codec,
            });
            return;
          }

          if (message.type === 'snapshot') {
            snapshots.push(message);
          }
        } catch {
          // Ignore malformed packets in test listener.
        }
      });
    },
  );

  socket.send(
    JSON.stringify({
      v: PROTOCOL_VERSION,
      type: 'join',
      room: roomId,
      name,
    }),
  );

  const { playerId: joinedPlayerId, codec: joinedCodec } = await joined;

  const close = async (): Promise<void> => {
    if (socket.readyState === WebSocket.CLOSED) return;

    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close();
    });
  };

  onTestFinished(close);

  return {
    socket,
    playerId: joinedPlayerId,
    codec: joinedCodec,
    snapshots,
    close,
  };
};

const startBotTestServer = async (codec: CodecMode) => {
  const server = createServer();
  const rooms = new RoomManager();

  rooms.create({
    id: 'profiling',
    name: 'Performance Arena',
    obstacleCount: 2,
    maxPlayers: 9,
  });

  rooms.create({
    id: 'small-room',
    name: 'Small Room',
    obstacleCount: 0,
    maxPlayers: 2,
  });

  let websocket: ReturnType<typeof setupWebSocket> | null = null;

  const matchManager = new MatchManager(rooms, {
    onSnapshot: (match) => {
      websocket?.broadcastSnapshot(match);
    },
  });

  websocket = setupWebSocket(server, rooms, { matchManager, codec });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address');
  }

  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;

  const botManager = new BotManager({
    roomManager: rooms,
    getWsUrl: () => wsUrl,
    connectTimeoutMs: 3000,
  });

  const close = async (): Promise<void> => {
    await botManager.shutdown();
    matchManager.shutdown();
    await websocket.shutdown();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };

  onTestFinished(close);

  return { rooms, matchManager, botManager, wsUrl, close };
};

const findSwordForPlayer = (
  snapshot: SnapshotMessage,
  playerId: PlayerId,
): SwordSnapshot | undefined =>
  snapshot.entities.find(
    (entity): entity is SwordSnapshot =>
      entity.kind === 'sword' &&
      entity.alive &&
      entity.ownerId === playerId,
  );

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<boolean> => {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  return false;
};

const waitForBotMovement = async (
  spectator: HumanSpectator,
  botIds: readonly PlayerId[],
  timeoutMs = 3000,
): Promise<boolean> => {
  const baseline = new Map<PlayerId, { x: number; y: number; angle: number }>();

  return waitUntil(() => {
    for (const snapshot of spectator.snapshots) {
      for (const botId of botIds) {
        const sword = findSwordForPlayer(snapshot, botId);
        if (!sword) continue;

        const first = baseline.get(botId);
        if (!first) {
          baseline.set(botId, {
            x: sword.pos.x,
            y: sword.pos.y,
            angle: sword.angle,
          });
          continue;
        }

        const moved =
          Math.abs(sword.pos.x - first.x) > 1 ||
          Math.abs(sword.pos.y - first.y) > 1 ||
          Math.abs(sword.angle - first.angle) > 0.05;

        if (moved) {
          return true;
        }
      }
    }

    return false;
  }, timeoutMs);
};

describe('BotManager WebSocket integration', () => {
  test.each<CodecMode>(['json', 'binary'])(
    'spawns bots in %s mode, drives real sword movement, and removes them cleanly',
    async (codec) => {
      const { rooms, matchManager, botManager, wsUrl } =
        await startBotTestServer(codec);
      const spectator = await joinHuman(wsUrl, 'profiling', 'Observer');

      expect(spectator.codec).toBe(codec);

      const match = matchManager.getMatch('profiling');
      expect(match).toBeDefined();
      const initialTick = match?.tick ?? 0;

      const added = await botManager.addBots('profiling', 2, 100);

      expect(added).toHaveLength(2);
      expect(added.map((bot) => bot.name)).toEqual(['Bot 01', 'Bot 02']);
      expect(botManager.getBotCount('profiling')).toBe(2);
      expect(botManager.getBotIds('profiling')).toHaveLength(2);
      expect(botManager.listBots('profiling')).toEqual(added);
      expect(rooms.get('profiling')?.getInfo().players).toBe(3);

      const tickAdvanced = await waitUntil(
        () =>
          (match?.tick ?? 0) > initialTick && spectator.snapshots.length > 0,
      );
      expect(tickAdvanced).toBe(true);

      const botIds = added.map((bot) => bot.playerId);

      const inputsProcessed = await waitUntil(() =>
        botIds.every(
          (botId) => (match?.getPlayer(botId)?.lastProcessedSeq ?? 0) > 0,
        ),
      );
      expect(inputsProcessed).toBe(true);

      const moved = await waitForBotMovement(spectator, botIds);
      expect(moved).toBe(true);

      const removed = await botManager.removeBots('profiling');

      expect(removed).toBe(2);
      expect(botManager.getBotCount('profiling')).toBe(0);
      expect(botManager.listBots('profiling')).toEqual([]);
      expect(rooms.get('profiling')?.getInfo().players).toBe(1);
    },
  );

  test('enforces maxPlayers room slots and frees them for human players on removal', async () => {
    const { rooms, botManager, wsUrl } = await startBotTestServer('binary');
    await joinHuman(wsUrl, 'small-room', 'Human-1');

    // One slot left out of maxPlayers=2, requesting 2 bots must fail with 409.
    await expect(botManager.addBots('small-room', 2)).rejects.toMatchObject({
      status: 409,
    });
    expect(botManager.getBotCount('small-room')).toBe(0);
    expect(rooms.get('small-room')?.getInfo().players).toBe(1);

    // Adding 1 bot fills the remaining slot.
    const bots = await botManager.addBots('small-room', 1);
    expect(bots).toHaveLength(1);
    expect(rooms.get('small-room')?.getInfo().players).toBe(2);

    // Remove bot, freeing the slot for another human player.
    expect(await botManager.removeBots('small-room')).toBe(1);
    expect(rooms.get('small-room')?.getInfo().players).toBe(1);

    const secondHuman = await joinHuman(wsUrl, 'small-room', 'Human-2');
    expect(secondHuman.playerId).toBeTruthy();
    expect(rooms.get('small-room')?.getInfo().players).toBe(2);
  });

  test('reserves slots and unique bot names atomically under concurrent requests', async () => {
    const { rooms, botManager, wsUrl } = await startBotTestServer('json');
    await joinHuman(wsUrl, 'small-room', 'Anchor');

    // Max 2 players: 1 free slot left, two parallel addBots(1) requests race.
    const results = await Promise.allSettled([
      botManager.addBots('small-room', 1, 1),
      botManager.addBots('small-room', 1, 2),
    ]);

    const fulfilled = results.filter((item) => item.status === 'fulfilled');
    const rejected = results.filter((item) => item.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(HttpError);
    expect(rooms.get('small-room')?.getInfo().players).toBe(2);
    expect(botManager.getBotCount('small-room')).toBe(1);
  });

  test('validates room existence and bot count bounds cleanly', async () => {
    const { botManager } = await startBotTestServer('json');

    await expect(botManager.addBots('unknown-room', 1)).rejects.toMatchObject({
      status: 404,
    });
    await expect(botManager.addBots('profiling', 0)).rejects.toMatchObject({
      status: 400,
    });
    await expect(botManager.addBots('profiling', 9)).rejects.toMatchObject({
      status: 400,
    });
    expect(() => botManager.listBots('unknown-room')).toThrow(HttpError);
    expect(await botManager.removeBots('profiling')).toBe(0);
  });
});
