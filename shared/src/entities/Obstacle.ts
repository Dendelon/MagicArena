import { Entity, type EntityOptions } from '../sim/entity.ts';
import { Vector2 } from '../sim/vector.ts';
import { createHoming, type HomingBehavior } from '../sim/behaviors/homing.ts';

import type { ObstacleSnapshot } from '../types.ts';
import type { World } from '../sim/world.ts';

export interface ObstacleOptions extends Omit<EntityOptions, 'kind'> {
  hp?: number;
  homing?: HomingBehavior | null;
}

export class Obstacle extends Entity {
  declare readonly kind: 'obstacle';

  previousPos: Vector2;
  hp: number;
  homing: HomingBehavior | null;

  constructor({
    id = null,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 26,
    hp = 1,
    alive = true,
    homing = null,
  }: ObstacleOptions = {}) {
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

  takeDamage(amount = 1): void {
    if (!this.alive) return;

    this.hp = Math.max(0, this.hp - amount);

    if (this.hp === 0) {
      this.destroy();
    }
  }

  override update(dt: number, world?: World): void {
    this.previousPos = this.pos;

    if (world) {
      this.homing?.update(this, world, dt);
    }

    // Переміщення за допомогою Entity.update()
    super.update(dt);

    if (!world) return;

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

  override toJSON(): ObstacleSnapshot {
    return {
      ...super.toJSON(),
      kind: this.kind,
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

  static override fromJSON(data: ObstacleSnapshot): Obstacle {
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

