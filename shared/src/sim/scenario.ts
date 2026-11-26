import { Bullet } from '../entities/Bullet.ts';
import { Obstacle } from '../entities/Obstacle.ts';
import { Pickup } from '../entities/Pickup.ts';
import { Sword } from '../entities/Sword.ts';
import { findSafeSpawn } from './arena.ts';
import { createHealingEffect } from './behaviors/healing.ts';
import { createHoming } from './behaviors/homing.ts';
import { Entity } from './entity.ts';
import { Vector2 } from './vector.ts';
import { World } from './world.ts';
import { createInputMessage } from '../protocol/messages.ts';
import { toSeq, toTick } from '../types.ts';

import type { InputMessage } from '../protocol/schemas.ts';
import type {
  Bounds,
  EntityId,
  Seq,
  SwordInput,
  Tick,
  WorldEventName,
  WorldSnapshot,
} from '../types.ts';

export const DEFAULT_SCENARIO_STEPS = 1000;
export const DEFAULT_FIXED_DT = 1 / 60;
export const DEFAULT_SCENARIO_SEED = 1337;

interface ScenarioOptions {
  seed?: number;
  steps?: number;
  dt?: number;
  bounds?: Bounds;
  inputSequence?:
    | readonly InputMessage[]
    | ((tick: Tick) => InputMessage)
    | null;
}

const isInputMessageArray = (
  value: ScenarioOptions['inputSequence'],
): value is readonly InputMessage[] => Array.isArray(value);

interface ScenarioResult {
  readonly seed: number;
  readonly steps: number;
  readonly dt: number;
  readonly tick: Tick;
  readonly score: number;
  readonly events: Record<WorldEventName, number>;
  readonly snapshot: WorldSnapshot;
}

export const createDefaultInputForTick = (tick: number): InputMessage => {
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
}: ScenarioOptions = {}): ScenarioResult => {
  Entity.resetNextId(1);

  const world = new World(bounds, { seed });

  const events: Record<WorldEventName, number> = {
    fired: 0,
    hit: 0,
    exploded: 0,
    healed: 0,
    scoreChanged: 0,
  };

  const eventNames: readonly WorldEventName[] = [
    'fired',
    'hit',
    'exploded',
    'healed',
    'scoreChanged',
  ];

  for (const eventName of eventNames) {
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

  const homingObstacle = obstacles[0];

  if (homingObstacle) {
    homingObstacle.homing = createHoming({
      targetKind: 'sword',
      turnRate: 2.4,
      speed: 70,
    });
  }

  for (const obstacle of obstacles) {
    world.spawn(obstacle);
  }

  world.spawn(
    new Pickup({
      pos: new Vector2(bounds.width * 0.5, bounds.height * 0.78),
      effect: createHealingEffect(1),
    }),
  );

  const inputs = new Map<EntityId, SwordInput>();
  let respawnTimer: number | null = null;
  let lastProcessedSeq: Seq = toSeq(0);

  for (let tick = 0; tick < steps; tick++) {
    const command =
      typeof inputSequence === 'function'
        ? inputSequence(toTick(tick))
        : isInputMessageArray(inputSequence)
          ? (inputSequence[tick] ?? createInputMessage({ seq: tick + 1, tick }))
          : createDefaultInputForTick(tick);

    if (sword.alive) {
      inputs.set(sword.id, command);
      lastProcessedSeq = command.seq;
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
        bullet.ttl = 1;
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

