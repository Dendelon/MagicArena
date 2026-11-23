export const drawSword = (ctx, x, y, angle = 0, thrusting = false) => {
  ctx.save();

  // Переміщуємо центр координат до меча та повертаємо його
  ctx.translate(x, y);
  ctx.rotate(angle);

  if (thrusting) {
    ctx.save();

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
  }

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
