import "./style.css";
import { createCanvas } from "./render/canvas";
import { drawBackground } from "./render/background";

const canvas = document.querySelector('#game')

createCanvas(canvas, drawBackground)