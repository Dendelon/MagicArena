import { describe, expect, test } from 'vitest';

import {
  Sword,
  Vector2,
  World,
  createInputMessage,
  createSnapshotMessage,
  toEntityId,
  toSeq,
  toTick,
} from '@magicarena/shared';

import { createPrediction } from '../src/network/prediction.ts';
import { shortestWrappedDelta } from '../src/network/math.ts';

import type { Bounds, EntityId, PlayerId, SwordInput } from '@magicarena/shared';

const bounds: Bounds = {
  width: 960,
  height: 640,
};

const playerId: PlayerId = 'player-1';
const swordId = toEntityId(1);

const makeCleanSnapshot = ({
  tick,
  lastProcessedSeq,
  x = 480,
  y = 320,
  vx = 0,
  vy = 0,
  angle = 0,
  thrust = false,
  alive = true,
}: {
  tick: number;
  lastProcessedSeq: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  angle?: number;
  thrust?: boolean;
  alive?: boolean;
}) =>
  createSnapshotMessage({
    tick,
    lastProcessedSeq,
    entities: [
      {
        id: swordId,
        kind: 'sword',
        ownerId: playerId,
        pos: { x, y },
        vel: { x: vx, y: vy },
        angle,
        radius: 22,
        alive,
        hp: 3,
        damageCooldown: 0,
        thrust,
      },
    ],
  });

