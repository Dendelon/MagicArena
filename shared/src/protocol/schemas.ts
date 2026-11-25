import { z } from 'zod';

import {
  EntityIdSchema,
  TickSchema,
  SeqSchema,
} from '../types.ts';

export const PROTOCOL_VERSION = 1;

export const CodecSchema = z.enum(['json', 'binary']);

export const EntityKindSchema = z.enum([
  'sword',
  'bullet',
  'obstacle',
  'pickup',
  'explosion',
]);

export const PlayerIdSchema = z.string();

export const VectorSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
});

export const BoundsSchema = z.strictObject({
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export const HomingSchema = z.strictObject({
  targetKind: EntityKindSchema,
  turnRate: z.number(),
  speed: z.number().nullable(),
});

export const HealingSchema = z.strictObject({
  kind: z.literal('healing'),
  amount: z.number(),
});

export const ParticleSchema = z.strictObject({
  pos: VectorSchema,
  vel: VectorSchema,
  lifetime: z.number(),
  remaining: z.number(),
  radius: z.number(),
});

const BaseEntitySchema = z.strictObject({
  id: EntityIdSchema,
  pos: VectorSchema,
  vel: VectorSchema,
  angle: z.number(),
  radius: z.number().nonnegative(),
  alive: z.boolean(),
});

export const SwordSchema = BaseEntitySchema.extend({
  kind: z.literal('sword'),
  ownerId: PlayerIdSchema.nullable(),
  hp: z.number(),
  damageCooldown: z.number(),
  thrust: z.boolean(),
});

export const BulletSchema = BaseEntitySchema.extend({
  kind: z.literal('bullet'),
  ttl: z.number(),
  ownerId: EntityIdSchema.nullable(),
  ownerPlayerId: PlayerIdSchema.nullable(),
  originSeq: SeqSchema.nullable(),
  damage: z.number(),
  homing: HomingSchema.nullable(),
});

export const ObstacleSchema = BaseEntitySchema.extend({
  kind: z.literal('obstacle'),
  hp: z.number(),
  homing: HomingSchema.nullable(),
});

export const PickupSchema = BaseEntitySchema.extend({
  kind: z.literal('pickup'),
  effect: HealingSchema.nullable(),
});

export const ExplosionSchema = BaseEntitySchema.extend({
  kind: z.literal('explosion'),
  color: z.string(),
  particles: z.array(ParticleSchema).max(4096),
});

export const EntitySnapshotSchema = z.discriminatedUnion('kind', [
  SwordSchema,
  BulletSchema,
  ObstacleSchema,
  PickupSchema,
  ExplosionSchema,
]);

export const FiredEventSchema = z.strictObject({
  type: z.literal('fired'),

  detail: z.strictObject({
    entityId: EntityIdSchema,
    ownerId: EntityIdSchema.nullable(),
    ownerPlayerId: EntityIdSchema.nullable(),
    originSeq: SeqSchema.nullable(),
    pos: VectorSchema,
  }),
});

export const HitEventSchema = z.strictObject({
  type: z.literal('hit'),

  detail: z.strictObject({
    kind: EntityKindSchema,
    pos: VectorSchema,
  }),
});

export const ExplodedEventSchema = z.strictObject({
  type: z.literal('exploded'),

  detail: z.strictObject({
    kind: EntityKindSchema,
    pos: VectorSchema,
  }),
});

export const HealedEventSchema = z.strictObject({
  type: z.literal('healed'),

  detail: z.strictObject({
    hp: z.number(),
  }),
});

export const ScoreChangedEventSchema = z.strictObject({
  type: z.literal('scoreChanged'),

  detail: z.strictObject({
    score: z.number(),
  }),
});

export const WorldEventSchema = z.discriminatedUnion('type', [
  FiredEventSchema,
  HitEventSchema,
  ExplodedEventSchema,
  HealedEventSchema,
  ScoreChangedEventSchema,
]);

export const InputMessageSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('input'),

  seq: SeqSchema,
  tick: TickSchema,

  thrust: z.boolean(),
  turn: z.number().min(-1).max(1),
  brake: z.boolean(),

  fire: z.boolean(),
  homingFire: z.boolean(),

  fireSeq: SeqSchema.optional(),
});

