import { Vector2 } from '../vector.js';

export const createHoming = ({ targetKind, turnRate = 3, speed = null }) => {
  const update = (entity, world, dt) => {
    let target = null;
    let nearestDistance = Infinity;

    // Шукаємо найближчу ціль
    for (const candidate of world.ofKind(targetKind)) {
      if (candidate.id === entity.id) continue;

      const distance = candidate.pos.sub(entity.pos).length();

      if (distance < nearestDistance && distance > 0) {
        nearestDistance = distance;
        target = candidate;
      }
    }

    if (!target) return;

    // Напрямок до цілі
    const direction = target.pos.sub(entity.pos);

    const targetAngle = Math.atan2(direction.y, direction.x);

    const currentSpeed = entity.vel.length();
    const movementSpeed = speed ?? currentSpeed;

    if (movementSpeed <= 0) return;

    const currentAngle =
      currentSpeed > 0 ? Math.atan2(entity.vel.y, entity.vel.x) : targetAngle;

    // Найкоротша різниця між кутами
    const angleDifference = Math.atan2(
      Math.sin(targetAngle - currentAngle),
      Math.cos(targetAngle - currentAngle),
    );

    // Обмежуємо швидкість повороту
    const maxTurn = turnRate * dt;

    const turn = Math.max(-maxTurn, Math.min(maxTurn, angleDifference));

    const newAngle = currentAngle + turn;

    // Змінюємо напрямок швидкості
    entity.vel = Vector2.fromAngle(newAngle).scale(movementSpeed);
  };

  return { update };
};
