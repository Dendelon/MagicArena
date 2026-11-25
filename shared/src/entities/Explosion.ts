import { Entity, type EntityOptions } from '../sim/entity.ts';
import { Vector2 } from '../sim/vector.ts';
import { mulberry32 } from '../sim/random.ts';

import type {
  ExplosionSnapshot,
  ParticleSnapshot,
  RandomSource,
} from '../types.ts';

interface Particle {
  pos: Vector2;
  vel: Vector2;
  lifetime: number;
  remaining: number;
  radius: number;
}

export interface ExplosionOptions
  extends Omit<EntityOptions, 'kind' | 'radius'> {
  count?: number;
  color?: string;
  particles?: readonly ParticleSnapshot[] | null;
  random?: RandomSource | null;
}

export class Explosion extends Entity {
  declare readonly kind: 'explosion';

  color: string;
  particles: Particle[];

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
  }: ExplosionOptions = {}) {
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
      const particleAngle = nextRandom() * Math.PI * 2;
      const speed = 50 + nextRandom() * 150;
      const lifetime = 0.3 + nextRandom() * 0.5;

      return {
        pos: new Vector2(this.pos.x, this.pos.y),
        vel: Vector2.fromAngle(particleAngle).scale(speed),
        lifetime,
        remaining: lifetime,
        radius: 2 + nextRandom() * 3,
      };
    });
  }

  override update(dt: number): void {
    for (const particle of this.particles) {
      particle.pos = particle.pos.add(particle.vel.scale(dt));

      particle.remaining -= dt;
    }

    this.particles = this.particles.filter((particle) => particle.remaining > 0);

    if (this.particles.length === 0) {
      this.destroy();
    }
  }

  override toJSON(): ExplosionSnapshot {
    return {
      ...super.toJSON(),
      kind: this.kind,
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

  static override fromJSON(data: ExplosionSnapshot): Explosion {
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

