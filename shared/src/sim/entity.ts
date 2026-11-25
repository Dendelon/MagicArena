import { Vector2 } from './vector.ts';
import { toEntityId } from '../types.ts';

import type {
  BaseEntitySnapshot,
  EntityId,
  EntityKind,
  Vec2Like,
} from '../types.ts';

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

  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  readonly kind: EntityKind;
  alive: boolean;

  constructor({
    id = null,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 16,
    kind = 'entity',
    alive = true,
  }: EntityOptions = {}) {
    if (id !== null && id !== undefined) {
      this.#id = id;

      if (
        typeof id === 'number' &&
        Number.isInteger(id) &&
        id >= Entity.#nextId
      ) {
        Entity.#nextId = id + 1;
      }
    } else {
      this.#id = toEntityId(Entity.#nextId++);
    }

    this.pos = Vector2.fromJSON(pos);
    this.vel = Vector2.fromJSON(vel);
    this.angle = angle;
    this.radius = radius;
    this.kind = kind;
    this.alive = alive;
  }

  static resetNextId(value = 1): void {
    Entity.#nextId = value;
  }

  get id(): EntityId {
    return this.#id;
  }

  update(dt: number): void {
    this.pos = this.pos.add(this.vel.scale(dt));
  }

  destroy(): void {
    this.alive = false;
  }

  toJSON(): BaseEntitySnapshot {
    return {
      id: this.#id,
      kind: this.kind,
      pos: this.pos.toJSON(),
      vel: this.vel.toJSON(),
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

