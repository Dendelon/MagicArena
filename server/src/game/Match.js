import {
  Bullet,
  Obstacle,
  Pickup,
  Sword,
  Vector2,
  World,
  createHealingEffect,
  createHoming,
  createSnapshotMessage,
  findSafeSpawn,
} from '@magicarena/shared';
import { FIXED_DT, createTickLoop } from './tickLoop.js';

const DEFAULT_ARENA_BOUNDS = {
  width: 960,
  height: 640,
};

const RESPAWN_SECONDS = 2;

const OBSTACLE_PRESETS = [
  { xFactor: 0.2, yFactor: 0.3, vx: 40, vy: 25, radius: 28, homing: true },
  { xFactor: 0.8, yFactor: 0.65, vx: -35, vy: 30, radius: 24, homing: false },
  { xFactor: 0.7, yFactor: 0.2, vx: -25, vy: -40, radius: 32, homing: false },
];

const WORLD_EVENTS = ['fired', 'hit', 'exploded', 'healed', 'scoreChanged'];

const hashSeed = (value) => {
  const str = String(value);
  let hash = 2166136261;

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0 || 1;
};

const serializeEventDetail = (detail = {}) => {
  const out = {};

  if (detail.kind !== undefined) out.kind = detail.kind;
  if (detail.entityId !== undefined) out.entityId = detail.entityId;
  if (detail.hp !== undefined) out.hp = detail.hp;
  if (detail.score !== undefined) out.score = detail.score;
  if (detail.pos) {
    out.pos = { x: detail.pos.x, y: detail.pos.y };
  }

  return out;
};

const findPlayerSpawn = (world) => {
  const hazards = [...world.ofKind('obstacle'), ...world.ofKind('sword')];

  if (hazards.length === 0) {
    return new Vector2(world.width / 2, world.height / 2);
  }

  let bestPosition = findSafeSpawn(world, world.rng);
  let bestClearance = -Infinity;
  const padding = Math.min(60, world.width / 4, world.height / 4);

  for (let i = 0; i < 40; i++) {
    const pos = new Vector2(
      padding + world.rng() * (world.width - padding * 2),
      padding + world.rng() * (world.height - padding * 2),
    );

    const clearance = Math.min(
      ...hazards.map((hazard) => pos.sub(hazard.pos).length() - hazard.radius - 22),
    );

    if (clearance > 55) return pos;

    if (clearance > bestClearance) {
      bestClearance = clearance;
      bestPosition = pos;
    }
  }

  return bestPosition;
};

export class Match {
  #tickEvents = [];
  #loop;
  #stopped = false;

