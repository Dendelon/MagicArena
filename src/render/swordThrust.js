export const drawSwordThrust = (ctx, x, y, angle = 0) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.translate(0, -6);

  ctx.shadowColor = '#b06cff';
  ctx.shadowBlur = 18;

  const glow = ctx.createLinearGradient(0, 43, 0, 95);

  glow.addColorStop(0, '#c39aff');
  glow.addColorStop(0.5, 'rgba(150, 75, 255, 0.7)');
  glow.addColorStop(1, 'rgba(150, 75, 255, 0)');

  ctx.fillStyle = glow;

  ctx.beginPath();
  ctx.moveTo(-9, 43);
  ctx.quadraticCurveTo(-14, 65, 0, 95);
  ctx.quadraticCurveTo(14, 65, 9, 43);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
};
