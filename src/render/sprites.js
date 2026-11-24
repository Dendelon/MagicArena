// Frames in M1 atlas: four 64x64 frames in a 256x64 PNG.
export const drawSheetSprite = (
  ctx,
  bitmap,
  x,
  y,
  { frame = 0, angle = 0, scale = 1, size = 64 } = {},
) => {
  if (!bitmap) return false;
  const frames = Math.max(1, Math.floor(bitmap.width / 64));
  const index = ((Math.floor(frame) % frames) + frames) % frames;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    bitmap,
    index * 64,
    0,
    64,
    64,
    (-size * scale) / 2,
    (-size * scale) / 2,
    size * scale,
    size * scale,
  );
  ctx.restore();
  return true;
};
