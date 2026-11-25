import type { CanvasSize } from '../types.ts';

export const createCanvas = (canvas: HTMLCanvasElement) => {
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Canvas 2D context is unavailable');
  }

  const size: CanvasSize = {
    width: 0,
    height: 0,
  };

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;

    size.width = window.innerWidth;
    size.height = window.innerHeight;

    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  window.addEventListener('resize', resize);
  resize();

  return { ctx, size };
};

