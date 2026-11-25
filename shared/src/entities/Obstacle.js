import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.ts';
import { createHoming } from '../sim/behaviors/homing.js';

export class Obstacle extends Entity {
  constructor({
    id = null,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 26,
    hp = 1,
    alive = true,
    homing = null,
  } = {}) {
    super({
      id,
      pos,
      vel,
      angle,
      radius,
      kind: 'obstacle',
      alive,
    });

    this.previousPos = this.pos;
    this.hp = hp;
    this.homing = homing;
  }

  takeDamage(amount = 1) {
    if (!this.alive) return;

    this.hp = Math.max(0, this.hp - amount);

    if (this.hp === 0) {
      this.destroy();
    }
  }

  update(dt, world) {
    this.previousPos = this.pos;

    this.homing?.update(this, world, dt);

    // Переміщення за допомогою Entity.update()
    super.update(dt);

    let x = this.pos.x;
    let y = this.pos.y;
    let vx = this.vel.x;
    let vy = this.vel.y;

    // Межі, за які центр каменя не повинен виходити
    const minX = Math.min(this.radius, world.width / 2);
    const maxX = Math.max(minX, world.width - this.radius);

    const minY = Math.min(this.radius, world.height / 2);
    const maxY = Math.max(minY, world.height - this.radius);

    // Відбивання від вертикальних меж
    if (x < minX) {
      x = minX;
      vx = Math.abs(vx);
    } else if (x > maxX) {
      x = maxX;
      vx = -Math.abs(vx);
    }

    // Відбивання від горизонтальних меж
    if (y < minY) {
      y = minY;
      vy = Math.abs(vy);
    } else if (y > maxY) {
      y = maxY;
      vy = -Math.abs(vy);
    }

    this.pos = new Vector2(x, y);
    this.vel = new Vector2(vx, vy);
  }

  toJSON() {
    return {
      ...super.toJSON(),
      hp: this.hp,
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
    return new Obstacle({
      id: data.id,
      pos: data.pos,
      vel: data.vel,
      angle: data.angle,
      radius: data.radius,
      hp: data.hp,
      alive: data.alive,
      homing: data.homing ? createHoming(data.homing) : null,
    });
  }
}

