export const wrap = (value, max) => {
  if (max <= 0) return 0;

  return ((value % max) + max) % max;
};