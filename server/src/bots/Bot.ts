import { mulberry32 } from '@magicarena/shared';

import type {
  Bounds,
  PlayerId,
  RandomSource,
  SnapshotMessage,
  SwordSnapshot,
} from '@magicarena/shared';

export interface BotControls {
  thrust: boolean;
  turn: -1 | 0 | 1;
  brake: boolean;
  fire: boolean;
  homingFire: boolean;
}

export interface PlayerInput {
  decide(
    snapshot: SnapshotMessage,
    playerId: PlayerId,
    timeSec: number,
    bounds?: Bounds,
  ): BotControls;
}

const DEFAULT_BOUNDS: Bounds = {
  width: 960,
  height: 640,
};

const ATTACK_RANGE_SQ = 350 * 350;
const AIM_TOLERANCE_RAD = 0.2;
const TURN_DEADZONE_RAD = 0.06;

const OBSTACLE_DANGER_BUFFER = 75;
const BULLET_DANGER_BUFFER = 95;
const BULLET_IMMEDIATE_BUFFER = 45;

const WANDER_TURNS: readonly (-1 | 0 | 1)[] = [-1, 0, 1];

const NEUTRAL_CONTROLS: Readonly<BotControls> = Object.freeze({
  thrust: false,
  turn: 0,
  brake: false,
  fire: false,
  homingFire: false,
});

const shortestWrappedDelta = (
  from: number,
  to: number,
  size: number,
): number => {
  if (size <= 0) return to - from;

  let delta = to - from;

  if (delta > size / 2) delta -= size;
  if (delta < -size / 2) delta += size;

  return delta;
};

const normalizeAngle = (angle: number): number =>
  Math.atan2(Math.sin(angle), Math.cos(angle));

const turnFromError = (angleError: number): -1 | 0 | 1 =>
  angleError > TURN_DEADZONE_RAD
    ? 1
    : angleError < -TURN_DEADZONE_RAD
      ? -1
      : 0;

export class Bot implements PlayerInput {
  readonly #rng: RandomSource;

  #nextFireAt = 0;
  #nextHomingFireAt: number;
  #nextWanderAt = 0;
  #wanderTurn: -1 | 0 | 1 = 0;

  constructor(seed = 1) {
    this.#rng = mulberry32(seed >>> 0 || 1);
    this.#nextHomingFireAt = 1.2 + this.#rng() * 0.6;
  }

