const ROTATION_SPEED = Math.PI;

export const integrate = (sword, input, dt) => {
  const direction = Number(input.right) - Number(input.left);

  return {
    ...sword,
    angle: sword.angle + direction * ROTATION_SPEED * dt,
  };
};
