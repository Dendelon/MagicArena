import './style.css';

import {
  World,
  createInputMessage,
  toSeq,
  toTick,
} from '@magicarena/shared';

import type {
  CodecMode,
  EntityId,
  NetSim,
  PlayerId,
  Seq,
  Tick,
} from '@magicarena/shared';

import { createCanvas } from './render/canvas.ts';
import { createGameAudio } from './audio/audio.ts';
import {
  drawArenaBorder,
  drawBackground,
  drawOuterBackground,
} from './render/background.ts';
import { drawSword } from './render/sword.ts';
import { drawHud } from './render/hud.ts';
import { drawBullet } from './render/bullet.ts';
import { drawObstacle } from './render/obstacle.ts';
import { drawExplosion } from './render/explosion.ts';
import { drawPickup } from './render/pickup.ts';
import { drawSheetSprite } from './render/sprites.ts';
import { drawSwordThrust } from './render/swordThrust.ts';
import { createLoop } from './loop.ts';
import { createInput } from './input.ts';
import { bootGame } from './assets/boot.ts';
import { Lobby, type LobbyEvents } from './lobby/Lobby.ts';
import { mountLobby } from './lobby/view.ts';
import {
  createConnection,
  resolveDecodeMode,
  type Connection,
} from './network/connection.ts';
import { mountRoomChat } from './network/chat.ts';
import { mountNetgraph, type Netgraph } from './network/netgraph.ts';
import { createPrediction } from './network/prediction.ts';
import {
  DEFAULT_INTERPOLATION_DELAY_MS,
  createInterpolation,
} from './network/interpolation.ts';
import { createProjectilePredictor } from './network/projectiles.ts';
import { createRenderProbe } from './e2e/renderProbe.ts';
import {
  FrameProfiler,
  createMagicArenaProfileApi,
} from './performance/FrameProfiler.ts';
import { DecodeProfiler } from './performance/DecodeProfiler.ts';

import type { FrameStats, LoadedAssets } from './types.ts';
import type { TypedEvent } from './events.ts';

const INPUT_INTERVAL = 1 / 30;

const canvas = document.querySelector('#game');

if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Game canvas was not found');
}

const { ctx, size } = createCanvas(canvas);
const renderProbe = createRenderProbe(canvas);

const input = createInput();

const world = new World({ width: 0, height: 0 });

let loadedAssets: LoadedAssets | null = null;
let gameAudio: ReturnType<typeof createGameAudio> | null = null;

let playerName = 'Mage';
let roomName = 'Arcane Ruins';
let roomId: string | null = null;
let roomPlayerCount: number | null = null;
let sessionCodec: CodecMode | null = null;
let sessionNetSim: NetSim | null = null;

let connection: Connection | null = null;
let netgraph: Netgraph | null = null;
let myPlayerId: PlayerId | null = null;
let myEntityId: EntityId | null = null;
let respawnTimer: number | null = null;
let lastAppliedSnapshotTick: Tick | null = null;
let lastServerAckSeq: Seq = toSeq(0);

const prediction = createPrediction();
const interpolation = createInterpolation({
  delayMs: DEFAULT_INTERPOLATION_DELAY_MS,
});
const projectiles = createProjectilePredictor();

let inputSeq: Seq = toSeq(0);
let clientTick: Tick = toTick(0);
let inputAccumulator = 0;
let pendingFire = false;
let pendingHomingFire = false;
let pendingShotSeq: Seq | null = null;

