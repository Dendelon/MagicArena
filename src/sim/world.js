import { resolveCollisions } from './collision.js';

export class World extends EventTarget {
  #entities = new Map();

  constructor(bounds) {
    super();

    this.bounds = bounds;
    this.score = 0;
  }

  emit(name, detail = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
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
    const entities = [...this.#entities.values()];

    // 1. Оновлюємо всі сутності
    for (const entity of entities) {
      if (!entity.alive) continue;

      if (typeof entity.setInput === 'function' && inputs.has(entity.id)) {
        entity.setInput(inputs.get(entity.id));
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
}
