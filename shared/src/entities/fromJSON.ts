import { Bullet } from './Bullet.ts';
import { Explosion } from './Explosion.ts';
import { Obstacle } from './Obstacle.ts';
import { Pickup } from './Pickup.ts';
import { Sword } from './Sword.ts';

import type { EntitySnapshot } from '../types.ts';
import type { GameEntity } from './types.ts';

export const entityFromJSON = (data: EntitySnapshot): GameEntity => {
  switch (data.kind) {
    case 'sword':
      return Sword.fromJSON(data);

    case 'bullet':
      return Bullet.fromJSON(data);

    case 'obstacle':
      return Obstacle.fromJSON(data);

    case 'pickup':
      return Pickup.fromJSON(data);

    case 'explosion':
      return Explosion.fromJSON(data);

    default: {
      const exhaustive: never = data;

      throw new Error(`Unknown entity kind: ${JSON.stringify(exhaustive)}`);
    }
  }
};

