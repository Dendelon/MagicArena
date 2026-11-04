import "./style.css";
import { createCanvas } from "./render/canvas";
import { drawBackground } from "./render/background";
import { drawSword } from "./render/sword";
import { drawHud } from "./render/hud";
import { createLoop } from "./loop";

const canvas = document.querySelector('#game')

const { ctx, size } = createCanvas(canvas)

const simulate = () => {
  // Тут пізніше буде фізика меча
};

const render = (alpha, stats) => {
  drawBackground(ctx, size.width, size.height);

  drawSword(ctx, size.width / 2, size.height / 2);

  drawHud(ctx, stats)
}

const loop = createLoop({
  render,
  simulate
})

loop.start();