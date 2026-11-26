import { describe, expect, test } from 'vitest';

import {
  Bullet,
  BulletPool,
  DEFAULT_FIXED_DT,
  Explosion,
  MutableVector2,
  Obstacle,
  ParticlePool,
  Sword,
  Vector2,
  World,
  createHoming,
  runDeterministicScenario,
  toEntityId,
  toSeq,
  toTick,
} from '../src/index.ts';
import type { WorldEvent } from '../src/index.ts';

describe('MutableVector2', () => {
  test('updates coordinates in place without breaking immutable Vector2', () => {
    const v = new MutableVector2(2, 3);
    const immutable = new Vector2(2, 3);

    v.addScaled({ x: 4, y: -2 }, 0.5);
    expect(v.x).toBe(4);
    expect(v.y).toBe(2);

    v.copyFrom({ x: 10, y: 20 });
    expect(v.toJSON()).toEqual({ x: 10, y: 20 });

    v.set(-5, 7);
    expect(v.x).toBe(-5);
    expect(v.y).toBe(7);
    expect(immutable.x).toBe(2);
    expect(immutable.y).toBe(3);
  });
});

describe('BulletPool and World bullet lifecycle regressions', () => {
  test('reused bullet gets new automatic EntityId and completely resets homing and shot metadata', () => {
    Bullet.resetNextId(1);

    const pool = new BulletPool(16);

    const homingBullet = pool.acquire({
      pos: { x: 100, y: 200 },
      vel: { x: 300, y: 0 },
      ttl: 0.75,
      ownerId: toEntityId(10),
      ownerPlayerId: 'player-a',
      originSeq: toSeq(5),
      damage: 3,
      homing: createHoming({ targetKind: 'obstacle', turnRate: 9 }),
    });

    const firstId = homingBullet.id;
    expect(homingBullet.homing).not.toBeNull();

    pool.release(homingBullet);

    const normalBullet = pool.acquire({
      pos: { x: 400, y: 500 },
      vel: { x: 0, y: -550 },
    });

    expect(normalBullet).toBe(homingBullet);
    expect(normalBullet.id).not.toBe(firstId);
    expect(normalBullet.homing).toBeNull();
    expect(normalBullet.ttl).toBe(1.5);
    expect(normalBullet.ownerId).toBeNull();
    expect(normalBullet.ownerPlayerId).toBeNull();
    expect(normalBullet.originSeq).toBeNull();
    expect(normalBullet.damage).toBe(1);
    expect(normalBullet.alive).toBe(true);
    expect(normalBullet.pos.toJSON()).toEqual({ x: 400, y: 500 });
    expect(normalBullet.previousPos.toJSON()).toEqual({ x: 400, y: 500 });
  });

  test('Bullet previousPos stays independent from current mutable pos and matches physics/wrap/TTL', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    const bullet = world.createBullet({
      pos: { x: 950, y: 100 },
      vel: { x: 600, y: 120 },
      ttl: 0.05,
    });
    world.spawn(bullet);

    bullet.update(1 / 30, world);

    // 950 + 600 * (1/30) = 970 -> wraps to 10; previousPos must stay 950!
    expect(bullet.previousPos.x).toBe(950);
    expect(bullet.previousPos.y).toBe(100);
    expect(bullet.pos.x).toBeCloseTo(10, 6);
    expect(bullet.pos.y).toBeCloseTo(104, 6);
    expect(bullet.alive).toBe(true);

    bullet.update(1 / 30, world);
    expect(bullet.previousPos.x).toBeCloseTo(10, 6);
    expect(bullet.alive).toBe(false);
  });

  test('World releases bullets only after collisions finish and ignores foreign bullets', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 42 });
    const obstacle = world.spawn(
      new Obstacle({ pos: { x: 200, y: 200 }, radius: 26, hp: 5 }),
    );
    const foreignBullet = world.spawn(
      new Bullet({
        pos: { x: 205, y: 200 },
        vel: { x: 0, y: 0 },
        damage: 1,
      }),
    );

    const sword = world.spawn(
      new Sword({ pos: { x: 195, y: 260 }, ownerId: 'p1' }),
    );
    const pooledBullet = sword.fire(world, { originSeq: toSeq(1) });
    pooledBullet.pos = { x: 205, y: 200 };

    let releasedDuringCollision = -1;
    world.step(DEFAULT_FIXED_DT, new Map(), {
      onAfterCollisions: () => {
        releasedDuringCollision = world.getPoolStats().bullets.released;
      },
    });

    expect(releasedDuringCollision).toBe(0);
    expect(obstacle.alive).toBe(true);
    expect(foreignBullet.alive).toBe(false);
    expect(pooledBullet.alive).toBe(false);
    expect(world.getPoolStats().bullets.released).toBe(1);
    expect(world.getPoolStats().bullets.active).toBe(0);
    expect(world.getPoolStats().bullets.available).toBe(1);
  });

  test('stabilizes created count over repeated acquire/update/release cycles', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 7 });
    const sword = world.spawn(
      new Sword({ pos: { x: 480, y: 320 }, ownerId: 'p1' }),
    );

    let createdAfterWarmup = 0;

    for (let cycle = 0; cycle < 60; cycle++) {
      const bullet = sword.fire(world, { originSeq: toSeq(cycle + 1) });
      bullet.ttl = DEFAULT_FIXED_DT * 0.5;
      world.step(DEFAULT_FIXED_DT);

      if (cycle === 5) {
        createdAfterWarmup = world.getPoolStats().bullets.created;
      }
    }

    const stats = world.getPoolStats().bullets;
    expect(stats.created).toBe(createdAfterWarmup);
    expect(stats.reused).toBeGreaterThanOrEqual(50);
    expect(stats.active).toBe(0);
  });

  test('stored snapshots and emitted event payloads stay immutable after reuse', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 12 });
    const firedEvents: WorldEvent[] = [];
    const hitEvents: WorldEvent[] = [];

    world.addEventListener('fired', (event) => firedEvents.push(event));
    world.addEventListener('hit', (event) => hitEvents.push(event));

    world.spawn(new Obstacle({ pos: { x: 200, y: 150 }, radius: 26, hp: 5 }));
    const sword = world.spawn(
      new Sword({ pos: { x: 200, y: 200 }, ownerId: 'p1' }),
    );
    const bullet1 = sword.fire(world, { originSeq: toSeq(1) });
    const snap1 = world.toSnapshot(toSeq(1));
    const snapBullet1 = snap1.entities.find((e) => e.id === bullet1.id);

    const firedPosBefore = { ...firedEvents[0]?.detail };

    // Hit obstacle -> bullet1 destroyed & released, then acquire bullet2 reusing instance
    world.step(DEFAULT_FIXED_DT);
    const bullet2 = sword.fire(world, { originSeq: toSeq(2) });
    bullet2.pos = { x: 800, y: 500 };

    expect(snapBullet1?.pos).not.toEqual({ x: 800, y: 500 });
    expect(firedEvents[0]?.detail).toEqual(firedPosBefore);
    expect(hitEvents[0]?.type).toBe('hit');
  });

  test('applySnapshot preserves IDs without creating duplicates or emitting fired events', () => {
    Bullet.resetNextId(1);
    const clientWorld = new World({ width: 960, height: 640 }, { seed: 1 });
    let firedCount = 0;
    clientWorld.addEventListener('fired', () => {
      firedCount += 1;
    });

    const serverWorld = new World({ width: 960, height: 640 }, { seed: 1 });
    const b1 = serverWorld.createBullet({
      id: toEntityId(500),
      pos: { x: 100, y: 100 },
      vel: { x: 10, y: 0 },
    });
    serverWorld.spawn(b1);

    const snapshot1 = serverWorld.toSnapshot(toSeq(1));

    Bullet.resetNextId(1);
    clientWorld.applySnapshot({ ...snapshot1, tick: toTick(1) });

    expect(firedCount).toBe(0);
    expect(clientWorld.count).toBe(1);
    expect(clientWorld.get(toEntityId(500))?.pos.toJSON()).toEqual({
      x: 100,
      y: 100,
    });

    // Apply updated snapshot twice with no duplicates and old bullet released into pool
    const snapshot2 = {
      ...snapshot1,
      tick: toTick(2),
      entities: [],
    };
    clientWorld.applySnapshot(snapshot2);

    expect(clientWorld.count).toBe(0);
    expect(clientWorld.getPoolStats().bullets).toMatchObject({
      active: 0,
      released: 1,
      available: 1,
    });
  });
});

