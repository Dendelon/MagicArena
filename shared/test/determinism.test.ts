import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Bullet,
  DEFAULT_SCENARIO_STEPS,
  Entity,
  Explosion,
  Obstacle,
  Pickup,
  Sword,
  Vector2,
  World,
  createHealingEffect,
  createHoming,
  createInputMessage,
  createSnapshotMessage,
  decodeMessage,
  encodeMessage,
  entityFromJSON,
  mulberry32,
  runDeterministicScenario,
  toEntityId,
  toSeq,
} from '../src/index.ts';

import { EntitySnapshotSchema } from '../src/protocol/index.ts';

test('shared modules import cleanly without DOM globals', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof World, 'function');
  assert.equal(typeof Sword, 'function');
  assert.equal(typeof mulberry32, 'function');
});

test('mulberry32 produces identical sequence for identical seeds', () => {
  const rngA = mulberry32(42);
  const rngB = mulberry32(42);
  const rngC = mulberry32(99);

  const seqA = Array.from({ length: 10 }, () => rngA());
  const seqB = Array.from({ length: 10 }, () => rngB());
  const seqC = Array.from({ length: 10 }, () => rngC());

  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
});

test('entities serialize to plain JSON data and restore preserving ID', () => {
  Entity.resetNextId(100);

  const sword = new Sword({
    pos: new Vector2(120, 240),
    vel: new Vector2(15, -30),
    angle: 0.75,
  });
  sword.takeDamage(1);

  const bullet = new Bullet({
    pos: new Vector2(10, 20),
    vel: new Vector2(300, 0),
    ownerId: sword.id,
    homing: createHoming({ targetKind: 'obstacle', turnRate: 9 }),
  });

  const obstacle = new Obstacle({
    pos: new Vector2(400, 300),
    vel: new Vector2(-20, 40),
    radius: 28,
    homing: createHoming({ targetKind: 'sword', turnRate: 2.4, speed: 70 }),
  });

  const pickup = new Pickup({
    pos: new Vector2(512, 600),
    effect: createHealingEffect(1),
  });

  const explosion = new Explosion({
    pos: new Vector2(200, 200),
    count: 5,
    random: mulberry32(7),
  });

  for (const entity of [sword, bullet, obstacle, pickup, explosion]) {
    const raw: unknown = JSON.parse(JSON.stringify(entity.toJSON()));
    const snapshot = EntitySnapshotSchema.parse(raw);
    const restored = entityFromJSON(snapshot);

    assert.equal(restored.id, entity.id);
    assert.equal(restored.kind, entity.kind);
    assert.deepEqual(restored.toJSON(), raw);
  }
});

test('protocol and codec round-trip Input and Snapshot messages', () => {
  const input = createInputMessage({
    seq: 12,
    tick: 340,
    thrust: true,
    turn: -1,
    brake: false,
    fire: true,
    homingFire: false,
  });

  assert.deepEqual(decodeMessage(encodeMessage(input)), input);

  const world = new World({ width: 800, height: 600 }, { seed: 5 });
  const sword = new Sword({ id: toEntityId(7), pos: new Vector2(400, 300) });
  world.spawn(sword);

  const snapshot = createSnapshotMessage(world.toSnapshot(toSeq(12)));
  assert.deepEqual(decodeMessage(encodeMessage(snapshot)), snapshot);
});

test('1000-step deterministic scenario produces identical output for same inputs', () => {
  const firstRun = runDeterministicScenario();
  const secondRun = runDeterministicScenario();

  assert.equal(firstRun.steps, DEFAULT_SCENARIO_STEPS);
  assert.equal(firstRun.tick, 1000);
  assert.deepEqual(firstRun, secondRun);
  assert.equal(JSON.stringify(firstRun), JSON.stringify(secondRun));
});

test('deterministic scenario changes output when seed or input changes', () => {
  const baseline = runDeterministicScenario({ seed: 1337 });
  const differentInput = runDeterministicScenario({
    seed: 1337,
    inputSequence: (tick) =>
      createInputMessage({
        seq: tick + 1,
        tick,
        thrust: false,
        turn: 1,
        brake: true,
        fire: false,
        homingFire: false,
      }),
  });

  assert.notDeepEqual(baseline.snapshot, differentInput.snapshot);
});

