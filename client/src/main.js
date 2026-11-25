import './style.css';
import { createCanvas } from './render/canvas';
import { World, createInputMessage } from '@magicarena/shared';
import { createGameAudio } from './audio/audio.js';
import {
  drawArenaBorder,
  drawBackground,
  drawOuterBackground,
} from './render/background';
import { drawSword } from './render/sword';
import { drawHud } from './render/hud';
import { drawBullet } from './render/bullet.js';
import { drawObstacle } from './render/obstacle.js';
import { drawExplosion } from './render/explosion.js';
import { drawPickup } from './render/pickup.js';
import { drawSheetSprite } from './render/sprites.js';
import { drawSwordThrust } from './render/swordThrust.js';
import { createLoop } from './loop';
import { createInput } from './input';
import { bootGame } from './assets/boot.js';
import { Lobby } from './lobby/Lobby.js';
import { mountLobby } from './lobby/view.js';
import { createConnection } from './network/connection.js';
import { mountRoomChat } from './network/chat.js';
import { mountNetgraph } from './network/netgraph.js';
import { createPrediction } from './network/prediction.js';
import {
  DEFAULT_INTERPOLATION_DELAY_MS,
  createInterpolation,
} from './network/interpolation.js';
import { createProjectilePredictor } from './network/projectiles.js';

const INPUT_INTERVAL = 1 / 30;

const canvas = document.querySelector('#game');
const { ctx, size } = createCanvas(canvas);

const input = createInput();

const world = new World({ width: 0, height: 0 });

let loadedAssets = null;
let gameAudio = null;

let playerName = 'Mage';
let roomName = 'Arcane Ruins';

let connection = null;
let netgraph = null;
let myPlayerId = null;
let myEntityId = null;
let respawnTimer = null;
let lastAppliedSnapshotTick = null;
let lastServerAckSeq = 0;

const prediction = createPrediction();
const interpolation = createInterpolation({ delayMs: DEFAULT_INTERPOLATION_DELAY_MS });
const projectiles = createProjectilePredictor();

let inputSeq = 0;
let clientTick = 0;
let inputAccumulator = 0;
let pendingFire = false;
let pendingHomingFire = false;
let pendingShotSeq = null;

const pollLocalShots = () => {
  const firePressed = input.justPressed('Space');
  const homingFirePressed = input.justPressed('KeyH');

  if (!firePressed && !homingFirePressed) return;
  if (!connection?.isJoined?.() || myPlayerId === null || !prediction.isAlive) return;

  if (pendingShotSeq === null) {
    pendingShotSeq = inputSeq + 1;
  }

  const spawnFire = firePressed && !pendingFire;
  const spawnHoming = homingFirePressed && !pendingHomingFire;

  if (firePressed) pendingFire = true;
  if (homingFirePressed) pendingHomingFire = true;

  if (!spawnFire && !spawnHoming) return;

  const spawned = projectiles.spawnLocalShot({
    originSeq: pendingShotSeq,
    swordState: prediction.getPredictedState(),
    fire: spawnFire,
    homingFire: spawnHoming,
    world,
    ownerId: myEntityId,
    ownerPlayerId: myPlayerId,
  });

  if (spawned) {
    gameAudio?.play('shoot', 0.2);
  }
};

const simulate = (dt) => {
  pollLocalShots();

  if (!connection?.isJoined?.() || myPlayerId === null) return;

  inputAccumulator += dt;

  if (inputAccumulator < INPUT_INTERVAL) return;

  inputAccumulator -= INPUT_INTERVAL;

  const controls = input.getState();
  const turn = Number(controls.right) - Number(controls.left);

  inputSeq += 1;
  clientTick += 1;

  const wantsNewShot = pendingFire || pendingHomingFire;
  const retryShot = !wantsNewShot ? projectiles.getRetryShot(lastServerAckSeq) : null;

  const message = createInputMessage({
    seq: inputSeq,
    tick: clientTick,
    thrust: controls.forward,
    turn,
    brake: controls.brake,
    fire: wantsNewShot ? pendingFire : Boolean(retryShot?.fire),
    homingFire: wantsNewShot ? pendingHomingFire : Boolean(retryShot?.homingFire),
    fireSeq: wantsNewShot
      ? pendingShotSeq !== null && pendingShotSeq !== inputSeq
        ? pendingShotSeq
        : undefined
      : retryShot?.fireSeq,
  });

  pendingFire = false;
  pendingHomingFire = false;
  pendingShotSeq = null;

  connection.send(message);
  prediction.predictInput(message, world);
  projectiles.step(INPUT_INTERVAL, world);
  netgraph?.setPendingCount(prediction.pendingCount);
};

