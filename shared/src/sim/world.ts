import { resolveCollisions } from './collision.ts';
import { BulletPool } from './BulletPool.ts';
import { ParticlePool } from './ParticlePool.ts';
import { mulberry32 } from './random.ts';
import { Explosion, type ExplosionOptions } from '../entities/Explosion.ts';
import { entityFromJSON } from '../entities/fromJSON.ts';
import { createHoming } from './behaviors/homing.ts';
import { toSeq, toTick } from '../types.ts';

import type { Bullet, BulletOptions } from '../entities/Bullet.ts';
import type { EntityOfKind, GameEntity } from '../entities/types.ts';
import type { PoolStats } from './ObjectPool.ts';
import type {
  Bounds,
  EntityId,
  EntitySnapshot,
  GameEntityKind,
  RandomSource,
  Seq,
  SnapshotWorldState,
  SwordInput,
  Tick,
  WorldEvent,
  WorldEventMap,
  WorldEventName,
  WorldSnapshot,
  WorldState,
} from '../types.ts';

export interface WorldPoolStats {
  readonly bullets: PoolStats;
  readonly particles: PoolStats;
}

export interface WorldOptions {
  seed?: number;
  rng?: RandomSource | null;
}

export interface WorldStepHooks {
  readonly onBeforeCollisions?: () => void;
  readonly onAfterCollisions?: () => void;
}

export type WorldInputs =
  | Map<EntityId, SwordInput>
  | Readonly<Record<string, SwordInput | undefined>>;

type WorldListener = (this: World, event: WorldEvent) => void;

type EmitArgs = {
  [K in keyof WorldEventMap]: [name: K, detail: WorldEventMap[K]];
}[keyof WorldEventMap];

export class World {
  #entities = new Map<EntityId, GameEntity>();
  #listeners = new Map<WorldEventName, Map<WorldListener, boolean>>();
  readonly #bulletPool = new BulletPool();
  readonly #particlePool = new ParticlePool();

  bounds: Bounds;
  readonly seed: number;
  readonly rng: RandomSource;

  tick: Tick;
  score: number;

  constructor(bounds: Bounds, { seed = 1, rng = null }: WorldOptions = {}) {
    this.bounds = {
      width: bounds.width,
      height: bounds.height,
    };
    this.seed = seed >>> 0;
    this.rng = rng ?? mulberry32(this.seed);
    this.tick = toTick(0);
    this.score = 0;
  }

  addEventListener(
    type: WorldEventName,
    listener: WorldListener,
    options: { once?: boolean } = {},
  ): void {
    if (typeof listener !== 'function') return;

    let set = this.#listeners.get(type);

    if (!set) {
      set = new Map();
      this.#listeners.set(type, set);
    }

    set.set(listener, Boolean(options?.once));
  }

  removeEventListener(type: WorldEventName, listener: WorldListener): void {
    const set = this.#listeners.get(type);

    if (!set) return;

    set.delete(listener);

    if (set.size === 0) {
      this.#listeners.delete(type);
    }
  }

  dispatchEvent(event: WorldEvent): boolean {
    const set = this.#listeners.get(event.type);

    if (!set) return true;

    for (const [listener, once] of [...set.entries()]) {
      if (once) {
        this.removeEventListener(event.type, listener);
      }

      listener.call(this, event);
    }

    return true;
  }

