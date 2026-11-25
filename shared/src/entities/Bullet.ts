import { Entity, type EntityOptions } from '../sim/entity.ts';
import { Vector2 } from '../sim/vector.ts';
import { wrap } from '../sim/arena.ts';
import { createHoming, type HomingBehavior } from '../sim/behaviors/homing.ts';

import type {
  BulletSnapshot,
  EntityId,
  PlayerId,
  Seq,
} from '../types.ts';
import type { World } from '../sim/world.ts';

export interface BulletOptions extends Omit<EntityOptions, 'kind'> {
  ttl?: number;
  ownerId?: EntityId | null;
  ownerPlayerId?: PlayerId | null;
  originSeq?: Seq | null;
  damage?: number;
  homing?: HomingBehavior | null;
}

export class Bullet extends Entity {
  declare readonly kind: 'bullet';

  ttl: number;
  ownerId: EntityId | null;
  ownerPlayerId: PlayerId | null;
  originSeq: Seq | null;
  damage: number;
  homing: HomingBehavior | null;
  previousPos: Vector2;

  constructor({
    id = null,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    ttl = 1.5,
    radius = 6,
    ownerId = null,
    ownerPlayerId = null,
    originSeq = null,
    damage = 1,
    alive = true,
    homing = null,
  }: BulletOptions = {}) {
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
    this.ownerPlayerId = ownerPlayerId;
    this.originSeq = originSeq;
    this.damage = damage;
    this.homing = homing;

    this.previousPos = this.pos;
  }

  override update(dt: number, world?: World): void {
    this.previousPos = this.pos;

    if (world) {
      this.homing?.update(this, world, dt);
    }

    super.update(dt);

    if (world) {
      this.pos = new Vector2(
        wrap(this.pos.x, world.width),
        wrap(this.pos.y, world.height),
      );
    }

    this.ttl -= dt;

    if (this.ttl <= 0) {
      this.destroy();
    }
  }

  override toJSON(): BulletSnapshot {
    return {
      ...super.toJSON(),
      kind: this.kind,
      ttl: this.ttl,
      ownerId: this.ownerId,
      ownerPlayerId: this.ownerPlayerId,
      originSeq: this.originSeq,
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

  static override fromJSON(data: BulletSnapshot): Bullet {
    return new Bullet({
      id: data.id,
      pos: data.pos,
      vel: data.vel,
      angle: data.angle,
      ttl: data.ttl,
      radius: data.radius,
      ownerId: data.ownerId,
      ownerPlayerId: data.ownerPlayerId ?? null,
      originSeq: data.originSeq ?? null,
      damage: data.damage,
      alive: data.alive,
      homing: data.homing ? createHoming(data.homing) : null,
    });
  }
}

