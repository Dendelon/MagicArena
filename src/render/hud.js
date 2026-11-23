export const drawHud = (ctx, stats) => {
  ctx.save();

  // Напівпрозорий фон HUD
  ctx.fillStyle = 'rgba(15, 12, 30, 0.85)';
  ctx.fillRect(15, 15, 190, 100);

  // Стиль тексту
  ctx.fillStyle = '#d8c8ff';
  ctx.font = '14px monospace';

  // Показники
  ctx.fillText(`FPS: ${stats.fps}`, 28, 42);
  ctx.fillText(`Steps/s: ${stats.sps}`, 28, 67);
  ctx.fillText(`Frame: ${stats.frameTimeMs.toFixed(2)} ms`, 28, 92);

  ctx.restore();
};
