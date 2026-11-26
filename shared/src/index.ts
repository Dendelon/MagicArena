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
export { integrate, integrateInto, type MutableSwordState } from './sim/sword.ts';
export { Vector2, MutableVector2, type Vector2View } from './sim/vector.ts';
export { World, type WorldStepHooks, type WorldPoolStats } from './sim/world.ts';
export {
  ObjectPool,
  diffPoolStats,
  type ObjectPoolOptions,
  type PoolDeltaStats,
  type PoolStats,
} from './sim/ObjectPool.ts';
export {
  BulletPool,
  DEFAULT_BULLET_POOL_MAX_SIZE,
} from './sim/BulletPool.ts';
export {
  ParticlePool,
  DEFAULT_PARTICLE_POOL_MAX_SIZE,
  type ParticleOptions,
  type PooledParticle,
} from './sim/ParticlePool.ts';
export {
  summarizeTimings,
  type TimingSummary,
} from './performance/statistics.ts';

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
  parseClientMessage,
  parseServerMessage,
  ClientMessageSchema,
  ServerMessageSchema,
  InputMessageSchema,
  SnapshotMessageSchema,
} from './protocol/index.ts';

export type {
  ChatMessage,
  ClientMessage,
  CodecMode,
  FireAckMessage,
  GameMessage,
  InputMessage,
  JoinMessage,
  JoinedMessage,
  NetSim,
  NoticeMessage,
  PingMessage,
  PongMessage,
  RoomInfo,
  RosterMessage,
  RosterPlayer,
  ServerChatMessage,
  ServerMessage,
  SnapshotMessage,
} from './protocol/index.ts';

export {
  encodeMessage,
  decodeMessage,
  encodeInput,
  decodeInput,
  encodeSnapshot,
  decodeSnapshot,
  jsonCodec,
  binaryCodec,
  getCodec,
} from './codec/index.ts';

export type { Codec } from './codec/types.ts';

