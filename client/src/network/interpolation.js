import { wrap } from '@magicarena/shared';
import { shortestWrappedDelta, shortestAngleDelta } from './math.js';

export const DEFAULT_INTERPOLATION_DELAY_MS = 100;
export const MIN_INTERPOLATION_DELAY_MS = 50;
export const MAX_INTERPOLATION_DELAY_MS = 250;

const SERVER_TICK_MS = 1000 / 30;
const MAX_SNAPSHOT_BUFFER = 30;
const CLOCK_SNAP_THRESHOLD_MS = 250;
const CLOCK_SMOOTHING = 0.1;
const TELEPORT_THRESHOLD_PX = 140;

const clampDelay = (delayMs) =>
  Math.max(
    MIN_INTERPOLATION_DELAY_MS,
    Math.min(MAX_INTERPOLATION_DELAY_MS, Number(delayMs) || DEFAULT_INTERPOLATION_DELAY_MS),
  );

export const createInterpolation = ({
  delayMs = DEFAULT_INTERPOLATION_DELAY_MS,
} = {}) => {
  const snapshots = [];
  const lastThrustByEntityId = new Map();

  let interpolationDelayMs = clampDelay(delayMs);
  let lastTick = null;
  let baseServerTimeMs = null;
  let baseClientTimeMs = null;

  const reset = () => {
    snapshots.length = 0;
    lastThrustByEntityId.clear();
    lastTick = null;
    baseServerTimeMs = null;
    baseClientTimeMs = null;
  };

  const setDelay = (nextDelayMs) => {
    interpolationDelayMs = clampDelay(nextDelayMs);
  };

  const pushSnapshot = (snapshot, receivedAt = performance.now()) => {
    const tick = snapshot?.tick;
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

    const entitiesById = new Map();
    const activeIds = new Set();

    for (const entity of snapshot.entities ?? []) {
      if (entity && entity.id !== undefined && entity.id !== null) {
        entitiesById.set(entity.id, entity);
        activeIds.add(entity.id);

        if (entity.kind === 'sword' && typeof entity.thrust === 'boolean') {
          lastThrustByEntityId.set(entity.id, entity.thrust);
        }
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

  const findBracketingSnapshots = (renderTimeMs) => {
    if (snapshots.length === 0) return null;

    if (snapshots.length === 1 || renderTimeMs <= snapshots[0].timeMs) {
      return { from: snapshots[0], to: snapshots[0], alpha: 0 };
    }

    const newest = snapshots[snapshots.length - 1];

    if (renderTimeMs >= newest.timeMs) {
      return { from: newest, to: newest, alpha: 1 };
    }

    for (let i = 0; i < snapshots.length - 1; i++) {
      const from = snapshots[i];
      const to = snapshots[i + 1];

      if (renderTimeMs >= from.timeMs && renderTimeMs <= to.timeMs) {
        const span = to.timeMs - from.timeMs;
        const alpha = span > 0 ? (renderTimeMs - from.timeMs) / span : 1;
        return { from, to, alpha };
      }
    }

    return { from: newest, to: newest, alpha: 1 };
  };

  const resolveDiscreteThrust = (a, b, alpha, entityId) => {
    const primary = alpha < 0.5 && a ? a : b;

    if (typeof primary?.thrust === 'boolean') {
      return primary.thrust;
    }

    const secondary = primary === a ? b : a;

    if (typeof secondary?.thrust === 'boolean') {
      return secondary.thrust;
    }

    return lastThrustByEntityId.get(entityId) ?? false;
  };

  const interpolateEntity = (authEntity, pair, world) => {
    if (!pair) {
      return {
        x: authEntity.pos.x,
        y: authEntity.pos.y,
        angle: authEntity.angle,
        thrust: lastThrustByEntityId.get(authEntity.id) ?? Boolean(authEntity.input?.forward),
      };
    }

    const a = pair.from.entitiesById.get(authEntity.id);
    const b = pair.to.entitiesById.get(authEntity.id);

    if (!b) {
      return {
        x: authEntity.pos.x,
        y: authEntity.pos.y,
        angle: authEntity.angle,
        thrust: lastThrustByEntityId.get(authEntity.id) ?? Boolean(authEntity.input?.forward),
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

  const resolveBracket = (now = performance.now()) => {
    if (baseServerTimeMs === null || baseClientTimeMs === null) {
      return null;
    }

    const estimatedServerTimeMs = baseServerTimeMs + (now - baseClientTimeMs);
    const renderTimeMs = estimatedServerTimeMs - interpolationDelayMs;
    return findBracketingSnapshots(renderTimeMs);
  };

  const getInterpolatedEntity = (authEntity, world, now = performance.now()) => {
    const pair = resolveBracket(now);
    return interpolateEntity(authEntity, pair, world);
  };

  const hasAtLeastTwoSnapshots = (entityId) => {
    let count = 0;

    for (const snapshot of snapshots) {
      if (snapshot.entitiesById.has(entityId)) {
        count += 1;
        if (count >= 2) return true;
      }
    }

    return false;
  };

  const getInterpolatedPosition = (authEntity, world, now = performance.now()) => {
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
    get delayMs() {
      return interpolationDelayMs;
    },
    setDelay,
    pushSnapshot,
    getInterpolatedEntity,
    getInterpolatedPosition,
    reset,
  };
};

