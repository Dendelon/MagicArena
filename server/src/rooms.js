import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class Room extends EventEmitter {
  constructor({ id = randomUUID(), name, obstacleCount = 3, maxPlayers = 4 }) {
    super();

    this.id = id;
    this.name = name;
    this.obstacleCount = obstacleCount;
    this.maxPlayers = maxPlayers;
    this.players = new Map();
  }

  getInfo() {
    return {
      id: this.id,
      name: this.name,
      obstacleCount: this.obstacleCount,
      maxPlayers: this.maxPlayers,
      players: this.players.size,
    };
  }

  getRoster() {
    return [...this.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
    }));
  }

  join(player) {
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

  leave(playerId) {
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

  chat(player, text) {
    const message = {
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

export class RoomManager extends EventEmitter {
  constructor({ maxRooms = 20 } = {}) {
    super();
    this.rooms = new Map();
    this.maxRooms = maxRooms;
  }

  create(options) {
    if (this.rooms.size >= this.maxRooms) {
      const error = new Error('Room limit reached');
      error.status = 429;
      throw error;
    }

    const room = new Room(options);

    this.rooms.set(room.id, room);

    room.once('empty', () => {
      this.rooms.delete(room.id);
      this.emit('removed', room);
    });

    room.on('error', (error) => {
      console.error(`Room ${room.id}:`, error);
    });

    this.emit('created', room);

    return room;
  }

  get(id) {
    return this.rooms.get(id);
  }

  list() {
    return [...this.rooms.values()].map((room) => room.getInfo());
  }
}
