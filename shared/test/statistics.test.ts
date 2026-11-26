import { describe, expect, test } from 'vitest';

import {
  DEFAULT_FIXED_DT,
  Obstacle,
  Sword,
  Vector2,
  World,
  summarizeTimings,
} from '../src/index.ts';

describe('summarizeTimings', () => {
  test('returns null for empty samples without fabricating zeros', () => {
    expect(summarizeTimings([])).toBeNull();
  });

  test('computes exact summary for a single element', () => {
    expect(summarizeTimings([12.345])).toEqual({
      count: 1,
      min: 12.345,
      mean: 12.345,
      p50: 12.345,
      p95: 12.345,
      p99: 12.345,
      max: 12.345,
    });
  });

  test('handles identical values accurately', () => {
    expect(summarizeTimings([4.5, 4.5, 4.5, 4.5])).toEqual({
      count: 4,
      min: 4.5,
      mean: 4.5,
      p50: 4.5,
      p95: 4.5,
      p99: 4.5,
      max: 4.5,
    });
  });

  test('uses nearest-rank percentile on known unsorted sample without rounding', () => {
    // 20 values: 1.25, 2.25, ..., 20.25 shuffled
    const input = [
      15.25, 3.25, 19.25, 1.25, 8.25,
      12.25, 6.25, 20.25, 11.25, 4.25,
      17.25, 2.25, 14.25, 9.25, 18.25,
      7.25, 10.25, 5.25, 16.25, 13.25,
    ];

    const summary = summarizeTimings(input);

    // Nearest-rank for n=20:
    // p50 -> ceil(0.5 * 20) - 1 = 9 -> 10.25
    // p95 -> ceil(0.95 * 20) - 1 = 18 -> 19.25
    // p99 -> ceil(0.99 * 20) - 1 = 19 -> 20.25
    expect(summary).toEqual({
      count: 20,
      min: 1.25,
      mean: 10.75,
      p50: 10.25,
      p95: 19.25,
      p99: 20.25,
      max: 20.25,
    });
  });

  test('respects nearest-rank percentile boundaries across sample sizes', () => {
    // n = 100: p50 -> index 49 (50), p95 -> index 94 (95), p99 -> index 98 (99)
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    const summary100 = summarizeTimings(hundred);

    expect(summary100).toEqual({
      count: 100,
      min: 1,
      mean: 50.5,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
    });

    // n = 101: p99 -> ceil(0.99 * 101) - 1 = ceil(99.99) - 1 = 100 - 1 = 99 -> value 100
    const hundredOne = Array.from({ length: 101 }, (_, index) => index + 1);
    const summary101 = summarizeTimings(hundredOne);

    expect(summary101?.p50).toBe(51);
    expect(summary101?.p95).toBe(96);
    expect(summary101?.p99).toBe(100);
    expect(summary101?.max).toBe(101);
  });

  test('does not mutate or reorder input array', () => {
    const samples = Object.freeze([9.1, 2.4, 7.8, 1.3, 5.6]);
    const copyBefore = [...samples];

    const summary = summarizeTimings(samples);

    expect(summary?.min).toBe(1.3);
    expect(summary?.max).toBe(9.1);
    expect(samples).toEqual(copyBefore);
  });
});

describe('World.step collision instrumentation hooks', () => {
  test('invokes optional collision hooks without altering simulation output', () => {
    const bounds = { width: 960, height: 640 };
    const worldA = new World(bounds, { seed: 42 });

    worldA.spawn(new Sword({ pos: new Vector2(200, 200) }));
    worldA.spawn(new Obstacle({ pos: new Vector2(210, 200) }));

    const worldB = World.fromJSON(worldA.toJSON());

    expect(worldB.toJSON()).toEqual(worldA.toJSON());

    const order: string[] = [];

    worldA.step(DEFAULT_FIXED_DT);
    worldB.step(DEFAULT_FIXED_DT, new Map(), {
      onBeforeCollisions: () => order.push('before'),
      onAfterCollisions: () => order.push('after'),
    });

    expect(order).toEqual(['before', 'after']);
    expect(worldB.toJSON()).toEqual(worldA.toJSON());
  });
});

