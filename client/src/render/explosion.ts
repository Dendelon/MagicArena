import type { Explosion } from '@magicarena/shared';

export const drawExplosion = (
  ctx: CanvasRenderingContext2D,
  explosion: Explosion,
): void => {
  ctx.save();

  ctx.fillStyle = explosion.color;

  for (const particle of explosion.particles) {
    ctx.globalAlpha = particle.remaining / particle.lifetime;

    ctx.beginPath();

    ctx.arc(particle.pos.x, particle.pos.y, particle.radius, 0, Math.PI * 2);

    ctx.fill();
  }

  ctx.restore();
};

