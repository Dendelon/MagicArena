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

const INPUT_INTERVAL = 1 / 30;

const canvas = document.querySelector('#game');
const { ctx, size } = createCanvas(canvas);

const input = createInput();

const world = new World({ width: 0, height: 0 });

let loadedAssets = null;

let playerName = 'Mage';
let roomName = 'Arcane Ruins';

let connection = null;
let netgraph = null;
let myPlayerId = null;
let myEntityId = null;
let respawnTimer = null;

let inputSeq = 0;
let clientTick = 0;
let inputAccumulator = 0;
let pendingFire = false;
let pendingHomingFire = false;

const simulate = (dt) => {
  if (input.justPressed('Space')) {
    pendingFire = true;
  }

  if (input.justPressed('KeyH')) {
    pendingHomingFire = true;
  }

  if (!connection || myPlayerId === null) return;

  inputAccumulator += dt;

  if (inputAccumulator < INPUT_INTERVAL) return;

  inputAccumulator %= INPUT_INTERVAL;

  const controls = input.getState();
  const turn = Number(controls.right) - Number(controls.left);

  inputSeq += 1;
  clientTick += 1;

  const message = createInputMessage({
    seq: inputSeq,
    tick: clientTick,
    thrust: controls.forward,
    turn,
    brake: controls.brake,
    fire: pendingFire,
    homingFire: pendingHomingFire,
  });

  pendingFire = false;
  pendingHomingFire = false;

  netgraph?.trackInput(message.seq);
  connection.send(message);
};

const render = (_alpha, stats) => {
  drawOuterBackground(ctx, size.width, size.height);

  const sprites = loadedAssets?.sprites ?? {};
  const frame = Math.floor(performance.now() / 150) % 4;

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

    for (const bullet of world.ofKind('bullet')) {
      const bulletX = bullet.pos.x;
      const bulletY = bullet.pos.y;

      const isHoming = Boolean(bullet.homing);

      const bulletSprite = isHoming ? sprites.bulletHoming : sprites.bullet;

      ctx.save();

      ctx.shadowColor = isHoming ? '#22d3ee' : '#a855f7';
      ctx.shadowBlur = 10;

      const rendered = drawSheetSprite(ctx, bulletSprite, bulletX, bulletY, {
        frame,
        scale: (bullet.radius / 6) * 0.75,
      });

      ctx.restore();

      if (!rendered) {
        drawBullet(ctx, bulletX, bulletY, bullet.radius, isHoming);
      }
    }

    for (const sword of world.ofKind('sword')) {
      const x = sword.pos.x;
      const y = sword.pos.y;
      const angle = sword.angle;

      if (sword.input?.forward) {
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

    audio.subscribe(world);

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

      connection.addEventListener('joined', (joinedEvent) => {
        const detail = joinedEvent.detail;

        myPlayerId = detail.player?.id ?? null;
        myEntityId = detail.entityId ?? detail.player?.entityId ?? null;
        inputSeq = 0;
        clientTick = 0;
        inputAccumulator = 0;
        pendingFire = false;
        pendingHomingFire = false;

        if (detail.bounds) {
          world.bounds = {
            width: detail.bounds.width,
            height: detail.bounds.height,
          };
        }
      });

      connection.addEventListener('snapshot', (snapshotEvent) => {
        const snapshot = snapshotEvent.detail;

        world.applySnapshot(snapshot);
        respawnTimer = snapshot.respawnSeconds ?? null;

        for (const entity of world.ofKind('sword')) {
          if (entity.ownerId === myPlayerId) {
            myEntityId = entity.id;
            break;
          }
        }
      });

      const destroyChat = mountRoomChat(connection);
      netgraph = mountNetgraph(connection);

      window.addEventListener(
        'beforeunload',
        () => {
          loop.stop();
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
