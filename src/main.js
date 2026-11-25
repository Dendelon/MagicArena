import './style.css';
import { createCanvas } from './render/canvas';
import { createHoming } from './sim/behaviors/homing.js';
import { createHealingEffect } from './sim/behaviors/healing.js';
import { createGameAudio } from './audio/audio.js';
import { drawBackground } from './render/background';
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
import { Vector2 } from './sim/vector.js';
import { Sword } from './entities/Sword.js';
import { World } from './sim/world.js';
import { Obstacle } from './entities/Obstacle.js';
import { Pickup } from './entities/Pickup.js';
import { Lobby } from './lobby/Lobby.js';
import { mountLobby } from './lobby/view.js';

const canvas = document.querySelector('#game');
const { ctx, size } = createCanvas(canvas);

const input = createInput();

let sword = new Sword({
  pos: new Vector2(size.width / 2, size.height / 2),
});

const world = new World(size);

let loadedAssets = null;

world.spawn(sword);

let playerName = 'Mage';
let roomName = 'Arcane Ruins';

// Створюємо три рунічні камені
const obstacles = [
  new Obstacle({
    pos: new Vector2(size.width * 0.2, size.height * 0.3),
    vel: new Vector2(40, 25),
    radius: 28,
  }),

  new Obstacle({
    pos: new Vector2(size.width * 0.8, size.height * 0.65),
    vel: new Vector2(-35, 30),
    radius: 24,
  }),

  new Obstacle({
    pos: new Vector2(size.width * 0.7, size.height * 0.2),
    vel: new Vector2(-25, -40),
    radius: 32,
  }),
];

for (const obstacle of obstacles) {
  world.spawn(obstacle);
}

obstacles[0].homing = createHoming({
  targetKind: 'sword',
  turnRate: 2.4,
  speed: 70,
});

const healingPickup = new Pickup({
  pos: new Vector2(size.width * 0.5, size.height * 0.78),
  effect: createHealingEffect(1),
});

world.spawn(healingPickup);

let respawnTimer = null;

const findSafeSpawn = () => {
  const obstacles = [...world.ofKind('obstacle')];

  let bestPosition = new Vector2(size.width / 2, size.height / 2);

  let bestClearance = -Infinity;

  const padding = Math.min(60, size.width / 4, size.height / 4);

  for (let i = 0; i < 40; i++) {
    const pos = new Vector2(
      padding + Math.random() * (size.width - padding * 2),
      padding + Math.random() * (size.height - padding * 2),
    );

    const clearance =
      obstacles.length === 0
        ? Infinity
        : Math.min(
            ...obstacles.map(
              (obstacle) => pos.sub(obstacle.pos).length() - obstacle.radius - 22,
            ),
          );

    if (clearance > 55) return pos;

    if (clearance > bestClearance) {
      bestClearance = clearance;
      bestPosition = pos;
    }
  }

  return bestPosition;
};

const inputs = new Map();

let previousSword = {
  x: sword.pos.x,
  y: sword.pos.y,
  angle: sword.angle,
};

const interpolateWrapped = (from, to, alpha, size) => {
  if (size <= 0) return 0;

  let delta = to - from;

  if (delta > size / 2) delta -= size;
  if (delta < -size / 2) delta += size;

  const value = from + delta * alpha;

  return ((value % size) + size) % size;
};

const simulate = (dt) => {
  const controls = input.getState();
  const firePressed = input.justPressed('Space');
  const homingFirePressed = input.justPressed('KeyH');

  if (sword.alive) {
    previousSword = {
      x: sword.pos.x,
      y: sword.pos.y,
      angle: sword.angle,
    };

    inputs.set(sword.id, controls);
  }

  world.step(dt, inputs);

  if (sword.alive && firePressed) {
    sword.fire(world);
  }

  if (sword.alive && homingFirePressed) {
    const bullet = sword.fire(world);

    bullet.homing = createHoming({
      targetKind: 'obstacle',
      turnRate: 9,
    });

    bullet.ttl = 3;
  }

  // Обробка знищеного меча
  if (!sword.alive) {
    inputs.delete(sword.id);

    if (respawnTimer === null) {
      respawnTimer = 2;
    } else {
      respawnTimer = Math.max(0, respawnTimer - dt);
    }

    // Створення нового меча
    if (respawnTimer <= 0) {
      sword = new Sword({
        pos: findSafeSpawn(),
      });

      world.spawn(sword);

      previousSword = {
        x: sword.pos.x,
        y: sword.pos.y,
        angle: sword.angle,
      };

      respawnTimer = null;
    }
  }
};

const render = (alpha, stats) => {
  drawBackground(ctx, size.width, size.height);

  const sprites = loadedAssets?.sprites ?? {};
  const frame = Math.floor(performance.now() / 150) % 4;

  // Малювання рунічних каменів
  for (const obstacle of world.ofKind('obstacle')) {
    const x = obstacle.previousPos.x + (obstacle.pos.x - obstacle.previousPos.x) * alpha;

    const y = obstacle.previousPos.y + (obstacle.pos.y - obstacle.previousPos.y) * alpha;

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
    const bulletX = interpolateWrapped(
      bullet.previousPos.x,
      bullet.pos.x,
      alpha,
      size.width,
    );

    const bulletY = interpolateWrapped(
      bullet.previousPos.y,
      bullet.pos.y,
      alpha,
      size.height,
    );

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

  if (sword.alive) {
    const x = interpolateWrapped(previousSword.x, sword.pos.x, alpha, size.width);

    const y = interpolateWrapped(previousSword.y, sword.pos.y, alpha, size.height);

    const angle = previousSword.angle + (sword.angle - previousSword.angle) * alpha;

    if (input.getState().forward) {
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

  drawHud(ctx, {
    ...stats,
    hp: sword.hp,
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

      // Налаштовуємо кількість каменів
      const obstacleCount = Math.max(
        0,
        Math.min(obstacles.length, room.obstacleCount ?? obstacles.length),
      );

      for (const obstacle of obstacles.slice(obstacleCount)) {
        world.despawn(obstacle.id);
      }

      // Прибираємо лобі та запускаємо гру
      destroyLobby();
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
