import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.js';

export class Explosion extends Entity {
  constructor({ pos = new Vector2(), count = 20, color = '#b794f6' } = {}) {
    super({
      pos,
      radius: 0,
      kind: 'explosion',
    });

    this.color = color;

    this.particles = Array.from({ length: count }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 50 + Math.random() * 150;
      const lifetime = 0.3 + Math.random() * 0.5;

      return {
        pos: new Vector2(pos.x, pos.y),
        vel: Vector2.fromAngle(angle).scale(speed),
        lifetime,
        remaining: lifetime,
        radius: 2 + Math.random() * 3,
      };
    });
  }

  update(dt) {
    for (const particle of this.particles) {
      particle.pos = particle.pos.add(particle.vel.scale(dt));

      particle.remaining -= dt;
    }

    this.particles = this.particles.filter((particle) => particle.remaining > 0);

    if (this.particles.length === 0) {
      this.destroy();
    }
  }
}
