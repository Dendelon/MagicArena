import { Match } from './Match.js';

export class MatchManager {
  #matches = new Map();
  #cleanups = new Map();
  #roomManager;
  #onSnapshot;
  #onCreated;
  #onRemoved;

  constructor(roomManager, { onSnapshot = null } = {}) {
    this.#roomManager = roomManager;
    this.#onSnapshot = onSnapshot;

    this.#onCreated = (room) => {
      this.#createMatch(room);
    };

    this.#onRemoved = (room) => {
      this.#destroyMatch(room.id);
    };

    // Початкові кімнати, створені до ініціалізації MatchManager
    for (const room of roomManager.rooms.values()) {
      this.#createMatch(room);
    }

    roomManager.on('created', this.#onCreated);
    roomManager.on('removed', this.#onRemoved);
  }

  #createMatch(room) {
    if (this.#matches.has(room.id)) {
      return this.#matches.get(room.id);
    }

    const match = new Match(room, {
      onSnapshot: this.#onSnapshot,
    });

    const onJoin = (player) => {
      match.addPlayer(player);
    };

    const onLeave = (player) => {
      match.removePlayer(player.id);
    };

    for (const player of room.players.values()) {
      match.addPlayer(player);
    }

    room.on('join', onJoin);
    room.on('leave', onLeave);

    this.#matches.set(room.id, match);
    this.#cleanups.set(room.id, () => {
      room.off('join', onJoin);
      room.off('leave', onLeave);
    });

    match.start();
    return match;
  }

  #destroyMatch(roomId) {
    const match = this.#matches.get(roomId);
    if (!match) return;

    this.#cleanups.get(roomId)?.();
    this.#cleanups.delete(roomId);

    match.stop();
    this.#matches.delete(roomId);
  }

  getMatch(roomId) {
    return this.#matches.get(roomId);
  }

  getStats() {
    return [...this.#matches.values()].map((match) => match.getStats());
  }

  shutdown() {
    this.#roomManager.off('created', this.#onCreated);
    this.#roomManager.off('removed', this.#onRemoved);

    for (const roomId of [...this.#matches.keys()]) {
      this.#destroyMatch(roomId);
    }
  }
}

