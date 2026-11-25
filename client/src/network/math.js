export const shortestWrappedDelta = (from, to, size) => {
  if (size <= 0) return to - from;

  let delta = to - from;

  if (delta > size / 2) delta -= size;
  if (delta < -size / 2) delta += size;

  return delta;
};

export const shortestAngleDelta = (from, to) =>
  Math.atan2(
    Math.sin(to - from),
    Math.cos(to - from),
  );

