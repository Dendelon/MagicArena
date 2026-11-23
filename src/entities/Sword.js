
import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.js';
import { integrate } from '../sim/sword.js';

export class Sword extends Entity {
  constructor({
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
  } = {}) {
    super({
      pos,
      vel,
      angle,
      radius: 22,
      kind: 'sword',
    });

    this.input = {
      left: false,
      right: false,
      forward: false,
      brake: false,
    };
  }

  setInput(input) {
    this.input = { ...input };
  }

  update(dt, world) {
    const state = {
      x: this.pos.x,
      y: this.pos.y,
      vx: this.vel.x,
      vy: this.vel.y,
      angle: this.angle,
    };

    const next = integrate(state, this.input, dt, world);

    this.pos = new Vector2(next.x, next.y);
    this.vel = new Vector2(next.vx, next.vy);
    this.angle = next.angle;
  }
}
