import { Entity } from '../sim/entity.js';
import { Bullet } from './Bullet.js';
import { Explosion } from './Explosion.js';
import { Obstacle } from './Obstacle.js';
import { Pickup } from './Pickup.js';
import { Sword } from './Sword.js';

const ENTITY_BUILDERS = {
  sword: Sword.fromJSON,
  bullet: Bullet.fromJSON,
  obstacle: Obstacle.fromJSON,
  pickup: Pickup.fromJSON,
  explosion: Explosion.fromJSON,
};

export const entityFromJSON = (data) => {
  const build = ENTITY_BUILDERS[data?.kind] ?? Entity.fromJSON;

  return build(data);
};

