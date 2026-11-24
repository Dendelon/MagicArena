// Перевірка перетину двох кіл
export const circlesOverlap = (a, b) => {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;

  const radiusSum = a.radius + b.radius;

  return dx * dx + dy * dy <= radiusSum * radiusSum;
};

// Генерує пари сутностей, які зіткнулися
export function* collisionPairs(world) {
  const entities = [...world].filter(
    (entity) => entity.alive && entity.radius > 0,
  );

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

// Обробка зіткнень
export const resolveCollisions = (world) => {
  for (const [a, b] of collisionPairs(world)) {
    if (!a.alive || !b.alive) continue;

    // Шукаємо снаряд серед двох об'єктів
    const bullet =
      a.kind === 'bullet' ? a :
      b.kind === 'bullet' ? b : null;

    // Шукаємо перешкоду
    const obstacle =
      a.kind === 'obstacle' ? a :
      b.kind === 'obstacle' ? b : null;

    // Поки обробляємо лише влучання у камені
    if (bullet && obstacle) {
      world.despawn(bullet.id);
      world.despawn(obstacle.id);
    }
  }
};