const pollLocalShots = (): void => {
  const firePressed = input.justPressed('Space');
  const homingFirePressed = input.justPressed('KeyH');

  if (!firePressed && !homingFirePressed) return;
  if (!connection?.isJoined() || myPlayerId === null || !prediction.isAlive) {
    return;
  }

  if (pendingShotSeq === null) {
    pendingShotSeq = toSeq(inputSeq + 1);
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

const simulate = (dt: number): void => {
  pollLocalShots();

  if (!connection?.isJoined() || myPlayerId === null) return;

  inputAccumulator += dt;

  if (inputAccumulator < INPUT_INTERVAL) return;

  inputAccumulator -= INPUT_INTERVAL;

  const controls = input.getState();
  const turn = Number(controls.right) - Number(controls.left);

  inputSeq = toSeq(inputSeq + 1);
  clientTick = toTick(clientTick + 1);

  const wantsNewShot = pendingFire || pendingHomingFire;
  const retryShot = !wantsNewShot
    ? projectiles.getRetryShot(lastServerAckSeq)
    : null;

  const message = createInputMessage({
    seq: inputSeq,
    tick: clientTick,
    thrust: controls.forward,
    turn,
    brake: controls.brake,
    fire: wantsNewShot ? pendingFire : Boolean(retryShot?.fire),
    homingFire: wantsNewShot
      ? pendingHomingFire
      : Boolean(retryShot?.homingFire),
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

const render = (_alpha: number, stats: FrameStats): void => {
  renderProbe.beginFrame();
  pollLocalShots();
  drawOuterBackground(ctx, size.width, size.height);
  prediction.advanceSmoothing(stats.frameTimeMs);

  const now = performance.now();

  projectiles.advanceRenderTime(world, netgraph?.getRttMs() ?? 0, now);
  const sprites: Readonly<Record<string, ImageBitmap>> =
    loadedAssets?.sprites ?? {};
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

    const drawBulletSprite = (
      bulletX: number,
      bulletY: number,
      radius: number,
      isHoming: boolean,
    ): void => {
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
        myPlayerId !== null && sword.ownerId !== null
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
      const thrusting = renderState
        ? renderState.thrust
        : Boolean(sword.input.forward);

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

      renderProbe.recordSword(sword.id, sword.ownerId, isOwnSword, x, y, angle);
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
    hp: mySword?.kind === 'sword' && mySword.alive ? mySword.hp : 0,
    score: world.score,
    respawnSeconds: respawnTimer,
  });

  ctx.save();
  ctx.fillStyle = '#ddd6fe';
  ctx.font = '13px monospace';
  ctx.textAlign = 'right';

  ctx.fillText(`${playerName} | ${roomName}`, size.width - 18, 30);

  ctx.restore();

  renderProbe.endFrame(lastAppliedSnapshotTick, world.width, world.height);
};

const frameProfiler =
  import.meta.env.VITE_PROFILE === '1' ? new FrameProfiler() : null;
const decodeProfiler =
  import.meta.env.VITE_PROFILE === '1' ? new DecodeProfiler() : null;
const decodeMode = resolveDecodeMode();

const loop = createLoop({
  render,
  simulate,
  ...(frameProfiler ? { profiler: frameProfiler } : {}),
});

if (import.meta.env.VITE_PROFILE === '1' && frameProfiler) {
  window.magicArenaProfile = createMagicArenaProfileApi({
    profiler: frameProfiler,
    decodeProfiler,
    getContext: () => ({
      roomId,
      roomName: roomId !== null ? roomName : null,
      playerCount: roomPlayerCount,
      codec: sessionCodec,
      netSim: sessionNetSim,
      bounds:
        world.width > 0 && world.height > 0
          ? { width: world.width, height: world.height }
          : null,
      pools: {
        world: world.getPoolStats(),
        localBullets: projectiles.getPoolStats(),
      },
      decode: connection?.getDecodeDiagnostics() ?? {
        requestedMode: decodeMode,
        actualMode: decodeMode,
        fallbackOccurred: false,
        worker: null,
      },
    }),
  });
}

const audioContext = new AudioContext();

bootGame({
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
        const detail = event.detail;
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
    const onJoined = (event: TypedEvent<LobbyEvents['joined']>): void => {
      const { name, room } = event.detail;

      playerName = name;
      roomName = room.name;
      roomId = room.id;
      roomPlayerCount = room.players;

      // Прибираємо лобі та запускаємо гру
      destroyLobby();

      const activeConnection = createConnection({
        name: playerName,
        roomId: room.id,
        decodeMode,
        decodeProfiler,
      });

      connection = activeConnection;

      const resetSessionState = (): void => {
        myPlayerId = null;
        myEntityId = null;
        sessionCodec = null;
        sessionNetSim = null;
        roomPlayerCount = null;
        lastAppliedSnapshotTick = null;
        lastServerAckSeq = toSeq(0);
        inputSeq = toSeq(0);
        clientTick = toTick(0);
        inputAccumulator = 0;
        pendingFire = false;
        pendingHomingFire = false;
        pendingShotSeq = null;
        respawnTimer = null;
        prediction.reset();
        interpolation.reset();
        projectiles.reset();
      };

      activeConnection.addEventListener('joined', (joinedEvent) => {
        const detail = joinedEvent.detail;

        resetSessionState();
        myPlayerId = detail.player.id;
        myEntityId = detail.entityId ?? detail.player.entityId ?? null;
        roomId = detail.room.id;
        roomName = detail.room.name;
        roomPlayerCount = detail.room.players;
        sessionCodec = detail.codec;
        sessionNetSim = detail.netSim;

        if (detail.bounds) {
          world.bounds = {
            width: detail.bounds.width,
            height: detail.bounds.height,
          };
        }
      });

      activeConnection.addEventListener('roster', (rosterEvent) => {
        roomPlayerCount = rosterEvent.detail.players.length;
      });

      activeConnection.addEventListener('disconnected', () => {
        resetSessionState();
      });

      activeConnection.addEventListener('shutdown', () => {
        loop.stop();
        frameProfiler?.dispose();
        resetSessionState();
        netgraph?.setPendingCount(0);
      });

      activeConnection.addEventListener('status', (statusEvent) => {
        if (
          statusEvent.detail === 'Connecting...' ||
          statusEvent.detail.startsWith('Reconnecting')
        ) {
          resetSessionState();
        }
      });

      activeConnection.addEventListener('fireAck', (ackEvent) => {
        if (
          connection !== activeConnection ||
          !activeConnection.isJoined() ||
          myPlayerId === null
        ) {
          return;
        }

        projectiles.onFireAck(ackEvent.detail);
      });

      activeConnection.addEventListener('snapshot', (snapshotEvent) => {
        if (
          connection !== activeConnection ||
          !activeConnection.isJoined() ||
          myPlayerId === null
        ) {
          return;
        }

        const snapshot = snapshotEvent.detail;

        if (
          lastAppliedSnapshotTick !== null &&
          snapshot.tick <= lastAppliedSnapshotTick
        ) {
          return;
        }

        lastAppliedSnapshotTick = snapshot.tick;

        lastServerAckSeq = snapshot.lastProcessedSeq ?? lastServerAckSeq;
        interpolation.pushSnapshot(snapshot);
        world.applySnapshot(snapshot);
        respawnTimer = snapshot.respawnSeconds ?? null;

        projectiles.onSnapshot(snapshot, myPlayerId, myEntityId);

        const reconcileStart = frameProfiler?.isActive() ? performance.now() : 0;
        const reconciliation = prediction.reconcile(
          snapshot,
          myPlayerId,
          myEntityId,
          world,
        );
        if (frameProfiler?.isActive() && typeof performance.measure === 'function') {
          try {
            performance.measure('magic-arena:reconcile', {
              start: reconcileStart,
              end: performance.now(),
            });
          } catch {
            // Ignore measure errors in restricted environments.
          }
        }

        if (reconciliation) {
          myEntityId = reconciliation.entityId;
          netgraph?.recordReconciliation(reconciliation);
        }
      });

      const destroyChat = mountRoomChat(activeConnection);
      netgraph = mountNetgraph(activeConnection, {
        initialInterpolationDelayMs: interpolation.delayMs,
        onInterpolationDelayChange: (nextDelayMs) => {
          interpolation.setDelay(nextDelayMs);
        },
      });

      window.addEventListener(
        'beforeunload',
        () => {
          frameProfiler?.dispose();
          loop.stop();
          activeConnection.close();
          resetSessionState();
          netgraph?.destroy();
          destroyChat();
        },
        { once: true },
      );

      activeConnection.connect();

      loop.start();
    };

    lobby.addEventListener('joined', onJoined, {
      once: true,
    });

    // Показуємо лобі
    const destroyLobby = mountLobby(lobby, {
      onJoinGesture: () => {
        audio.unlock().catch((error: unknown) => {
          console.error('Audio unlock failed:', error);
        });
      },
    });
  },
}).catch((error: unknown) => {
  console.error('[Lab03] Fatal boot error:', error);
});

