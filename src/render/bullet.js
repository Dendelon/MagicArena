export const drawBullet = (ctx, x, y, radius = 6) => {
  ctx.save();

  // Магічне світіння
  ctx.shadowColor = '#a855f7';
  ctx.shadowBlur = 15;

  // Зовнішня частина снаряда
  ctx.fillStyle = '#9b6dff';

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Яскраве ядро
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#e9d5ff';

  ctx.beginPath();
  ctx.arc(x, y, radius * 0.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
};
