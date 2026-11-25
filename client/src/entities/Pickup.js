import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.js';

export class Pickup extends Entity {
  constructor({ pos = new Vector2(), radius = 18, effect = null } = {}) {
    super({
      pos,
      radius,
      kind: 'pickup',
    });

    this.effect = effect;
  }

  collect(entity, world) {
    if (!this.alive || !entity.alive) {
      return false;
    }

    const applied = this.effect?.apply(entity) ?? false;

    if (applied) {
      world.despawn(this.id);
    }

    return applied;
  }
}