  decide(
    snapshot: SnapshotMessage,
    playerId: PlayerId,
    timeSec: number,
    bounds: Bounds = DEFAULT_BOUNDS,
  ): BotControls {
    const arenaBounds = snapshot.bounds ?? bounds;

    let own: SwordSnapshot | null = null;

    for (const entity of snapshot.entities) {
      if (
        entity.kind === 'sword' &&
        entity.alive &&
        entity.ownerId === playerId
      ) {
        own = entity;
        break;
      }
    }

    if (!own) {
      return { ...NEUTRAL_CONTROLS };
    }

    // 1. Evade nearby obstacles and threatening enemy projectiles.
    let nearestThreatDx = 0;
    let nearestThreatDy = 0;
    let nearestThreatDistSq = Infinity;

    for (const entity of snapshot.entities) {
      if (!entity.alive) continue;

      if (entity.kind === 'obstacle') {
        const dx = shortestWrappedDelta(
          own.pos.x,
          entity.pos.x,
          arenaBounds.width,
        );
        const dy = shortestWrappedDelta(
          own.pos.y,
          entity.pos.y,
          arenaBounds.height,
        );
        const dangerRadius =
          own.radius + entity.radius + OBSTACLE_DANGER_BUFFER;
        const distSq = dx * dx + dy * dy;

        if (distSq <= dangerRadius * dangerRadius && distSq < nearestThreatDistSq) {
          nearestThreatDistSq = distSq;
          nearestThreatDx = dx;
          nearestThreatDy = dy;
        }
        continue;
      }

      if (
        entity.kind === 'bullet' &&
        entity.ownerPlayerId !== playerId &&
        entity.ownerId !== own.id
      ) {
        const dx = shortestWrappedDelta(
          own.pos.x,
          entity.pos.x,
          arenaBounds.width,
        );
        const dy = shortestWrappedDelta(
          own.pos.y,
          entity.pos.y,
          arenaBounds.height,
        );
        const distSq = dx * dx + dy * dy;
        const immediateRadius =
          own.radius + entity.radius + BULLET_IMMEDIATE_BUFFER;
        const dangerRadius = own.radius + entity.radius + BULLET_DANGER_BUFFER;

        if (distSq > dangerRadius * dangerRadius) continue;

        // Vector from bullet to own sword: positive dot product means bullet moves toward own sword.
        const approaching =
          distSq <= immediateRadius * immediateRadius ||
          -dx * entity.vel.x - dy * entity.vel.y > 0;

        if (approaching && distSq < nearestThreatDistSq) {
          nearestThreatDistSq = distSq;
          nearestThreatDx = dx;
          nearestThreatDy = dy;
        }
      }
    }

    if (nearestThreatDistSq < Infinity) {
      const hazardAngle = Math.atan2(nearestThreatDx, -nearestThreatDy);
      const hazardError = normalizeAngle(hazardAngle - own.angle);
      const escapeAngle =
        hazardAngle + (hazardError >= 0 ? -Math.PI / 2 : Math.PI / 2);
      const escapeError = normalizeAngle(escapeAngle - own.angle);

      return {
        thrust: true,
        turn: turnFromError(escapeError),
        brake: false,
        fire: false,
        homingFire: false,
      };
    }

    // 2. Chase and attack the nearest alive enemy sword.
    let targetDx = 0;
    let targetDy = 0;
    let nearestEnemyDistSq = Infinity;

    for (const entity of snapshot.entities) {
      if (
        entity.kind !== 'sword' ||
        !entity.alive ||
        entity.ownerId === playerId ||
        entity.id === own.id
      ) {
        continue;
      }

      const dx = shortestWrappedDelta(
        own.pos.x,
        entity.pos.x,
        arenaBounds.width,
      );
      const dy = shortestWrappedDelta(
        own.pos.y,
        entity.pos.y,
        arenaBounds.height,
      );
      const distSq = dx * dx + dy * dy;

      if (distSq < nearestEnemyDistSq) {
        nearestEnemyDistSq = distSq;
        targetDx = dx;
        targetDy = dy;
      }
    }

    if (nearestEnemyDistSq < Infinity) {
      const targetAngle = Math.atan2(targetDx, -targetDy);
      const angleError = normalizeAngle(targetAngle - own.angle);
      const turn = turnFromError(angleError);
      const thrust = Math.abs(angleError) < Math.PI / 2;

      let fire = false;
      let homingFire = false;

      if (
        nearestEnemyDistSq <= ATTACK_RANGE_SQ &&
        Math.abs(angleError) <= AIM_TOLERANCE_RAD
      ) {
        if (timeSec >= this.#nextHomingFireAt) {
          homingFire = true;
          this.#nextHomingFireAt = timeSec + 1.2 + this.#rng() * 0.6;
        } else if (timeSec >= this.#nextFireAt) {
          fire = true;
          this.#nextFireAt = timeSec + 0.35 + this.#rng() * 0.2;
        }
      }

      return {
        thrust,
        turn,
        brake: false,
        fire,
        homingFire,
      };
    }

    // 3. Wander when no opponents are present.
    if (timeSec >= this.#nextWanderAt) {
      const idx = Math.floor(this.#rng() * WANDER_TURNS.length);
      this.#wanderTurn = WANDER_TURNS[idx] ?? 0;
      this.#nextWanderAt = timeSec + 0.8 + this.#rng() * 1.2;
    }

    return {
      thrust: true,
      turn: this.#wanderTurn,
      brake: false,
      fire: false,
      homingFire: false,
    };
  }
}

