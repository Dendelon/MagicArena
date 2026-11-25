export { wrap, findSafeSpawn } from './sim/arena.ts';
export { createHealingEffect } from './sim/behaviors/healing.ts';
export { createHoming } from './sim/behaviors/homing.ts';
export {
  circlesOverlap,
  collisionPairs,
  resolveCollisions,
} from './sim/collision.ts';
export { Entity } from './sim/entity.ts';
export { mulberry32 } from './sim/random.ts';
export {
  DEFAULT_FIXED_DT,
  DEFAULT_SCENARIO_SEED,
  DEFAULT_SCENARIO_STEPS,
  createDefaultInputForTick,
  runDeterministicScenario,
} from './sim/scenario.ts';
export { integrate } from './sim/sword.ts';
export { Vector2 } from './sim/vector.ts';
export { World } from './sim/world.ts';

export { Bullet } from './entities/Bullet.ts';
export { Explosion } from './entities/Explosion.ts';
export { Obstacle } from './entities/Obstacle.ts';
export { Pickup } from './entities/Pickup.ts';
export { Sword } from './entities/Sword.ts';
export { entityFromJSON } from './entities/fromJSON.ts';

export { toEntityId, toTick, toSeq } from './types.ts';

export type {
  Bounds,
  BulletSnapshot,
  EntityId,
  EntityKind,
  EntitySnapshot,
  ExplosionSnapshot,
  GameEntityKind,
  HealingData,
  HomingData,
  ObstacleSnapshot,
  ParticleSnapshot,
  PickupSnapshot,
  PlayerId,
  RandomSource,
  Seq,
  SnapshotWorldState,
  SwordControls,
  SwordInput,
  SwordSnapshot,
  SwordState,
  Tick,
  Vec2Like,
  WorldEvent,
  WorldEventMap,
  WorldEventName,
  WorldSnapshot,
  WorldState,
} from './types.ts';

export type { EntityOfKind, GameEntity } from './entities/types.ts';

export {
  PROTOCOL_VERSION,
  MESSAGE_TYPES,
  createInputMessage,
  createSnapshotMessage,
  isInputMessage,
  isSnapshotMessage,
  isValidMessage,
  assertValidMessage,
} from './protocol/index.js';

export {
  encodeMessage,
  decodeMessage,
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
} from './codec/index.js';