const render = (_alpha, stats) => {
  pollLocalShots();
  drawOuterBackground(ctx, size.width, size.height);
  prediction.advanceSmoothing(stats.frameTimeMs);

  const now = performance.now();

  projectiles.advanceRenderTime(
    world,
    netgraph?.getRttMs?.() ?? 0,
    now,
  );
  const sprites = loadedAssets?.sprites ?? {};
  const frame = Math.floor(now / 150) % 4;

  if (world.width > 0 && world.height > 0) {
    const arenaPadding = 20;
    const availableWidth = Math.max(1, size.width - arenaPadding * 2);
    const availableHeight = Math.max(1, size.height - arenaPadding * 2);
    const worldScale = Math.min(
      availableWidth / world.width,
      availableHeight / world.height,
    );
    const scaledWidth = world.width * worldScale;
    const scaledHeight = world.height * worldScale;
    const offsetX = (size.width - scaledWidth) / 2;
    const offsetY = (size.height - scaledHeight) / 2;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(worldScale, worldScale);
    ctx.beginPath();
    ctx.rect(0, 0, world.width, world.height);
    ctx.clip();

    drawBackground(ctx, world.width, world.height);

    // Малювання рунічних каменів
    for (const obstacle of world.ofKind('obstacle')) {
      const x = obstacle.pos.x;
      const y = obstacle.pos.y;

      if (
        !drawSheetSprite(ctx, sprites.obstacle, x, y, {
          frame,
          scale: (obstacle.radius / 25) * 1.65,
        })
      ) {
        drawObstacle(ctx, x, y, obstacle.radius);
      }
    }

    for (const pickup of world.ofKind('pickup')) {
      drawPickup(ctx, pickup.pos.x, pickup.pos.y, pickup.radius);
    }

    const drawBulletSprite = (bulletX, bulletY, radius, isHoming) => {
      const bulletSprite = isHoming ? sprites.bulletHoming : sprites.bullet;

      ctx.save();

      ctx.shadowColor = isHoming ? '#22d3ee' : '#a855f7';
      ctx.shadowBlur = 10;

      const rendered = drawSheetSprite(ctx, bulletSprite, bulletX, bulletY, {
        frame,
        scale: (radius / 6) * 0.75,
      });

      ctx.restore();

      if (!rendered) {
        drawBullet(ctx, bulletX, bulletY, radius, isHoming);
      }
    };

    for (const bullet of projectiles.getBulletsToRender({
      world,
      interpolation,
      myPlayerId,
      myEntityId,
      now,
    })) {
      drawBulletSprite(bullet.x, bullet.y, bullet.radius, bullet.isHoming);
    }

    for (const sword of world.ofKind('sword')) {
      const isOwnSword =
        myPlayerId !== null && sword.ownerId !== null && sword.ownerId !== undefined
          ? sword.ownerId === myPlayerId
          : myEntityId !== null && sword.id === myEntityId;
      const usePredicted = isOwnSword && prediction.isAlive;
      const renderState = usePredicted
        ? prediction.getRenderState(world)
        : isOwnSword
          ? null
          : interpolation.getInterpolatedEntity(sword, world, now);

      const x = renderState ? renderState.x : sword.pos.x;
      const y = renderState ? renderState.y : sword.pos.y;
      const angle = renderState ? renderState.angle : sword.angle;
      const thrusting = renderState ? renderState.thrust : Boolean(sword.input?.forward);

      if (thrusting) {
        drawSwordThrust(ctx, x, y, angle);
      }

      if (
        !drawSheetSprite(ctx, sprites.sword, x, y, {
          frame,
          angle,
          scale: 2.15,
        })
      ) {
        drawSword(ctx, x, y, angle);
      }
    }

    // Малювання вибухів
    for (const explosion of world.ofKind('explosion')) {
      drawExplosion(ctx, explosion);
    }

    ctx.restore();

    drawArenaBorder(ctx, offsetX, offsetY, scaledWidth, scaledHeight);
  }

  const mySword = myEntityId !== null ? world.get(myEntityId) : null;

  drawHud(ctx, {
    ...stats,
    hp: mySword?.alive ? mySword.hp : 0,
    score: world.score,
    respawnSeconds: respawnTimer,
  });

  ctx.save();
  ctx.fillStyle = '#ddd6fe';
  ctx.font = '13px monospace';
  ctx.textAlign = 'right';

  ctx.fillText(`${playerName} | ${roomName}`, size.width - 18, 30);

  ctx.restore();
};

