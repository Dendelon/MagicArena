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
  ];

  for (const env of invalid) {
    assert.equal(EnvSchema.safeParse(env).success, false);
  }
});

test('Supports Docker production configuration while preserving loopback debug restrictions', () => {
  const prod = EnvSchema.parse({
    NODE_ENV: 'production',
    HOST: '0.0.0.0',
    PORT: '3000',
    LOG_LEVEL: '  WARN ',
  });

  assert.equal(prod.NODE_ENV, 'production');
  assert.equal(prod.HOST, '0.0.0.0');
  assert.equal(prod.PORT, 3000);
  assert.equal(prod.LOG_LEVEL, 'warn');

  for (const flag of [
    'ENABLE_BOTS',
    'ENABLE_PROFILE',
    'ENABLE_LOAD_TEST',
  ] as const) {
    const rejected = EnvSchema.safeParse({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      [flag]: '1',
    });
    assert.equal(rejected.success, false);
  }
});

