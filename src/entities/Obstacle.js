import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.js';

export class Obstacle extends Entity {
  constructor({ pos = new Vector2(), vel = new Vector2(), radius = 26 } = {}) {
    super({
      pos,
      vel,
      radius,
      kind: 'obstacle',
    });

    this.previousPos = pos;
    this.hp = 1;
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
}
