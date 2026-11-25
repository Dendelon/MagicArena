import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.js';
import { wrap } from '../sim/arena.js';
import { createHoming } from '../sim/behaviors/homing.js';

export class Bullet extends Entity {
  constructor({
    id = null,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    ttl = 1.5,
    radius = 6,
    ownerId = null,
    damage = 1,
    alive = true,
    homing = null,
  } = {}) {
    super({
      id,
      pos,
      vel,
      angle,
      radius,
      kind: 'bullet',
      alive,
    });

    this.ttl = ttl;
    this.ownerId = ownerId;
    this.damage = damage;
    this.homing = homing;

    this.previousPos = this.pos;
  }

  update(dt, world) {
    this.previousPos = this.pos;

    this.homing?.update(this, world, dt);

    super.update(dt);

    this.pos = new Vector2(wrap(this.pos.x, world.width), wrap(this.pos.y, world.height));

    this.ttl -= dt;

    if (this.ttl <= 0) {
      this.destroy();
    }
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ttl: this.ttl,
      ownerId: this.ownerId,
      damage: this.damage,
      homing: this.homing
        ? {
            targetKind: this.homing.targetKind,
            turnRate: this.homing.turnRate,
            speed: this.homing.speed ?? null,
          }
        : null,
    };
  }

  static fromJSON(data) {
    return new Bullet({
      id: data.id,
      pos: data.pos,
      vel: data.vel,
      angle: data.angle,
      ttl: data.ttl,
      radius: data.radius,
      ownerId: data.ownerId,
      damage: data.damage,
      alive: data.alive,
      homing: data.homing ? createHoming(data.homing) : null,
    });
  }
}

