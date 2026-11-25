export const drawPickup = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius = 18,
): void => {
  ctx.save();
  ctx.translate(x, y);

  // Магічне світіння
  ctx.shadowColor = '#22d3ee';
  ctx.shadowBlur = 18;

  // Зовнішня форма кристала
  ctx.fillStyle = '#0891b2';
  ctx.strokeStyle = '#a5f3fc';
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(0, -radius);
  ctx.lineTo(radius * 0.7, 0);
  ctx.lineTo(0, radius);
  ctx.lineTo(-radius * 0.7, 0);
  ctx.closePath();

  ctx.fill();
  ctx.stroke();

  // Внутрішня грань
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#67e8f9';

  ctx.beginPath();
  ctx.moveTo(0, -radius);
  ctx.lineTo(radius * 0.35, 0);
  ctx.lineTo(0, radius);
  ctx.closePath();
  ctx.fill();

  // Магічний символ
  ctx.strokeStyle = '#ecfeff';
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(-5, 0);
  ctx.lineTo(5, 0);
  ctx.moveTo(0, -5);
  ctx.lineTo(0, 5);
  ctx.stroke();

  ctx.restore();
};

