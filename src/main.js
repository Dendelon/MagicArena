import "./style.css";
import { createCanvas } from "./render/canvas";
import { drawBackground } from "./render/background";
import { drawSword } from "./render/sword";

const canvas = document.querySelector('#game')

createCanvas(canvas, (ctx, width, height) => {
  drawBackground(ctx, width, height)

  drawSword(ctx, width / 2, height / 2, 0)
})