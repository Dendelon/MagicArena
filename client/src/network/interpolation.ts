import { wrap } from '@magicarena/shared';

import type {
  Bounds,
  EntityId,
  EntitySnapshot,
  GameEntity,
  SnapshotMessage,
  Tick,
} from '@magicarena/shared';

import type { RenderState } from '../types.ts';
import { shortestWrappedDelta, shortestAngleDelta } from './math.ts';

export const DEFAULT_INTERPOLATION_DELAY_MS = 100;
export const MIN_INTERPOLATION_DELAY_MS = 50;
export const MAX_INTERPOLATION_DELAY_MS = 250;

const SERVER_TICK_MS = 1000 / 30;
const MAX_SNAPSHOT_BUFFER = 30;
const CLOCK_SNAP_THRESHOLD_MS = 250;
const CLOCK_SMOOTHING = 0.1;
const TELEPORT_THRESHOLD_PX = 140;

interface BufferedSnapshot {
  readonly tick: Tick;
  readonly timeMs: number;

  readonly entitiesById: ReadonlyMap<EntityId, EntitySnapshot>;
}

interface SnapshotPair {
  readonly from: BufferedSnapshot;
  readonly to: BufferedSnapshot;
  readonly alpha: number;
}

const clampDelay = (delayMs: number): number =>
  Math.max(
    MIN_INTERPOLATION_DELAY_MS,
    Math.min(
      MAX_INTERPOLATION_DELAY_MS,
      Number(delayMs) || DEFAULT_INTERPOLATION_DELAY_MS,
    ),
  );

const getThrust = (entity: EntitySnapshot | undefined): boolean | undefined =>
  entity?.kind === 'sword' ? entity.thrust : undefined;

