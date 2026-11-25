import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.js';
import { createHealingEffect } from '../sim/behaviors/healing.js';

export class Pickup extends Entity {
  constructor({
    id = null,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 18,
    alive = true,
    effect = null,
  } = {}) {
    super({
      id,
      pos,
      vel,
      angle,
      radius,
      kind: 'pickup',
      alive,
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

  toJSON() {
    return {
      ...super.toJSON(),
      effect: this.effect
        ? {
            kind: this.effect.kind ?? 'healing',
            amount: this.effect.amount ?? 1,
          }
        : null,
    };
  }

  static fromJSON(data) {
    return new Pickup({
      id: data.id,
      pos: data.pos,
      vel: data.vel,
      angle: data.angle,
      radius: data.radius,
      alive: data.alive,
      effect:
        data.effect?.kind === 'healing'
          ? createHealingEffect(data.effect.amount)
          : null,
    });
  }
}

