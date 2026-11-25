import { resolveCollisions } from './collision.js';
import { mulberry32 } from './random.ts';
import { entityFromJSON } from '../entities/fromJSON.js';

export class World {
  #entities = new Map();
  #listeners = new Map();

  constructor(bounds, { seed = 1, rng = null } = {}) {
    this.bounds = {
      width: bounds.width,
      height: bounds.height,
    };
    this.seed = seed >>> 0;
    this.rng = rng ?? mulberry32(this.seed);
    this.tick = 0;
    this.score = 0;
  }

  addEventListener(type, listener, options = {}) {
    if (typeof listener !== 'function') return;

    let set = this.#listeners.get(type);

    if (!set) {
      set = new Map();
      this.#listeners.set(type, set);
    }

    set.set(listener, Boolean(options?.once));
  }

  removeEventListener(type, listener) {
    const set = this.#listeners.get(type);

    if (!set) return;

    set.delete(listener);

    if (set.size === 0) {
      this.#listeners.delete(type);
    }
  }

  dispatchEvent(event) {
    const set = this.#listeners.get(event?.type);

    if (!set) return true;

    for (const [listener, once] of [...set.entries()]) {
      if (once) {
        this.removeEventListener(event.type, listener);
      }

      listener.call(this, event);
    }

    return true;
  }

  emit(name, detail = {}) {
    this.dispatchEvent({ type: name, detail });
  }

  get width() {
    return this.bounds.width;
  }

  get height() {
    return this.bounds.height;
  }

  get count() {
    return this.#entities.size;
  }

  // Додавання сутності
  spawn(entity) {
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
  despawn(id) {
    const entity = this.#entities.get(id);

    if (!entity) return false;

    entity.destroy();
    return true;
  }

  // Отримання сутності за ID
  get(id) {
    return this.#entities.get(id);
  }

  // Перебір усіх сутностей
  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  // Перебір сутностей певного типу
  *ofKind(kind) {
    for (const entity of this) {
      if (entity.alive && entity.kind === kind) {
        yield entity;
      }
    }
  }

  // Один крок симуляції
  step(dt, inputs = new Map()) {
    this.tick += 1;

    const entities = [...this.#entities.values()];

    // 1. Оновлюємо всі сутності
    for (const entity of entities) {
      if (!entity.alive) continue;

      const entityInput =
        inputs instanceof Map ? inputs.get(entity.id) : inputs?.[entity.id];

      if (typeof entity.setInput === 'function' && entityInput) {
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

  toSnapshot(lastProcessedSeq = 0) {
    return {
      tick: this.tick,
      lastProcessedSeq,
      entities: [...this.#entities.values()].map((entity) => entity.toJSON()),
    };
  }

  applySnapshot(snapshot) {
    this.#entities.clear();

    for (const entityData of snapshot.entities ?? []) {
      const entity = entityFromJSON(entityData);
      this.#entities.set(entity.id, entity);
    }

    if (typeof snapshot.tick === 'number') {
      this.tick = snapshot.tick;
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
        this.emit(event.type, event.detail ?? event);
      }
    }
  }

  toJSON() {
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

  static fromJSON(data, { rng = null } = {}) {
    const world = new World(data.bounds, {
      seed: data.seed ?? 1,
      rng,
    });

    world.tick = data.tick ?? 0;
    world.score = data.score ?? 0;

    for (const entityData of data.entities ?? []) {
      world.#entities.set(entityData.id, entityFromJSON(entityData));
    }

    return world;
  }
}

