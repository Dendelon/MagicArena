import { Bullet, Sword, createHoming, wrap } from '@magicarena/shared';
import { shortestWrappedDelta } from './math.js';

const FIXED_DT = 1 / 30;
const MAX_LOCAL_PROJECTILES = 32;
const MAX_UNCONFIRMED_AGE_MS = 2500;
const RETRY_INTERVAL_MS = 180;
const MAX_SHOT_RETRIES = 5;
const RECONCILE_BLEND_RATE = 10;
const MAX_CORRECTION_RATIO = 0.5;
const MAX_RENDER_DT_SEC = 0.05;

export const createProjectilePredictor = () => {
  const ownProjectiles = new Map();
  const pendingShots = new Map();

  const makeKey = (originSeq, isHoming) => `${originSeq}:${isHoming ? 'h' : 'n'}`;

  const reset = () => {
    ownProjectiles.clear();
    pendingShots.clear();
  };

  const isOwnBullet = (bullet, myPlayerId, myEntityId) =>
    myPlayerId !== null &&
      bullet.ownerPlayerId !== null &&
      bullet.ownerPlayerId !== undefined
      ? bullet.ownerPlayerId === myPlayerId
      : myEntityId !== null && bullet.ownerId === myEntityId;

  const isMatchedByServer = (record, bullet, myPlayerId, myEntityId) => {
    if (record.serverEntityId !== null && bullet.id === record.serverEntityId) {
      return true;
    }

    if (
      Array.isArray(record.serverEntityIds) &&
      record.serverEntityIds.includes(bullet.id) &&
      Boolean(bullet.homing) === record.isHoming
    ) {
      return true;
    }

    return (
      isOwnBullet(bullet, myPlayerId, myEntityId) &&
      bullet.originSeq === record.originSeq &&
      Boolean(bullet.homing) === record.isHoming
    );
  };

  const spawnLocalShot = ({
    originSeq,
    swordState,
    fire,
    homingFire,
    world,
    ownerId,
    ownerPlayerId,
  }) => {
    if (!swordState?.alive || world.width <= 0 || world.height <= 0) {
      return false;
    }

    const now = performance.now();
    const existingPending = pendingShots.get(originSeq);

    pendingShots.set(originSeq, {
      originSeq,
      fire: Boolean(existingPending?.fire) || Boolean(fire),
      homingFire: Boolean(existingPending?.homingFire) || Boolean(homingFire),
      createdAt: existingPending?.createdAt ?? now,
      lastSentAt: now,
      retries: existingPending?.retries ?? 0,
    });

    if (pendingShots.size > MAX_LOCAL_PROJECTILES) {
      const oldestKey = pendingShots.keys().next().value;
      pendingShots.delete(oldestKey);
    }

    const { pos, vel } = Sword.createBulletSpawn({
      pos: { x: swordState.x, y: swordState.y },
      vel: { x: swordState.vx, y: swordState.vy },
      angle: swordState.angle,
      world,
    });

    const addRecord = (isHoming) => {
      const key = makeKey(originSeq, isHoming);

      if (ownProjectiles.has(key)) return;

      if (ownProjectiles.size >= MAX_LOCAL_PROJECTILES) {
        const oldestKey = ownProjectiles.keys().next().value;
        ownProjectiles.delete(oldestKey);
      }

      const bullet = new Bullet({
        id: -originSeq - (isHoming ? 0.5 : 0),
        pos,
        vel,
        ttl: isHoming ? 1 : 1.5,
        ownerId,
        ownerPlayerId,
        originSeq,
        homing: isHoming
          ? createHoming({
            targetKind: 'obstacle',
            turnRate: 9,
          })
          : null,
      });

      ownProjectiles.set(key, {
        originSeq,
        isHoming,
        bullet,
        visualPos: { x: pos.x, y: pos.y },
        lastVisualAt: now,
        accepted: null,
        serverEntityId: null,
        serverEntityIds: null,
        seenOnServer: false,
        seenSnapshotAfterAck: false,
        lastServerPos: null,
        lastServerVel: null,
        lastSnapshotReceivedAt: null,
        createdAt: now,
      });
    };

    if (fire) addRecord(false);
    if (homingFire) addRecord(true);

    return true;
  };

  const getRetryShot = (lastProcessedSeq, now = performance.now()) => {
    for (const [originSeq, shot] of pendingShots) {
      if (
        now - shot.createdAt > MAX_UNCONFIRMED_AGE_MS ||
        shot.retries >= MAX_SHOT_RETRIES
      ) {
        pendingShots.delete(originSeq);
        continue;
      }

      const skippedByServer =
        typeof lastProcessedSeq === 'number' && lastProcessedSeq >= shot.originSeq;
      const timedOut = now - shot.lastSentAt >= RETRY_INTERVAL_MS;

      if (skippedByServer || timedOut) {
        shot.lastSentAt = now;
        shot.retries += 1;

        return {
          fire: shot.fire,
          homingFire: shot.homingFire,
          fireSeq: shot.originSeq,
        };
      }
    }

    return null;
  };

  const step = (dt = FIXED_DT, world) => {
    const now = performance.now();

    for (const [key, record] of ownProjectiles) {
      if (record.seenOnServer) continue;

      record.bullet.update(dt, world);

      if (
        !record.bullet.alive ||
        now - record.createdAt > MAX_UNCONFIRMED_AGE_MS
      ) {
        ownProjectiles.delete(key);
      }
    }
  };

  const advanceRenderTime = (
    world,
    rttMs = 0,
    now = performance.now(),
  ) => {
    if (world.width <= 0 || world.height <= 0) return;

    const halfRttSec = Math.max(
      0,
      Math.min(0.25, (Number(rttMs) || 0) / 2000),
    );

    for (const record of ownProjectiles.values()) {
      const dt = Math.min(
        MAX_RENDER_DT_SEC,
        Math.max(0, (now - record.lastVisualAt) / 1000),
      );

      record.lastVisualAt = now;

      if (dt === 0) continue;

      let vel = record.bullet.vel;
      let target = null;

      if (
        record.seenOnServer &&
        record.lastServerPos &&
        record.lastServerVel
      ) {
        vel = record.lastServerVel;

        const age = Math.max(
          0,
          (now - record.lastSnapshotReceivedAt) / 1000,
        );

        const lead = Math.min(
          record.isHoming ? 0.1 : 0.25,
          age + halfRttSec,
        );

        target = {
          x: wrap(
            record.lastServerPos.x + vel.x * lead,
            world.width,
          ),
          y: wrap(
            record.lastServerPos.y + vel.y * lead,
            world.height,
          ),
        };
      }

      // Безперервний рух у кожному кадрі.
      const x = wrap(
        record.visualPos.x + vel.x * dt,
        world.width,
      );

      const y = wrap(
        record.visualPos.y + vel.y * dt,
        world.height,
      );

      let correctionX = 0;
      let correctionY = 0;

      if (target) {
        const blend = 1 - Math.exp(-RECONCILE_BLEND_RATE * dt);

        correctionX =
          shortestWrappedDelta(x, target.x, world.width) * blend;

        correctionY =
          shortestWrappedDelta(y, target.y, world.height) * blend;

        const length = Math.hypot(correctionX, correctionY);

        const limit =
          Math.hypot(vel.x, vel.y) * dt * MAX_CORRECTION_RATIO;

        if (length > limit && length > 0) {
          correctionX *= limit / length;
          correctionY *= limit / length;
        }
      }

      record.visualPos = {
        x: wrap(x + correctionX, world.width),
        y: wrap(y + correctionY, world.height),
      };
    }
  };

  const bindServerEntityToRecord = (record, serverEntity, receivedAt) => {
    record.serverEntityId = serverEntity.id;
    record.accepted = true;
    record.seenOnServer = true;

    record.lastServerPos = {
      x: serverEntity.pos.x,
      y: serverEntity.pos.y,
    };

    record.lastServerVel = {
      x: serverEntity.vel.x,
      y: serverEntity.vel.y,
    };

    record.lastSnapshotReceivedAt = receivedAt;
  };

  const onFireAck = ({
    originSeq,
    accepted,
    entityId = null,
    entityIds = null,
  }) => {
    pendingShots.delete(originSeq);

    const ids = Array.isArray(entityIds)
      ? entityIds
      : entityId !== null && entityId !== undefined
        ? [entityId]
        : [];

    for (const [key, record] of ownProjectiles) {
      if (record.originSeq !== originSeq) continue;

      if (!accepted) {
        ownProjectiles.delete(key);
        continue;
      }

      record.accepted = true;

      if (record.serverEntityId === null) {
        record.serverEntityId = ids.length === 1 ? ids[0] : null;
        record.serverEntityIds = ids;
      }
    }
  };

  const onSnapshot = (snapshot, myPlayerId, myEntityId) => {
    const now = performance.now();
    const serverBullets = (snapshot.entities ?? []).filter(
      (entity) => entity.kind === 'bullet' && entity.alive,
    );

    for (const [key, record] of ownProjectiles) {
      const matched = serverBullets.find((bullet) =>
        isMatchedByServer(record, bullet, myPlayerId, myEntityId),
      );

      if (matched) {
        pendingShots.delete(record.originSeq);

        bindServerEntityToRecord(record, matched, now);

        continue;
      }

      if (record.seenOnServer) {
        ownProjectiles.delete(key);
        continue;
      }

      if (record.accepted) {
        if (record.seenSnapshotAfterAck) {
          ownProjectiles.delete(key);
        } else {
          record.seenSnapshotAfterAck = true;
        }
      }
    }
  };

  const getBulletsToRender = ({
    world,
    interpolation,
    myPlayerId,
    myEntityId,
    now = performance.now(),
  }) => {
    const renderList = [];
    const claimedServerBulletIds = new Set();
    const serverBullets = [...world.ofKind('bullet')];
    const sampleHomingPosition = (bullet) =>
      interpolation.getInterpolatedPosition(bullet, world, now);

    for (const record of ownProjectiles.values()) {
      for (const bullet of serverBullets) {
        if (isMatchedByServer(record, bullet, myPlayerId, myEntityId)) {
          claimedServerBulletIds.add(bullet.id);
        }
      }

      renderList.push({
        x: record.visualPos.x,
        y: record.visualPos.y,
        radius: record.bullet.radius,
        isHoming: record.isHoming,
      });
    }

    for (const bullet of serverBullets) {
      if (claimedServerBulletIds.has(bullet.id)) {
        continue;
      }

      const isHoming = Boolean(bullet.homing);

      if (isHoming) {
        // Чужий homing (або невідслідкований серверний homing): інтерпольована позиція з буфера snapshots
        const interp = sampleHomingPosition(bullet);

        if (interp) {
          renderList.push({
            x: interp.x,
            y: interp.y,
            radius: bullet.radius,
            isHoming: true,
          });
        }
        continue;
      }

      // Звичайні кулі без змін
      const pos = isOwnBullet(bullet, myPlayerId, myEntityId)
        ? bullet.pos
        : interpolation.getInterpolatedEntity(bullet, world, now);

      renderList.push({
        x: pos.x,
        y: pos.y,
        radius: bullet.radius,
        isHoming: false,
      });
    }

    return renderList;
  };

  return {
    spawnLocalShot,
    getRetryShot,
    step,
    advanceRenderTime,
    onFireAck,
    onSnapshot,
    getBulletsToRender,
    reset,
  };
};
