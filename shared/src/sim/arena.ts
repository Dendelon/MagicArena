import { Vector2 } from './vector.ts';

import type { RandomSource } from '../types.ts';
import type { World } from './world.ts';

export const wrap = (value: number, max: number): number => {
  if (max <= 0) return 0;

  return ((value % max) + max) % max;
};

export const findSafeSpawn = (
  world: World,
  rng: RandomSource = world.rng,
): Vector2 => {
  const obstacles = [...world.ofKind('obstacle')];

  let bestPosition = new Vector2(world.width / 2, world.height / 2);
  let bestClearance = -Infinity;

  const padding = Math.min(60, world.width / 4, world.height / 4);

  for (let i = 0; i < 40; i++) {
    const pos = new Vector2(
      padding + rng() * (world.width - padding * 2),
      padding + rng() * (world.height - padding * 2),
    );

    const clearance =
      obstacles.length === 0
        ? Infinity
        : Math.min(
            ...obstacles.map(
              (obstacle) => pos.sub(obstacle.pos).length() - obstacle.radius - 22,
            ),
          );

    if (clearance > 55) return pos;

    if (clearance > bestClearance) {
      bestClearance = clearance;
      bestPosition = pos;
    }
  }

  return bestPosition;
};

