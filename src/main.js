import './style.css';
import { createCanvas } from './render/canvas';
import { drawBackground } from './render/background';
import { drawSword } from './render/sword';
import { drawHud } from './render/hud';
import { drawBullet } from './render/bullet.js';
import { drawObstacle } from './render/obstacle.js';
import { drawExplosion } from './render/explosion.js';
import { createLoop } from './loop';
import { createInput } from './input';
import { Vector2 } from './sim/vector.js';
import { Sword } from './entities/Sword.js';
import { World } from './sim/world.js';
import { Obstacle } from './entities/Obstacle.js';

const canvas = document.querySelector('#game');
const { ctx, size } = createCanvas(canvas);

const input = createInput();

let sword = new Sword({
  pos: new Vector2(size.width / 2, size.height / 2),
});

const world = new World(size);

world.spawn(sword);

// Створюємо три рунічні камені
const obstacles = [
  new Obstacle({
    pos: new Vector2(size.width * 0.2, size.height * 0.3),
    vel: new Vector2(40, 25),
    radius: 28,
  }),

  new Obstacle({
    pos: new Vector2(size.width * 0.8, size.height * 0.65),
    vel: new Vector2(-35, 30),
    radius: 24,
  }),

  new Obstacle({
    pos: new Vector2(size.width * 0.7, size.height * 0.2),
    vel: new Vector2(-25, -40),
    radius: 32,
  }),
];

for (const obstacle of obstacles) {
  world.spawn(obstacle);
}

let respawnTimer = null;

const findSafeSpawn = () => {
  const obstacles = [...world.ofKind('obstacle')];

  let bestPosition = new Vector2(size.width / 2, size.height / 2);

  let bestClearance = -Infinity;

  const padding = Math.min(60, size.width / 4, size.height / 4);

  for (let i = 0; i < 40; i++) {
    const pos = new Vector2(
      padding + Math.random() * (size.width - padding * 2),
      padding + Math.random() * (size.height - padding * 2),
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

const inputs = new Map();

let previousSword = {
  x: sword.pos.x,
  y: sword.pos.y,
  angle: sword.angle,
};

const interpolateWrapped = (from, to, alpha, size) => {
  if (size <= 0) return 0;

  let delta = to - from;

  if (delta > size / 2) delta -= size;
  if (delta < -size / 2) delta += size;

  const value = from + delta * alpha;

  return ((value % size) + size) % size;
};

const simulate = (dt) => {
  const controls = input.getState();
  const firePressed = input.justPressed('Space');

  if (sword.alive) {
    previousSword = {
      x: sword.pos.x,
      y: sword.pos.y,
      angle: sword.angle,
    };

    inputs.set(sword.id, controls);
  }

  world.step(dt, inputs);

  if (sword.alive && firePressed) {
    sword.fire(world);
  }

  // Обробка знищеного меча
  if (!sword.alive) {
    inputs.delete(sword.id);

    if (respawnTimer === null) {
      respawnTimer = 2;
    } else {
      respawnTimer = Math.max(0, respawnTimer - dt);
    }

    // Створення нового меча
    if (respawnTimer <= 0) {
      sword = new Sword({
        pos: findSafeSpawn(),
      });

      world.spawn(sword);

      previousSword = {
        x: sword.pos.x,
        y: sword.pos.y,
        angle: sword.angle,
      };

      respawnTimer = null;
    }
  }
};

const render = (alpha, stats) => {
  drawBackground(ctx, size.width, size.height);

  // Малювання рунічних каменів
  for (const obstacle of world.ofKind('obstacle')) {
    const x = obstacle.previousPos.x + (obstacle.pos.x - obstacle.previousPos.x) * alpha;

    const y = obstacle.previousPos.y + (obstacle.pos.y - obstacle.previousPos.y) * alpha;

    drawObstacle(ctx, x, y, obstacle.radius);
  }

  for (const bullet of world.ofKind('bullet')) {
    const bulletX = interpolateWrapped(
      bullet.previousPos.x,
      bullet.pos.x,
      alpha,
      size.width,
    );

    const bulletY = interpolateWrapped(
      bullet.previousPos.y,
      bullet.pos.y,
      alpha,
      size.height,
    );

    drawBullet(ctx, bulletX, bulletY, bullet.radius);
  }

  if (sword.alive) {
    const x = interpolateWrapped(previousSword.x, sword.pos.x, alpha, size.width);

    const y = interpolateWrapped(previousSword.y, sword.pos.y, alpha, size.height);

    const angle = previousSword.angle + (sword.angle - previousSword.angle) * alpha;

    drawSword(ctx, x, y, angle, input.getState().forward);
  }

  // Малювання вибухів
  for (const explosion of world.ofKind('explosion')) {
    drawExplosion(ctx, explosion);
  }

  drawHud(ctx, {
    ...stats,
    hp: sword.hp,
    score: world.score,
    respawnSeconds: respawnTimer,
  });
};

const loop = createLoop({
  render,
  simulate,
});

loop.start();
