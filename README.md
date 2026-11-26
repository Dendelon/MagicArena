# Magic Arena

[![CI](https://github.com/Dendelon/MagicArena/actions/workflows/typecheck.yml/badge.svg)](https://github.com/Dendelon/MagicArena/actions/workflows/typecheck.yml)
[![Release](https://github.com/Dendelon/MagicArena/actions/workflows/release.yml/badge.svg)](https://github.com/Dendelon/MagicArena/actions/workflows/release.yml)

**Magic Arena** — браузерна багатокористувацька 2D-гра реального часу, у якій гравець керує зачарованим літаючим мечем з інерцією, прискоренням, обертанням на 360°, wrap-around ареною, снарядами, перешкодами та мультиплеєрними кімнатами.

**Публічний production URL (HTTPS/WSS):** <https://magicarena-sha-eeb53ef.onrender.com/>

---

## Архітектура та технологічний стек

- **Клієнт (`client/`):** Vanilla TypeScript, HTML5 Canvas 2D, client-side prediction + server reconciliation, entity interpolation, object pools для локальних ефектів, Web Worker експериментальний декодер, PWA (Web App Manifest + multiplayer-safe Service Worker).
- **Сервер (`server/`):** Node.js 24 (native TypeScript execution), HTTP + WebSocket (`ws`), авторитетна симуляція 30 Hz (`MatchManager` / `Match`), persistent та динамічні кімнати (`RoomManager`), Zod-валідація конфігурації та повідомлень, Pino structured JSON logging, `/health`, `/ready`, `/metrics`, graceful shutdown.
- **Спільний пакет (`shared/`):** детермінований `World`, фізика меча та зіткнень, `ObjectPool` / `BulletPool` / `ParticlePool`, бінарний та JSON кодеки, схеми протоколу.
- **Якість, інфраструктура та доставка:** TypeScript strict mode (`0` explicit `any`), type-aware ESLint, Vitest + v8 coverage + fast-check property tests, Playwright E2E, multi-stage Docker (`122.81 MB`), GitHub Actions CI & GHCR Release workflow, Render blueprint.

```text
client/
  public/                         # PWA manifest, Service Worker (sw.js), іконки, спрайти, аудіо
  src/
    assets/                       # завантаження ресурсів
    audio/                        # Web Audio API
    e2e/                          # render probe для E2E
    lobby/                        # лобі вибору кімнати та імені
    network/                      # WebSocket, prediction, reconciliation, interpolation, chat, netgraph
    performance/                  # FrameProfiler, DecodeProfiler
    render/                       # Canvas 2D рендерер
    pwa.ts                        # реєстрація Service Worker у production
    main.ts                       # точка входу клієнта
  test/                           # unit, resilience, shutdown, profiler та PWA тести (Vitest + jsdom)
server/
  src/
    bots/                         # Bot, BotClient, BotManager
    game/                         # Match, MatchManager, tickLoop
    log/                          # Pino logger, match NDJSON log, RSS profiler
    network/                      # WebSocket origin check, rate limiter, IP tracker
    performance/                  # ServerProfiler, LoadProfiler, ServerMetrics, serverStats
    config.ts                     # Zod-схема змінних середовища
    lifecycle.ts                  # readiness, health payload, time-bounded graceful shutdown
    rooms.ts                      # Room, RoomManager (persistent і тимчасові кімнати)
    ws.ts                         # WebSocket транспорт і обробка протоколу
    index.ts                      # HTTP-сервер, static serving, /health, /ready, /metrics, /api/*
  scripts/                        # load-test runner та утиліти профілювання
  test/                           # інтеграційні, security, chaos, metrics та lifecycle тести
shared/
  src/                            # симуляція, сутності, пули, протокол, JSON/Binary кодеки
  test/                           # unit, determinism, pooling та fast-check property тести
e2e/                              # Playwright тести (multiplayer, resilience, PWA, worker decoder)
.github/workflows/                # typecheck.yml (CI) та release.yml (GHCR release на v*)
Dockerfile                        # 3-stage Docker build (<200 MB)
render.yaml                       # Render Blueprint для GHCR deployment
```

---

## Локальний запуск

Вимоги: **Node.js 24** та **npm**. Команди виконуються з кореня репозиторію:

```powershell
npm ci
if (!(Test-Path server/.env)) { Copy-Item server/.env.example server/.env }
npx playwright install chromium
```

### Режим розробки
Перший термінал (сервер на `127.0.0.1:3000`):
```powershell
npm run dev:server
```
Другий термінал (Vite dev server на `http://localhost:5173` із проксі `/api` та `/ws`):
```powershell
npm run dev:client
```

### Локальний production-режим
```powershell
npm run build
node --env-file=server/.env server/src/index.ts
```

### Керування в грі
| Клавіша | Дія |
|---|---|
| `W` | Прискорення вперед |
| `S` | Гальмування |
| `A` / `D` | Обертання ліворуч / праворуч |
| `Space` | Звичайний постріл |
| `H` | Самонавідний постріл |

На старті сервер створює постійні публічні кімнати `arcane` (**Arcane Ruins**) і `training` (**Training Grounds**), які залишаються доступними в лобі навіть після виходу всіх гравців.

---

## Конфігурація та змінні середовища

Валідація виконується через `EnvSchema` ([server/src/config.ts](server/src/config.ts)) із використанням Zod:

| Змінна | За замовчуванням | Опис |
|---|---|---|
| `NODE_ENV` | `development` | Режим роботи (`production` вимагає явного `ALLOWED_ORIGINS`) |
| `HOST` | `127.0.0.1` | Хост прослуховування (`0.0.0.0` у Docker/production) |
| `PORT` | `3000` | HTTP/WS порт (`1..65535`) |
| `LOG_DIR` | `server/logs` | Директорія логів матчів |
| `LOG_LEVEL` | `info` | Рівень Pino (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) |
| `ALLOWED_ORIGINS` | локальні dev URLs | Через кому список дозволених `http://` / `https://` Origin для WebSocket handshake (обов'язковий при `NODE_ENV=production`) |
| `ALLOW_MISSING_ORIGIN` | `1` у dev, `0` у prod | Дозвіл WS-з'єднань без заголовка `Origin` (`0` або `1`) |
| `MAX_CONNECTIONS_PER_IP` | `10` | Максимум одночасних WS-підключень з одного IP (`1..1000`) |
| `MAX_ROOMS` | `20` | Максимум активних кімнат (`1..500`) |
| `MAX_PLAYERS_PER_ROOM` | `4` | Ліміт гравців у стандартній кімнаті (`1..64`) |
| `MAX_TOTAL_PLAYERS` | `80` | Глобальний ліміт гравців на сервері (`1..2000`) |
| `GIT_SHA` | `null` | Git commit SHA збірки (передається через Docker `--build-arg`) |
| `BUILD_ID` | `null` | Ідентифікатор збірки / CI run |
| `NET_CODEC` | `binary` | Формат snapshot-ів (`binary` або `json`) |
| `NET_DELAY_MS` / `NET_JITTER_MS` / `NET_DROP_RATE` | `0` / `0` / `0` | Симуляція мережевої затримки, джитеру та втрати пакетів |
| `ENABLE_BOTS` / `ENABLE_PROFILE` / `ENABLE_LOAD_TEST` | `0` | Локальні діагностичні режими (кожний вимагає `HOST=127.0.0.1`) |

---

## Production Lifecycle, Observability та Security

### Lifecycle і Graceful Shutdown
- Обробка `SIGTERM` / `SIGINT` через ідемпотентний `createServerLifecycle` ([server/src/lifecycle.ts](server/src/lifecycle.ts)) із жорстким дедлайном завершення `8000` мс.
- Під час shutdown: `readiness` переходить у `false`, нові підключення відхиляються, клієнтам надсилається повідомлення `{ "v": 1, "type": "shutdown", "reason": "Server is shutting down" }`, сокети закриваються з кодом `1001`, зупиняються `BotManager` / профайлери, закриваються HTTP-з'єднання та скидаються логи (`flush`).
- `GET /health` повертає `status: "ok"`, `version`, `gitSha`, `buildId`.
- `GET /ready` повертає `200` (`ready`) після старту (у production додатково перевіряє наявність `client/dist/index.html`) і `503` (`not-ready`) під час завершення.

### Observability
- `GET /metrics`: активні гравці та кімнати, message/byte rates, частота та тривалість тіків (`ServerMetrics`), event loop utilization і delay (`monitorEventLoopDelay`), пам'ять (`rssBytes`, `heapTotalBytes`, `heapUsedBytes`), метадані рантайму (`nodeVersion`, `nodeEnv`, `gitSha`, `buildId`).
- Структуровані JSON-логи (Pino): lifecycle-події сервера, створення/закриття кімнат, підключення/відключення гравців, помилки та події безпеки.

### Security та Resilience
- Валідація `Origin` під час WebSocket upgrade: недозволені або відсутні (при `ALLOW_MISSING_ORIGIN=0`) Origin відхиляються зі статусом **HTTP 403** до створення стану гравця.
- Підтримка IPv4, IPv6 та IPv4-mapped IPv6 (`::ffff:`), ігнорування недовірених `X-Forwarded-*` заголовків, очищення IP-лічильників при закритті та помилках сокета.
- Token-bucket rate limiting для команд і чату, обмеження розміру/схеми повідомлень (`Zod`), розрив з'єднання при invalid/flood-трафіку.
- Chaos-тести (`server/test/chaos.test.ts`, `client/test/chaos-resilience.test.ts`): підтверджено відновлення після обривів, відсутність нескінченного reconnect-циклу при серверному `shutdown` (код `1001`), а також ізоляцію флуду ~1000/s пошкоджених фреймів (атакуючі клієнти відключаються без деградації тіків іншої кімнати).

---

## PWA

- Маніфест [client/public/manifest.webmanifest](client/public/manifest.webmanifest) (`display: "standalone"`, `start_url: "/"`, тема `#0b0d17`, іконки `192×192`, `512×512` `any` та `512×512` `maskable`).
- Сервер віддає `.webmanifest` із `Content-Type: application/manifest+json; charset=utf-8` та `Cache-Control: no-cache`, а `/sw.js` із `Cache-Control: no-cache`.
- Service Worker [client/public/sw.js](client/public/sw.js) реєструється в production-збірці (`client/src/pwa.ts`), прекешує оболонку застосунку, використовує `network-first` для HTML-навігацій і **повністю обходить** `/ws`, `/api/*`, `/health`, `/ready`, `/metrics`, не-`GET` та cross-origin запити, не впливаючи на WebSocket-мультиплеєр.

---

## Docker та Deployment

### Docker
[Dockerfile](Dockerfile) реалізує 3-етапну збірку:
1. `builder` (`node:24-alpine`): встановлює всі залежності й збирає клієнт (`npm run build -w client`).
2. `prod-deps` (`node:24-alpine`): встановлює лише production-залежності (`npm ci --omit=dev --ignore-scripts`).
3. `runtime` (`alpine:3.24`): встановлює пакет `nodejs` (`v24.22.3`), створює non-root користувача `node`, копіює production `node_modules`, `shared/src`, `server/src`, `client/dist`, налаштовує `HEALTHCHECK` на `/health` та запускає сервер напряму через `CMD ["node", "server/src/index.ts"]` (для прямої доставки `SIGTERM` у PID 1).

Локально перевірений розмір фінального образу: **`122,812,277` байтів (`122.81 MB`)** — значно менше обмеження `< 200 MB`.

```powershell
docker build --build-arg GIT_SHA=local --build-arg BUILD_ID=local -t magicarena:prod .
docker run --rm -p 3000:3000 -e ALLOWED_ORIGINS=http://localhost:3000 magicarena:prod
```

### CI/CD та Hosting
- **CI** ([.github/workflows/typecheck.yml](.github/workflows/typecheck.yml)): запускається на `push` та `pull_request` (`typecheck`, `audit:types`, `lint`, `test:coverage`, `build`, `test:e2e`).
- **Release** ([.github/workflows/release.yml](.github/workflows/release.yml)): запускається на тегах `v*`, проганяє перевірки якості, збирає образ із `GIT_SHA=${{ github.sha }}`, перевіряє розмір `< 200 MB` і відповідь `/health`, публікує у **GHCR** (`ghcr.io/dendelon/magicarena`) та за наявності `RENDER_DEPLOY_HOOK_URL` ініціює деплой на Render ([render.yaml](render.yaml)).

---

## Тестування та перевірки

```powershell
npm run typecheck       # tsc --noEmit для кореня та всіх workspaces
npm run lint            # ESLint (recommendedTypeChecked)
npm run audit:types     # контроль відсутності any
npm run test:coverage   # Vitest + v8 coverage + fast-check
npm run build           # production-збірка клієнта (Vite)
npm run test:e2e        # Playwright E2E (multiplayer, resilience, PWA)
npm run test:e2e:worker # Playwright E2E для Worker-декодера
```

Фактичні результати прогону перед фіналізацією:
- **Unit / Integration / Property tests:** **40 файлів, 267 тестів** пройдено (включно з 10 `fast-check` property-тестами).
- **Покриття `shared`:** Statements **92.67%**, Branches **85.32%**, Functions **90.38%**, Lines **93.48%** (поріг 85%).
- **TypeScript audit:** **97 файлів**, `0` explicit `any`, `0` non-null assertions.
- **Playwright E2E:** Main mode — **3 passed** (`multiplayer`, `pwa`, `resilience`), Worker mode — **1 passed**.

---

## Матеріали дослідження продуктивності (ЛР №7)

Попередні вимірювання V8, GC, Web Worker та навантажувальних тестів збережено в [`docs/lab07/`](docs/lab07/):
- Object pool reuse у вимірюваному прогоні: **99.83%** (21 725 повторних використань із 21 763 acquire).
- **Worker-експеримент:** залишено `main` режим за замовчуванням (`no-go` для Worker як default, оскільки main-thread work у досліді зріс на 21.03% через messaging/clone overhead) — деталі у [`docs/lab07/worker/README.md`](docs/lab07/worker/README.md).
- **Load testing:** у локальному стенді сервер стабільно витримав **32 одночасні клієнти** в межах 33 ms бюджету (p99 `30.54` мс, ~30 Hz), а при **64** та **128** клієнтах перейшов у перевантаження — деталі у [`docs/lab07/load/summary.json`](docs/lab07/load/summary.json).
