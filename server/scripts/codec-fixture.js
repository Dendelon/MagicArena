import {
  Sword,
  Bullet,
  Obstacle,
  Pickup,
  Explosion,
  Vector2,
  createHoming,
  createHealingEffect,
  createInputMessage,
  createSnapshotMessage,
} from '@magicarena/shared';

export const createCodecFixture = () => {
  const players = Array.from(
    { length: 4 },
    (_, i) =>
      new Sword({
        id: i + 1,
        ownerId: `00000000-0000-4000-8000-00000000000${i + 1}`,
        pos: new Vector2(150 + i * 150, 200 + i * 60),
        vel: new Vector2(50, -100),
        angle: 0.75 + i * 0.5,
        hp: 3,
        input: { forward: true },
      }),
  );

  const bullets = Array.from(
    { length: 8 },
    (_, i) =>
      new Bullet({
        id: 100 + i,
        ownerId: players[i % 4].id,
        ownerPlayerId: players[i % 4].ownerId,
        originSeq: 100 + i,
        pos: new Vector2(200 + i * 50, 300),
        vel: new Vector2(0, -550),
        angle: 0.75,
        homing:
          i % 2 === 0
            ? createHoming({
                targetKind: 'obstacle',
                turnRate: 4,
                speed: 550,
              })
            : null,
      }),
  );

  const obstacles = Array.from(
    { length: 3 },
    (_, i) =>
      new Obstacle({
        id: 200 + i,
        pos: new Vector2(300 + i * 150, 400),
        vel: new Vector2(35, -20),
        hp: 3,
      }),
  );

  const pickup = new Pickup({
    id: 300,
    pos: new Vector2(600, 450),
    effect: createHealingEffect(1),
  });

  const explosion = new Explosion({
    id: 400,
    pos: new Vector2(500, 350),
    count: 20,
  });

  const snapshot = createSnapshotMessage({
    tick: 1000,
    lastProcessedSeq: 995,
    bounds: {
      width: 1280,
      height: 720,
    },
    score: 5,
    respawnSeconds: null,
    entities: [...players, ...bullets, ...obstacles, pickup, explosion],
    events: [
      {
        type: 'fired',
        detail: {
          entityId: 100,
          ownerId: players[0].id,
          ownerPlayerId: players[0].ownerId,
          originSeq: 100,
          pos: { x: 200, y: 300 },
        },
      },
    ],
  });

  const input = createInputMessage({
    seq: 1001,
    tick: 1001,
    thrust: true,
    turn: -1,
    brake: false,
    fire: true,
    homingFire: false,
    fireSeq: 1001,
  });

  return { input, snapshot };
};

