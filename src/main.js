import "./style.css";
import { createCanvas } from "./render/canvas";
import { drawBackground } from "./render/background";
import { drawSword } from "./render/sword";
import { drawHud } from "./render/hud";
import { createLoop } from "./loop";
import { createInput } from "./input";
import { integrate } from "./physics";

const canvas = document.querySelector('#game')
const { ctx, size } = createCanvas(canvas)

const input = createInput();

let sword = {
  x: size.width / 2,
  y: size.height / 2,
  vx: 0,
  vy: 0,
  angle: 0,
}

let previousSword = {...sword};

const simulate = (dt) => {
  previousSword = sword;

  sword = integrate(sword, input.getState(), dt)
};

const render = (alpha, stats) => {
  const angle = previousSword.angle + (sword.angle -
    previousSword.angle) * alpha;
  
  drawBackground(ctx, size.width, size.height);
  drawSword(ctx, sword.x, sword.y, angle);
  drawHud(ctx, stats)
}

const loop = createLoop({
  render,
  simulate
})

loop.start();