  constructor(
    room,
    { bounds = DEFAULT_ARENA_BOUNDS, seed = hashSeed(room.id), onSnapshot = null } = {},
  ) {
    this.room = room;
    this.bounds = {
      width: bounds.width,
      height: bounds.height,
    };
    this.seed = seed >>> 0;
    this.world = new World(this.bounds, { seed: this.seed });
    this.players = new Map();
    this.onSnapshot = onSnapshot;

    for (const eventName of WORLD_EVENTS) {
      this.world.addEventListener(eventName, (event) => {
        this.#tickEvents.push({
          type: eventName,
          detail: serializeEventDetail(event.detail),
        });
      });
    }

    this.#initWorldEntities();

    this.#loop = createTickLoop({
      onTick: (dt) => {
        this.step(dt);
      },
      onAfterTick: () => {
        this.onSnapshot?.(this);
      },
    });
  }

  #initWorldEntities() {
    const obstacleCount = Math.max(
      0,
      Math.min(OBSTACLE_PRESETS.length, this.room.obstacleCount ?? OBSTACLE_PRESETS.length),
    );

    for (const preset of OBSTACLE_PRESETS.slice(0, obstacleCount)) {
      const obstacle = new Obstacle({
        pos: new Vector2(
          this.bounds.width * preset.xFactor,
          this.bounds.height * preset.yFactor,
        ),
        vel: new Vector2(preset.vx, preset.vy),
        radius: preset.radius,
      });

      if (preset.homing) {
        obstacle.homing = createHoming({
          targetKind: 'sword',
          turnRate: 2.4,
          speed: 70,
        });
      }

      this.world.spawn(obstacle);
    }

    this.world.spawn(
      new Pickup({
        pos: new Vector2(this.bounds.width * 0.5, this.bounds.height * 0.78),
        effect: createHealingEffect(1),
      }),
    );
  }

  get tick() {
    return this.world.tick;
  }

  get stopped() {
    return this.#stopped;
  }

  start() {
    if (this.#stopped) return;

    this.#loop.start();
  }

  stop() {
    if (this.#stopped) return;

    this.#stopped = true;
    this.#loop.stop();
  }

  addPlayer(player) {
    const existing = this.players.get(player.id);
    if (existing) return existing;

    const pos =
      this.players.size === 0
        ? new Vector2(this.bounds.width / 2, this.bounds.height / 2)
        : findPlayerSpawn(this.world);

    const sword = new Sword({
      pos,
      ownerId: player.id,
    });

    this.world.spawn(sword);

    const state = {
      playerId: player.id,
      entityId: sword.id,
      lastReceivedSeq: -1,
      pendingSeq: null,
      lastProcessedSeq: 0,
      lastInput: {
        thrust: false,
        turn: 0,
        brake: false,
      },
      pendingFire: false,
      pendingHomingFire: false,
      respawnTimer: null,
    };

    this.players.set(player.id, state);
    return state;
  }

  removePlayer(playerId) {
    const state = this.players.get(playerId);
    if (!state) return;

    this.world.despawn(state.entityId);
    this.players.delete(playerId);
  }

  getPlayer(playerId) {
    return this.players.get(playerId);
  }

  applyInput(playerId, input) {
    const state = this.players.get(playerId);
    if (!state) return false;

    // Ігноруємо дублікати та застарілі seq
    if (input.seq <= state.lastReceivedSeq) {
      return false;
    }

    state.lastReceivedSeq = input.seq;
    state.pendingSeq = input.seq;
    state.lastInput = {
      thrust: input.thrust,
      turn: input.turn,
      brake: input.brake,
    };

    if (input.fire) {
      state.pendingFire = true;
    }

    if (input.homingFire) {
      state.pendingHomingFire = true;
    }

    return true;
  }

  step(dt = FIXED_DT) {
    this.#tickEvents = [];

    const inputs = new Map();

    for (const state of this.players.values()) {
      const sword = this.world.get(state.entityId);

      if (sword && sword.alive) {
        inputs.set(sword.id, state.lastInput);
      }
    }

    this.world.step(dt, inputs);

    for (const state of this.players.values()) {
      if (state.pendingSeq !== null) {
        state.lastProcessedSeq = state.pendingSeq;
        state.pendingSeq = null;
      }

      const sword = this.world.get(state.entityId);

      if (sword && sword.alive) {
        if (state.pendingFire) {
          sword.fire(this.world);
        }

        if (state.pendingHomingFire) {
          const bullet = sword.fire(this.world);

          if (bullet instanceof Bullet) {
            bullet.homing = createHoming({
              targetKind: 'obstacle',
              turnRate: 9,
            });
            bullet.ttl = 3;
          }
        }

        state.pendingFire = false;
        state.pendingHomingFire = false;
        continue;
      }

      state.pendingFire = false;
      state.pendingHomingFire = false;

      if (state.respawnTimer === null) {
        state.respawnTimer = RESPAWN_SECONDS;
      } else {
        state.respawnTimer = Math.max(0, state.respawnTimer - dt);
      }

      if (state.respawnTimer <= 0) {
        const respawned = new Sword({
          pos: findPlayerSpawn(this.world),
          ownerId: state.playerId,
        });

        this.world.spawn(respawned);
        state.entityId = respawned.id;
        state.respawnTimer = null;
      }
    }
  }

  getSnapshotForPlayer(playerId) {
    const state = this.players.get(playerId);

    return createSnapshotMessage({
      tick: this.world.tick,
      lastProcessedSeq: state?.lastProcessedSeq ?? 0,
      entities: [...this.world],
      score: this.world.score,
      bounds: this.bounds,
      events: this.#tickEvents,
      respawnSeconds: state?.respawnTimer ?? null,
    });
  }

  getStats() {
    const loopStats = this.#loop.getStats();

    return {
      roomId: this.room.id,
      tick: this.world.tick,
      targetHz: loopStats.targetHz,
      lastStepMs: loopStats.lastStepMs,
      avgStepMs: loopStats.avgStepMs,
      lastJitterMs: loopStats.lastJitterMs,
      avgJitterMs: loopStats.avgJitterMs,
      players: this.players.size,
    };
  }
}

