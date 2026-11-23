import './style.css';
import { createCanvas } from './render/canvas';
import { drawBackground } from './render/background';
import { drawSword } from './render/sword';
import { drawHud } from './render/hud';
import { createLoop } from './loop';
import { createInput } from './input';
import { Vector2 } from './sim/vector.js';
import { Sword } from './entities/Sword.js';

const canvas = document.querySelector('#game');
const { ctx, size } = createCanvas(canvas);

const input = createInput();

const sword = new Sword({
  pos: new Vector2(size.width / 2, size.height / 2),
});

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

  sword.setInput(input.getState());
  sword.update(dt, size);
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

  drawSword(ctx, x, y, angle, input.getState().forward);

  drawHud(ctx, stats);
};

const loop = createLoop({
  render,
  simulate,
});


loop.start();
