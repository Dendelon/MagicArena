export const drawSword = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle = 0,
): void => {
  ctx.save();

  // Переміщуємо центр координат до меча та повертаємо його
  ctx.translate(x, y);
  ctx.rotate(angle);

  // Магічне світіння леза
  ctx.shadowColor = '#9966ff';
  ctx.shadowBlur = 18;

  // Лезо меча
  ctx.fillStyle = '#c8d5f5';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;

  ctx.beginPath();
  ctx.moveTo(0, -55); // Вістря
  ctx.lineTo(9, -30);
  ctx.lineTo(7, 10);
  ctx.lineTo(-7, 10);
  ctx.lineTo(-9, -30);
  ctx.closePath();

  ctx.fill();
  ctx.stroke();

  // Вимикаємо світіння для інших частин
  ctx.shadowBlur = 0;

  // Центральна лінія леза
  ctx.strokeStyle = '#8899cc';
  ctx.lineWidth = 2;

  ctx.beginPath();
  ctx.moveTo(0, -48);
  ctx.lineTo(0, 9);
  ctx.stroke();

  // Гарда (поперечна частина рукоятки)
  ctx.fillStyle = '#7945bc';
  ctx.fillRect(-22, 8, 44, 8);

  // Кінці гарди
  ctx.fillStyle = '#b38aff';
  ctx.beginPath();
  ctx.arc(-22, 12, 5, 0, Math.PI * 2);
  ctx.arc(22, 12, 5, 0, Math.PI * 2);
  ctx.fill();

  // Рукоятка
  ctx.fillStyle = '#39235c';
  ctx.fillRect(-5, 16, 10, 24);

  // Декоративні смуги на рукоятці
  ctx.strokeStyle = '#a681dc';
  ctx.lineWidth = 2;

  for (let i = 20; i < 39; i += 6) {
    ctx.beginPath();
    ctx.moveTo(-5, i);
    ctx.lineTo(5, i + 3);
    ctx.stroke();
  }

  // Навершя
  ctx.fillStyle = '#7945bc';
  ctx.beginPath();
  ctx.arc(0, 42, 7, 0, Math.PI * 2);
  ctx.fill();

  // Магічний кристал у центрі гарди
  ctx.fillStyle = '#66e0ff';
  ctx.beginPath();
  ctx.arc(0, 12, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
};