  emit(...args: EmitArgs): void {
    switch (args[0]) {
      case 'fired':
        this.dispatchEvent({ type: 'fired', detail: args[1] });
        break;

      case 'hit':
        this.dispatchEvent({ type: 'hit', detail: args[1] });
        break;

      case 'exploded':
        this.dispatchEvent({ type: 'exploded', detail: args[1] });
        break;

      case 'healed':
        this.dispatchEvent({ type: 'healed', detail: args[1] });
        break;

      case 'scoreChanged':
        this.dispatchEvent({ type: 'scoreChanged', detail: args[1] });
        break;

      default: {
        const exhaustive: never = args;

        throw new Error(
          `Unhandled world event: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  get width(): number {
    return this.bounds.width;
  }

  get height(): number {
    return this.bounds.height;
  }

  get count(): number {
    return this.#entities.size;
  }

  createBullet(options: BulletOptions = {}): Bullet {
    return this.#bulletPool.acquire(options);
  }

  createExplosion(options: ExplosionOptions = {}): Explosion {
    return new Explosion({
      ...options,
      particlePool: options.particlePool ?? this.#particlePool,
    });
  }

  getPoolStats(): WorldPoolStats {
    return {
      bullets: this.#bulletPool.getStats(),
      particles: this.#particlePool.getStats(),
    };
  }

  #releaseEntityResources(entity: GameEntity): void {
    if (entity.kind === 'bullet') {
      this.#bulletPool.release(entity);
    } else if (entity.kind === 'explosion') {
      entity.releaseParticles();
    }
  }

  #restoreSnapshotEntity(entityData: EntitySnapshot): GameEntity {
    if (entityData.kind === 'bullet') {
      return this.#bulletPool.acquire({
        id: entityData.id,
        pos: entityData.pos,
        vel: entityData.vel,
        angle: entityData.angle,
        ttl: entityData.ttl,
        radius: entityData.radius,
        ownerId: entityData.ownerId,
        ownerPlayerId: entityData.ownerPlayerId ?? null,
        originSeq: entityData.originSeq ?? null,
        damage: entityData.damage,
        alive: entityData.alive,
        homing: entityData.homing ? createHoming(entityData.homing) : null,
      });
    }

    if (entityData.kind === 'explosion') {
      return new Explosion({
        id: entityData.id,
        pos: entityData.pos,
        vel: entityData.vel,
        angle: entityData.angle,
        color: entityData.color,
        alive: entityData.alive,
        particles: entityData.particles ?? [],
        particlePool: this.#particlePool,
      });
    }

    return entityFromJSON(entityData);
  }

  // Додавання сутності
  spawn<T extends GameEntity>(entity: T): T {
    if (this.#entities.has(entity.id)) {
      throw new Error(`Entity ${entity.id} already exists`);
    }

    this.#entities.set(entity.id, entity);

    if (entity.kind === 'bullet') {
      this.emit('fired', {
        entityId: entity.id,
        ownerId: entity.ownerId ?? null,
        ownerPlayerId: entity.ownerPlayerId ?? null,
        originSeq: entity.originSeq ?? null,
        pos: entity.pos.toJSON(),
      });
    }

    return entity;
  }

  // Позначення сутності для видалення
  despawn(id: EntityId): boolean {
    const entity = this.#entities.get(id);

    if (!entity) return false;

    entity.destroy();
    return true;
  }

  // Отримання сутності за ID
  get(id: EntityId): GameEntity | undefined {
    return this.#entities.get(id);
  }

  // Перебір усіх сутностей
  *[Symbol.iterator](): IterableIterator<GameEntity> {
    yield* this.#entities.values();
  }

  // Перебір сутностей певного типу
  *ofKind<K extends GameEntityKind>(kind: K): IterableIterator<EntityOfKind<K>> {
    const matchesKind = (entity: GameEntity): entity is EntityOfKind<K> =>
      entity.kind === kind;

    for (const entity of this) {
      if (entity.alive && matchesKind(entity)) {
        yield entity;
      }
    }
  }

  // Один крок симуляції
  step(
    dt: number,
    inputs: WorldInputs = new Map(),
    hooks?: WorldStepHooks,
  ): void {
    this.tick = toTick(this.tick + 1);

    const entities = [...this.#entities.values()];

    // 1. Оновлюємо всі сутності
    for (const entity of entities) {
      if (!entity.alive) continue;

      const entityInput =
        inputs instanceof Map ? inputs.get(entity.id) : inputs[String(entity.id)];

      if (entity.kind === 'sword' && entityInput) {
        entity.setInput(entityInput);
      }

      entity.update(dt, this);
    }

    // 2. Перевіряємо зіткнення
    hooks?.onBeforeCollisions?.();
    try {
      resolveCollisions(this);
    } finally {
      hooks?.onAfterCollisions?.();
    }

    // 3. Видаляємо знищені об'єкти та повертаємо їх у пул лише після завершення колізій
    for (const [id, entity] of this.#entities) {
      if (!entity.alive) {
        this.#entities.delete(id);
        this.#releaseEntityResources(entity);
      }
    }
  }

  toSnapshot(lastProcessedSeq: Seq = toSeq(0)): WorldSnapshot {
    return {
      tick: this.tick,
      lastProcessedSeq,
      entities: [...this.#entities.values()].map((entity) => entity.toJSON()),
    };
  }

  applySnapshot(snapshot: SnapshotWorldState): void {
    for (const existing of this.#entities.values()) {
      this.#releaseEntityResources(existing);
    }

    this.#entities.clear();

    for (const entityData of snapshot.entities ?? []) {
      const entity = this.#restoreSnapshotEntity(entityData);
      this.#entities.set(entity.id, entity);
    }

    if (typeof snapshot.tick === 'number') {
      this.tick = toTick(snapshot.tick);
    }

    if (typeof snapshot.score === 'number') {
      this.score = snapshot.score;
    }

    if (snapshot.bounds) {
      this.bounds = {
        width: snapshot.bounds.width,
        height: snapshot.bounds.height,
      };
    }

    for (const event of snapshot.events ?? []) {
      if (event && typeof event.type === 'string') {
        this.dispatchEvent(event);
      }
    }
  }

  toJSON(): WorldState {
    return {
      bounds: {
        width: this.bounds.width,
        height: this.bounds.height,
      },
      seed: this.seed,
      tick: this.tick,
      score: this.score,
      entities: [...this.#entities.values()].map((entity) => entity.toJSON()),
    };
  }

  static fromJSON(
    data: WorldState,
    { rng = null }: WorldOptions = {},
  ): World {
    const world = new World(data.bounds, {
      seed: data.seed ?? 1,
      rng,
    });

    world.tick = toTick(data.tick ?? 0);
    world.score = data.score ?? 0;

    for (const entityData of data.entities ?? []) {
      const entity = world.#restoreSnapshotEntity(entityData);
      world.#entities.set(entity.id, entity);
    }

    return world;
  }
}

