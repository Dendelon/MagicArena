export interface PoolStats {
  readonly created: number;
  readonly acquired: number;
  readonly reused: number;
  readonly released: number;
  readonly discarded: number;
  readonly active: number;
  readonly available: number;
  readonly peakActive: number;
}

export interface PoolDeltaStats {
  readonly before: PoolStats;
  readonly after: PoolStats;
  readonly delta: {
    readonly created: number;
    readonly acquired: number;
    readonly reused: number;
    readonly released: number;
    readonly discarded: number;
  };
}

export interface ObjectPoolOptions<T extends object, TOptions> {
  readonly factory: () => T;
  readonly reset: (object: T, options: TOptions) => void;
  readonly maxSize?: number;
}

const DEFAULT_MAX_POOL_SIZE = 256;

export const diffPoolStats = (
  before: PoolStats,
  after: PoolStats,
): PoolDeltaStats => ({
  before,
  after,
  delta: {
    created: Math.max(0, after.created - before.created),
    acquired: Math.max(0, after.acquired - before.acquired),
    reused: Math.max(0, after.reused - before.reused),
    released: Math.max(0, after.released - before.released),
    discarded: Math.max(0, after.discarded - before.discarded),
  },
});

export class ObjectPool<T extends object, TOptions = void> {
  readonly #factory: () => T;
  readonly #reset: (object: T, options: TOptions) => void;
  readonly #maxSize: number;

  readonly #free: T[] = [];
  readonly #active = new Set<T>();

  #created = 0;
  #acquired = 0;
  #reused = 0;
  #released = 0;
  #discarded = 0;
  #peakActive = 0;

  constructor({
    factory,
    reset,
    maxSize = DEFAULT_MAX_POOL_SIZE,
  }: ObjectPoolOptions<T, TOptions>) {
    if (!Number.isFinite(maxSize) || !Number.isInteger(maxSize) || maxSize < 0) {
      throw new RangeError(`Invalid ObjectPool maxSize: ${String(maxSize)}`);
    }

    this.#factory = factory;
    this.#reset = reset;
    this.#maxSize = maxSize;
  }

  acquire(options: TOptions): T {
    let instance = this.#free.pop();

    if (instance !== undefined) {
      if (this.#active.has(instance)) {
        throw new Error('ObjectPool invariant violated: free object is still active');
      }
      this.#reused += 1;
    } else {
      instance = this.#factory();
      this.#created += 1;
    }

    this.#reset(instance, options);
    this.#active.add(instance);
    this.#acquired += 1;

    if (this.#active.size > this.#peakActive) {
      this.#peakActive = this.#active.size;
    }

    return instance;
  }

  isActive(object: T): boolean {
    return this.#active.has(object);
  }

  release(object: T): void {
    if (!this.#active.has(object)) {
      return;
    }

    this.#active.delete(object);
    this.#released += 1;

    if (this.#free.length < this.#maxSize) {
      this.#free.push(object);
    } else {
      this.#discarded += 1;
    }
  }

  getStats(): PoolStats {
    return {
      created: this.#created,
      acquired: this.#acquired,
      reused: this.#reused,
      released: this.#released,
      discarded: this.#discarded,
      active: this.#active.size,
      available: this.#free.length,
      peakActive: this.#peakActive,
    };
  }

  clear(): void {
    this.#free.length = 0;
  }
}

