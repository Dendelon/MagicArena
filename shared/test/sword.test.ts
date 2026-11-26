import { describe, expect, test } from 'vitest';

import { integrate } from '../src/sim/sword.ts';

import type { Bounds, SwordInput, SwordState } from '../src/types.ts';

const bounds: Bounds = {
  width: 960,
  height: 640,
};

const idle: SwordInput = {
  thrust: false,
  turn: 0,
  brake: false,
};

const createState = (overrides: Partial<SwordState> = {}): SwordState => ({
  x: 480,
  y: 320,
  vx: 0,
  vy: 0,
  angle: 0,

  ...overrides,
});

const speedOf = (state: SwordState): number => Math.hypot(state.vx, state.vy);

describe('Sword integration', () => {
  test('Stationary sword stays stationary', () => {
    const state = createState();

    const next = integrate(state, idle, 1 / 60, bounds);

    expect(next).toEqual(state);
  });

  test('Thrust accelerates the sword', () => {
    const next = integrate(
      createState(),
      {
        ...idle,
        thrust: true,
      },
      1 / 60,
      bounds,
    );

    expect(speedOf(next)).toBeGreaterThan(0);
  });

  test('Drag reduces velocity', () => {
    const initial = createState({
      vx: 100,
    });

    const next = integrate(initial, idle, 1 / 60, bounds);

    expect(speedOf(next)).toBeLessThan(speedOf(initial));
  });

  test('Brake slows the sword more than idle drag', () => {
    const initial = createState({
      vx: 200,
      vy: 50,
    });

    const normal = integrate(initial, idle, 1 / 60, bounds);

    const braking = integrate(
      initial,
      {
        ...idle,
        brake: true,
      },
      1 / 60,
      bounds,
    );

    expect(speedOf(braking)).toBeLessThan(speedOf(normal));
  });

  test('Positive turn rotates the sword', () => {
    const initial = createState();

    const next = integrate(
      initial,
      {
        ...idle,
        turn: 1,
      },
      1 / 60,
      bounds,
    );

    expect(next.angle).not.toBe(initial.angle);
  });

  test('Wraps across the horizontal boundary', () => {
    const next = integrate(
      createState({
        x: bounds.width - 1,
        vx: 200,
      }),
      idle,
      1 / 30,
      bounds,
    );

    expect(next.x).toBeGreaterThanOrEqual(0);
    expect(next.x).toBeLessThan(10);
  });

  test('Wraps across the vertical boundary', () => {
    const next = integrate(
      createState({
        y: 1,
        vy: -200,
      }),
      idle,
      1 / 30,
      bounds,
    );

    expect(next.y).toBeGreaterThan(bounds.height - 10);
    expect(next.y).toBeLessThan(bounds.height);
  });

  test('Does not mutate the original state', () => {
    const initial = createState({
      vx: 100,
      vy: 50,
    });

    const copy = { ...initial };

    integrate(
      initial,
      {
        ...idle,
        thrust: true,
        turn: 1,
      },
      1 / 60,
      bounds,
    );

    expect(initial).toEqual(copy);
  });

  test('Repeated integration is deterministic', () => {
    const initial = createState({
      vx: 100,
      vy: -50,
      angle: 0.5,
    });

    const input: SwordInput = {
      thrust: true,
      turn: -0.5,
      brake: false,
    };

    const first = integrate(initial, input, 1 / 60, bounds);

    const second = integrate(
      { ...initial },
      { ...input },
      1 / 60,
      bounds,
    );

    expect(first).toEqual(second);
  });

  test('Continuous thrust respects maximum speed', () => {
    let state = createState();

    for (let i = 0; i < 600; i++) {
      state = integrate(
        state,
        {
          ...idle,
          thrust: true,
        },
        1 / 60,
        bounds,
      );
    }

    expect(speedOf(state)).toBeLessThanOrEqual(320 + 1e-8);
  });

  test('Single step thrust matches analytical kinematics', () => {
    const dt = 0.1;
    const expectedVy = -400 * dt * Math.exp(-0.8 * dt);
    const expectedY = 320 + expectedVy * dt;

    const next = integrate(
      createState(),
      {
        ...idle,
        thrust: true,
      },
      dt,
      bounds,
    );

    expect(next.vx).toBeCloseTo(0, 12);
    expect(next.vy).toBeCloseTo(expectedVy, 10);
    expect(next.x).toBeCloseTo(480, 12);
    expect(next.y).toBeCloseTo(expectedY, 10);
    expect(next.angle).toBeCloseTo(0, 12);
  });

  test('Single step turn and brake match analytical formulas', () => {
    const dt = 0.25;
    const expectedAngle = Math.PI * dt;
    const expectedVx = 100 * Math.exp(-(0.8 + 5) * dt);
    const expectedX = 480 + expectedVx * dt;

    const next = integrate(
      createState({ vx: 100 }),
      {
        ...idle,
        turn: 1,
        brake: true,
      },
      dt,
      bounds,
    );

    expect(next.angle).toBeCloseTo(expectedAngle, 12);
    expect(next.vx).toBeCloseTo(expectedVx, 10);
    expect(next.vy).toBeCloseTo(0, 12);
    expect(next.x).toBeCloseTo(expectedX, 10);
    expect(next.y).toBeCloseTo(320, 12);
  });
});

