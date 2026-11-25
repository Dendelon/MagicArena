import { Bullet, Sword, createHoming, wrap } from '@magicarena/shared';

const FIXED_DT = 1 / 30;
const FIXED_STEP_MS = FIXED_DT * 1000;
const MAX_LOCAL_PROJECTILES = 32;
const MAX_UNCONFIRMED_AGE_MS = 2500;
const RETRY_INTERVAL_MS = 180;
const MAX_SHOT_RETRIES = 5;
const RECONCILE_BLEND_RATE = 16;

const shortestWrappedDelta = (from, to, size) => {
  if (size <= 0) return to - from;

  let delta = to - from;

  if (delta > size / 2) delta -= size;
  if (delta < -size / 2) delta += size;

  return delta;
};

export const createProjectilePredictor = () => {
  const ownProjectiles = new Map();
  const pendingShots = new Map();
  const playedLocalShotSeqs = new Set();

  const makeKey = (originSeq, isHoming) => `${originSeq}:${isHoming ? 'h' : 'n'}`;

  const reset = () => {
    ownProjectiles.clear();
    pendingShots.clear();
    playedLocalShotSeqs.clear();
  };

  const rememberLocalSound = (originSeq) => {
    playedLocalShotSeqs.add(originSeq);

    if (playedLocalShotSeqs.size > 64) {
      const oldest = playedLocalShotSeqs.values().next().value;
      playedLocalShotSeqs.delete(oldest);
    }
  };

  const consumeLocalSound = (originSeq) => {
    if (originSeq === null || originSeq === undefined) return false;

    return playedLocalShotSeqs.delete(originSeq);
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
        ttl: isHoming ? 3 : 1.5,
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
        key,
        originSeq,
        isHoming,
        ownerId,
        ownerPlayerId,
        bullet,
        visualPos: { x: pos.x, y: pos.y },
        subTickMs: 0,
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

    rememberLocalSound(originSeq);
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
      record.bullet.update(dt, world);
      record.subTickMs = 0;

      if (record.lastServerPos === null) {
        record.visualPos = {
          x: record.bullet.pos.x,
          y: record.bullet.pos.y,
        };
      }

      if (
        !record.bullet.alive ||
        (!record.seenOnServer && now - record.createdAt > MAX_UNCONFIRMED_AGE_MS)
      ) {
        ownProjectiles.delete(key);
      }
    }
  };

  const advanceRenderTime = (frameTimeMs, world, rttMs = 0) => {
    if (world.width <= 0 || world.height <= 0) return;

    const now = performance.now();
    const stepMs = Math.max(0, Number(frameTimeMs) || 0);
    const dtSec = stepMs / 1000;
    const halfRttSec = Math.max(0, Math.min(0.25, (Number(rttMs) || 0) / 2000));

    for (const record of ownProjectiles.values()) {
      record.subTickMs = Math.min(FIXED_STEP_MS, record.subTickMs + stepMs);

      if (record.lastServerPos !== null && record.lastServerVel !== null) {
        const vx = record.lastServerVel.x;
        const vy = record.lastServerVel.y;

        const predictedX = wrap(record.visualPos.x + vx * dtSec, world.width);
        const predictedY = wrap(record.visualPos.y + vy * dtSec, world.height);

        const ageSec = Math.max(
          0,
          Math.min(0.2, (now - record.lastSnapshotReceivedAt) / 1000),
        );
        const leadSec = ageSec + halfRttSec;

        const targetX = wrap(record.lastServerPos.x + vx * leadSec, world.width);
        const targetY = wrap(record.lastServerPos.y + vy * leadSec, world.height);

        const dx = shortestWrappedDelta(predictedX, targetX, world.width);
        const dy = shortestWrappedDelta(predictedY, targetY, world.height);
        const blend = 1 - Math.exp(-RECONCILE_BLEND_RATE * dtSec);

        record.visualPos = {
          x: wrap(predictedX + dx * blend, world.width),
          y: wrap(predictedY + dy * blend, world.height),
        };
      } else {
        const subDtSec = Math.min(FIXED_DT, record.subTickMs / 1000);
        record.visualPos = {
          x: wrap(record.bullet.pos.x + record.bullet.vel.x * subDtSec, world.width),
          y: wrap(record.bullet.pos.y + record.bullet.vel.y * subDtSec, world.height),
        };
      }
    }
  };

  const bindServerEntityToRecord = (record, serverEntity, receivedAt) => {
    record.serverEntityId = serverEntity.id;
    record.accepted = true;
    record.seenOnServer = true;
    record.lastServerPos = { x: serverEntity.pos.x, y: serverEntity.pos.y };
    record.lastServerVel = { x: serverEntity.vel.x, y: serverEntity.vel.y };
    record.lastSnapshotReceivedAt = receivedAt;
    record.bullet.vel.x = serverEntity.vel.x;
    record.bullet.vel.y = serverEntity.vel.y;
  };

  const onFireAck = ({ originSeq, accepted, entityId = null, entityIds = null }, world) => {
    pendingShots.delete(originSeq);

    const ids = Array.isArray(entityIds)
      ? entityIds
      : entityId !== null && entityId !== undefined
        ? [entityId]
        : [];
    const now = performance.now();

    for (const [key, record] of ownProjectiles) {
      if (record.originSeq !== originSeq) continue;

      if (!accepted) {
        ownProjectiles.delete(key);
        continue;
      }

      record.accepted = true;

      for (const candidateId of ids) {
        const serverEntity = world.get(candidateId);

        if (
          serverEntity &&
          serverEntity.kind === 'bullet' &&
          Boolean(serverEntity.homing) === record.isHoming
        ) {
          if (serverEntity.alive) {
            bindServerEntityToRecord(record, serverEntity, now);
          } else {
            ownProjectiles.delete(key);
          }
          break;
        }
      }

      if (record.serverEntityId === null) {
        record.serverEntityId = ids.length === 1 ? ids[0] : null;
        record.serverEntityIds = ids;
      }
    }
  };

  const onSnapshot = (snapshot, world, myPlayerId, myEntityId) => {
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

    for (const record of ownProjectiles.values()) {
      if (record.serverEntityId !== null) {
        claimedServerBulletIds.add(record.serverEntityId);
      } else {
        for (const bullet of serverBullets) {
          if (isMatchedByServer(record, bullet, myPlayerId, myEntityId)) {
            claimedServerBulletIds.add(bullet.id);
          }
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

      if (isOwnBullet(bullet, myPlayerId, myEntityId)) {
        renderList.push({
          x: bullet.pos.x,
          y: bullet.pos.y,
          radius: bullet.radius,
          isHoming,
        });
      } else {
        const interp = interpolation.getInterpolatedEntity(bullet, world, now);
        renderList.push({
          x: interp.x,
          y: interp.y,
          radius: bullet.radius,
          isHoming,
        });
      }
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
    consumeLocalSound,
    reset,
  };
};
