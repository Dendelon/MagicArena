import { z } from 'zod';

export interface Vec2Like {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly width: number;
  readonly height: number;
}

export type RandomSource = () => number;

export const EntityIdSchema = z
  .union([z.number(), z.string()])
  .brand<'EntityId'>();

export const TickSchema = z
  .number()
  .int()
  .min(0)
  .max(0xffffffff)
  .brand<'Tick'>();

export const SeqSchema = z
  .number()
  .int()
  .min(0)
  .max(0xffffffff)
  .brand<'Seq'>();

export const toEntityId = (value: number | string): EntityId =>
  EntityIdSchema.parse(value);

export const toTick = (value: number): Tick => TickSchema.parse(value);

export const toSeq = (value: number): Seq => SeqSchema.parse(value);

export type EntityId = z.infer<typeof EntityIdSchema>;

export type Tick = z.infer<typeof TickSchema>;

export type Seq = z.infer<typeof SeqSchema>;

export type PlayerId = string;

export type GameEntityKind =
  | 'sword'
  | 'bullet'
  | 'obstacle'
  | 'pickup'
  | 'explosion';

export type EntityKind = GameEntityKind | 'entity';

export interface SwordState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly angle: number;
}

export interface SwordInput {
  readonly left?: boolean;
  readonly right?: boolean;
  readonly forward?: boolean;
  readonly thrust?: boolean;
  readonly brake?: boolean;
  readonly turn?: number;
}

export interface SwordControls {
  readonly left: boolean;
  readonly right: boolean;
  readonly forward: boolean;
  readonly brake: boolean;
}

export interface HomingData {
  readonly targetKind: GameEntityKind;
  readonly turnRate: number;
  readonly speed: number | null;
}

export interface HealingData {
  readonly kind: 'healing';
  readonly amount: number;
}

export interface ParticleSnapshot {
  readonly pos: Vec2Like;
  readonly vel: Vec2Like;
  readonly lifetime: number;
  readonly remaining: number;
  readonly radius: number;
}

export interface BaseEntitySnapshot<K extends EntityKind = EntityKind> {
  readonly id: EntityId;
  readonly kind: K;
  readonly pos: Vec2Like;
  readonly vel: Vec2Like;
  readonly angle: number;
  readonly radius: number;
  readonly alive: boolean;
}

export interface SwordSnapshot extends BaseEntitySnapshot<'sword'> {
  readonly ownerId: PlayerId | null;
  readonly hp: number;
  readonly damageCooldown: number;
  readonly thrust: boolean;
}

export interface BulletSnapshot extends BaseEntitySnapshot<'bullet'> {
  readonly ttl: number;
  readonly ownerId: EntityId | null;
  readonly ownerPlayerId: PlayerId | null;
  readonly originSeq: Seq | null;
  readonly damage: number;
  readonly homing: HomingData | null;
}

export interface ObstacleSnapshot extends BaseEntitySnapshot<'obstacle'> {
  readonly hp: number;
  readonly homing: HomingData | null;
}

export interface PickupSnapshot extends BaseEntitySnapshot<'pickup'> {
  readonly effect: HealingData | null;
}

export interface ExplosionSnapshot extends BaseEntitySnapshot<'explosion'> {
  readonly color: string;
  readonly particles: readonly ParticleSnapshot[];
}

export type EntitySnapshot =
  | SwordSnapshot
  | BulletSnapshot
  | ObstacleSnapshot
  | PickupSnapshot
  | ExplosionSnapshot;

export interface WorldSnapshot {
  readonly tick: Tick;
  readonly lastProcessedSeq: Seq;
  readonly entities: readonly EntitySnapshot[];
}

export interface WorldState {
  readonly bounds: Bounds;
  readonly seed: number;
  readonly tick: Tick;
  readonly score: number;
  readonly entities: readonly EntitySnapshot[];
}

export interface WorldEventMap {
  fired: {
    entityId: EntityId;
    ownerId: EntityId | null;
    ownerPlayerId: PlayerId | null;
    originSeq: Seq | null;
    pos: Vec2Like;
  };

  hit: {
    kind: GameEntityKind;
    pos: Vec2Like;
  };

  exploded: {
    kind: GameEntityKind;
    pos: Vec2Like;
  };

  healed: {
    hp: number;
  };

  scoreChanged: {
    score: number;
  };
}

export type WorldEventName = keyof WorldEventMap;

export interface WorldEvent {
  readonly type: WorldEventName;
  readonly detail: WorldEventMap[WorldEventName];
}

export interface SnapshotWorldState extends WorldSnapshot {
  readonly score?: number;
  readonly bounds?: Bounds;
  readonly events?: readonly WorldEvent[];
}
