import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.js';
import { wrap } from '../sim/arena.js';

export class Bullet extends Entity {
  constructor({
    pos = new Vector2(),
    vel = new Vector2(),
    ttl = 1.5,
    radius = 6,
    ownerId = null,
    damage = 1,
  } = {}) {
    super({
      pos,
      vel,
      radius,
      kind: 'bullet',
    });

    this.ttl = ttl;
    this.ownerId = ownerId;
    this.damage = damage;

    this.previousPos = pos;
  }

  update(dt, world) {
    this.previousPos = this.pos;

    super.update(dt);

    this.pos = new Vector2(
      wrap(this.pos.x, world.width),
      wrap(this.pos.y, world.height),
    );

    this.ttl -= dt;

    if (this.ttl <= 0) {
      this.destroy();
    }
  }
}
