export const drawBullet = (ctx, x, y, radius = 6, isHoming = false) => {
  ctx.save();

  ctx.shadowColor = isHoming ? '#22d3ee' : '#a855f7';
  ctx.shadowBlur = 15;

  ctx.fillStyle = isHoming ? '#22d3ee' : '#9b6dff';

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.fillStyle = isHoming ? '#ecfeff' : '#e9d5ff';

  ctx.beginPath();
  ctx.arc(x, y, radius * 0.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
};