export const createInterpolation = ({
  delayMs = DEFAULT_INTERPOLATION_DELAY_MS,
}: { delayMs?: number } = {}) => {
  const snapshots: BufferedSnapshot[] = [];
  const lastThrustByEntityId = new Map<EntityId, boolean>();

  let interpolationDelayMs = clampDelay(delayMs);
  let lastTick: Tick | null = null;
  let baseServerTimeMs: number | null = null;
  let baseClientTimeMs: number | null = null;

  const reset = (): void => {
    snapshots.length = 0;
    lastThrustByEntityId.clear();
    lastTick = null;
    baseServerTimeMs = null;
    baseClientTimeMs = null;
  };

  const setDelay = (nextDelayMs: number): void => {
    interpolationDelayMs = clampDelay(nextDelayMs);
  };

  const pushSnapshot = (
    snapshot: SnapshotMessage,
    receivedAt = performance.now(),
  ): boolean => {
    const tick = snapshot.tick;
    if (typeof tick !== 'number') return false;

    if (lastTick !== null && tick <= lastTick) {
      return false;
    }

    lastTick = tick;

    const serverTimeMs = tick * SERVER_TICK_MS;

    if (baseServerTimeMs === null || baseClientTimeMs === null) {
      baseServerTimeMs = serverTimeMs;
      baseClientTimeMs = receivedAt;
    } else {
      const estimatedNow = baseServerTimeMs + (receivedAt - baseClientTimeMs);
      const error = serverTimeMs - estimatedNow;

      if (Math.abs(error) > CLOCK_SNAP_THRESHOLD_MS) {
        baseServerTimeMs = serverTimeMs;
        baseClientTimeMs = receivedAt;
      } else {
        baseServerTimeMs += error * CLOCK_SMOOTHING;
      }
    }

    const entitiesById = new Map<EntityId, EntitySnapshot>();
    const activeIds = new Set<EntityId>();

    for (const entity of snapshot.entities) {
      entitiesById.set(entity.id, entity);
      activeIds.add(entity.id);

      if (entity.kind === 'sword') {
        lastThrustByEntityId.set(entity.id, entity.thrust);
      }
    }

    for (const entityId of [...lastThrustByEntityId.keys()]) {
      if (!activeIds.has(entityId)) {
        lastThrustByEntityId.delete(entityId);
      }
    }

    snapshots.push({
      tick,
      timeMs: serverTimeMs,
      entitiesById,
    });

    if (snapshots.length > MAX_SNAPSHOT_BUFFER) {
      snapshots.shift();
    }

    return true;
  };

  const findBracketingSnapshots = (
    renderTimeMs: number,
  ): SnapshotPair | null => {
    const first = snapshots[0];
    const newest = snapshots.at(-1);

    if (!first || !newest) return null;

    if (snapshots.length === 1 || renderTimeMs <= first.timeMs) {
      return { from: first, to: first, alpha: 0 };
    }

    if (renderTimeMs >= newest.timeMs) {
      return { from: newest, to: newest, alpha: 1 };
    }

    for (let i = 0; i < snapshots.length - 1; i++) {
      const from = snapshots[i];
      const to = snapshots[i + 1];

      if (!from || !to) continue;

      if (renderTimeMs >= from.timeMs && renderTimeMs <= to.timeMs) {
        const span = to.timeMs - from.timeMs;
        const alpha = span > 0 ? (renderTimeMs - from.timeMs) / span : 1;
        return { from, to, alpha };
      }
    }

    return { from: newest, to: newest, alpha: 1 };
  };

  const resolveDiscreteThrust = (
    a: EntitySnapshot | undefined,
    b: EntitySnapshot | undefined,
    alpha: number,
    entityId: EntityId,
  ): boolean => {
    const primary = alpha < 0.5 && a ? a : b;
    const primaryThrust = getThrust(primary);

    if (typeof primaryThrust === 'boolean') {
      return primaryThrust;
    }

    const secondary = primary === a ? b : a;
    const secondaryThrust = getThrust(secondary);

    if (typeof secondaryThrust === 'boolean') {
      return secondaryThrust;
    }

    return lastThrustByEntityId.get(entityId) ?? false;
  };

  const interpolateEntity = (
    authEntity: GameEntity,
    pair: SnapshotPair | null,
    world: Bounds,
  ): RenderState => {
    const fallbackThrust =
      authEntity.kind === 'sword' ? Boolean(authEntity.input.forward) : false;

    if (!pair) {
      return {
        x: authEntity.pos.x,
        y: authEntity.pos.y,
        angle: authEntity.angle,
        thrust: lastThrustByEntityId.get(authEntity.id) ?? fallbackThrust,
      };
    }

    const a = pair.from.entitiesById.get(authEntity.id);
    const b = pair.to.entitiesById.get(authEntity.id);

    if (!b) {
      return {
        x: authEntity.pos.x,
        y: authEntity.pos.y,
        angle: authEntity.angle,
        thrust: lastThrustByEntityId.get(authEntity.id) ?? fallbackThrust,
      };
    }

    const thrust = resolveDiscreteThrust(a, b, pair.alpha, authEntity.id);

    if (!a || pair.from === pair.to) {
      return {
        x: b.pos.x,
        y: b.pos.y,
        angle: b.angle,
        thrust,
      };
    }

    const dx = shortestWrappedDelta(a.pos.x, b.pos.x, world.width);
    const dy = shortestWrappedDelta(a.pos.y, b.pos.y, world.height);

    // При телепортації або великому стрибку не інтерполюємо через арену
    if (Math.hypot(dx, dy) > TELEPORT_THRESHOLD_PX) {
      return {
        x: b.pos.x,
        y: b.pos.y,
        angle: b.angle,
        thrust,
      };
    }

    const t = pair.alpha;

    return {
      x: wrap(a.pos.x + dx * t, world.width),
      y: wrap(a.pos.y + dy * t, world.height),
      angle: a.angle + shortestAngleDelta(a.angle, b.angle) * t,
      thrust,
    };
  };

  const resolveBracket = (now = performance.now()): SnapshotPair | null => {
    if (baseServerTimeMs === null || baseClientTimeMs === null) {
      return null;
    }

    const estimatedServerTimeMs = baseServerTimeMs + (now - baseClientTimeMs);
    const renderTimeMs = estimatedServerTimeMs - interpolationDelayMs;
    return findBracketingSnapshots(renderTimeMs);
  };

  const getInterpolatedEntity = (
    authEntity: GameEntity,
    world: Bounds,
    now = performance.now(),
  ): RenderState => {
    const pair = resolveBracket(now);
    return interpolateEntity(authEntity, pair, world);
  };

  const hasAtLeastTwoSnapshots = (entityId: EntityId): boolean => {
    let count = 0;

    for (const snapshot of snapshots) {
      if (snapshot.entitiesById.has(entityId)) {
        count += 1;
        if (count >= 2) return true;
      }
    }

    return false;
  };

  const getInterpolatedPosition = (
    authEntity: GameEntity,
    world: Bounds,
    now = performance.now(),
  ): RenderState | null => {
    const pair = resolveBracket(now);

    if (!pair) {
      return null;
    }

    const a = pair.from.entitiesById.get(authEntity.id);
    const b = pair.to.entitiesById.get(authEntity.id);

    if (!a || !b) {
      return null;
    }

    if (pair.from === pair.to && !hasAtLeastTwoSnapshots(authEntity.id)) {
      return null;
    }

    return interpolateEntity(authEntity, pair, world);
  };

  return {
    get delayMs(): number {
      return interpolationDelayMs;
    },
    setDelay,
    pushSnapshot,
    getInterpolatedEntity,
    getInterpolatedPosition,
    reset,
  };
};

export type Interpolation = ReturnType<typeof createInterpolation>;

