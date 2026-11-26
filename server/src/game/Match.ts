import { performance } from 'node:perf_hooks';

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
  toSeq,
} from '@magicarena/shared';

import { WorldEventSchema } from '@magicarena/shared/protocol';

import type {
  Bounds,
  EntityId,
  EntitySnapshot,
  GameEntityKind,
  PlayerId,
  Seq,
  SnapshotMessage,
  SwordInput,
  Tick,
  WorldEvent,
  WorldEventName,
} from '@magicarena/shared';

import type { z } from 'zod';

import type {
  Player,
  MatchPlayerState,
  QueuedInput,
  ContinuousInput,
  FireAck,
  InputCommand,
} from '../types.ts';

import type { Room } from '../rooms.ts';
import type { ServerProfiler } from '../performance/ServerProfiler.ts';
import type { LoadProfiler } from '../performance/LoadProfiler.ts';
import type { ServerMetrics } from '../performance/ServerMetrics.ts';
import { FIXED_DT, createTickLoop } from './tickLoop.ts';

type SnapshotEvent = z.infer<typeof WorldEventSchema>;

export type SnapshotHandler = (match: Match) => void;

export interface MatchOptions {
  bounds?: Bounds;
  seed?: number;
  onSnapshot?: SnapshotHandler | null;
  profiler?: ServerProfiler | null;
  loadProfiler?: LoadProfiler | null;
  metrics?: ServerMetrics | null;
}

export interface MatchStats {
  roomId: string;
  tick: Tick;
  targetHz: number;
  lastStepMs: number;
  avgStepMs: number;
  lastJitterMs: number;
  avgJitterMs: number;
  players: number;
}

interface SerializedEventDetail {
  kind?: GameEntityKind;
  entityId?: EntityId;
  ownerId?: EntityId | null;
  ownerPlayerId?: PlayerId | null;
  originSeq?: Seq | null;
  hp?: number;
  score?: number;
  pos?: { x: number; y: number };
}

const DEFAULT_ARENA_BOUNDS: Bounds = {
  width: 960,
  height: 640,
};

const RESPAWN_SECONDS = 2;
const MAX_INPUT_QUEUE = 16;
const MAX_HANDLED_SHOT_SEQS = 64;
const IDLE_TIMEOUT_TICKS = 30;
const IDLE_INPUT: Readonly<ContinuousInput> = Object.freeze({
  thrust: false,
  turn: 0,
  brake: false,
});

const OBSTACLE_PRESETS = [
  { xFactor: 0.2, yFactor: 0.3, vx: 40, vy: 25, radius: 28, homing: true },
  { xFactor: 0.8, yFactor: 0.65, vx: -35, vy: 30, radius: 24, homing: false },
  { xFactor: 0.7, yFactor: 0.2, vx: -25, vy: -40, radius: 32, homing: false },
];

const WORLD_EVENTS: readonly WorldEventName[] = [
  'fired',
  'hit',
  'exploded',
  'healed',
  'scoreChanged',
];

const hashSeed = (value: string | number): number => {
  const str = String(value);
  let hash = 2166136261;

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0 || 1;
};

const serializeEventDetail = (
  detail: WorldEvent['detail'],
): SerializedEventDetail => {
  const out: SerializedEventDetail = {};

  if ('kind' in detail && detail.kind !== undefined) {
    out.kind = detail.kind;
  }

  if ('entityId' in detail && detail.entityId !== undefined) {
    out.entityId = detail.entityId;
  }

  if ('ownerId' in detail && detail.ownerId !== undefined) {
    out.ownerId = detail.ownerId;
  }

  if ('ownerPlayerId' in detail && detail.ownerPlayerId !== undefined) {
    out.ownerPlayerId = detail.ownerPlayerId;
  }

  if ('originSeq' in detail && detail.originSeq !== undefined) {
    out.originSeq = detail.originSeq;
  }

  if ('hp' in detail && detail.hp !== undefined) {
    out.hp = detail.hp;
  }

  if ('score' in detail && detail.score !== undefined) {
    out.score = detail.score;
  }

  if ('pos' in detail && detail.pos) {
    out.pos = { x: detail.pos.x, y: detail.pos.y };
  }

  return out;
};

