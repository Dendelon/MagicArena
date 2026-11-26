import { Match } from './Match.ts';

import type { MatchStats, SnapshotHandler } from './Match.ts';
import type { Room, RoomManager } from '../rooms.ts';
import type { ServerProfiler } from '../performance/ServerProfiler.ts';
import type { LoadProfiler } from '../performance/LoadProfiler.ts';
import type { ServerMetrics } from '../performance/ServerMetrics.ts';
import type { Player } from '../types.ts';
import type { WorldPoolStats } from '@magicarena/shared';

export class MatchManager {
  #matches = new Map<string, Match>();
  #cleanups = new Map<string, () => void>();
  #roomManager: RoomManager;
  #onSnapshot: SnapshotHandler | null;
  #profiler: ServerProfiler | null;
  #loadProfiler: LoadProfiler | null;
  #metrics: ServerMetrics | null;
  #onCreated: (room: Room) => void;
  #onRemoved: (room: Room) => void;

  constructor(
    roomManager: RoomManager,
    {
      onSnapshot = null,
      profiler = null,
      loadProfiler = null,
      metrics = null,
    }: {
      onSnapshot?: SnapshotHandler | null;
      profiler?: ServerProfiler | null;
      loadProfiler?: LoadProfiler | null;
      metrics?: ServerMetrics | null;
    } = {},
  ) {
    this.#roomManager = roomManager;
    this.#onSnapshot = onSnapshot;
    this.#profiler = profiler;
    this.#loadProfiler = loadProfiler;
    this.#metrics = metrics;

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

  #createMatch(room: Room): Match {
    const existing = this.#matches.get(room.id);

    if (existing) {
      return existing;
    }

    const match = new Match(room, {
      onSnapshot: this.#onSnapshot,
      profiler: this.#profiler,
      loadProfiler: this.#loadProfiler,
      metrics: this.#metrics,
    });

    const onJoin = (player: Player) => {
      match.addPlayer(player);
    };

    const onLeave = (player: Player) => {
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

  #destroyMatch(roomId: string): void {
    const match = this.#matches.get(roomId);
    if (!match) return;

    this.#cleanups.get(roomId)?.();
    this.#cleanups.delete(roomId);

    match.stop();
    this.#matches.delete(roomId);
  }

  getMatch(roomId: string): Match | undefined {
    return this.#matches.get(roomId);
  }

  getStats(): MatchStats[] {
    return [...this.#matches.values()].map((match) => match.getStats());
  }

  getPoolStats(): WorldPoolStats {
    let bulletsCreated = 0;
    let bulletsAcquired = 0;
    let bulletsReused = 0;
    let bulletsReleased = 0;
    let bulletsDiscarded = 0;
    let bulletsActive = 0;
    let bulletsAvailable = 0;
    let bulletsPeakActive = 0;

    let particlesCreated = 0;
    let particlesAcquired = 0;
    let particlesReused = 0;
    let particlesReleased = 0;
    let particlesDiscarded = 0;
    let particlesActive = 0;
    let particlesAvailable = 0;
    let particlesPeakActive = 0;

    for (const match of this.#matches.values()) {
      const stats = match.world.getPoolStats();
      bulletsCreated += stats.bullets.created;
      bulletsAcquired += stats.bullets.acquired;
      bulletsReused += stats.bullets.reused;
      bulletsReleased += stats.bullets.released;
      bulletsDiscarded += stats.bullets.discarded;
      bulletsActive += stats.bullets.active;
      bulletsAvailable += stats.bullets.available;
      bulletsPeakActive += stats.bullets.peakActive;

      particlesCreated += stats.particles.created;
      particlesAcquired += stats.particles.acquired;
      particlesReused += stats.particles.reused;
      particlesReleased += stats.particles.released;
      particlesDiscarded += stats.particles.discarded;
      particlesActive += stats.particles.active;
      particlesAvailable += stats.particles.available;
      particlesPeakActive += stats.particles.peakActive;
    }

    return {
      bullets: {
        created: bulletsCreated,
        acquired: bulletsAcquired,
        reused: bulletsReused,
        released: bulletsReleased,
        discarded: bulletsDiscarded,
        active: bulletsActive,
        available: bulletsAvailable,
        peakActive: bulletsPeakActive,
      },
      particles: {
        created: particlesCreated,
        acquired: particlesAcquired,
        reused: particlesReused,
        released: particlesReleased,
        discarded: particlesDiscarded,
        active: particlesActive,
        available: particlesAvailable,
        peakActive: particlesPeakActive,
      },
    };
  }

  shutdown(): void {
    this.#roomManager.off('created', this.#onCreated);
    this.#roomManager.off('removed', this.#onRemoved);

    for (const roomId of [...this.#matches.keys()]) {
      this.#destroyMatch(roomId);
    }
  }
}

