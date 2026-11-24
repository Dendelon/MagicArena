import { Explosion } from '../entities/Explosion.js';

export const circlesOverlap = (a, b) => {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;

  const radiusSum = a.radius + b.radius;

  return dx * dx + dy * dy <= radiusSum * radiusSum;
};

export function* collisionPairs(world) {
  const entities = [...world].filter((entity) => entity.alive && entity.radius > 0);

  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i];
      const b = entities[j];

      if (circlesOverlap(a, b)) {
        yield [a, b];
      }
    }
  }
}

const explode = (world, entity, { count = 20, color = '#b794f6' } = {}) => {
  world.spawn(
    new Explosion({
      pos: entity.pos,
      count,
      color,
    }),
  );

  world.emit('exploded', {
    kind: entity.kind,
    pos: entity.pos,
  });
};

export const resolveCollisions = (world) => {
  for (const [a, b] of collisionPairs(world)) {
    if (!a.alive || !b.alive) continue;

    const bullet = a.kind === 'bullet' ? a : b.kind === 'bullet' ? b : null;

    const obstacle = a.kind === 'obstacle' ? a : b.kind === 'obstacle' ? b : null;

    const sword = a.kind === 'sword' ? a : b.kind === 'sword' ? b : null;

    const pickup = a.kind === 'pickup' ? a : b.kind === 'pickup' ? b : null;

    // Підбирання кристала
    if (sword && pickup) {
      if (pickup.collect(sword, world)) {
        world.emit('healed', { hp: sword.hp });
      }
      continue;
    }

    // Снаряд потрапив у камінь
    if (bullet && obstacle) {
      world.despawn(bullet.id);
      obstacle.takeDamage(bullet.damage);

      world.emit('hit', {
        kind: 'obstacle',
        pos: obstacle.pos,
      });

      if (!obstacle.alive) {
        explode(world, obstacle);

        world.score += 10;

        world.emit('scoreChanged', {
          score: world.score,
        });
      }
    }

    // Чужий снаряд потрапив у меч
    else if (bullet && sword) {
      if (bullet.ownerId === sword.id) continue;

      world.despawn(bullet.id);

      const damaged = sword.takeDamage(bullet.damage);

      if (damaged) {
        world.emit('hit', {
          kind: 'sword',
          pos: sword.pos,
        });
      }

      if (damaged && !sword.alive) {
        explode(world, sword, {
          count: 35,
          color: '#66e0ff',
        });
      }
    }

    // Меч зіткнувся з каменем
    else if (sword && obstacle) {
      const damaged = sword.takeDamage(1);

      if (damaged) {
        world.emit('hit', {
          kind: 'sword',
          pos: sword.pos,
        });
      }

      if (damaged && !sword.alive) {
        explode(world, sword, {
          count: 35,
          color: '#66e0ff',
        });
      }
    }
  }
};
