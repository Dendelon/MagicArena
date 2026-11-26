import { describe, expect, test } from 'vitest';

import {
  Bullet,
  Obstacle,
  Sword,
  Vector2,
  createSnapshotMessage,
  toEntityId,
} from '@magicarena/shared';
import type { SnapshotMessage } from '@magicarena/shared';

import { Bot } from '../src/bots/Bot.ts';

const BOUNDS = { width: 960, height: 640 } as const;

const buildSnapshot = (
  entities: Array<Sword | Bullet | Obstacle>,
  tick = 1,
): SnapshotMessage =>
  createSnapshotMessage({
    tick,
    lastProcessedSeq: 0,
    bounds: BOUNDS,
    entities: entities.map((entity) => entity.toJSON()),
  });

describe('Bot AI decision making', () => {
  test('returns neutral controls when own sword is missing', () => {
    const bot = new Bot(42);
    const enemy = new Sword({
      id: toEntityId('enemy-sword'),
      ownerId: 'enemy-1',
      pos: new Vector2(400, 300),
    });

    const controls = bot.decide(buildSnapshot([enemy]), 'bot-1', 1, BOUNDS);

    expect(controls).toEqual({
      thrust: false,
      turn: 0,
      brake: false,
      fire: false,
      homingFire: false,
    });
  });

  test('returns neutral controls when own sword is dead', () => {
    const bot = new Bot(42);
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(200, 200),
      alive: false,
    });

    const controls = bot.decide(buildSnapshot([own]), 'bot-1', 1, BOUNDS);

    expect(controls).toEqual({
      thrust: false,
      turn: 0,
      brake: false,
      fire: false,
      homingFire: false,
    });
  });

  test('evades nearby obstacle by thrusting and turning away', () => {
    const bot = new Bot(7);
    // Heading up (angle = 0) straight toward obstacle directly ahead at y - 60.
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(300, 300),
      angle: 0,
    });
    const obstacle = new Obstacle({
      id: toEntityId('obs-1'),
      pos: new Vector2(320, 250),
    });

    const controls = bot.decide(
      buildSnapshot([own, obstacle]),
      'bot-1',
      1,
      BOUNDS,
    );

    expect(controls.thrust).toBe(true);
    expect(controls.brake).toBe(false);
    expect(controls.fire).toBe(false);
    expect(controls.homingFire).toBe(false);
    expect(controls.turn).toBe(-1);
  });

  test('evades approaching enemy bullet', () => {
    const bot = new Bot(7);
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(400, 300),
      angle: 0,
    });
    const enemyBullet = new Bullet({
      id: toEntityId('b-enemy'),
      ownerId: toEntityId('enemy-sword'),
      ownerPlayerId: 'enemy-1',
      pos: new Vector2(450, 240),
      vel: new Vector2(-100, 120),
    });

    const controls = bot.decide(
      buildSnapshot([own, enemyBullet]),
      'bot-1',
      1,
      BOUNDS,
    );

    expect(controls.thrust).toBe(true);
    expect(controls.fire).toBe(false);
    expect(controls.homingFire).toBe(false);
    expect(controls.turn).not.toBe(0);
  });

  test('ignores own bullets and non-approaching distant enemy bullets', () => {
    const bot = new Bot(7);
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(200, 200),
      angle: 0,
    });
    const ownBullet = new Bullet({
      id: toEntityId('b-own'),
      ownerId: toEntityId('bot-sword'),
      ownerPlayerId: 'bot-1',
      pos: new Vector2(210, 200),
      vel: new Vector2(-100, 0),
    });
    const recedingBullet = new Bullet({
      id: toEntityId('b-away'),
      ownerId: toEntityId('enemy-sword'),
      ownerPlayerId: 'enemy-1',
      pos: new Vector2(290, 200),
      vel: new Vector2(400, 0),
    });
    const enemy = new Sword({
      id: toEntityId('enemy-sword'),
      ownerId: 'enemy-1',
      pos: new Vector2(200, 100),
    });

    const controls = bot.decide(
      buildSnapshot([own, ownBullet, recedingBullet, enemy]),
      'bot-1',
      0.5,
      BOUNDS,
    );

    // Not evading: aimed directly up at enemy within attack range, so it fires.
    expect(controls.fire).toBe(true);
  });

  test('chases nearest alive enemy ahead outside attack range without firing', () => {
    const bot = new Bot(11);
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(100, 300),
      angle: Math.PI / 2,
    });
    const deadCloserEnemy = new Sword({
      id: toEntityId('dead-enemy'),
      ownerId: 'enemy-dead',
      pos: new Vector2(250, 300),
      alive: false,
    });
    const nearestAliveEnemy = new Sword({
      id: toEntityId('nearest-enemy'),
      ownerId: 'enemy-1',
      pos: new Vector2(510, 250),
    });
    const fartherAliveEnemy = new Sword({
      id: toEntityId('farther-enemy'),
      ownerId: 'enemy-2',
      pos: new Vector2(550, 380),
    });

    const controls = bot.decide(
      buildSnapshot([own, deadCloserEnemy, nearestAliveEnemy, fartherAliveEnemy]),
      'bot-1',
      0.5,
      BOUNDS,
    );

    expect(controls.thrust).toBe(true);
    expect(controls.turn).toBe(-1);
    expect(controls.fire).toBe(false);
    expect(controls.homingFire).toBe(false);
  });

  test('turns toward enemy positioned directly to the side without thrusting', () => {
    const bot = new Bot(11);
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(100, 300),
      angle: 0,
    });
    const sideEnemy = new Sword({
      id: toEntityId('side-enemy'),
      ownerId: 'enemy-1',
      pos: new Vector2(520, 300),
    });

    const controls = bot.decide(
      buildSnapshot([own, sideEnemy]),
      'bot-1',
      0.5,
      BOUNDS,
    );

    expect(controls.turn).toBe(1);
    expect(controls.thrust).toBe(false);
    expect(controls.fire).toBe(false);
    expect(controls.homingFire).toBe(false);
  });

  test('uses toroidal arena wraparound when aiming and measuring range', () => {
    const bot = new Bot(11);
    // Across top wrap boundary: y=20 to y=610 is -50px (straight up at angle 0).
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(400, 20),
      angle: 0,
    });
    const wrappedEnemy = new Sword({
      id: toEntityId('enemy-sword'),
      ownerId: 'enemy-1',
      pos: new Vector2(400, 610),
    });

    const controls = bot.decide(
      buildSnapshot([own, wrappedEnemy]),
      'bot-1',
      0.5,
      BOUNDS,
    );

    expect(controls.turn).toBe(0);
    expect(controls.fire).toBe(true);
  });

  test('aims toward close enemy and fires regular bullet when aligned', () => {
    const bot = new Bot(19);
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(300, 300),
      angle: 0,
    });
    // Target directly ahead (upward) inside 350px range.
    const enemy = new Sword({
      id: toEntityId('enemy-sword'),
      ownerId: 'enemy-1',
      pos: new Vector2(300, 120),
    });

    const controls = bot.decide(
      buildSnapshot([own, enemy]),
      'bot-1',
      0.2,
      BOUNDS,
    );

    expect(controls.turn).toBe(0);
    expect(controls.fire).toBe(true);
    expect(controls.homingFire).toBe(false);
  });

  test('respects regular fire cooldown between shots', () => {
    const bot = new Bot(23);
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(300, 300),
      angle: 0,
    });
    const enemy = new Sword({
      id: toEntityId('enemy-sword'),
      ownerId: 'enemy-1',
      pos: new Vector2(300, 150),
    });
    const snapshot = buildSnapshot([own, enemy]);

    const first = bot.decide(snapshot, 'bot-1', 0.1, BOUNDS);
    const duringCooldown = bot.decide(snapshot, 'bot-1', 0.3, BOUNDS);
    const afterCooldown = bot.decide(snapshot, 'bot-1', 0.8, BOUNDS);

    expect(first.fire).toBe(true);
    expect(duringCooldown.fire).toBe(false);
    expect(afterCooldown.fire).toBe(true);
  });

  test('fires homing missile after cooldown and never fires both weapons together', () => {
    const bot = new Bot(31);
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(300, 300),
      angle: 0,
    });
    const enemy = new Sword({
      id: toEntityId('enemy-sword'),
      ownerId: 'enemy-1',
      pos: new Vector2(300, 150),
    });
    const snapshot = buildSnapshot([own, enemy]);

    let homingCount = 0;
    let simultaneousCount = 0;

    for (let step = 0; step < 60; step++) {
      const timeSec = step * 0.1;
      const controls = bot.decide(snapshot, 'bot-1', timeSec, BOUNDS);

      if (controls.homingFire) homingCount++;
      if (controls.fire && controls.homingFire) simultaneousCount++;
    }

    expect(homingCount).toBeGreaterThanOrEqual(2);
    expect(simultaneousCount).toBe(0);
  });

  test('wanders smoothly when no enemies or threats exist', () => {
    const bot = new Bot(99);
    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(480, 320),
    });
    const snapshot = buildSnapshot([own]);

    const first = bot.decide(snapshot, 'bot-1', 0.1, BOUNDS);
    const immediate = bot.decide(snapshot, 'bot-1', 0.2, BOUNDS);

    expect(first.thrust).toBe(true);
    expect(first.brake).toBe(false);
    expect(first.fire).toBe(false);
    expect(first.homingFire).toBe(false);
    expect([-1, 0, 1]).toContain(first.turn);
    expect(immediate.turn).toBe(first.turn);
  });

  test('produces deterministic control sequences for identical seed', () => {
    const botA = new Bot(1337);
    const botB = new Bot(1337);

    const own = new Sword({
      id: toEntityId('bot-sword'),
      ownerId: 'bot-1',
      pos: new Vector2(400, 320),
      angle: 0.4,
    });
    const enemy = new Sword({
      id: toEntityId('enemy-sword'),
      ownerId: 'enemy-1',
      pos: new Vector2(560, 260),
    });
    const snapshot = buildSnapshot([own, enemy]);

    for (let step = 0; step < 25; step++) {
      const timeSec = step * 0.15;
      expect(botA.decide(snapshot, 'bot-1', timeSec, BOUNDS)).toEqual(
        botB.decide(snapshot, 'bot-1', timeSec, BOUNDS),
      );
    }
  });
});