describe('ParticlePool and Explosion regressions', () => {
  test('particles have independent coordinates, preserve order on compaction, and return to pool on expiry', () => {
    const pool = new ParticlePool(64);
    const explosion = new Explosion({
      pos: { x: 300, y: 200 },
      count: 0,
      particles: [
        {
          pos: { x: 10, y: 10 },
          vel: { x: 100, y: 0 },
          lifetime: 0.2,
          remaining: 0.2,
          radius: 3,
        },
        {
          pos: { x: 20, y: 20 },
          vel: { x: 0, y: 50 },
          lifetime: 0.05,
          remaining: 0.05,
          radius: 2,
        },
        {
          pos: { x: 30, y: 30 },
          vel: { x: -50, y: 0 },
          lifetime: 0.4,
          remaining: 0.4,
          radius: 4,
        },
      ],
      particlePool: pool,
    });

    expect(explosion.particles[0]?.pos).not.toBe(explosion.particles[1]?.pos);
    expect(pool.getStats()).toMatchObject({ active: 3, acquired: 3 });

    explosion.update(0.1);

    expect(explosion.particles.map((p) => p.radius)).toEqual([3, 4]);
    expect(explosion.particles[0]?.pos.toJSON()).toEqual({ x: 20, y: 10 });
    expect(pool.getStats()).toMatchObject({
      active: 2,
      released: 1,
      available: 1,
    });

    explosion.update(0.5);
    expect(explosion.alive).toBe(false);
    expect(pool.getStats()).toMatchObject({
      active: 0,
      released: 3,
      available: 3,
    });
  });

  test('Obstacle previousPos stays independent and bounces without wrapping', () => {
    const world = new World({ width: 200, height: 200 }, { seed: 1 });
    const obstacle = world.spawn(
      new Obstacle({
        pos: { x: 28, y: 100 },
        vel: { x: -120, y: 0 },
        radius: 26,
      }),
    );

    obstacle.update(1 / 30, world);

    expect(obstacle.previousPos.toJSON()).toEqual({ x: 28, y: 100 });
    expect(obstacle.pos.x).toBe(26);
    expect(obstacle.vel.x).toBe(120);
  });

  test('1000-step deterministic scenario remains bit-identical', () => {
    const runA = runDeterministicScenario({ steps: 1000, seed: 1337 });
    const runB = runDeterministicScenario({ steps: 1000, seed: 1337 });

    expect(runA).toEqual(runB);
  });
});
