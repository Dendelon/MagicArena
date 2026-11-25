import { Entity } from '../sim/entity.js';
import { Vector2 } from '../sim/vector.js';
import { mulberry32 } from '../sim/random.js';

export class Explosion extends Entity {
  constructor({
    id = null,
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    count = 20,
    color = '#b794f6',
    alive = true,
    particles = null,
    random = null,
  } = {}) {
    super({
      id,
      pos,
      vel,
      angle,
      radius: 0,
      kind: 'explosion',
      alive,
    });

    this.color = color;

    if (Array.isArray(particles)) {
      this.particles = particles.map((particle) => ({
        pos: Vector2.fromJSON(particle.pos),
        vel: Vector2.fromJSON(particle.vel),
        lifetime: particle.lifetime,
        remaining: particle.remaining,
        radius: particle.radius,
      }));
      return;
    }

    const nextRandom = random ?? mulberry32(1);

    this.particles = Array.from({ length: count }, () => {
      const angle = nextRandom() * Math.PI * 2;
      const speed = 50 + nextRandom() * 150;
      const lifetime = 0.3 + nextRandom() * 0.5;

      return {
        pos: new Vector2(this.pos.x, this.pos.y),
        vel: Vector2.fromAngle(angle).scale(speed),
        lifetime,
        remaining: lifetime,
        radius: 2 + nextRandom() * 3,
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

  toJSON() {
    return {
      ...super.toJSON(),
      color: this.color,
      particles: this.particles.map((particle) => ({
        pos: particle.pos.toJSON(),
        vel: particle.vel.toJSON(),
        lifetime: particle.lifetime,
        remaining: particle.remaining,
        radius: particle.radius,
      })),
    };
  }

  static fromJSON(data) {
    return new Explosion({
      id: data.id,
      pos: data.pos,
      vel: data.vel,
      angle: data.angle,
      color: data.color,
      alive: data.alive,
      particles: data.particles ?? [],
    });
  }
}

