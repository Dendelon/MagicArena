export const drawObstacle = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
): void => {
  ctx.save();
  ctx.translate(x, y);

  // Фіолетове світіння
  ctx.shadowColor = '#8b5cf6';
  ctx.shadowBlur = 12;

  // Шестикутний камінь
  ctx.fillStyle = '#39304f';
  ctx.strokeStyle = '#9470d4';
  ctx.lineWidth = 2;

  ctx.beginPath();

  for (let i = 0; i < 6; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 3;

    const px = Math.cos(angle) * radius;
    const py = Math.sin(angle) * radius;

    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }

  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Магічна руна в центрі
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#d8b4fe';
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(0, -radius * 0.55);
  ctx.lineTo(radius * 0.4, 0);
  ctx.lineTo(0, radius * 0.55);
  ctx.lineTo(-radius * 0.4, 0);
  ctx.closePath();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, -radius * 0.55);
  ctx.lineTo(0, radius * 0.55);
  ctx.stroke();

  ctx.restore();
};

