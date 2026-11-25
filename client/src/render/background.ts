export const drawOuterBackground = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void => {
  ctx.fillStyle = '#060711';
  ctx.fillRect(0, 0, width, height);
};

export const drawArenaBorder = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
): void => {
  ctx.save();

  ctx.strokeStyle = 'rgba(168, 85, 247, 0.78)';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(168, 85, 247, 0.55)';
  ctx.shadowBlur = 14;
  ctx.strokeRect(x, y, width, height);

  const corner = Math.min(18, width * 0.05, height * 0.05);

  ctx.shadowBlur = 8;
  ctx.strokeStyle = 'rgba(196, 181, 253, 0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();

  // Top-left
  ctx.moveTo(x, y + corner);
  ctx.lineTo(x, y);
  ctx.lineTo(x + corner, y);

  // Top-right
  ctx.moveTo(x + width - corner, y);
  ctx.lineTo(x + width, y);
  ctx.lineTo(x + width, y + corner);

  // Bottom-right
  ctx.moveTo(x + width, y + height - corner);
  ctx.lineTo(x + width, y + height);
  ctx.lineTo(x + width - corner, y + height);

  // Bottom-left
  ctx.moveTo(x + corner, y + height);
  ctx.lineTo(x, y + height);
  ctx.lineTo(x, y + height - corner);

  ctx.stroke();

  ctx.restore();
};

export const drawBackground = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): void => {
  const gradient = ctx.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    Math.max(width, height),
  );

  gradient.addColorStop(0, '#242039');
  gradient.addColorStop(1, '#090b17');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const tileSize = 64;

  ctx.strokeStyle = 'rgba(170, 150, 210, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (let x = 0; x < width; x += tileSize) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }

  for (let y = 0; y < height; y += tileSize) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }

  ctx.stroke();
};

