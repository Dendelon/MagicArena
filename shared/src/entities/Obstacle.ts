import { Entity, type EntityOptions } from '../sim/entity.ts';
import { MutableVector2, type Vector2View } from '../sim/vector.ts';
import { createHoming, type HomingBehavior } from '../sim/behaviors/homing.ts';

import type { ObstacleSnapshot, Vec2Like } from '../types.ts';
import type { World } from '../sim/world.ts';

const ZERO_VEC: Vec2Like = { x: 0, y: 0 };

export interface ObstacleOptions extends Omit<EntityOptions, 'kind'> {
  hp?: number;
  homing?: HomingBehavior | null;
}

export class Obstacle extends Entity {
  declare readonly kind: 'obstacle';

  readonly #previousPos: MutableVector2;
  hp: number;
  homing: HomingBehavior | null;

  constructor({
    id = null,
    pos = ZERO_VEC,
    vel = ZERO_VEC,
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

    this.#previousPos = new MutableVector2(this.mutablePos.x, this.mutablePos.y);
    this.hp = hp;
    this.homing = homing;
  }

  get previousPos(): Vector2View {
    return this.#previousPos;
  }

  set previousPos(value: Vec2Like) {
    this.#previousPos.copyFrom(value);
  }

  takeDamage(amount = 1): void {
    if (!this.alive) return;

    this.hp = Math.max(0, this.hp - amount);

    if (this.hp === 0) {
      this.destroy();
    }
  }

  override update(dt: number, world?: World): void {
    this.#previousPos.copyFrom(this.mutablePos);

    if (world) {
      this.homing?.update(this, world, dt);
    }

    // Переміщення за допомогою Entity.update()
    super.update(dt);

    if (!world) return;

    let x = this.mutablePos.x;
    let y = this.mutablePos.y;
    let vx = this.mutableVel.x;
    let vy = this.mutableVel.y;

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

    this.mutablePos.set(x, y);
    this.mutableVel.set(vx, vy);
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

