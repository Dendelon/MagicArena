import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.js';
import { integrate } from '../sim/sword.js';
import { wrap } from '../sim/arena.js';
import { Bullet } from './Bullet.js';

const BULLET_SPEED = 550;
const SWORD_TIP_OFFSET = 60;

export class Sword extends Entity {
  #hp;
  #damageCooldown;

  get hp() {
    return this.#hp;
  }

  get damageCooldown() {
    return this.#damageCooldown;
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

  heal(amount = 1) {
    if (!this.alive || amount <= 0) {
      return false;
    }

    const previousHp = this.#hp;

    this.#hp = Math.min(3, this.#hp + amount);

    return this.#hp > previousHp;
  }

  constructor({
    id = null,
    ownerId = null,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 22,
    alive = true,
    hp = 3,
    damageCooldown = 0,
    input = null,
  } = {}) {
    super({
      id,
      pos,
      vel,
      angle,
      radius,
      kind: 'sword',
      alive,
    });

    this.ownerId = ownerId;
    this.#hp = hp;
    this.#damageCooldown = damageCooldown;

    this.input = {
      left: false,
      right: false,
      forward: false,
      brake: false,
    };

    if (input) {
      this.setInput(input);
    }
  }

  setInput(input = {}) {
    const turn = typeof input.turn === 'number' ? input.turn : null;

    this.input = {
      left: turn !== null ? turn < 0 : Boolean(input.left),
      right: turn !== null ? turn > 0 : Boolean(input.right),
      forward: Boolean(input.thrust ?? input.forward),
      brake: Boolean(input.brake),
    };
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

  static createBulletSpawn({ pos, vel, angle, world }) {
    const direction = Vector2.fromAngle(angle - Math.PI / 2);
    const spawnPos = Vector2.fromJSON(pos).add(direction.scale(SWORD_TIP_OFFSET));
    const spawnVel = Vector2.fromJSON(vel).add(direction.scale(BULLET_SPEED));

    return {
      pos: new Vector2(wrap(spawnPos.x, world.width), wrap(spawnPos.y, world.height)),
      vel: spawnVel,
    };
  }

  fire(world, { originSeq = null } = {}) {
    const { pos, vel } = Sword.createBulletSpawn({
      pos: this.pos,
      vel: this.vel,
      angle: this.angle,
      world,
    });

    const bullet = new Bullet({
      pos,
      vel,
      ownerId: this.id,
      ownerPlayerId: this.ownerId,
      originSeq,
    });

    world.spawn(bullet);

    return bullet;
  }

  toJSON() {
    return {
      ...super.toJSON(),
      ownerId: this.ownerId,
      hp: this.#hp,
      damageCooldown: this.#damageCooldown,
      thrust: Boolean(this.input.forward),
    };
  }

  static fromJSON(data) {
    return new Sword({
      id: data.id,
      ownerId: data.ownerId ?? null,
      pos: data.pos,
      vel: data.vel,
      angle: data.angle,
      radius: data.radius,
      alive: data.alive,
      hp: data.hp,
      damageCooldown: data.damageCooldown,
      input:
        data.thrust !== undefined
          ? { forward: Boolean(data.thrust) }
          : (data.input ?? null),
    });
  }
}