const findPlayerSpawn = (world: World): Vector2 => {
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
  readonly room: Room;
  readonly bounds: Bounds;
  readonly seed: number;
  readonly world: World;

  readonly players = new Map<PlayerId, MatchPlayerState>();

  readonly onSnapshot: SnapshotHandler | null;

  #tickEvents: SnapshotEvent[] = [];
  #loop: ReturnType<typeof createTickLoop>;
  #stopped = false;
  #profiler: ServerProfiler | null;
  #loadProfiler: LoadProfiler | null;
  #metrics: ServerMetrics | null;
  #activeTickStart: number | null = null;
  #activeLoadTickStart: number | null = null;
  #activeMetricsTickStart: number | null = null;

  constructor(
    room: Room,
    {
      bounds = DEFAULT_ARENA_BOUNDS,
      seed = hashSeed(room.id),
      onSnapshot = null,
      profiler = null,
      loadProfiler = null,
      metrics = null,
    }: MatchOptions = {},
  ) {
    this.room = room;
    this.bounds = {
      width: bounds.width,
      height: bounds.height,
    };
    this.seed = seed >>> 0;
    this.world = new World(this.bounds, { seed: this.seed });
    this.onSnapshot = onSnapshot;
    this.#profiler = profiler;
    this.#loadProfiler = loadProfiler;
    this.#metrics = metrics;

    for (const eventName of WORLD_EVENTS) {
      this.world.addEventListener(eventName, (event) => {
        const serialized = WorldEventSchema.parse({
          type: eventName,
          detail: serializeEventDetail(event.detail),
        });

        this.#tickEvents.push(serialized);
      });
    }

    this.#initWorldEntities();

    this.#loop = createTickLoop({
      onTick: (dt) => {
        if (this.players.size > 0 && this.#profiler?.isRunning()) {
          this.#activeTickStart = performance.now();
        } else {
          this.#activeTickStart = null;
        }
        if (this.room.id === 'load-test' && this.#loadProfiler?.isRunning()) {
          this.#activeLoadTickStart = performance.now();
        } else {
          this.#activeLoadTickStart = null;
        }
        this.#activeMetricsTickStart =
          this.#metrics !== null ? performance.now() : null;
        this.step(dt);
      },
      onAfterTick: () => {
        this.onSnapshot?.(this);
        if (this.#activeTickStart !== null) {
          this.#profiler?.recordTick(performance.now() - this.#activeTickStart);
          this.#activeTickStart = null;
        }
        if (this.#activeLoadTickStart !== null) {
          this.#loadProfiler?.recordTick(
            performance.now() - this.#activeLoadTickStart,
            this.world.count,
            this.players.size,
          );
          this.#activeLoadTickStart = null;
        }
        if (this.#activeMetricsTickStart !== null) {
          this.#metrics?.recordTick(
            performance.now() - this.#activeMetricsTickStart,
          );
          this.#activeMetricsTickStart = null;
        }
      },
    });
  }

  #initWorldEntities(): void {
    const obstacleCount = Math.max(
      0,
      Math.min(OBSTACLE_PRESETS.length, this.room.obstacleCount),
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

  get tick(): Tick {
    return this.world.tick;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  start(): void {
    if (this.#stopped) return;

    this.#loop.start();
  }

  stop(): void {
    if (this.#stopped) return;

    this.#stopped = true;
    this.#loop.stop();
  }

  addPlayer(player: Player): MatchPlayerState {
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

    const state: MatchPlayerState = {
      playerId: player.id,
      entityId: sword.id,

      lastReceivedSeq: -1,
      lastProcessedSeq: toSeq(0),

      inputQueue: [],
      handledShotSeqs: new Set(),
      pendingFireAcks: [],

      lastContinuousInput: { ...IDLE_INPUT },
      lastKnownThrust: false,

      idleTicks: 0,
      respawnTimer: null,
    };

    this.players.set(player.id, state);
    return state;
  }

  removePlayer(playerId: PlayerId): void {
    const state = this.players.get(playerId);
    if (!state) return;

    state.lastContinuousInput = { ...IDLE_INPUT };
    state.lastKnownThrust = false;
    state.inputQueue.length = 0;

    this.world.despawn(state.entityId);
    this.players.delete(playerId);
  }

  getPlayer(playerId: PlayerId): MatchPlayerState | undefined {
    return this.players.get(playerId);
  }

  applyInput(playerId: PlayerId, input: InputCommand): boolean {
    const state = this.players.get(playerId);
    if (!state) return false;

    // Ігноруємо дублікати та застарілі seq
    if (input.seq <= state.lastReceivedSeq) {
      return false;
    }

    state.lastReceivedSeq = input.seq;

    if (state.inputQueue.length >= MAX_INPUT_QUEUE) {
      const dropped = state.inputQueue.shift();

      if (dropped && (dropped.fire || dropped.homingFire)) {
        const droppedOriginSeq = dropped.fireSeq ?? dropped.seq;

        if (this.#markShotHandled(state, droppedOriginSeq)) {
          state.pendingFireAcks.push({
            originSeq: droppedOriginSeq,
            accepted: false,
            entityId: null,
            entityIds: [],
          });
        }
      }
    }

    state.inputQueue.push({
      seq: input.seq,
      fireSeq: input.fireSeq ?? null,
      thrust: Boolean(input.thrust),
      turn: input.turn,
      brake: Boolean(input.brake),
      fire: Boolean(input.fire),
      homingFire: Boolean(input.homingFire),
    });

    return true;
  }

  #markShotHandled(state: MatchPlayerState, originSeq: Seq): boolean {
    if (state.handledShotSeqs.has(originSeq)) {
      return false;
    }

    state.handledShotSeqs.add(originSeq);

    if (state.handledShotSeqs.size > MAX_HANDLED_SHOT_SEQS) {
      const oldest = state.handledShotSeqs.values().next();

      if (!oldest.done) {
        state.handledShotSeqs.delete(oldest.value);
      }
    }

    return true;
  }

  drainFireAcks(playerId: PlayerId): FireAck[] {
    const state = this.players.get(playerId);
    if (!state || state.pendingFireAcks.length === 0) return [];

    const acks = [...state.pendingFireAcks];
    state.pendingFireAcks.length = 0;
    return acks;
  }

  step(dt = FIXED_DT): void {
    this.#tickEvents = [];

    const inputs = new Map<EntityId, SwordInput>();
    const tickCommands = new Map<PlayerId, QueuedInput>();

    for (const state of this.players.values()) {
      const sword = this.world.get(state.entityId);

      if (sword?.kind === 'sword' && sword.alive) {
        const command = state.inputQueue.shift() ?? null;

        if (command) {
          state.lastContinuousInput = {
            thrust: command.thrust,
            turn: command.turn,
            brake: command.brake,
          };
          state.lastKnownThrust = Boolean(command.thrust);
          state.idleTicks = 0;
          tickCommands.set(state.playerId, command);
          inputs.set(sword.id, state.lastContinuousInput);
        } else {
          state.idleTicks += 1;

          if (state.idleTicks > IDLE_TIMEOUT_TICKS) {
            state.lastContinuousInput = { ...IDLE_INPUT };
            state.lastKnownThrust = false;
            inputs.set(sword.id, IDLE_INPUT);
          } else {
            state.lastKnownThrust = Boolean(state.lastContinuousInput.thrust);
            inputs.set(sword.id, state.lastContinuousInput);
          }
        }
      } else {
        state.lastContinuousInput = { ...IDLE_INPUT };
        state.lastKnownThrust = false;
        state.idleTicks = 0;

        if (state.inputQueue.length > 0) {
          for (const drained of state.inputQueue) {
            if (drained.fire || drained.homingFire) {
              const originSeq = drained.fireSeq ?? drained.seq;
              if (this.#markShotHandled(state, originSeq)) {
                state.pendingFireAcks.push({
                  originSeq,
                  accepted: false,
                  entityId: null,
                  entityIds: [],
                });
              }
            }
          }

          const latest = state.inputQueue.at(-1);

          if (latest) {
            state.lastProcessedSeq = latest.seq;
          }

          state.inputQueue.length = 0;
        }
      }
    }

    if (this.players.size > 0 && this.#profiler?.isRunning()) {
      let collisionStart = 0;
      let collisionMs = 0;
      const worldStepStart = performance.now();

      this.world.step(dt, inputs, {
        onBeforeCollisions: () => {
          collisionStart = performance.now();
        },
        onAfterCollisions: () => {
          collisionMs = performance.now() - collisionStart;
        },
      });

      this.#profiler.recordWorldStep(performance.now() - worldStepStart);
      this.#profiler.recordCollision(collisionMs);
      this.#profiler.recordEntities(this.world.count);
      this.#profiler.recordPlayers(this.players.size);
    } else {
      this.world.step(dt, inputs);
    }

    for (const state of this.players.values()) {
      const command = tickCommands.get(state.playerId);

      if (command) {
        state.lastProcessedSeq = command.seq;
      }

      const sword = this.world.get(state.entityId);
      const originSeq =
        command && (command.fire || command.homingFire)
          ? (command.fireSeq ?? command.seq)
          : null;

      if (sword?.kind === 'sword' && sword.alive) {
        if (
          command &&
          originSeq !== null &&
          this.#markShotHandled(state, originSeq)
        ) {
          const entityIds: EntityId[] = [];

          if (command.fire) {
            const bullet = sword.fire(this.world, { originSeq });
            entityIds.push(bullet.id);
          }

          if (command.homingFire) {
            const bullet = sword.fire(this.world, { originSeq });

            if (bullet instanceof Bullet) {
              bullet.homing = createHoming({
                targetKind: 'obstacle',
                turnRate: 9,
              });
              bullet.ttl = 1;
            }

            entityIds.push(bullet.id);
          }

          state.pendingFireAcks.push({
            originSeq,
            accepted: true,
            entityId: entityIds.at(-1) ?? null,
            entityIds,
          });
        }

        continue;
      }

      state.lastContinuousInput = { ...IDLE_INPUT };
      state.lastKnownThrust = false;

      if (originSeq !== null && this.#markShotHandled(state, originSeq)) {
        state.pendingFireAcks.push({
          originSeq,
          accepted: false,
          entityId: null,
          entityIds: [],
        });
      }

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
        state.inputQueue.length = 0;
        state.lastContinuousInput = { ...IDLE_INPUT };
        state.lastKnownThrust = false;
        state.idleTicks = 0;
      }
    }
  }

  getSnapshotForPlayer(playerId: PlayerId): SnapshotMessage {
    const state = this.players.get(playerId);
    const entities: EntitySnapshot[] = [...this.world].map((entity) => {
      const json = entity.toJSON();

      if (json.kind === 'sword' && json.alive && json.ownerId) {
        const ownerState = this.players.get(json.ownerId);
        if (ownerState) {
          return {
            ...json,
            thrust: ownerState.lastKnownThrust,
          };
        }
      }

      return json;
    });

    return createSnapshotMessage({
      tick: this.world.tick,
      lastProcessedSeq: state?.lastProcessedSeq ?? toSeq(0),
      entities,
      score: this.world.score,
      bounds: this.bounds,
      events: this.#tickEvents,
      respawnSeconds: state?.respawnTimer ?? null,
    });
  }

  getStats(): MatchStats {
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

