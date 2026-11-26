import { describe, expect, test, vi } from 'vitest';

import {
  Obstacle,
  Sword,
  Vector2,
  World,
  mulberry32,
  toEntityId,
  toSeq,
  toTick,
} from '../src/index.ts';

import type { EntityId, SnapshotWorldState, SwordInput } from '../src/index.ts';

describe('World', () => {
  test('spawn returns the added entity and tracks count', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    const sword = new Sword({ id: toEntityId(10), pos: new Vector2(100, 100) });

    const spawned = world.spawn(sword);

    expect(spawned).toBe(sword);
    expect(world.count).toBe(1);
  });

  test('spawn throws on duplicate EntityId', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    const id = toEntityId(10);

    world.spawn(new Sword({ id, pos: new Vector2(100, 100) }));

    expect(() =>
      world.spawn(new Sword({ id, pos: new Vector2(200, 200) })),
    ).toThrow();
  });

  test('get returns entity by EntityId and undefined when missing', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    const sword = world.spawn(
      new Sword({ id: toEntityId(10), pos: new Vector2(100, 100) }),
    );

    expect(world.get(toEntityId(10))).toBe(sword);
    expect(world.get(toEntityId(999999))).toBeUndefined();
  });

  test('despawn removes entity from active simulation and returns false if absent', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    const sword = world.spawn(
      new Sword({ id: toEntityId(5), pos: new Vector2(100, 100) }),
    );

    expect(world.despawn(toEntityId(999))).toBe(false);
    expect(world.despawn(sword.id)).toBe(true);
    expect(sword.alive).toBe(false);
    expect([...world.ofKind('sword')]).toEqual([]);

    world.step(1 / 60);

    expect(world.get(sword.id)).toBeUndefined();
  });

  test('ofKind returns only alive entities of matching kind', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    const aliveSword = world.spawn(
      new Sword({ id: toEntityId(1), pos: new Vector2(100, 100) }),
    );
    world.spawn(
      new Sword({ id: toEntityId(2), pos: new Vector2(200, 200), alive: false }),
    );
    world.spawn(
      new Obstacle({ id: toEntityId(3), pos: new Vector2(400, 300) }),
    );

    const swords = [...world.ofKind('sword')];

    expect(swords).toEqual([aliveSword]);
  });

  test('step increments world tick and accepts plain record inputs', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    const sword = world.spawn(
      new Sword({ id: toEntityId(1), pos: new Vector2(200, 200) }),
    );

    expect(world.tick).toBe(0);

    world.step(1 / 30, {
      '1': { thrust: true, turn: 0, brake: false },
    });

    expect(world.tick).toBe(1);
    expect(sword.vel.length()).toBeGreaterThan(0);
  });

  test('toSnapshot contains current tick and lastProcessedSeq', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    world.step(1 / 60);
    world.step(1 / 60);

    const snapshot = world.toSnapshot(toSeq(7));

    expect(snapshot.tick).toBe(2);
    expect(snapshot.lastProcessedSeq).toBe(7);
  });

  test('Event listeners support once, removeEventListener, and dispatch with or without listeners', () => {
    const world = new World({ width: 960, height: 640 }, { seed: 1 });
    const first = vi.fn();
    const second = vi.fn();
    const onceListener = vi.fn();

    // Dispatch without listeners does not fail.
    expect(
      world.dispatchEvent({ type: 'scoreChanged', detail: { score: 10 } }),
    ).toBe(true);

    // Removing listener when none registered is a no-op.
    world.removeEventListener('scoreChanged', first);

    world.addEventListener('scoreChanged', first);
    world.addEventListener('scoreChanged', second);
    world.addEventListener('healed', onceListener, { once: true });

    world.emit('healed', { hp: 3 });
    world.emit('healed', { hp: 2 });
    expect(onceListener).toHaveBeenCalledTimes(1);

    // Removing one of two listeners preserves the other, then removing the last cleans up.
    world.removeEventListener('scoreChanged', first);
    world.emit('scoreChanged', { score: 5 });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    world.removeEventListener('scoreChanged', second);
    world.emit('scoreChanged', { score: 6 });
    expect(second).toHaveBeenCalledTimes(1);
  });

  test('applySnapshot restores entities, bounds, score, tick, and dispatches events', () => {
    const world = new World({ width: 400, height: 300 }, { seed: 1 });
    const sword = new Sword({ id: toEntityId(3), pos: new Vector2(150, 120) });

    const scoreListener = vi.fn();
    world.addEventListener('scoreChanged', scoreListener);

    const snapshot: SnapshotWorldState = {
      tick: toTick(25),
      lastProcessedSeq: toSeq(19),
      score: 40,
      bounds: { width: 1200, height: 800 },
      entities: [sword.toJSON()],
      events: [{ type: 'scoreChanged', detail: { score: 40 } }],
    };

    world.applySnapshot(snapshot);

    expect(world.tick).toBe(25);
    expect(world.score).toBe(40);
    expect(world.bounds).toEqual({ width: 1200, height: 800 });
    expect(world.get(toEntityId(3))?.kind).toBe('sword');
    expect(scoreListener).toHaveBeenCalledWith({
      type: 'scoreChanged',
      detail: { score: 40 },
    });
  });

  test('World.fromJSON restores serialized state', () => {
    const world = new World({ width: 800, height: 600 }, { seed: 77 });
    world.spawn(
      new Sword({
        id: toEntityId(11),
        pos: new Vector2(300, 250),
        vel: new Vector2(20, -10),
        angle: 0.3,
      }),
    );
    world.step(1 / 30);

    const serialized = world.toJSON();
    const restored = World.fromJSON(serialized);

    expect(restored.toJSON()).toEqual(serialized);
  });

  test('Single step is deterministic across identical serialized copies', () => {
    const seed = 1234;
    const swordId = toEntityId(1);
    const worldA = new World(
      { width: 960, height: 640 },
      { seed, rng: mulberry32(seed) },
    );

    worldA.spawn(
      new Sword({
        id: swordId,
        pos: new Vector2(200, 200),
        vel: new Vector2(50, -25),
        angle: 0.4,
      }),
    );

    const worldB = World.fromJSON(worldA.toJSON(), {
      rng: mulberry32(seed),
    });

    const inputs = new Map<EntityId, SwordInput>([
      [swordId, { thrust: true, turn: 0.5, brake: false }],
    ]);

    worldA.step(1 / 60, inputs);
    worldB.step(1 / 60, inputs);

    expect(worldA.toJSON()).toEqual(worldB.toJSON());
  });
});
