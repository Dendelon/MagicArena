import { resolveCollisions } from './collision.ts';
import { mulberry32 } from './random.ts';
import { entityFromJSON } from '../entities/fromJSON.ts';
import { toSeq, toTick } from '../types.ts';

import type { EntityOfKind, GameEntity } from '../entities/types.ts';
import type {
  Bounds,
  EntityId,
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

export interface WorldOptions {
  seed?: number;
  rng?: RandomSource | null;
}

export type WorldInputs =
  | Map<EntityId, SwordInput>
  | Readonly<Record<string, SwordInput | undefined>>;

type WorldListener = (this: World, event: WorldEvent) => void;

export class World {
  #entities = new Map<EntityId, GameEntity>();
  #listeners = new Map<WorldEventName, Map<WorldListener, boolean>>();

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

  emit<K extends WorldEventName>(name: K, detail: WorldEventMap[K]): void {
    this.dispatchEvent({
      type: name,
      detail,
    });
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
        pos: entity.pos,
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
  step(dt: number, inputs: WorldInputs = new Map()): void {
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
    resolveCollisions(this);

    // 3. Видаляємо знищені об'єкти
    for (const [id, entity] of this.#entities) {
      if (!entity.alive) {
        this.#entities.delete(id);
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
    this.#entities.clear();

    for (const entityData of snapshot.entities ?? []) {
      const entity = entityFromJSON(entityData);
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
      const entity = entityFromJSON(entityData);
      world.#entities.set(entity.id, entity);
    }

    return world;
  }
}

