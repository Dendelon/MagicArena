import { afterEach, describe, expect, test, vi } from 'vitest';

import { World, toEntityId, toSeq, toTick } from '@magicarena/shared';

import { createProjectilePredictor } from '../src/network/projectiles.ts';

afterEach(() => {
  vi.useRealTimers();
});

const DEFAULT_SWORD = {
  entityId: toEntityId(1),
  alive: true,
  x: 300,
  y: 300,
  vx: 0,
  vy: 0,
  angle: 0,
  thrust: false,
};

describe('ProjectilePredictor pooling', () => {
  test('uses dedicated BulletPool and releases all bullets on reset()', () => {
    const world = new World({ width: 960, height: 640 });
    const predictor = createProjectilePredictor();

    for (let i = 1; i <= 5; i++) {
      predictor.spawnLocalShot({
        originSeq: toSeq(i),
        swordState: DEFAULT_SWORD,
        fire: true,
        homingFire: i % 2 === 0,
        world,
        ownerId: toEntityId(1),
        ownerPlayerId: 'p1',
      });
    }

    const activeStats = predictor.getPoolStats();
    expect(activeStats.active).toBe(7);
    expect(world.getPoolStats().bullets.acquired).toBe(0);

    predictor.reset();

    const resetStats = predictor.getPoolStats();
    expect(resetStats.active).toBe(0);
    expect(resetStats.released).toBe(7);
    expect(resetStats.available).toBe(7);
  });

  test('releases bullets on rejection, expiry, server disappearance, and stabilizes created count', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const world = new World({ width: 960, height: 640 });
    const predictor = createProjectilePredictor();

    // Spawn 1 normal shot, reject via fireAck
    predictor.spawnLocalShot({
      originSeq: toSeq(1),
      swordState: DEFAULT_SWORD,
      fire: true,
      homingFire: false,
      world,
      ownerId: toEntityId(1),
      ownerPlayerId: 'p1',
    });
    predictor.onFireAck({
      v: 1,
      type: 'fireAck',
      originSeq: toSeq(1),
      accepted: false,
      entityId: null,
      entityIds: [],
    });
    expect(predictor.getPoolStats()).toMatchObject({
      active: 0,
      released: 1,
      available: 1,
    });

    // Spawn shot, expire after TTL via step()
    predictor.spawnLocalShot({
      originSeq: toSeq(2),
      swordState: DEFAULT_SWORD,
      fire: true,
      homingFire: false,
      world,
      ownerId: toEntityId(1),
      ownerPlayerId: 'p1',
    });
    expect(predictor.getPoolStats().reused).toBe(1);

    vi.advanceTimersByTime(3000);
    predictor.step(1 / 30, world);
    expect(predictor.getPoolStats().active).toBe(0);

    // Spawn shot, match on server snapshot, then disappear on next snapshot
    predictor.spawnLocalShot({
      originSeq: toSeq(3),
      swordState: DEFAULT_SWORD,
      fire: true,
      homingFire: false,
      world,
      ownerId: toEntityId(1),
      ownerPlayerId: 'p1',
    });
    predictor.onSnapshot(
      {
        v: 1,
        type: 'snapshot',
        tick: toTick(1),
        lastProcessedSeq: toSeq(3),
        entities: [
          {
            id: toEntityId(99),
            kind: 'bullet',
            pos: { x: 300, y: 240 },
            vel: { x: 0, y: -550 },
            angle: 0,
            radius: 6,
            alive: true,
            ttl: 1.4,
            ownerId: toEntityId(1),
            ownerPlayerId: 'p1',
            originSeq: toSeq(3),
            damage: 1,
            homing: null,
          },
        ],
      },
      'p1',
      toEntityId(1),
    );
    expect(predictor.getPoolStats().active).toBe(1);

    predictor.onSnapshot(
      {
        v: 1,
        type: 'snapshot',
        tick: toTick(2),
        lastProcessedSeq: toSeq(3),
        entities: [],
      },
      'p1',
      toEntityId(1),
    );
    expect(predictor.getPoolStats().active).toBe(0);

    // Rapid fire > MAX_LOCAL_PROJECTILES stabilizes created at <= 32
    for (let seq = 10; seq <= 70; seq++) {
      predictor.spawnLocalShot({
        originSeq: toSeq(seq),
        swordState: DEFAULT_SWORD,
        fire: true,
        homingFire: false,
        world,
        ownerId: toEntityId(1),
        ownerPlayerId: 'p1',
      });
    }

    const finalStats = predictor.getPoolStats();
    expect(finalStats.created).toBeLessThanOrEqual(32);
    expect(finalStats.reused).toBeGreaterThan(25);
  });
});
