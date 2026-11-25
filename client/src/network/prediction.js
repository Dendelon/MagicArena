import { integrate, wrap } from '@magicarena/shared';
import { shortestWrappedDelta, shortestAngleDelta } from './math.js';

const FIXED_DT = 1 / 30;
const MAX_PENDING_INPUTS = 120;
const SMOOTHING_DURATION_MS = 100;
const SNAP_DISTANCE_THRESHOLD = 160;

const createEmptyState = () => ({
  entityId: null,
  alive: false,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  angle: 0,
  thrust: false,
});

const stateFromSword = (sword) => ({
  entityId: sword.id,
  alive: Boolean(sword.alive),
  x: sword.pos.x,
  y: sword.pos.y,
  vx: sword.vel.x,
  vy: sword.vel.y,
  angle: sword.angle,
  thrust: Boolean(sword.thrust),
});

export const createPrediction = () => {
  const pendingInputs = [];

  let predicted = createEmptyState();
  let lastAuthoritative = null;
  let lastSnapshotTick = null;

  let startOffset = { x: 0, y: 0, angle: 0 };
  let offset = { x: 0, y: 0, angle: 0 };
  let smoothingRemainingMs = 0;

  const clearSmoothing = () => {
    startOffset = { x: 0, y: 0, angle: 0 };
    offset = { x: 0, y: 0, angle: 0 };
    smoothingRemainingMs = 0;
  };

  const reset = () => {
    pendingInputs.length = 0;
    predicted = createEmptyState();
    lastAuthoritative = null;
    lastSnapshotTick = null;
    clearSmoothing();
  };

  const resyncToAuthoritative = () => {
    pendingInputs.length = 0;
    clearSmoothing();

    if (lastAuthoritative && lastAuthoritative.alive) {
      predicted = { ...lastAuthoritative };
    } else {
      predicted = createEmptyState();
    }
  };

  const predictInput = (message, world) => {
    if (!predicted.alive || world.width <= 0 || world.height <= 0) {
      return false;
    }

    const lastEntry = pendingInputs[pendingInputs.length - 1];

    if (lastEntry && message.seq <= lastEntry.seq) {
      return false;
    }

    // При переповненні буфера безпечно відновлюємося до останнього серверного стану
    if (pendingInputs.length >= MAX_PENDING_INPUTS) {
      resyncToAuthoritative();
      return false;
    }

    const inputCopy = {
      thrust: Boolean(message.thrust),
      turn: message.turn,
      brake: Boolean(message.brake),
    };

    pendingInputs.push({
      seq: message.seq,
      tick: message.tick,
      input: inputCopy,
    });

    const next = integrate(predicted, inputCopy, FIXED_DT, world);

    predicted = {
      ...predicted,
      x: next.x,
      y: next.y,
      vx: next.vx,
      vy: next.vy,
      angle: next.angle,
      thrust: inputCopy.thrust,
    };

    return true;
  };

  const getRenderState = (world) => ({
    x: wrap(predicted.x + offset.x, world.width),
    y: wrap(predicted.y + offset.y, world.height),
    angle: predicted.angle + offset.angle,
    thrust: predicted.thrust,
  });

  const advanceSmoothing = (frameTimeMs) => {
    if (smoothingRemainingMs <= 0) {
      if (offset.x !== 0 || offset.y !== 0 || offset.angle !== 0) {
        clearSmoothing();
      }
      return;
    }

    const stepMs = Math.max(0, Number(frameTimeMs) || 0);
    smoothingRemainingMs = Math.max(0, smoothingRemainingMs - stepMs);

    if (smoothingRemainingMs === 0) {
      clearSmoothing();
      return;
    }

    const ratio = smoothingRemainingMs / SMOOTHING_DURATION_MS;

    offset = {
      x: startOffset.x * ratio,
      y: startOffset.y * ratio,
      angle: startOffset.angle * ratio,
    };
  };

  const reconcile = (snapshot, playerId, entityId, world) => {
    if (typeof snapshot.tick === 'number') {
      if (lastSnapshotTick !== null && snapshot.tick <= lastSnapshotTick) {
        return null;
      }

      lastSnapshotTick = snapshot.tick;
    }

    const ackSeq = snapshot.lastProcessedSeq ?? 0;

    while (pendingInputs.length > 0 && pendingInputs[0].seq <= ackSeq) {
      pendingInputs.shift();
    }

    const authSword = (snapshot.entities ?? []).find(
      (entity) =>
        entity.kind === 'sword' &&
        (playerId !== null && entity.ownerId !== null && entity.ownerId !== undefined
          ? entity.ownerId === playerId
          : entityId !== null && entity.id === entityId),
    );

    if (!authSword || !authSword.alive) {
      predicted = createEmptyState();
      predicted.entityId = authSword?.id ?? null;
      lastAuthoritative = null;
      pendingInputs.length = 0;
      clearSmoothing();

      return {
        correctionPx: 0,
        pendingCount: 0,
        entityId: predicted.entityId,
      };
    }

    const isSpawnOrSwitch = !predicted.alive || predicted.entityId !== authSword.id;

    lastAuthoritative = stateFromSword(authSword);

    if (isSpawnOrSwitch) {
      pendingInputs.length = 0;
      predicted = { ...lastAuthoritative };
      clearSmoothing();

      return {
        correctionPx: 0,
        pendingCount: 0,
        entityId: authSword.id,
      };
    }

    const prevDisplay = getRenderState(world);

    let reconciled = {
      x: authSword.pos.x,
      y: authSword.pos.y,
      vx: authSword.vel.x,
      vy: authSword.vel.y,
      angle: authSword.angle,
    };

    let lastThrust = Boolean(authSword.thrust);

    for (const entry of pendingInputs) {
      reconciled = integrate(reconciled, entry.input, FIXED_DT, world);
      lastThrust = entry.input.thrust;
    }

    predicted = {
      entityId: authSword.id,
      alive: true,
      x: reconciled.x,
      y: reconciled.y,
      vx: reconciled.vx,
      vy: reconciled.vy,
      angle: reconciled.angle,
      thrust: lastThrust,
    };

    const dx = shortestWrappedDelta(reconciled.x, prevDisplay.x, world.width);
    const dy = shortestWrappedDelta(reconciled.y, prevDisplay.y, world.height);
    const dAngle = shortestAngleDelta(reconciled.angle, prevDisplay.angle);
    const correctionPx = Math.hypot(dx, dy);

    if (correctionPx > SNAP_DISTANCE_THRESHOLD) {
      clearSmoothing();
    } else if (correctionPx > 0.01 || Math.abs(dAngle) > 0.0005) {
      startOffset = { x: dx, y: dy, angle: dAngle };
      offset = { x: dx, y: dy, angle: dAngle };
      smoothingRemainingMs = SMOOTHING_DURATION_MS;
    } else {
      clearSmoothing();
    }

    return {
      correctionPx,
      pendingCount: pendingInputs.length,
      entityId: authSword.id,
    };
  };

  return {
    get isAlive() {
      return predicted.alive;
    },
    get entityId() {
      return predicted.entityId;
    },
    get pendingCount() {
      return pendingInputs.length;
    },
    predictInput,
    reconcile,
    advanceSmoothing,
    getRenderState,
    getPredictedState: () => ({ ...predicted }),
    reset,
  };
};

