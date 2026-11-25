import type { Sword } from './Sword.ts';
import type { Bullet } from './Bullet.ts';
import type { Obstacle } from './Obstacle.ts';
import type { Pickup } from './Pickup.ts';
import type { Explosion } from './Explosion.ts';

export type GameEntity = Sword | Bullet | Obstacle | Pickup | Explosion;

export type EntityOfKind<K extends GameEntity['kind']> = Extract<
  GameEntity,
  { kind: K }
>;

