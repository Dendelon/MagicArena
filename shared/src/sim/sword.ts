import { wrap } from './arena.ts';

import type { Bounds, SwordInput, SwordState } from '../types.ts';

const ROTATION_SPEED = Math.PI;
const ACCELERATION = 400;
const MAX_SPEED = 320;
const DRAG = 0.8;
const BRAKE_FORCE = 5;

export interface MutableSwordState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
}

export const integrateInto = (
  target: MutableSwordState,
  sword: SwordState,
  input: SwordInput,
  dt: number,
  world: Bounds,
): void => {
  const direction =
    typeof input.turn === 'number'
      ? Math.max(-1, Math.min(1, input.turn))
      : Number(Boolean(input.right)) - Number(Boolean(input.left));

  const angle = sword.angle + direction * ROTATION_SPEED * dt;

  let vx = sword.vx;
  let vy = sword.vy;

  if (input.thrust ?? input.forward) {
    vx += Math.sin(angle) * ACCELERATION * dt;
    vy -= Math.cos(angle) * ACCELERATION * dt;
  }

  const resistance = DRAG + (input.brake ? BRAKE_FORCE : 0);
  const damping = Math.exp(-resistance * dt);

  vx *= damping;
  vy *= damping;

  const speed = Math.hypot(vx, vy);

  if (speed > MAX_SPEED) {
    const scale = MAX_SPEED / speed;

    vx *= scale;
    vy *= scale;
  }

  target.x = wrap(sword.x + vx * dt, world.width);
  target.y = wrap(sword.y + vy * dt, world.height);
  target.vx = vx;
  target.vy = vy;
  target.angle = angle;
};

export const integrate = <T extends SwordState>(
  sword: T,
  input: SwordInput,
  dt: number,
  world: Bounds,
): T => {
  const next: T = { ...sword };
  integrateInto(next, sword, input, dt, world);
  return next;
};

