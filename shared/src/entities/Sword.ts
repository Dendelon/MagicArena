import { Entity, type EntityOptions } from '../sim/entity.ts';
import { Vector2 } from '../sim/vector.ts';
import { integrateInto, type MutableSwordState } from '../sim/sword.ts';
import { wrap } from '../sim/arena.ts';
import type { Bullet } from './Bullet.ts';

import type {
  Bounds,
  PlayerId,
  Seq,
  SwordControls,
  SwordInput,
  SwordSnapshot,
  Vec2Like,
} from '../types.ts';
import type { World } from '../sim/world.ts';

const BULLET_SPEED = 550;
const SWORD_TIP_OFFSET = 60;
const ZERO_VEC: Vec2Like = { x: 0, y: 0 };

interface MutableControls {
  left: boolean;
  right: boolean;
  forward: boolean;
  brake: boolean;
}

export interface SwordOptions extends Omit<EntityOptions, 'kind'> {
  ownerId?: PlayerId | null;
  hp?: number;
  damageCooldown?: number;
  input?: SwordInput | null;
}

interface BulletSpawnOptions {
  pos: Vec2Like;
  vel: Vec2Like;
  angle: number;
  world: Bounds;
}

interface BulletSpawn {
  pos: Vector2;
  vel: Vector2;
}

export class Sword extends Entity {
  declare readonly kind: 'sword';

  #hp: number;
  #damageCooldown: number;
  readonly #controls: MutableControls;
  readonly #simState: MutableSwordState;

  ownerId: PlayerId | null;

  get hp(): number {
    return this.#hp;
  }

  get damageCooldown(): number {
    return this.#damageCooldown;
  }

  takeDamage(amount = 1): boolean {
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

  heal(amount = 1): boolean {
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
    pos = ZERO_VEC,
    vel = ZERO_VEC,
    angle = 0,
    radius = 22,
    alive = true,
    hp = 3,
    damageCooldown = 0,
    input = null,
  }: SwordOptions = {}) {
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

    this.#controls = {
      left: false,
      right: false,
      forward: false,
      brake: false,
    };

    this.#simState = {
      x: this.mutablePos.x,
      y: this.mutablePos.y,
      vx: this.mutableVel.x,
      vy: this.mutableVel.y,
      angle: this.angle,
    };

    if (input) {
      this.setInput(input);
    }
  }

  get input(): SwordControls {
    return this.#controls;
  }

  set input(value: SwordInput) {
    this.setInput(value);
  }

  setInput(input: SwordInput = {}): void {
    const turn = typeof input.turn === 'number' ? input.turn : null;

    this.#controls.left = turn !== null ? turn < 0 : Boolean(input.left);
    this.#controls.right = turn !== null ? turn > 0 : Boolean(input.right);
    this.#controls.forward = Boolean(input.thrust ?? input.forward);
    this.#controls.brake = Boolean(input.brake);
  }

  override update(dt: number, world?: World): void {
    this.#damageCooldown = Math.max(0, this.#damageCooldown - dt);

    if (!world) return;

    this.#simState.x = this.mutablePos.x;
    this.#simState.y = this.mutablePos.y;
    this.#simState.vx = this.mutableVel.x;
    this.#simState.vy = this.mutableVel.y;
    this.#simState.angle = this.angle;

    integrateInto(this.#simState, this.#simState, this.#controls, dt, world);

    this.mutablePos.set(this.#simState.x, this.#simState.y);
    this.mutableVel.set(this.#simState.vx, this.#simState.vy);
    this.angle = this.#simState.angle;
  }

  static createBulletSpawn({
    pos,
    vel,
    angle,
    world,
  }: BulletSpawnOptions): BulletSpawn {
    const direction = Vector2.fromAngle(angle - Math.PI / 2);
    const spawnPos = Vector2.fromJSON(pos).add(direction.scale(SWORD_TIP_OFFSET));
    const spawnVel = Vector2.fromJSON(vel).add(direction.scale(BULLET_SPEED));

    return {
      pos: new Vector2(wrap(spawnPos.x, world.width), wrap(spawnPos.y, world.height)),
      vel: spawnVel,
    };
  }

  fire(
    world: World,
    { originSeq = null }: { originSeq?: Seq | null } = {},
  ): Bullet {
    const dirAngle = this.angle - Math.PI / 2;
    const dirX = Math.cos(dirAngle);
    const dirY = Math.sin(dirAngle);
    const spawnX = wrap(this.mutablePos.x + dirX * SWORD_TIP_OFFSET, world.width);
    const spawnY = wrap(this.mutablePos.y + dirY * SWORD_TIP_OFFSET, world.height);
    const spawnVx = this.mutableVel.x + dirX * BULLET_SPEED;
    const spawnVy = this.mutableVel.y + dirY * BULLET_SPEED;

    const bullet = world.createBullet({
      pos: { x: spawnX, y: spawnY },
      vel: { x: spawnVx, y: spawnVy },
      ownerId: this.id,
      ownerPlayerId: this.ownerId,
      originSeq,
    });

    return world.spawn(bullet);
  }

  override toJSON(): SwordSnapshot {
    return {
      ...super.toJSON(),
      kind: this.kind,
      ownerId: this.ownerId,
      hp: this.#hp,
      damageCooldown: this.#damageCooldown,
      thrust: Boolean(this.input.forward),
    };
  }

  static override fromJSON(
    data: SwordSnapshot & {
      readonly input?: SwordInput | null;
    },
  ): Sword {
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

