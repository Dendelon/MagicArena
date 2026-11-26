import { describe, expect, test, vi } from 'vitest';

import {
  Bullet,
  Obstacle,
  Sword,
  Vector2,
  World,
  createHealingEffect,
  createHoming,
  mulberry32,
  toEntityId,
} from '../src/index.ts';
import { findSafeSpawn, wrap } from '../src/sim/arena.ts';

describe('Arena helpers', () => {
  test('wrap handles negative coordinates, overflow, and zero max', () => {
    expect(wrap(-10, 100)).toBe(90);
    expect(wrap(115, 100)).toBe(15);
    expect(wrap(50, 0)).toBe(0);
    expect(wrap(50, -20)).toBe(0);
  });

  test('findSafeSpawn works in empty arena using deterministic RNG', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 10 });
    const pos = findSafeSpawn(world, mulberry32(42));

    expect(pos.x).toBeGreaterThanOrEqual(60);
    expect(pos.x).toBeLessThanOrEqual(900);
    expect(pos.y).toBeGreaterThanOrEqual(60);
    expect(pos.y).toBeLessThanOrEqual(580);
  });

  test('findSafeSpawn avoids nearby obstacles', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 10 });
    const obstacle = world.spawn(
      new Obstacle({
        pos: new Vector2(480, 320),
        radius: 30,
      }),
    );

    const pos = findSafeSpawn(world, mulberry32(7));

    expect(pos.sub(obstacle.pos).length() - obstacle.radius - 22).toBeGreaterThan(
      55,
    );
  });

  test('findSafeSpawn falls back to best clearance when no spot has clearance > 55', () => {
    const world = new World({ width: 200, height: 200 }, { seed: 1 });
    world.spawn(
      new Obstacle({
        pos: new Vector2(100, 100),
        radius: 120,
      }),
    );

    let step = 0;
    const sequenceRng = () => {
      step += 1;
      return (step % 5) / 5;
    };

    const pos = findSafeSpawn(world, sequenceRng);

    expect(pos.x).toBeGreaterThanOrEqual(50);
    expect(pos.x).toBeLessThanOrEqual(150);
    expect(pos.y).toBeGreaterThanOrEqual(50);
    expect(pos.y).toBeLessThanOrEqual(150);
  });
});

describe('Healing behavior', () => {
  test('Heals a damaged sword and returns false when at max HP', () => {
    const effect = createHealingEffect(1);
    const sword = new Sword({ hp: 2 });

    expect(effect.apply(sword)).toBe(true);
    expect(sword.hp).toBe(3);

    expect(effect.apply(sword)).toBe(false);
    expect(sword.hp).toBe(3);
  });

  test('Returns false for object without heal()', () => {
    const effect = createHealingEffect(1);

    expect(effect.apply({})).toBe(false);
  });
});

describe('Homing and proximity aim assist', () => {
  test('Proximity assist steers bullet toward obstacle inside cone and preserves speed', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    world.spawn(
      new Obstacle({
        pos: new Vector2(180, 130),
        radius: 26,
      }),
    );

    const initialSpeed = 550;
    const bullet = world.spawn(
      new Bullet({
        pos: new Vector2(100, 100),
        vel: new Vector2(initialSpeed, 0),
        homing: createHoming({
          targetKind: 'obstacle',
          turnRate: 9,
        }),
      }),
    );

    const dt = 1 / 30;
    bullet.update(dt, world);

    // Should steer slightly toward positive y without exceeding turn rate.
    expect(bullet.vel.y).toBeGreaterThan(0);
    expect(bullet.vel.length()).toBeCloseTo(initialSpeed, 8);

    const turnedAngle = Math.atan2(bullet.vel.y, bullet.vel.x);
    expect(turnedAngle).toBeLessThanOrEqual(2.5 * dt + 1e-8);
  });

  test('Proximity assist ignores obstacles outside angle sector or radius', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    // Outside 45-degree cone (at +y, angle = PI/2).
    world.spawn(
      new Obstacle({
        pos: new Vector2(100, 150),
      }),
    );
    // Beyond ASSIST_RADIUS = 180.
    world.spawn(
      new Obstacle({
        pos: new Vector2(320, 105),
      }),
    );

    const bullet = world.spawn(
      new Bullet({
        pos: new Vector2(100, 100),
        vel: new Vector2(550, 0),
        homing: createHoming({
          targetKind: 'obstacle',
          turnRate: 9,
        }),
      }),
    );

    bullet.update(1 / 30, world);

    expect(bullet.vel.x).toBeCloseTo(550, 8);
    expect(bullet.vel.y).toBeCloseTo(0, 8);
  });

  test('Proximity assist flies straight when no obstacle exists and chooses higher-weight target', () => {
    const emptyWorld = new World({ width: 960, height: 640 }, { seed: 1 });
    const straightBullet = emptyWorld.spawn(
      new Bullet({
        pos: new Vector2(100, 100),
        vel: new Vector2(550, 0),
        homing: createHoming({ targetKind: 'obstacle', turnRate: 9 }),
      }),
    );

    straightBullet.update(1 / 30, emptyWorld);
    expect(straightBullet.vel.y).toBeCloseTo(0, 8);

    // Two candidates: one closer & centered (negative y), one edge of cone/radius (positive y).
    const multiWorld = new World({ width: 960, height: 640 }, { seed: 1 });
    multiWorld.spawn(new Obstacle({ pos: new Vector2(180, 90) }));
    multiWorld.spawn(new Obstacle({ pos: new Vector2(240, 190) }));

    const multiBullet = multiWorld.spawn(
      new Bullet({
        pos: new Vector2(100, 100),
        vel: new Vector2(550, 0),
        homing: createHoming({ targetKind: 'obstacle', turnRate: 9 }),
      }),
    );

    multiBullet.update(1 / 30, multiWorld);
    expect(multiBullet.vel.y).toBeLessThan(0);
  });

  test('General homing on obstacle steers toward nearest sword at configured speed', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    world.spawn(new Sword({ pos: new Vector2(200, 300) }));

    const obstacle = world.spawn(
      new Obstacle({
        id: toEntityId(50),
        pos: new Vector2(200, 100),
        vel: new Vector2(70, 0),
        homing: createHoming({
          targetKind: 'sword',
          turnRate: 2.4,
          speed: 70,
        }),
      }),
    );

    const spy = vi.fn();
    world.addEventListener('hit', spy);
    obstacle.update(0.1, world);

    expect(obstacle.vel.y).toBeGreaterThan(0);
    expect(obstacle.vel.length()).toBeCloseTo(70, 8);
    expect(spy).not.toHaveBeenCalled();
  });
});

