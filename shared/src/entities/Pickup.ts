import { Entity, type EntityOptions } from '../sim/entity.ts';
import { Vector2 } from '../sim/vector.ts';
import {
  createHealingEffect,
  type HealingEffect,
} from '../sim/behaviors/healing.ts';

import type { PickupSnapshot } from '../types.ts';
import type { Sword } from './Sword.ts';
import type { World } from '../sim/world.ts';

export interface PickupOptions extends Omit<EntityOptions, 'kind'> {
  effect?: HealingEffect | null;
}

export class Pickup extends Entity {
  declare readonly kind: 'pickup';

  effect: HealingEffect | null;

  constructor({
    id = null,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 18,
    alive = true,
    effect = null,
  }: PickupOptions = {}) {
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

  collect(entity: Sword, world: World): boolean {
    if (!this.alive || !entity.alive) {
      return false;
    }

    const applied = this.effect?.apply(entity) ?? false;

    if (applied) {
      world.despawn(this.id);
    }

    return applied;
  }

  override toJSON(): PickupSnapshot {
    return {
      ...super.toJSON(),
      kind: this.kind,
      effect: this.effect
        ? {
            kind: this.effect.kind ?? 'healing',
            amount: this.effect.amount ?? 1,
          }
        : null,
    };
  }

  static override fromJSON(data: PickupSnapshot): Pickup {
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

