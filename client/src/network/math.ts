export const shortestWrappedDelta = (
  from: number,
  to: number,
  size: number,
): number => {
  if (size <= 0) return to - from;

  let delta = to - from;

  if (delta > size / 2) delta -= size;
  if (delta < -size / 2) delta += size;

  return delta;
};

export const shortestAngleDelta = (from: number, to: number): number =>
  Math.atan2(Math.sin(to - from), Math.cos(to - from));

