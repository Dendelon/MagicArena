import { Bullet, type BulletOptions } from '../entities/Bullet.ts';
import { toEntityId } from '../types.ts';
import { ObjectPool, type PoolStats } from './ObjectPool.ts';

export const DEFAULT_BULLET_POOL_MAX_SIZE = 256;

const POOL_PLACEHOLDER_ID = toEntityId('__pooled_bullet__');

export class BulletPool {
  readonly #pool: ObjectPool<Bullet, BulletOptions>;

  constructor(maxSize = DEFAULT_BULLET_POOL_MAX_SIZE) {
    this.#pool = new ObjectPool<Bullet, BulletOptions>({
      maxSize,
      factory: () =>
        new Bullet({
          id: POOL_PLACEHOLDER_ID,
          alive: false,
        }),
      reset: (bullet, options) => {
        bullet.resetFromPool(options);
      },
    });
  }

  acquire(options: BulletOptions = {}): Bullet {
    return this.#pool.acquire(options);
  }

  release(bullet: Bullet): void {
    if (!this.#pool.isActive(bullet)) {
      return;
    }

    bullet.destroy();
    bullet.homing = null;
    this.#pool.release(bullet);
  }

  isActive(bullet: Bullet): boolean {
    return this.#pool.isActive(bullet);
  }

  getStats(): PoolStats {
    return this.#pool.getStats();
  }

  clear(): void {
    this.#pool.clear();
  }
}

