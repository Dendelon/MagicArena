import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.js';
import { integrate } from '../sim/sword.js';
import { Bullet } from './Bullet.js';

const BULLET_SPEED = 550;
const SWORD_TIP_OFFSET = 60;

export class Sword extends Entity {
  #hp = 3;
  #damageCooldown = 0;

  get hp() {
    return this.#hp;
  }

  takeDamage(amount = 1) {
    if (!this.alive || this.#damageCooldown > 0) {
      return false;
    }

    this.#hp = Math.max(0, this.#hp - amount);
    this.#damageCooldown = 0.8;

    if (this.#hp === 0) {
      this.destroy();
    }

    return true;
  }

  constructor({ pos = new Vector2(), vel = new Vector2(), angle = 0 } = {}) {
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
    this.#damageCooldown = Math.max(0, this.#damageCooldown - dt);

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

  fire(world) {
    const direction = Vector2.fromAngle(this.angle - Math.PI / 2);

    const pos = this.pos.add(direction.scale(SWORD_TIP_OFFSET));

    const vel = this.vel.add(direction.scale(BULLET_SPEED));

    const bullet = new Bullet({
      pos: new Vector2(
        ((pos.x % world.width) + world.width) % world.width,
        ((pos.y % world.height) + world.height) % world.height,
      ),
      vel,
      ownerId: this.id,
    });

    world.spawn(bullet);

    return bullet;
  }
}