export const JoinMessageSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('join'),

  room: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(24),
});

export const ChatMessageSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('chat'),

  text: z.string().max(300).trim().min(1),
});

export const PingMessageSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('ping'),

  id: z.number().int().nonnegative(),
  clientTime: z.number(),
});

export const ClientMessageSchema = z.discriminatedUnion('type', [
  JoinMessageSchema,
  ChatMessageSchema,
  InputMessageSchema,
  PingMessageSchema,
]);

export const SnapshotMessageSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('snapshot'),

  tick: TickSchema,
  lastProcessedSeq: SeqSchema,

  entities: z.array(EntitySnapshotSchema).max(4096),

  score: z.number().optional(),
  bounds: BoundsSchema.optional(),
  events: z.array(WorldEventSchema).max(4096).optional(),
  respawnSeconds: z.number().nullable().optional(),
});

export const RoomInfoSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  obstacleCount: z.number().int().nonnegative(),
  maxPlayers: z.number().int().positive(),
  players: z.number().int().nonnegative(),
});

export const RosterPlayerSchema = z.strictObject({
  id: PlayerIdSchema,
  name: z.string(),
});

export const NetSimSchema = z.strictObject({
  delayMs: z.number().nonnegative(),
  jitterMs: z.number().nonnegative(),
  dropRate: z.number().min(0).max(1),
});

export const JoinedMessageSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('joined'),

  room: RoomInfoSchema,

  player: RosterPlayerSchema.extend({
    entityId: EntityIdSchema.nullable(),
  }),

  entityId: EntityIdSchema.nullable(),
  bounds: BoundsSchema.nullable(),

  codec: CodecSchema,
  netSim: NetSimSchema,
});

export const RosterMessageSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('roster'),
  players: z.array(RosterPlayerSchema),
});

export const NoticeMessageSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('notice'),
  text: z.string(),
});

export const ServerChatMessageSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('chat'),

  playerId: PlayerIdSchema,
  name: z.string(),
  text: z.string(),
});

export const PongMessageSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('pong'),

  id: z.number().int().nonnegative(),
  clientTime: z.number(),
});

export const FireAckMessageSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal('fireAck'),

  originSeq: SeqSchema,
  accepted: z.boolean(),

  entityId: EntityIdSchema.nullable(),
  entityIds: z.array(EntityIdSchema),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  SnapshotMessageSchema,
  JoinedMessageSchema,
  RosterMessageSchema,
  NoticeMessageSchema,
  ServerChatMessageSchema,
  PongMessageSchema,
  FireAckMessageSchema,
]);

export const GameMessageSchema = z.discriminatedUnion('type', [
  InputMessageSchema,
  SnapshotMessageSchema,
]);

export type Codec = z.infer<typeof CodecSchema>;

export type InputMessage = z.infer<typeof InputMessageSchema>;

export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;

export type JoinMessage = z.infer<typeof JoinMessageSchema>;

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export type PingMessage = z.infer<typeof PingMessageSchema>;

export type JoinedMessage = z.infer<typeof JoinedMessageSchema>;

export type RosterMessage = z.infer<typeof RosterMessageSchema>;

export type NoticeMessage = z.infer<typeof NoticeMessageSchema>;

export type ServerChatMessage = z.infer<typeof ServerChatMessageSchema>;

export type PongMessage = z.infer<typeof PongMessageSchema>;

export type FireAckMessage = z.infer<typeof FireAckMessageSchema>;

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type GameMessage = z.infer<typeof GameMessageSchema>;

export type RoomInfo = z.infer<typeof RoomInfoSchema>;

export type RosterPlayer = z.infer<typeof RosterPlayerSchema>;

export type NetSim = z.infer<typeof NetSimSchema>;

