import { resolve } from 'node:path';
import { z } from 'zod';

import { CodecSchema } from '@magicarena/shared/protocol';

const envNumber = (defaultValue: number, schema: z.ZodNumber) =>
  z.preprocess((value) => {
    if (
      value === undefined ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      return defaultValue;
    }

    if (typeof value === 'string') {
      return Number(value.trim());
    }

    return value;
  }, schema);

const envText = (defaultValue: string) =>
  z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value.trim() || defaultValue
        : (value ?? defaultValue),
    z.string(),
  );

export const LogLevelSchema = z.enum([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

export type LogLevel = z.infer<typeof LogLevelSchema>;

export const EnvSchema = z.object({
  NODE_ENV: envText('development'),

  PORT: z.preprocess(
    (value) =>
      typeof value === 'string' ? Number(value) : (value ?? 3000),
    z.number().int().min(1).max(65535),
  ),

  HOST: envText('127.0.0.1').refine(
    (value) => value.length > 0 && !/[\s/\\]/.test(value),
    'Invalid HOST',
  ),

  LOG_DIR: envText('server/logs').refine(
    (value) => value.length > 0 && !value.includes('\0'),
    'Invalid LOG_DIR',
  ),

  LOG_LEVEL: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value.trim().toLowerCase() || 'info'
        : (value ?? 'info'),
    LogLevelSchema,
  ),

  NET_DELAY_MS: envNumber(0, z.number().min(0).max(1000)),

  NET_JITTER_MS: envNumber(0, z.number().min(0).max(500)),

  NET_DROP_RATE: envNumber(0, z.number().min(0).max(1)),

  NET_CODEC: z.preprocess(
    (value) =>
      typeof value === 'string'
        ? value.trim().toLowerCase() || 'binary'
        : (value ?? 'binary'),
    CodecSchema,
  ),

  RSS_PROFILE: z
    .string()
    .optional()
    .transform((value) => value === '1'),

  ENABLE_SLOW_DEMO: z
    .string()
    .optional()
    .transform((value) => value === '1'),

  ENABLE_BOTS: z
    .string()
    .optional()
    .transform((value) => value === '1'),

  ENABLE_PROFILE: z
    .string()
    .optional()
    .transform((value) => value === '1'),

  ENABLE_LOAD_TEST: z
    .string()
    .optional()
    .transform((value) => value === '1'),
})
  .refine(
    (data) => !data.ENABLE_BOTS || data.HOST === '127.0.0.1',
    {
      message: 'ENABLE_BOTS=1 requires HOST=127.0.0.1',
      path: ['ENABLE_BOTS'],
    },
  )
  .refine(
    (data) => !data.ENABLE_PROFILE || data.HOST === '127.0.0.1',
    {
      message: 'ENABLE_PROFILE=1 requires HOST=127.0.0.1',
      path: ['ENABLE_PROFILE'],
    },
  )
  .refine(
    (data) => !data.ENABLE_LOAD_TEST || data.HOST === '127.0.0.1',
    {
      message: 'ENABLE_LOAD_TEST=1 requires HOST=127.0.0.1',
      path: ['ENABLE_LOAD_TEST'],
    },
  );

export const readConfig = (env: unknown) => {
  const data = EnvSchema.parse(env);

  return {
    nodeEnv: data.NODE_ENV,
    isProduction: data.NODE_ENV === 'production',
    port: data.PORT,
    host: data.HOST,
    logDir: resolve(data.LOG_DIR),
    logLevel: data.LOG_LEVEL,

    netDelayMs: data.NET_DELAY_MS,
    netJitterMs: data.NET_JITTER_MS,
    netDropRate: data.NET_DROP_RATE,

    netCodec: data.NET_CODEC,

    rssProfile: data.RSS_PROFILE,
    enableSlowDemo: data.ENABLE_SLOW_DEMO,
    enableBots: data.ENABLE_BOTS,
    enableProfile: data.ENABLE_PROFILE,
    enableLoadTest: data.ENABLE_LOAD_TEST,
  };
};

export type ServerConfig = ReturnType<typeof readConfig>;

export const config = readConfig(process.env);

