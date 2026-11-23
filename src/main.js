import './style.css';
import { createCanvas } from './render/canvas';
import { drawBackground } from './render/background';
import { drawSword } from './render/sword';
import { drawHud } from './render/hud';
import { createLoop } from './loop';
import { createInput } from './input';
import { integrate } from './sim/sword.js';

const canvas = document.querySelector('#game');
const { ctx, size } = createCanvas(canvas);

const input = createInput();

let sword = {
  x: size.width / 2,
  y: size.height / 2,
  vx: 0,
  vy: 0,
  angle: 0,
};

let previousSword = { ...sword };

const interpolateWrapped = (from, to, alpha, size) => {
  if (size <= 0) return 0;

  let delta = to - from;

  if (delta > size / 2) delta -= size;
  if (delta < -size / 2) delta += size;

  const value = from + delta * alpha;

  return ((value % size) + size) % size;
};

const simulate = (dt) => {
  previousSword = sword;

  if (input.justPressed('Space')) {
    console.log('Space натиснуто!');
  }

  sword = integrate(sword, input.getState(), dt, size);
};

const render = (alpha, stats) => {
  const x = interpolateWrapped(previousSword.x, sword.x, alpha, size.width);

  const y = interpolateWrapped(previousSword.y, sword.y, alpha, size.height);

  const angle = previousSword.angle + (sword.angle - previousSword.angle) * alpha;

  drawBackground(ctx, size.width, size.height);
  drawSword(ctx, x, y, angle, input.getState().forward);
  drawHud(ctx, stats);
};

const loop = createLoop({
  render,
  simulate,
});

loop.start();
