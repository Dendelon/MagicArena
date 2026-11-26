import { describe, expect, test } from 'vitest';

import {
  Bullet,
  Obstacle,
  Pickup,
  Sword,
  Vector2,
  World,
  createHealingEffect,
} from '../src/index.ts';
import { circlesOverlap } from '../src/sim/collision.ts';

const circle = (x: number, y: number, radius = 10) => ({
  pos: { x, y },
  radius,
});

const createTestWorld = () => new World({ width: 960, height: 640 }, { seed: 42 });

describe('Circle collisions', () => {
  test('Detects overlapping circles', () => {
    expect(circlesOverlap(circle(0, 0), circle(15, 0))).toBe(true);
  });

  test('Rejects separated circles', () => {
    expect(circlesOverlap(circle(0, 0), circle(30, 0))).toBe(false);
  });

  test('Detects circles with the same center', () => {
    expect(circlesOverlap(circle(5, 5), circle(5, 5))).toBe(true);
  });

  test('Collision detection is symmetric', () => {
    const a = circle(0, 0, 15);
    const b = circle(10, 10, 5);

    expect(circlesOverlap(a, b)).toBe(circlesOverlap(b, a));
  });

  test('Treats touching boundary circles as overlapping (<=)', () => {
    expect(circlesOverlap(circle(0, 0, 10), circle(20, 0, 10))).toBe(true);
    expect(circlesOverlap(circle(0, 0, 10), circle(20.001, 0, 10))).toBe(
      false,
    );
  });
});

describe('World collision resolution', () => {
  test('Regular bullet damages an obstacle', () => {
    const world = createTestWorld();
    const obstacle = world.spawn(
      new Obstacle({
        pos: new Vector2(200, 200),
        radius: 26,
        hp: 2,
      }),
    );
    const bullet = world.spawn(
      new Bullet({
        pos: new Vector2(210, 200),
        vel: new Vector2(0, 0),
        radius: 6,
        damage: 1,
      }),
    );

    let hits = 0;
    world.addEventListener('hit', () => {
      hits += 1;
    });

    world.step(1 / 60);

    expect(obstacle.hp).toBe(1);
    expect(obstacle.alive).toBe(true);
    expect(bullet.alive).toBe(false);
    expect(hits).toBe(1);
  });

  test('Bullet does not damage its own sword', () => {
    const world = createTestWorld();
    const sword = world.spawn(
      new Sword({
        pos: new Vector2(200, 200),
        hp: 3,
      }),
    );
    const bullet = world.spawn(
      new Bullet({
        pos: new Vector2(200, 200),
        vel: new Vector2(0, 0),
        ownerId: sword.id,
        damage: 1,
      }),
    );

    world.step(1 / 60);

    expect(sword.hp).toBe(3);
    expect(sword.alive).toBe(true);
    expect(bullet.alive).toBe(true);
  });

  test('Destroying an obstacle spawns an Explosion and increments score', () => {
    const world = createTestWorld();
    const obstacle = world.spawn(
      new Obstacle({
        pos: new Vector2(300, 300),
        radius: 26,
        hp: 1,
      }),
    );
    world.spawn(
      new Bullet({
        pos: new Vector2(300, 300),
        vel: new Vector2(0, 0),
        damage: 1,
      }),
    );

    let exploded = 0;
    world.addEventListener('exploded', () => {
      exploded += 1;
    });

    world.step(1 / 60);

    expect(obstacle.alive).toBe(false);
    expect([...world.ofKind('explosion')].length).toBe(1);
    expect(world.score).toBe(10);
    expect(exploded).toBe(1);
  });

  test('Healing pickup restores sword HP', () => {
    const world = createTestWorld();
    const sword = world.spawn(
      new Sword({
        pos: new Vector2(400, 300),
        hp: 3,
      }),
    );
    sword.takeDamage(1);

    const pickup = world.spawn(
      new Pickup({
        pos: new Vector2(400, 300),
        effect: createHealingEffect(1),
      }),
    );

    let healedHp = 0;
    world.addEventListener('healed', (event) => {
      if (event.type === 'healed') {
        healedHp = event.detail.hp;
      }
    });

    world.step(1 / 60);

    expect(sword.hp).toBe(3);
    expect(healedHp).toBe(3);
    expect(pickup.alive).toBe(false);
  });

  test('Dead entity does not participate in subsequent collisions', () => {
    const world = createTestWorld();
    const sword = world.spawn(
      new Sword({
        pos: new Vector2(200, 200),
        hp: 3,
      }),
    );
    const deadObstacle = world.spawn(
      new Obstacle({
        pos: new Vector2(200, 200),
        hp: 1,
        alive: false,
      }),
    );

    let hits = 0;
    world.addEventListener('hit', () => {
      hits += 1;
    });

    world.step(1 / 60);

    expect(deadObstacle.alive).toBe(false);
    expect(sword.hp).toBe(3);
    expect(hits).toBe(0);
  });

  test('Separated entities do not emit collision events', () => {
    const world = createTestWorld();
    world.spawn(
      new Sword({
        pos: new Vector2(100, 100),
      }),
    );
    world.spawn(
      new Obstacle({
        pos: new Vector2(700, 500),
      }),
    );

    let events = 0;
    world.addEventListener('hit', () => {
      events += 1;
    });
    world.addEventListener('exploded', () => {
      events += 1;
    });
    world.addEventListener('healed', () => {
      events += 1;
    });

    world.step(1 / 60);

    expect(events).toBe(0);
  });

  test('Fast bullet tunnels through obstacle when start and end positions do not overlap', () => {
    const world = createTestWorld();
    const obstacle = world.spawn(
      new Obstacle({
        pos: new Vector2(300, 320),
        vel: new Vector2(0, 0),
        radius: 20,
        hp: 1,
      }),
    );
    const bullet = world.spawn(
      new Bullet({
        pos: new Vector2(200, 320),
        vel: new Vector2(6000, 0),
        radius: 6,
        damage: 1,
      }),
    );

    let hits = 0;
    world.addEventListener('hit', () => {
      hits += 1;
    });

    world.step(1 / 30);

    // Current discrete collision check tests only end-of-step positions.
    expect(bullet.pos.x).toBeCloseTo(400);
    expect(obstacle.alive).toBe(true);
    expect(obstacle.hp).toBe(1);
    expect(bullet.alive).toBe(true);
    expect(hits).toBe(0);
  });
});

