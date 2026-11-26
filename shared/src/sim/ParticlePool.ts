import { ObjectPool, type PoolStats } from './ObjectPool.ts';
import { MutableVector2 } from './vector.ts';

export const DEFAULT_PARTICLE_POOL_MAX_SIZE = 1024;

export interface ParticleOptions {
  readonly x?: number;
  readonly y?: number;
  readonly vx?: number;
  readonly vy?: number;
  readonly lifetime?: number;
  readonly remaining?: number;
  readonly radius?: number;
}

export interface PooledParticle {
  readonly pos: MutableVector2;
  readonly vel: MutableVector2;
  lifetime: number;
  remaining: number;
  radius: number;
}

export class ParticlePool {
  readonly #pool: ObjectPool<PooledParticle, ParticleOptions>;

  constructor(maxSize = DEFAULT_PARTICLE_POOL_MAX_SIZE) {
    this.#pool = new ObjectPool<PooledParticle, ParticleOptions>({
      maxSize,
      factory: () => ({
        pos: new MutableVector2(0, 0),
        vel: new MutableVector2(0, 0),
        lifetime: 0,
        remaining: 0,
        radius: 0,
      }),
      reset: (particle, options) => {
        const lifetime = options.lifetime ?? 0;
        particle.pos.set(options.x ?? 0, options.y ?? 0);
        particle.vel.set(options.vx ?? 0, options.vy ?? 0);
        particle.lifetime = lifetime;
        particle.remaining = options.remaining ?? lifetime;
        particle.radius = options.radius ?? 0;
      },
    });
  }

  acquire(options: ParticleOptions = {}): PooledParticle {
    return this.#pool.acquire(options);
  }

  release(particle: PooledParticle): void {
    this.#pool.release(particle);
  }

  isActive(particle: PooledParticle): boolean {
    return this.#pool.isActive(particle);
  }

  getStats(): PoolStats {
    return this.#pool.getStats();
  }

  clear(): void {
    this.#pool.clear();
  }
}

