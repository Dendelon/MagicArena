// Frames in M1 atlas: four 64x64 frames in a 256x64 PNG.
export const drawSheetSprite = (
  ctx,
  bitmap,
  x,
  y,
  { frame = 0, angle = 0, scale = 1, size = 64 } = {},
) => {
  if (!bitmap) return false;
  const frameSize = bitmap.height;
  const frames = Math.max(1, Math.floor(bitmap.width / 320));
  const index = ((Math.floor(frame) % frames) + frames) % frames;
  const displaySize = size * scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    bitmap,
    index * frameSize,
    0,
    frameSize,
    frameSize,
    -displaySize / 2,
    -displaySize / 2,
    displaySize,
    displaySize,
  );
  ctx.restore();
  return true;
};
