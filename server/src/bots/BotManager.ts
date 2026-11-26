import { HttpError } from '../errors.ts';
import { BotClient } from './BotClient.ts';

import type { PlayerId } from '@magicarena/shared';
import type { Room, RoomManager } from '../rooms.ts';

const MAX_BOTS_PER_ROOM = 8;
const BOT_REMOVAL_TIMEOUT_MS = 2000;

export interface BotSummary {
  readonly playerId: PlayerId;
  readonly name: string;
}

export interface BotManagerOptions {
  roomManager: RoomManager;
  getWsUrl: () => string;
  connectTimeoutMs?: number;
}

const deriveBotSeed = (baseSeed: number, botIndex: number): number =>
  (Math.imul(baseSeed ^ (botIndex * 2654435761), 1597334677) >>> 0) || 1;

const formatBotName = (index: number): string =>
  `Bot ${String(index).padStart(2, '0')}`;

export class BotManager {
  readonly #roomManager: RoomManager;
  readonly #getWsUrl: () => string;
  readonly #connectTimeoutMs?: number;

  readonly #botsByRoom = new Map<string, BotClient[]>();
  readonly #reservedByRoom = new Map<string, number>();
  readonly #reservedNamesByRoom = new Map<string, Set<string>>();

  readonly #onRemoved: (room: Room) => void;

  #nextSeedOffset = 1;
  #stopping = false;
  #shutdownPromise: Promise<void> | null = null;

  constructor({ roomManager, getWsUrl, connectTimeoutMs }: BotManagerOptions) {
    this.#roomManager = roomManager;
    this.#getWsUrl = getWsUrl;
    this.#connectTimeoutMs = connectTimeoutMs;

    this.#onRemoved = (room: Room): void => {
      const removedBots = this.#botsByRoom.get(room.id);
      if (removedBots) {
        for (const bot of removedBots) {
          bot.stop();
        }
        this.#botsByRoom.delete(room.id);
      }
    };

