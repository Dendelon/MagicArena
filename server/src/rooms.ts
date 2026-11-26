import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { HttpError } from './errors.ts';
import { serializeLogError, type AppLogger } from './log/logger.ts';

import type {
  Player,
  RoomOptions,
  ChatEvent,
  RoomLogEvent,
} from './types.ts';

import type {
  PlayerId,
  RoomInfo,
  RosterPlayer,
} from '@magicarena/shared';

interface RoomEvents {
  join: [player: Player];
  leave: [player: Player];
  chat: [message: ChatEvent];
  event: [event: RoomLogEvent];
  empty: [];
  error: [error: unknown];
}

interface RoomManagerEvents {
  created: [room: Room];
  removed: [room: Room];
}

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  readonly name: string;
  readonly obstacleCount: number;
  readonly maxPlayers: number;

  readonly players = new Map<PlayerId, Player>();

  logBackpressured = false;

  constructor({
    id = randomUUID(),
    name,
    obstacleCount = 3,
    maxPlayers = 4,
  }: RoomOptions) {
    super();

    this.id = id;
    this.name = name;
    this.obstacleCount = obstacleCount;
    this.maxPlayers = maxPlayers;
  }

  getInfo(): RoomInfo {
    return {
      id: this.id,
      name: this.name,
      obstacleCount: this.obstacleCount,
      maxPlayers: this.maxPlayers,
      players: this.players.size,
    };
  }

  getRoster(): RosterPlayer[] {
    return [...this.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
    }));
  }

  join(player: Player): boolean {
    if (this.players.size >= this.maxPlayers) {
      return false;
    }

    this.players.set(player.id, player);

    this.emit('join', player);

    this.emit('event', {
      t: Date.now(),
      type: 'join',
      playerId: player.id,
      name: player.name,
    });

    return true;
  }

  leave(playerId: PlayerId): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.players.delete(playerId);

    this.emit('leave', player);

    this.emit('event', {
      t: Date.now(),
      type: 'leave',
      playerId,
      name: player.name,
    });

    if (this.players.size === 0) {
      this.emit('empty');
    }
  }

  chat(player: Player, text: string): void {
    const message: ChatEvent = {
      playerId: player.id,
      name: player.name,
      text,
    };

    this.emit('chat', message);

    this.emit('event', {
      t: Date.now(),
      type: 'chat',
      ...message,
    });
  }
}

export type RoomLogger = Pick<AppLogger, 'info' | 'warn' | 'error'>;

export class RoomManager extends EventEmitter<RoomManagerEvents> {
  readonly rooms = new Map<string, Room>();

  readonly maxRooms: number;
  readonly #logger: RoomLogger | null;

  constructor({
    maxRooms = 20,
    logger = null,
  }: {
    maxRooms?: number;
    logger?: RoomLogger | null;
  } = {}) {
    super();

    this.maxRooms = maxRooms;
    this.#logger = logger;
  }

  create(options: RoomOptions): Room {
    if (this.rooms.size >= this.maxRooms) {
      throw new HttpError('Room limit reached', 429);
    }

    const room = new Room(options);

    this.rooms.set(room.id, room);

    room.on('join', (player) => {
      this.#logger?.info(
        {
          event: 'room.player.joined',
          roomId: room.id,
          playerId: player.id,
        },
        'room.player.joined',
      );
    });

    room.on('leave', (player) => {
      this.#logger?.info(
        {
          event: 'room.player.left',
          roomId: room.id,
          playerId: player.id,
        },
        'room.player.left',
      );
    });

    room.once('empty', () => {
      this.rooms.delete(room.id);
      this.emit('removed', room);
      this.#logger?.info(
        {
          event: 'room.closed',
          roomId: room.id,
        },
        'room.closed',
      );
    });

    room.on('error', (error) => {
      if (this.#logger) {
        this.#logger.error(
          {
            event: 'room.error',
            roomId: room.id,
            err: serializeLogError(error),
          },
          'room.error',
        );
      } else {
        console.error(`Room ${room.id}:`, error);
      }
    });

    this.emit('created', room);
    this.#logger?.info(
      {
        event: 'room.created',
        roomId: room.id,
        maxPlayers: room.maxPlayers,
      },
      'room.created',
    );

    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  list(): RoomInfo[] {
    return [...this.rooms.values()].map((room) => room.getInfo());
  }
}

