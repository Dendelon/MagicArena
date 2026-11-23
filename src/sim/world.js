export class World {
  #entities = new Map();

  constructor(bounds) {
    this.bounds = bounds;
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

    for (const entity of entities) {
      if (!entity.alive) continue;

      if (
        typeof entity.setInput === 'function' &&
        inputs.has(entity.id)
      ) {
        entity.setInput(inputs.get(entity.id));
      }

      entity.update(dt, this);
    }

    // Пізніше тут буде перевірка зіткнень

    // Остаточне видалення мертвих сутностей
    for (const [id, entity] of this.#entities) {
      if (!entity.alive) {
        this.#entities.delete(id);
      }
    }
  }
}
