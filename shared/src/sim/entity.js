import { Vector2 } from './vector.ts';

export class Entity {
  static #nextId = 1;

  #id;

  constructor({
    id = null,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 16,
    kind = 'entity',
    alive = true,
  } = {}) {
    if (id !== null && id !== undefined) {
      this.#id = id;
      if (Number.isInteger(id) && id >= Entity.#nextId) {
        Entity.#nextId = id + 1;
      }
    } else {
      this.#id = Entity.#nextId++;
    }

    this.pos = Vector2.fromJSON(pos);
    this.vel = Vector2.fromJSON(vel);
    this.angle = angle;
    this.radius = radius;
    this.kind = kind;
    this.alive = alive;
  }

  static resetNextId(value = 1) {
    Entity.#nextId = value;
  }

  get id() {
    return this.#id;
  }

  update(dt) {
    this.pos = this.pos.add(this.vel.scale(dt));
  }

  destroy() {
    this.alive = false;
  }

  toJSON() {
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

  static fromJSON(data) {
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

