import { Entity, type EntityOptions } from '../sim/entity.ts';
import { MutableVector2, type Vector2View } from '../sim/vector.ts';
import { wrap } from '../sim/arena.ts';
import { createHoming, type HomingBehavior } from '../sim/behaviors/homing.ts';

import type {
  BulletSnapshot,
  EntityId,
  PlayerId,
  Seq,
  Vec2Like,
} from '../types.ts';
import type { World } from '../sim/world.ts';

const ZERO_VEC: Vec2Like = { x: 0, y: 0 };

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

  readonly #previousPos: MutableVector2;

  ttl: number;
  ownerId: EntityId | null;
  ownerPlayerId: PlayerId | null;
  originSeq: Seq | null;
  damage: number;
  homing: HomingBehavior | null;

  constructor({
    id = null,
    pos = ZERO_VEC,
    vel = ZERO_VEC,
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

    this.#previousPos = new MutableVector2(this.mutablePos.x, this.mutablePos.y);
    this.ttl = ttl;
    this.ownerId = ownerId;
    this.ownerPlayerId = ownerPlayerId;
    this.originSeq = originSeq;
    this.damage = damage;
    this.homing = homing;
  }

  get previousPos(): Vector2View {
    return this.#previousPos;
  }

  set previousPos(value: Vec2Like) {
    this.#previousPos.copyFrom(value);
  }

  resetFromPool({
    id = null,
    pos = ZERO_VEC,
    vel = ZERO_VEC,
    angle = 0,
    ttl = 1.5,
    radius = 6,
    ownerId = null,
    ownerPlayerId = null,
    originSeq = null,
    damage = 1,
    alive = true,
    homing = null,
  }: BulletOptions = {}): void {
    if (this.alive) {
      throw new Error('Cannot reset an active Bullet');
    }

    this.reinitEntity({
      id,
      pos,
      vel,
      angle,
      radius,
      alive,
    });

    this.#previousPos.copyFrom(this.mutablePos);
    this.ttl = ttl;
    this.ownerId = ownerId;
    this.ownerPlayerId = ownerPlayerId;
    this.originSeq = originSeq;
    this.damage = damage;
    this.homing = homing;
  }

  override update(dt: number, world?: World): void {
    this.#previousPos.copyFrom(this.mutablePos);

    if (world) {
      this.homing?.update(this, world, dt);
    }

    super.update(dt);

    if (world) {
      this.mutablePos.set(
        wrap(this.mutablePos.x, world.width),
        wrap(this.mutablePos.y, world.height),
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

