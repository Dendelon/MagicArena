import { Bullet } from '../entities/Bullet.js';
import { Obstacle } from '../entities/Obstacle.js';
import { Pickup } from '../entities/Pickup.js';
import { Sword } from '../entities/Sword.js';
import { findSafeSpawn } from './arena.js';
import { createHealingEffect } from './behaviors/healing.js';
import { createHoming } from './behaviors/homing.js';
import { Entity } from './entity.js';
import { Vector2 } from './vector.js';
import { World } from './world.js';
import { createInputMessage } from '../protocol/messages.js';

export const DEFAULT_SCENARIO_STEPS = 1000;
export const DEFAULT_FIXED_DT = 1 / 60;
export const DEFAULT_SCENARIO_SEED = 1337;

export const createDefaultInputForTick = (tick) => {
  const phase = tick % 180;
  let turn = 0;

  if (phase < 45) turn = 1;
  else if (phase >= 90 && phase < 135) turn = -1;

  return createInputMessage({
    seq: tick + 1,
    tick,
    thrust: phase < 120,
    turn,
    brake: phase >= 150 && phase < 165,
    fire: tick % 40 === 10,
    homingFire: tick % 90 === 25,
  });
};

export const runDeterministicScenario = ({
  seed = DEFAULT_SCENARIO_SEED,
  steps = DEFAULT_SCENARIO_STEPS,
  dt = DEFAULT_FIXED_DT,
  bounds = { width: 1024, height: 768 },
  inputSequence = null,
} = {}) => {
  Entity.resetNextId(1);

  const world = new World(bounds, { seed });

  const events = {
    fired: 0,
    hit: 0,
    exploded: 0,
    healed: 0,
    scoreChanged: 0,
  };

  for (const eventName of Object.keys(events)) {
    world.addEventListener(eventName, () => {
      events[eventName] += 1;
    });
  }

  let sword = new Sword({
    pos: new Vector2(bounds.width / 2, bounds.height / 2),
  });
  world.spawn(sword);

  const obstacles = [
    new Obstacle({
      pos: new Vector2(bounds.width * 0.2, bounds.height * 0.3),
      vel: new Vector2(40, 25),
      radius: 28,
    }),
    new Obstacle({
      pos: new Vector2(bounds.width * 0.8, bounds.height * 0.65),
      vel: new Vector2(-35, 30),
      radius: 24,
    }),
    new Obstacle({
      pos: new Vector2(bounds.width * 0.7, bounds.height * 0.2),
      vel: new Vector2(-25, -40),
      radius: 32,
    }),
  ];

  obstacles[0].homing = createHoming({
    targetKind: 'sword',
    turnRate: 2.4,
    speed: 70,
  });

  for (const obstacle of obstacles) {
    world.spawn(obstacle);
  }

  world.spawn(
    new Pickup({
      pos: new Vector2(bounds.width * 0.5, bounds.height * 0.78),
      effect: createHealingEffect(1),
    }),
  );

  const inputs = new Map();
  let respawnTimer = null;
  let lastProcessedSeq = 0;

  for (let tick = 0; tick < steps; tick++) {
    const command =
      typeof inputSequence === 'function'
        ? inputSequence(tick)
        : Array.isArray(inputSequence)
          ? (inputSequence[tick] ?? createInputMessage({ seq: tick + 1, tick }))
          : createDefaultInputForTick(tick);

    if (sword.alive) {
      inputs.set(sword.id, command);
      lastProcessedSeq = command.seq ?? tick + 1;
    }

    world.step(dt, inputs);

    if (sword.alive && command.fire) {
      sword.fire(world);
    }

    if (sword.alive && command.homingFire) {
      const bullet = sword.fire(world);
      if (bullet instanceof Bullet) {
        bullet.homing = createHoming({
          targetKind: 'obstacle',
          turnRate: 9,
        });
        bullet.ttl = 3;
      }
    }

    if (!sword.alive) {
      inputs.delete(sword.id);

      if (respawnTimer === null) {
        respawnTimer = 2;
      } else {
        respawnTimer = Math.max(0, respawnTimer - dt);
      }

      if (respawnTimer <= 0) {
        sword = new Sword({
          pos: findSafeSpawn(world, world.rng),
        });
        world.spawn(sword);
        respawnTimer = null;
      }
    }
  }

  return {
    seed: world.seed,
    steps,
    dt,
    tick: world.tick,
    score: world.score,
    events,
    snapshot: world.toSnapshot(lastProcessedSeq),
  };
};