const loop = createLoop({
  render,
  simulate,
});

const audioContext = new AudioContext();

void bootGame({
  ctx,
  size,
  audioContext,

  start: (assets) => {
    loadedAssets = assets;

    // Підключаємо звуки
    const audio = createGameAudio(audioContext, assets.audio);
    gameAudio = audio;

    audio.subscribe(world, {
      shouldPlay: (event) => {
        const detail = event.detail ?? {};
        const isOwnEvent =
          (myPlayerId !== null && detail.ownerPlayerId === myPlayerId) ||
          (myEntityId !== null && detail.ownerId === myEntityId);

        return !isOwnEvent;
      },
    });

    // Створюємо лобі
    const lobby = new Lobby({
      url: '/api/rooms',
      refreshMs: 5000,
      timeoutMs: 3000,
    });

    // Обробка входу в кімнату
    const onJoined = (event) => {
      const { name, room } = event.detail;

      playerName = name;
      roomName = room.name;

      // Прибираємо лобі та запускаємо гру
      destroyLobby();

      connection = createConnection({
        name: playerName,
        roomId: room.id,
      });

      const resetSessionState = () => {
        myPlayerId = null;
        myEntityId = null;
        lastAppliedSnapshotTick = null;
        lastServerAckSeq = 0;
        inputSeq = 0;
        clientTick = 0;
        inputAccumulator = 0;
        pendingFire = false;
        pendingHomingFire = false;
        pendingShotSeq = null;
        respawnTimer = null;
        prediction.reset();
        interpolation.reset();
        projectiles.reset();
      };

      connection.addEventListener('joined', (joinedEvent) => {
        const detail = joinedEvent.detail;

        resetSessionState();
        myPlayerId = detail.player?.id ?? null;
        myEntityId = detail.entityId ?? detail.player?.entityId ?? null;

        if (detail.bounds) {
          world.bounds = {
            width: detail.bounds.width,
            height: detail.bounds.height,
          };
        }
      });

      connection.addEventListener('disconnected', () => {
        resetSessionState();
      });

      connection.addEventListener('status', (statusEvent) => {
        if (
          statusEvent.detail === 'Connecting...' ||
          String(statusEvent.detail).startsWith('Reconnecting')
        ) {
          resetSessionState();
        }
      });

      connection.addEventListener('fireAck', (ackEvent) => {
        if (!connection?.isJoined?.() || myPlayerId === null) return;

        projectiles.onFireAck(ackEvent.detail);
      });

      connection.addEventListener('snapshot', (snapshotEvent) => {
        if (!connection?.isJoined?.() || myPlayerId === null) return;

        const snapshot = snapshotEvent.detail;

        if (
          typeof snapshot.tick === 'number' &&
          lastAppliedSnapshotTick !== null &&
          snapshot.tick <= lastAppliedSnapshotTick
        ) {
          return;
        }

        if (typeof snapshot.tick === 'number') {
          lastAppliedSnapshotTick = snapshot.tick;
        }

        lastServerAckSeq = snapshot.lastProcessedSeq ?? lastServerAckSeq;
        interpolation.pushSnapshot(snapshot);
        world.applySnapshot(snapshot);
        respawnTimer = snapshot.respawnSeconds ?? null;

        projectiles.onSnapshot(snapshot, myPlayerId, myEntityId);

        const reconciliation = prediction.reconcile(
          snapshot,
          myPlayerId,
          myEntityId,
          world,
        );

        if (reconciliation) {
          myEntityId = reconciliation.entityId;
          netgraph?.recordReconciliation(reconciliation);
        }
      });

      const destroyChat = mountRoomChat(connection);
      netgraph = mountNetgraph(connection, {
        initialInterpolationDelayMs: interpolation.delayMs,
        onInterpolationDelayChange: (nextDelayMs) => {
          interpolation.setDelay(nextDelayMs);
        },
      });

      window.addEventListener(
        'beforeunload',
        () => {
          loop.stop();
          resetSessionState();
          netgraph?.destroy();
          destroyChat();
        },
        { once: true },
      );

      connection.connect();

      loop.start();
    };

    lobby.addEventListener('joined', onJoined, {
      once: true,
    });

    // Показуємо лобі
    const destroyLobby = mountLobby(lobby, {
      onJoinGesture: () => {
        void audio.unlock().catch(console.error);
      },
    });
  },
});
