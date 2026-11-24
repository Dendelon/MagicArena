import './style.css';
import { createCanvas } from './render/canvas';
import { drawBackground } from './render/background';
import { drawSword } from './render/sword';
import { drawHud } from './render/hud';
import { drawBullet } from './render/bullet.js';
import { drawObstacle } from './render/obstacle.js';
import { createLoop } from './loop';
import { createInput } from './input';
import { Vector2 } from './sim/vector.js';
import { Sword } from './entities/Sword.js';
import { World } from './sim/world.js';
import { Obstacle } from './entities/Obstacle.js';

const canvas = document.querySelector('#game');
const { ctx, size } = createCanvas(canvas);

const input = createInput();

const sword = new Sword({
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
  previousSword = {
    x: sword.pos.x,
    y: sword.pos.y,
    angle: sword.angle,
  };

  inputs.set(sword.id, input.getState());

  world.step(dt, inputs);

  // Один постріл на одне натискання Space
  if (input.justPressed('Space')) {
    sword.fire(world);
  }
};

const render = (alpha, stats) => {
  const x = interpolateWrapped(
    previousSword.x,
    sword.pos.x,
    alpha,
    size.width,
  );

  const y = interpolateWrapped(
    previousSword.y,
    sword.pos.y,
    alpha,
    size.height,
  );

  const angle =
    previousSword.angle +
    (sword.angle - previousSword.angle) * alpha;

  drawBackground(ctx, size.width, size.height);

  // Малювання рунічних каменів
  for (const obstacle of world.ofKind('obstacle')) {
    const x =
      obstacle.previousPos.x +
      (obstacle.pos.x - obstacle.previousPos.x) * alpha;

    const y =
      obstacle.previousPos.y +
      (obstacle.pos.y - obstacle.previousPos.y) * alpha;

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

  drawSword(ctx, x, y, angle, input.getState().forward);

  drawHud(ctx, stats);
};

const loop = createLoop({
  render,
  simulate,
});


loop.start();
