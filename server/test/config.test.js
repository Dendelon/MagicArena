import test from 'node:test';
import assert from 'node:assert/strict';

import { EnvSchema } from '../src/config.ts';

test('Environment defaults', () => {
  const result = EnvSchema.parse({});

  assert.equal(result.PORT, 3000);
  assert.equal(result.HOST, '127.0.0.1');
  assert.equal(result.NET_CODEC, 'binary');
  assert.equal(result.NET_DELAY_MS, 0);
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
  const invalid = [
    { PORT: '70000' },
    { NET_DELAY_MS: '-1' },
    { NET_JITTER_MS: '501' },
    { NET_DROP_RATE: '1.5' },
    { NET_CODEC: 'unknown' },
    { HOST: 'invalid host' },
  ];

  for (const env of invalid) {
    assert.equal(EnvSchema.safeParse(env).success, false);
  }
});

