import { MutableVector2, type Vector2View } from './vector.ts';
import { toEntityId } from '../types.ts';

import type {
  BaseEntitySnapshot,
  EntityId,
  EntityKind,
  Vec2Like,
} from '../types.ts';

const ZERO_VEC: Vec2Like = { x: 0, y: 0 };

export interface EntityOptions {
  id?: EntityId | null;
  pos?: Vec2Like;
  vel?: Vec2Like;
  angle?: number;
  radius?: number;
  kind?: EntityKind;
  alive?: boolean;
}

export class Entity {
  static #nextId = 1;

  #id: EntityId;
  readonly #pos: MutableVector2;
  readonly #vel: MutableVector2;

  angle: number;
  radius: number;
  readonly kind: EntityKind;
  alive: boolean;

  constructor({
    id = null,
    pos = ZERO_VEC,
    vel = ZERO_VEC,
    angle = 0,
    radius = 16,
    kind = 'entity',
    alive = true,
  }: EntityOptions = {}) {
    this.#id = Entity.#resolveId(id);
    this.#pos = new MutableVector2(pos.x, pos.y);
    this.#vel = new MutableVector2(vel.x, vel.y);
    this.angle = angle;
    this.radius = radius;
    this.kind = kind;
    this.alive = alive;
  }

  static #resolveId(id?: EntityId | null): EntityId {
    if (id !== null && id !== undefined) {
      if (
        typeof id === 'number' &&
        Number.isInteger(id) &&
        id >= Entity.#nextId
      ) {
        Entity.#nextId = id + 1;
      }

      return id;
    }

    return toEntityId(Entity.#nextId++);
  }

  static resetNextId(value = 1): void {
    Entity.#nextId = value;
  }

  get id(): EntityId {
    return this.#id;
  }

  get pos(): Vector2View {
    return this.#pos;
  }

  set pos(value: Vec2Like) {
    this.#pos.copyFrom(value);
  }

  get vel(): Vector2View {
    return this.#vel;
  }

  set vel(value: Vec2Like) {
    this.#vel.copyFrom(value);
  }

  protected get mutablePos(): MutableVector2 {
    return this.#pos;
  }

  protected get mutableVel(): MutableVector2 {
    return this.#vel;
  }

  setVelocity(vx: number, vy: number): void {
    this.#vel.set(vx, vy);
  }

  protected reinitEntity({
    id = null,
    pos = ZERO_VEC,
    vel = ZERO_VEC,
    angle = 0,
    radius = 16,
    alive = true,
  }: Omit<EntityOptions, 'kind'> = {}): void {
    this.#id = Entity.#resolveId(id);
    this.#pos.copyFrom(pos);
    this.#vel.copyFrom(vel);
    this.angle = angle;
    this.radius = radius;
    this.alive = alive;
  }

  update(dt: number): void {
    this.#pos.addScaled(this.#vel, dt);
  }

  destroy(): void {
    this.alive = false;
  }

  toJSON(): BaseEntitySnapshot {
    return {
      id: this.#id,
      kind: this.kind,
      pos: this.#pos.toJSON(),
      vel: this.#vel.toJSON(),
      angle: this.angle,
      radius: this.radius,
      alive: this.alive,
    };
  }

  static fromJSON(data: BaseEntitySnapshot): Entity {
    return new Entity({
      id: data.id,
      pos: data.pos,
      vel: data.vel,
      angle: data.angle,
      radius: data.radius,
      kind: data.kind,
      alive: data.alive,
    });
  }
}

