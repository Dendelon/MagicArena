import { test } from 'vitest';
import assert from 'node:assert/strict';

import { EnvSchema } from '../src/config.ts';

test('Environment defaults', () => {
  const result = EnvSchema.parse({});

  assert.equal(result.PORT, 3000);
  assert.equal(result.HOST, '127.0.0.1');
  assert.equal(result.NODE_ENV, 'development');
  assert.equal(result.LOG_LEVEL, 'info');
  assert.equal(result.NET_CODEC, 'binary');
  assert.equal(result.NET_DELAY_MS, 0);
  assert.equal(result.ENABLE_BOTS, false);
  assert.equal(result.ENABLE_PROFILE, false);
  assert.equal(result.ENABLE_LOAD_TEST, false);
  assert.equal(result.ALLOW_MISSING_ORIGIN, true);
  assert.equal(result.MAX_CONNECTIONS_PER_IP, 10);
  assert.equal(result.MAX_ROOMS, 20);
  assert.equal(result.MAX_PLAYERS_PER_ROOM, 4);
  assert.equal(result.MAX_TOTAL_PLAYERS, 80);
  assert.deepEqual(result.ALLOWED_ORIGINS, [
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]);
});

test('ENABLE_BOTS accepts loopback host and rejects non-loopback host', () => {
  const enabled = EnvSchema.parse({
    HOST: '127.0.0.1',
    ENABLE_BOTS: '1',
  });

  assert.equal(enabled.ENABLE_BOTS, true);

  const rejected = EnvSchema.safeParse({
    HOST: '0.0.0.0',
    ENABLE_BOTS: '1',
  });

  assert.equal(rejected.success, false);
});

test('ENABLE_PROFILE accepts loopback host and rejects non-loopback host', () => {
  const enabled = EnvSchema.parse({
    HOST: '127.0.0.1',
    ENABLE_PROFILE: '1',
  });

  assert.equal(enabled.ENABLE_PROFILE, true);

  const rejected = EnvSchema.safeParse({
    HOST: '0.0.0.0',
    ENABLE_PROFILE: '1',
  });

  assert.equal(rejected.success, false);
});

test('ENABLE_LOAD_TEST accepts loopback host and rejects non-loopback host', () => {
  const enabled = EnvSchema.parse({
    HOST: '127.0.0.1',
    ENABLE_LOAD_TEST: '1',
  });

  assert.equal(enabled.ENABLE_LOAD_TEST, true);

  const rejected = EnvSchema.safeParse({
    HOST: '0.0.0.0',
    ENABLE_LOAD_TEST: '1',
  });

  assert.equal(rejected.success, false);
});

test('Parse valid network configuration', () => {
  const result = EnvSchema.parse({
    PORT: '3000',
    NET_DELAY_MS: '100',
    NET_JITTER_MS: '30',
    NET_DROP_RATE: '0.02',
    NET_CODEC: 'binary',
  });

  assert.equal(result.NET_DELAY_MS, 100);
  assert.equal(result.NET_JITTER_MS, 30);
  assert.equal(result.NET_DROP_RATE, 0.02);
});

test('Reject invalid environment values', () => {
  const invalid: unknown[] = [
    { PORT: '70000' },
    { NET_DELAY_MS: '-1' },
    { NET_JITTER_MS: '501' },
    { NET_DROP_RATE: '1.5' },
    { NET_CODEC: 'unknown' },
    { LOG_LEVEL: 'verbose' },
    { HOST: 'invalid host' },
    { ALLOWED_ORIGINS: '*' },
    { ALLOWED_ORIGINS: 'https://arena.example.com/path' },
    { ALLOWED_ORIGINS: 'https://arena.example.com/' },
    { ALLOWED_ORIGINS: 'ws://arena.example.com' },
    { ALLOW_MISSING_ORIGIN: 'yes' },
    { MAX_CONNECTIONS_PER_IP: '0' },
    { MAX_CONNECTIONS_PER_IP: '1001' },
    { MAX_ROOMS: '0' },
    { MAX_ROOMS: '501' },
    { MAX_PLAYERS_PER_ROOM: '0' },
    { MAX_PLAYERS_PER_ROOM: '65' },
    { MAX_TOTAL_PLAYERS: '0' },
    { MAX_TOTAL_PLAYERS: '2001' },
  ];

  for (const env of invalid) {
    assert.equal(EnvSchema.safeParse(env).success, false);
  }
});

test('Supports Docker production configuration while preserving loopback debug restrictions', () => {
  const missingProdOrigins = EnvSchema.safeParse({
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '3000',
  });
  assert.equal(missingProdOrigins.success, false);

  const prod = EnvSchema.parse({
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '3000',
    LOG_LEVEL: '  WARN ',
    ALLOWED_ORIGINS: 'https://arena.example.com, http://localhost:8080',
  });

  assert.equal(prod.NODE_ENV, 'production');
  assert.equal(prod.HOST, '0.0.0.0');
  assert.equal(prod.PORT, 3000);
  assert.equal(prod.LOG_LEVEL, 'warn');
  assert.equal(prod.ALLOW_MISSING_ORIGIN, false);
  assert.deepEqual(prod.ALLOWED_ORIGINS, [
    'https://arena.example.com',
    'http://localhost:8080',
  ]);
  assert.equal(prod.GIT_SHA, null);
  assert.equal(prod.BUILD_ID, null);

  const withMetadata = EnvSchema.parse({
    GIT_SHA: '  abc1234def5678  ',
    BUILD_ID: ' build-42 ',
  });
  assert.equal(withMetadata.GIT_SHA, 'abc1234def5678');
  assert.equal(withMetadata.BUILD_ID, 'build-42');

  for (const flag of [
    'ENABLE_BOTS',
    'ENABLE_PROFILE',
    'ENABLE_LOAD_TEST',
  ] as const) {
    const rejected = EnvSchema.safeParse({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      ALLOWED_ORIGINS: 'https://arena.example.com',
      [flag]: '1',
    });
    assert.equal(rejected.success, false);
  }
});