    this.#roomManager.on('removed', this.#onRemoved);
  }

  #getActiveBots(roomId: string): BotClient[] {
    const bots = this.#botsByRoom.get(roomId);
    if (!bots) return [];

    const active = bots.filter((bot) => bot.isConnected);
    if (active.length !== bots.length) {
      if (active.length === 0) {
        this.#botsByRoom.delete(roomId);
      } else {
        this.#botsByRoom.set(roomId, active);
      }
    }

    return active;
  }

  #allocateUniqueNames(roomId: string, count: number): string[] {
    const activeNames = new Set(
      this.#getActiveBots(roomId).map((bot) => bot.name),
    );
    const reservedNames =
      this.#reservedNamesByRoom.get(roomId) ?? new Set<string>();
    this.#reservedNamesByRoom.set(roomId, reservedNames);

    const names: string[] = [];
    let candidateNumber = 1;

    while (names.length < count) {
      const candidate = formatBotName(candidateNumber);
      candidateNumber += 1;

      if (activeNames.has(candidate) || reservedNames.has(candidate)) {
        continue;
      }

      reservedNames.add(candidate);
      names.push(candidate);
    }

    return names;
  }

  #releaseReservation(
    roomId: string,
    count: number,
    names: readonly string[],
  ): void {
    const remaining = Math.max(
      0,
      (this.#reservedByRoom.get(roomId) ?? 0) - count,
    );

    if (remaining === 0) {
      this.#reservedByRoom.delete(roomId);
    } else {
      this.#reservedByRoom.set(roomId, remaining);
    }

    const reservedNames = this.#reservedNamesByRoom.get(roomId);
    if (reservedNames) {
      for (const name of names) {
        reservedNames.delete(name);
      }

      if (reservedNames.size === 0) {
        this.#reservedNamesByRoom.delete(roomId);
      }
    }
  }

  async addBots(
    roomId: string,
    count: number,
    seed = 1337,
  ): Promise<BotSummary[]> {
    if (this.#stopping) {
      throw new HttpError('Server is shutting down', 503);
    }

    const room = this.#roomManager.get(roomId);
    if (!room) {
      throw new HttpError('Room not found', 404);
    }

    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_BOTS_PER_ROOM
    ) {
      throw new HttpError(
        `Bot count must be an integer between 1 and ${MAX_BOTS_PER_ROOM}`,
        400,
      );
    }

    const activeBots = this.#getActiveBots(roomId);
    const reserved = this.#reservedByRoom.get(roomId) ?? 0;

    if (activeBots.length + reserved + count > MAX_BOTS_PER_ROOM) {
      throw new HttpError(
        `Room supports at most ${MAX_BOTS_PER_ROOM} bots`,
        409,
      );
    }

    const occupied = room.players.size + reserved;

    if (occupied + count > room.maxPlayers) {
      throw new HttpError('Not enough free slots in room', 409);
    }

    this.#reservedByRoom.set(roomId, reserved + count);
    const names = this.#allocateUniqueNames(roomId, count);

    const url = this.#getWsUrl();
    const clients = names.map((name) => {
      const botSeed = deriveBotSeed(seed, this.#nextSeedOffset++);

      return new BotClient({
        url,
        roomId,
        name,
        seed: botSeed,
        connectTimeoutMs: this.#connectTimeoutMs,
      });
    });

    try {
      await Promise.all(clients.map((client) => client.connect()));
    } catch {
      await Promise.all(clients.map((client) => client.disconnect()));
      this.#releaseReservation(roomId, count, names);
      throw new HttpError('Failed to connect bots to room', 503);
    }

    if (this.#stopping) {
      await Promise.all(clients.map((client) => client.disconnect()));
      this.#releaseReservation(roomId, count, names);
      throw new HttpError('Server is shutting down', 503);
    }

    const current = this.#getActiveBots(roomId);
    this.#botsByRoom.set(roomId, [...current, ...clients]);
    this.#releaseReservation(roomId, count, names);

    const summaries: BotSummary[] = [];

    for (const client of clients) {
      if (client.playerId !== null) {
        summaries.push({
          playerId: client.playerId,
          name: client.name,
        });
      }
    }

    return summaries;
  }

  getBotCount(roomId: string): number {
    return this.#getActiveBots(roomId).length;
  }

  getBotIds(roomId: string): PlayerId[] {
    const ids: PlayerId[] = [];

    for (const bot of this.#getActiveBots(roomId)) {
      if (bot.playerId !== null) {
        ids.push(bot.playerId);
      }
    }

    return ids;
  }

  listBots(roomId: string): BotSummary[] {
    const room = this.#roomManager.get(roomId);
    if (!room) {
      throw new HttpError('Room not found', 404);
    }

    const summaries: BotSummary[] = [];

    for (const bot of this.#getActiveBots(roomId)) {
      if (bot.playerId !== null) {
        summaries.push({
          playerId: bot.playerId,
          name: bot.name,
        });
      }
    }

    return summaries;
  }

  #waitForRoomRemoval(
    roomId: string,
    botIds: readonly PlayerId[],
  ): Promise<void> {
    const room = this.#roomManager.get(roomId);
    if (!room) {
      return Promise.resolve();
    }

    const pendingIds = new Set<PlayerId>();
    for (const botId of botIds) {
      if (room.players.has(botId)) {
        pendingIds.add(botId);
      }
    }

    if (pendingIds.size === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const cleanup = (): void => {
        clearTimeout(timer);
        room.off('leave', onLeave);
        room.off('empty', onEmpty);
        this.#roomManager.off('removed', onRoomRemoved);
      };

      const finish = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const checkDone = (): void => {
        if (!this.#roomManager.get(roomId) || pendingIds.size === 0) {
          finish();
        }
      };

      const onLeave = (player: { readonly id: PlayerId }): void => {
        pendingIds.delete(player.id);
        checkDone();
      };

      const onEmpty = (): void => {
        pendingIds.clear();
        finish();
      };

      const onRoomRemoved = (removed: Room): void => {
        if (removed.id === roomId) {
          pendingIds.clear();
          finish();
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();

        if (!this.#roomManager.get(roomId)) {
          resolve();
          return;
        }

        const remaining = [...pendingIds].filter((id) =>
          room.players.has(id),
        );

        if (remaining.length === 0) {
          resolve();
          return;
        }

        reject(
          new HttpError(
            `Timed out waiting for bots to leave room ${roomId}`,
            504,
          ),
        );
      }, BOT_REMOVAL_TIMEOUT_MS);

      room.on('leave', onLeave);
      room.once('empty', onEmpty);
      this.#roomManager.on('removed', onRoomRemoved);
    });
  }

  async removeBots(roomId: string): Promise<number> {
    const bots = this.#botsByRoom.get(roomId) ?? [];
    const room = this.#roomManager.get(roomId);

    if (!room && bots.length === 0) {
      throw new HttpError('Room not found', 404);
    }

    this.#botsByRoom.delete(roomId);

    const botIds: PlayerId[] = [];
    for (const bot of bots) {
      if (bot.playerId !== null) {
        botIds.push(bot.playerId);
      }
    }

    const removalDone = this.#waitForRoomRemoval(roomId, botIds);

    await Promise.all(bots.map((bot) => bot.disconnect()));
    await removalDone;

    return bots.length;
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise;
    }

    this.#stopping = true;
    this.#roomManager.off('removed', this.#onRemoved);

    const allBots = [...this.#botsByRoom.values()].flat();
    this.#botsByRoom.clear();
    this.#reservedByRoom.clear();
    this.#reservedNamesByRoom.clear();

    this.#shutdownPromise = Promise.all(
      allBots.map((bot) => bot.disconnect()),
    ).then(() => {});

    return this.#shutdownPromise;
  }
}

