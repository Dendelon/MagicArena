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

export const resolveCollisions = (world) => {
  for (const [a, b] of collisionPairs(world)) {
    if (!a.alive || !b.alive) continue;

    const bullet = a.kind === 'bullet' ? a : b.kind === 'bullet' ? b : null;

    const obstacle = a.kind === 'obstacle' ? a : b.kind === 'obstacle' ? b : null;

    const sword = a.kind === 'sword' ? a : b.kind === 'sword' ? b : null;

    const pickup = a.kind === 'pickup' ? a : b.kind === 'pickup' ? b : null;

    // Підбирання магічного кристала
    if (sword && pickup) {
      pickup.collect(sword, world);
      continue;
    }

    // Влучання снаряда в камінь
    if (bullet && obstacle) {
      world.despawn(bullet.id);

      obstacle.takeDamage(bullet.damage);

      if (!obstacle.alive) {
        world.spawn(
          new Explosion({
            pos: obstacle.pos,
          }),
        );

        world.score += 10;
      }
    }

    // Влучання чужого снаряда в меч
    else if (bullet && sword) {
      if (bullet.ownerId === sword.id) continue;

      world.despawn(bullet.id);

      const damaged = sword.takeDamage(bullet.damage);

      if (damaged && !sword.alive) {
        world.spawn(
          new Explosion({
            pos: sword.pos,
            count: 35,
            color: '#66e0ff',
          }),
        );
      }
    }

    // Зіткнення меча з каменем
    else if (sword && obstacle) {
      const damaged = sword.takeDamage(1);

      if (damaged && !sword.alive) {
        world.spawn(
          new Explosion({
            pos: sword.pos,
            count: 35,
            color: '#66e0ff',
          }),
        );
      }
    }
  }
};
