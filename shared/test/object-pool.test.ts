import { describe, expect, test } from 'vitest';

import { ObjectPool, diffPoolStats } from '../src/index.ts';

interface DummyItem {
  value: number;
  label: string;
}

const createDummyPool = (maxSize = 4) =>
  new ObjectPool<DummyItem, { value: number; label?: string }>({
    maxSize,
    factory: () => ({ value: 0, label: 'init' }),
    reset: (item, options) => {
      item.value = options.value;
      item.label = options.label ?? 'default';
    },
  });

describe('ObjectPool', () => {
  test('acquire creates a new object when pool is empty', () => {
    const pool = createDummyPool();
    const item = pool.acquire({ value: 42, label: 'first' });

    expect(item).toEqual({ value: 42, label: 'first' });
    expect(pool.getStats()).toMatchObject({
      created: 1,
      acquired: 1,
      reused: 0,
      active: 1,
      available: 0,
      peakActive: 1,
    });
  });

  test('release returns object to pool and next acquire reuses exact JS instance with reset state', () => {
    const pool = createDummyPool();
    const first = pool.acquire({ value: 10, label: 'one' });

    pool.release(first);
    expect(pool.getStats()).toMatchObject({
      released: 1,
      active: 0,
      available: 1,
    });

    const second = pool.acquire({ value: 99 });
    expect(second).toBe(first);
    expect(second).toEqual({ value: 99, label: 'default' });
    expect(pool.getStats()).toMatchObject({
      created: 1,
      acquired: 2,
      reused: 1,
      released: 1,
      active: 1,
      available: 0,
      peakActive: 1,
    });
  });

  test('two concurrently active objects are distinct references', () => {
    const pool = createDummyPool();
    const a = pool.acquire({ value: 1 });
    const b = pool.acquire({ value: 2 });

    expect(a).not.toBe(b);
    expect(pool.getStats()).toMatchObject({
      created: 2,
      active: 2,
      peakActive: 2,
    });
  });

  test('protects against double release and foreign object release', () => {
    const poolA = createDummyPool();
    const poolB = createDummyPool();

    const itemA = poolA.acquire({ value: 5 });
    const itemB = poolB.acquire({ value: 6 });
    const standalone: DummyItem = { value: 7, label: 'external' };

    poolA.release(itemB);
    poolA.release(standalone);
    expect(poolA.getStats()).toMatchObject({
      released: 0,
      available: 0,
      active: 1,
    });

    poolA.release(itemA);
    poolA.release(itemA);
    expect(poolA.getStats()).toMatchObject({
      released: 1,
      available: 1,
      active: 0,
    });
  });

  test('enforces maxSize on free list without capping active objects', () => {
    const pool = createDummyPool(2);
    const items = [
      pool.acquire({ value: 1 }),
      pool.acquire({ value: 2 }),
      pool.acquire({ value: 3 }),
      pool.acquire({ value: 4 }),
    ];

    expect(pool.getStats()).toMatchObject({
      created: 4,
      active: 4,
      peakActive: 4,
    });

    for (const item of items) {
      pool.release(item);
    }

    expect(pool.getStats()).toEqual({
      created: 4,
      acquired: 4,
      reused: 0,
      released: 4,
      discarded: 2,
      active: 0,
      available: 2,
      peakActive: 4,
    });
  });

  test('clear empties free objects without corrupting active object tracking', () => {
    const pool = createDummyPool(4);
    const activeItem = pool.acquire({ value: 1 });
    const releasedItem = pool.acquire({ value: 2 });

    pool.release(releasedItem);
    expect(pool.getStats().available).toBe(1);

    pool.clear();
    expect(pool.getStats().available).toBe(0);
    expect(pool.getStats().active).toBe(1);
    expect(pool.isActive(activeItem)).toBe(true);

    pool.release(activeItem);
    expect(pool.getStats().active).toBe(0);
    expect(pool.getStats().available).toBe(1);
  });

  test('validates maxSize limits and computes diffPoolStats', () => {
    expect(() => createDummyPool(-1)).toThrow(RangeError);
    expect(() => createDummyPool(1.5)).toThrow(RangeError);
    expect(() => createDummyPool(Number.NaN)).toThrow(RangeError);
    expect(() => createDummyPool(Number.POSITIVE_INFINITY)).toThrow(RangeError);

    const pool = createDummyPool(4);
    const before = pool.getStats();
    const item = pool.acquire({ value: 1 });
    pool.release(item);
    const reused = pool.acquire({ value: 2 });
    const after = pool.getStats();

    expect(reused).toBe(item);
    expect(diffPoolStats(before, after).delta).toEqual({
      created: 1,
      acquired: 2,
      reused: 1,
      released: 1,
      discarded: 0,
    });
  });
});