describe('Client prediction and reconciliation', () => {
  test('Initial server snapshot initializes local predicted state', () => {
    const prediction = createPrediction();

    const result = prediction.reconcile(
      makeCleanSnapshot({
        tick: 1,
        lastProcessedSeq: 0,
        x: 200,
        y: 150,
        vx: 10,
        vy: -5,
        angle: 0.4,
        thrust: true,
      }),
      playerId,
      swordId,
      bounds,
    );

    expect(result).toEqual({
      correctionPx: 0,
      pendingCount: 0,
      entityId: swordId,
    });
    expect(prediction.isAlive).toBe(true);
    expect(prediction.entityId).toBe(swordId);
    expect(prediction.getPredictedState()).toEqual({
      entityId: swordId,
      alive: true,
      x: 200,
      y: 150,
      vx: 10,
      vy: -5,
      angle: 0.4,
      thrust: true,
    });
  });

  test('Local input immediately updates predicted state and increments pendingCount', () => {
    const prediction = createPrediction();
    prediction.reconcile(
      makeCleanSnapshot({ tick: 1, lastProcessedSeq: 0 }),
      playerId,
      swordId,
      bounds,
    );

    const applied = prediction.predictInput(
      createInputMessage({ seq: 1, tick: 1, thrust: true, turn: 1 }),
      bounds,
    );

    expect(applied).toBe(true);
    expect(prediction.pendingCount).toBe(1);

    const state = prediction.getPredictedState();
    expect(state.angle).toBeCloseTo(Math.PI / 30, 10);
    expect(Math.hypot(state.vx, state.vy)).toBeGreaterThan(0);
    expect(state.thrust).toBe(true);
  });

  test('Acknowledged sequence numbers are removed and unacknowledged inputs replayed', () => {
    const prediction = createPrediction();
    prediction.reconcile(
      makeCleanSnapshot({ tick: 1, lastProcessedSeq: 0 }),
      playerId,
      swordId,
      bounds,
    );

    const input1 = createInputMessage({ seq: 1, tick: 1, thrust: true });
    const input2 = createInputMessage({ seq: 2, tick: 2, thrust: true });
    const input3 = createInputMessage({ seq: 3, tick: 3, thrust: true, turn: 1 });

    prediction.predictInput(input1, bounds);
    prediction.predictInput(input2, bounds);
    prediction.predictInput(input3, bounds);
    expect(prediction.pendingCount).toBe(3);

    // Server acknowledges seq 1 with analytical state after step 1.
    const dt = 1 / 30;
    const step1Vy = -400 * dt * Math.exp(-0.8 * dt);
    const step1Y = 320 + step1Vy * dt;

    const res = prediction.reconcile(
      makeCleanSnapshot({
        tick: 2,
        lastProcessedSeq: 1,
        x: 480,
        y: step1Y,
        vx: 0,
        vy: step1Vy,
        angle: 0,
        thrust: true,
      }),
      playerId,
      swordId,
      bounds,
    );

    // Seq 1 removed; seq 2 and seq 3 remain pending and replayed.
    expect(res?.pendingCount).toBe(2);
    expect(res?.correctionPx).toBeCloseTo(0, 8);
    expect(prediction.pendingCount).toBe(2);
    expect(prediction.getPredictedState().angle).toBeCloseTo(Math.PI / 30, 10);
  });

  test('Reconciliation matches independent analytical state after server correction', () => {
    const prediction = createPrediction();
    prediction.reconcile(
      makeCleanSnapshot({ tick: 1, lastProcessedSeq: 0 }),
      playerId,
      swordId,
      bounds,
    );

    prediction.predictInput(
      createInputMessage({ seq: 1, tick: 1, thrust: true }),
      bounds,
    );

    // Authoritative server moves sword to x = 500, vy = -20 at ack 1 (no pending left).
    const res = prediction.reconcile(
      makeCleanSnapshot({
        tick: 2,
        lastProcessedSeq: 1,
        x: 500,
        y: 320,
        vx: 0,
        vy: -20,
        angle: 0,
        thrust: true,
      }),
      playerId,
      swordId,
      bounds,
    );

    expect(res).not.toBeNull();
    expect(res?.pendingCount).toBe(0);
    expect(res?.correctionPx).toBeGreaterThan(10);
    expect(prediction.getPredictedState()).toEqual({
      entityId: swordId,
      alive: true,
      x: 500,
      y: 320,
      vx: 0,
      vy: -20,
      angle: 0,
      thrust: true,
    });
  });

  test('Stale snapshot does not roll back client state', () => {
    const prediction = createPrediction();
    prediction.reconcile(
      makeCleanSnapshot({ tick: 10, lastProcessedSeq: 5, x: 500 }),
      playerId,
      swordId,
      bounds,
    );

    const stale = prediction.reconcile(
      makeCleanSnapshot({ tick: 9, lastProcessedSeq: 4, x: 100 }),
      playerId,
      swordId,
      bounds,
    );

    expect(stale).toBeNull();
    expect(prediction.getPredictedState().x).toBe(500);
  });

  test('Smoothing offset gradually decays over the smoothing duration', () => {
    const prediction = createPrediction();
    prediction.reconcile(
      makeCleanSnapshot({ tick: 1, lastProcessedSeq: 0, x: 400 }),
      playerId,
      swordId,
      bounds,
    );

    // Server shifts authoritative x by 20px (within snap threshold 160px).
    prediction.reconcile(
      makeCleanSnapshot({ tick: 2, lastProcessedSeq: 0, x: 420 }),
      playerId,
      swordId,
      bounds,
    );

    // At t=0ms after reconcile, render state still holds full previous position (400).
    expect(prediction.getRenderState(bounds).x).toBeCloseTo(400, 6);

    // Halfway through 100ms smoothing interval -> halfway between 400 and 420.
    prediction.advanceSmoothing(50);
    expect(prediction.getRenderState(bounds).x).toBeCloseTo(410, 6);

    // After full smoothing interval -> reaches authoritative 420.
    prediction.advanceSmoothing(50);
    expect(prediction.getRenderState(bounds).x).toBeCloseTo(420, 6);
  });

  test('Reset clears pending inputs and predicted state', () => {
    const prediction = createPrediction();
    prediction.reconcile(
      makeCleanSnapshot({ tick: 1, lastProcessedSeq: 0, x: 300 }),
      playerId,
      swordId,
      bounds,
    );
    prediction.predictInput(
      createInputMessage({ seq: 1, tick: 1, thrust: true }),
      bounds,
    );

    prediction.reset();

    expect(prediction.isAlive).toBe(false);
    expect(prediction.entityId).toBeNull();
    expect(prediction.pendingCount).toBe(0);
  });

  test('Deterministic prediction matches authoritative World simulation for discrete turns', () => {
    const authWorld = new World(bounds, { seed: 99 });
    const authSword = authWorld.spawn(
      new Sword({
        id: swordId,
        ownerId: playerId,
        pos: new Vector2(480, 320),
      }),
    );

    const prediction = createPrediction();

    const initialSnapshot = createSnapshotMessage({
      ...authWorld.toSnapshot(toSeq(0)),
    });
    prediction.reconcile(initialSnapshot, playerId, authSword.id, bounds);

    const sequence = [
      createInputMessage({ seq: toSeq(1), tick: toTick(1), thrust: true, turn: 1 }),
      createInputMessage({ seq: toSeq(2), tick: toTick(2), thrust: true, turn: 0 }),
      createInputMessage({ seq: toSeq(3), tick: toTick(3), thrust: false, turn: -1, brake: true }),
      createInputMessage({ seq: toSeq(4), tick: toTick(4), thrust: true, turn: -1 }),
      createInputMessage({ seq: toSeq(5), tick: toTick(5), thrust: false, turn: 0, brake: false }),
    ];

    for (const command of sequence) {
      prediction.predictInput(command, bounds);

      const stepInputs = new Map<EntityId, SwordInput>([
        [
          authSword.id,
          {
            thrust: command.thrust,
            turn: command.turn,
            brake: command.brake,
          },
        ],
      ]);
      authWorld.step(1 / 30, stepInputs);
    }

    const preReconcileState = prediction.getPredictedState();
    const authoritativeJson = authSword.toJSON();

    expect(preReconcileState.x).toBeCloseTo(authoritativeJson.pos.x, 10);
    expect(preReconcileState.y).toBeCloseTo(authoritativeJson.pos.y, 10);
    expect(preReconcileState.vx).toBeCloseTo(authoritativeJson.vel.x, 10);
    expect(preReconcileState.vy).toBeCloseTo(authoritativeJson.vel.y, 10);
    expect(preReconcileState.angle).toBeCloseTo(authoritativeJson.angle, 10);

    const finalSnapshot = createSnapshotMessage({
      ...authWorld.toSnapshot(toSeq(5)),
    });

    const result = prediction.reconcile(
      finalSnapshot,
      playerId,
      authSword.id,
      bounds,
    );

    expect(result?.pendingCount).toBe(0);
    expect(result?.correctionPx).toBeCloseTo(0, 10);

    const reconciledState = prediction.getPredictedState();

    expect(reconciledState.x).toBeCloseTo(authoritativeJson.pos.x, 10);
    expect(reconciledState.y).toBeCloseTo(authoritativeJson.pos.y, 10);
    expect(reconciledState.vx).toBeCloseTo(authoritativeJson.vel.x, 10);
    expect(reconciledState.vy).toBeCloseTo(authoritativeJson.vel.y, 10);
    expect(reconciledState.angle).toBeCloseTo(authoritativeJson.angle, 10);
  });

  test('Reconciliation converges with authoritative World simulation when fractional turn causes divergence', () => {
    const authWorld = new World(bounds, { seed: 99 });
    const authSword = authWorld.spawn(
      new Sword({
        id: swordId,
        ownerId: playerId,
        pos: new Vector2(480, 320),
      }),
    );

    const prediction = createPrediction();

    const initialSnapshot = createSnapshotMessage({
      ...authWorld.toSnapshot(toSeq(0)),
    });
    prediction.reconcile(initialSnapshot, playerId, authSword.id, bounds);

    const sequence = [
      createInputMessage({ seq: toSeq(1), tick: toTick(1), thrust: true, turn: 0.5 }),
      createInputMessage({ seq: toSeq(2), tick: toTick(2), thrust: true, turn: 0 }),
      createInputMessage({ seq: toSeq(3), tick: toTick(3), thrust: false, turn: -1, brake: true }),
      createInputMessage({ seq: toSeq(4), tick: toTick(4), thrust: true, turn: 0.25 }),
      createInputMessage({ seq: toSeq(5), tick: toTick(5), thrust: false, turn: 0, brake: false }),
    ];

    for (const command of sequence) {
      prediction.predictInput(command, bounds);

      const stepInputs = new Map<EntityId, SwordInput>([
        [
          authSword.id,
          {
            thrust: command.thrust,
            turn: command.turn,
            brake: command.brake,
          },
        ],
      ]);
      authWorld.step(1 / 30, stepInputs);
    }

    const preReconcileRender = prediction.getRenderState(bounds);
    const authoritativeJson = authSword.toJSON();

    const expectedCorrectionPx = Math.hypot(
      shortestWrappedDelta(
        authoritativeJson.pos.x,
        preReconcileRender.x,
        bounds.width,
      ),
      shortestWrappedDelta(
        authoritativeJson.pos.y,
        preReconcileRender.y,
        bounds.height,
      ),
    );

    const finalSnapshot = createSnapshotMessage({
      ...authWorld.toSnapshot(toSeq(5)),
    });

    const result = prediction.reconcile(
      finalSnapshot,
      playerId,
      authSword.id,
      bounds,
    );

    expect(result?.pendingCount).toBe(0);
    expect(result?.correctionPx).toBeGreaterThan(0);
    expect(result?.correctionPx).toBeCloseTo(expectedCorrectionPx, 10);

    const reconciledState = prediction.getPredictedState();

    expect(reconciledState.x).toBeCloseTo(authoritativeJson.pos.x, 10);
    expect(reconciledState.y).toBeCloseTo(authoritativeJson.pos.y, 10);
    expect(reconciledState.vx).toBeCloseTo(authoritativeJson.vel.x, 10);
    expect(reconciledState.vy).toBeCloseTo(authoritativeJson.vel.y, 10);
    expect(reconciledState.angle).toBeCloseTo(authoritativeJson.angle, 10);
  });
});
