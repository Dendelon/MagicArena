export const drawHud = (ctx, stats) => {
  ctx.save();

  ctx.fillStyle = 'rgba(15, 12, 30, 0.85)';
  ctx.fillRect(15, 15, 215, 180);

  ctx.fillStyle = '#d8c8ff';
  ctx.font = '14px monospace';

  ctx.fillText(`FPS: ${stats.fps}`, 28, 42);
  ctx.fillText(`Steps/s: ${stats.sps}`, 28, 67);

  ctx.fillText(`Frame: ${stats.frameTimeMs.toFixed(2)} ms`, 28, 92);

  ctx.fillStyle = '#66e0ff';
  ctx.fillText(`HP: ${stats.hp}/3`, 28, 122);

  ctx.fillStyle = '#facc15';
  ctx.fillText(`Score: ${stats.score}`, 28, 147);

  if (stats.respawnSeconds !== null) {
    ctx.fillStyle = '#fca5a5';

    ctx.fillText(`Respawn: ${stats.respawnSeconds.toFixed(1)} s`, 28, 172);
  }

  ctx.restore();
};
