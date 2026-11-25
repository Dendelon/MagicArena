import { Vector2 } from '../vector.js';

const ASSIST_RADIUS = 180;
const ASSIST_FULL_RADIUS = 90;

const ASSIST_HALF_ANGLE = Math.PI / 4;
const ASSIST_FULL_ANGLE = Math.PI / 8;

const ASSIST_MAX_TURN_RATE = 2.5;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const smoothstep = (value) => {
  const t = clamp01(value);

  return t * t * (3 - 2 * t);
};

const updateBulletAssist = (entity, world, dt, turnRate, speed) => {
  const currentSpeed = entity.vel.length();

  if (currentSpeed <= 0 || dt <= 0) return;

  const movementSpeed = speed ?? currentSpeed;

  if (movementSpeed <= 0) return;

  const currentAngle = Math.atan2(entity.vel.y, entity.vel.x);

  let bestWeight = 0;
  let bestDifference = 0;

  for (const candidate of world.ofKind('obstacle')) {
    if (candidate.id === entity.id) continue;

    const dx = candidate.pos.x - entity.pos.x;
    const dy = candidate.pos.y - entity.pos.y;

    const distance = Math.hypot(dx, dy);

    // Ігноруємо далекі цілі.
    if (distance <= 0 || distance >= ASSIST_RADIUS) {
      continue;
    }

    const targetAngle = Math.atan2(dy, dx);

    const difference = Math.atan2(
      Math.sin(targetAngle - currentAngle),
      Math.cos(targetAngle - currentAngle),
    );

    // Ігноруємо цілі позаду та збоку.
    if (Math.abs(difference) >= ASSIST_HALF_ANGLE) {
      continue;
    }

    // Плавно збільшуємо силу наведення
    // при наближенні до цілі.
    const distanceWeight = smoothstep(
      (ASSIST_RADIUS - distance) / (ASSIST_RADIUS - ASSIST_FULL_RADIUS),
    );

    // Слабше наведення на краях сектора.
    const angleWeight = smoothstep(
      (ASSIST_HALF_ANGLE - Math.abs(difference)) /
        (ASSIST_HALF_ANGLE - ASSIST_FULL_ANGLE),
    );

    const weight = distanceWeight * angleWeight;

    if (weight > bestWeight) {
      bestWeight = weight;
      bestDifference = difference;
    }
  }

  // Якщо відповідної цілі немає,
  // снаряд продовжує летіти прямо.
  if (bestWeight === 0) return;

  const maxTurn =
    Math.max(0, Math.min(turnRate, ASSIST_MAX_TURN_RATE)) * dt * bestWeight;

  const turn = Math.max(-maxTurn, Math.min(maxTurn, bestDifference));

  entity.vel = Vector2.fromAngle(currentAngle + turn).scale(movementSpeed);
};

export const createHoming = ({ targetKind, turnRate = 3, speed = null }) => {
  const update = (entity, world, dt) => {
    if (entity.kind === 'bullet' && targetKind === 'obstacle') {
      updateBulletAssist(entity, world, dt, turnRate, speed);

      return;
    }

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

  return {
    targetKind,
    turnRate,
    speed,
    update,
  };
};

