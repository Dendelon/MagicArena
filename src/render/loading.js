export const drawLoadingScreen = (
  ctx,
  size,
  { done = 0, total = 1, error = '' } = {},
) => {
  const { width, height } = size;
  const ratio = total > 0 ? Math.min(1, done / total) : 1;
  const barWidth = Math.min(420, width * 0.72);
  const barHeight = 18;
  const x = (width - barWidth) / 2;
  const y = height / 2 + 18;

  ctx.save();
  ctx.fillStyle = '#151126';
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#d8c4ff';
  ctx.font = 'bold 27px sans-serif';
  ctx.fillText('MAGIC ARENA', width / 2, height / 2 - 48);
  ctx.font = '16px sans-serif';
  ctx.fillText(error ? 'Loading failed' : 'Loading assets...', width / 2, height / 2 - 8);

  ctx.fillStyle = '#342849';
  ctx.fillRect(x, y, barWidth, barHeight);
  ctx.fillStyle = error ? '#f87171' : '#a78bfa';
  ctx.fillRect(x, y, barWidth * ratio, barHeight);
  ctx.strokeStyle = '#dbc5fc';
  ctx.strokeRect(x, y, barWidth, barHeight);

  ctx.font = '14px sans-serif';
  ctx.fillStyle = '#ddd6fe';
  ctx.fillText(`${done}/${total}  (${Math.round(ratio * 100)}%)`, width / 2, y + 41);

  if (error) {
    ctx.fillStyle = '#fca5a5';
    ctx.fillText(error.slice(0, 75), width / 2, y + 69);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Press R to retry', width / 2, y + 96);
  }
  ctx.restore();
};
