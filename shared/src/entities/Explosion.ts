import { Entity, type EntityOptions } from '../sim/entity.ts';
import { MutableVector2 } from '../sim/vector.ts';
import { mulberry32 } from '../sim/random.ts';
import type { ParticlePool, PooledParticle } from '../sim/ParticlePool.ts';

import type {
  ExplosionSnapshot,
  ParticleSnapshot,
  RandomSource,
  Vec2Like,
} from '../types.ts';

const ZERO_VEC: Vec2Like = { x: 0, y: 0 };

export interface ExplosionOptions
  extends Omit<EntityOptions, 'kind' | 'radius'> {
  count?: number;
  color?: string;
  particles?: readonly ParticleSnapshot[] | null;
  random?: RandomSource | null;
  particlePool?: ParticlePool | null;
}

export class Explosion extends Entity {
  declare readonly kind: 'explosion';

  readonly #particlePool: ParticlePool | null;

  color: string;
  particles: PooledParticle[];

  constructor({
    id = null,
    pos = ZERO_VEC,
    vel = ZERO_VEC,
    angle = 0,
    count = 20,
    color = '#b794f6',
    alive = true,
    particles = null,
    random = null,
    particlePool = null,
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

    this.#particlePool = particlePool;
    this.color = color;

    if (Array.isArray(particles)) {
      this.particles = particles.map((particle) =>
        this.#particlePool
          ? this.#particlePool.acquire({
              x: particle.pos.x,
              y: particle.pos.y,
              vx: particle.vel.x,
              vy: particle.vel.y,
              lifetime: particle.lifetime,
              remaining: particle.remaining,
              radius: particle.radius,
            })
          : {
              pos: new MutableVector2(particle.pos.x, particle.pos.y),
              vel: new MutableVector2(particle.vel.x, particle.vel.y),
              lifetime: particle.lifetime,
              remaining: particle.remaining,
              radius: particle.radius,
            },
      );
      return;
    }

    const nextRandom = random ?? mulberry32(1);
    this.particles = new Array<PooledParticle>(count);

    for (let i = 0; i < count; i++) {
      const particleAngle = nextRandom() * Math.PI * 2;
      const speed = 50 + nextRandom() * 150;
      const lifetime = 0.3 + nextRandom() * 0.5;
      const radius = 2 + nextRandom() * 3;
      const vx = Math.cos(particleAngle) * speed;
      const vy = Math.sin(particleAngle) * speed;

      this.particles[i] = this.#particlePool
        ? this.#particlePool.acquire({
            x: this.mutablePos.x,
            y: this.mutablePos.y,
            vx,
            vy,
            lifetime,
            remaining: lifetime,
            radius,
          })
        : {
            pos: new MutableVector2(this.mutablePos.x, this.mutablePos.y),
            vel: new MutableVector2(vx, vy),
            lifetime,
            remaining: lifetime,
            radius,
          };
    }
  }

  override update(dt: number): void {
    let writeIndex = 0;

    for (let readIndex = 0; readIndex < this.particles.length; readIndex++) {
      const particle = this.particles[readIndex];
      if (!particle) continue;

      particle.pos.addScaled(particle.vel, dt);
      particle.remaining -= dt;

      if (particle.remaining > 0) {
        this.particles[writeIndex] = particle;
        writeIndex += 1;
      } else {
        this.#particlePool?.release(particle);
      }
    }

    this.particles.length = writeIndex;

    if (writeIndex === 0) {
      this.destroy();
    }
  }

  releaseParticles(): void {
    if (this.#particlePool) {
      for (let i = 0; i < this.particles.length; i++) {
        const particle = this.particles[i];
        if (particle) {
          this.#particlePool.release(particle);
        }
      }
    }

    this.particles.length = 0;
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

