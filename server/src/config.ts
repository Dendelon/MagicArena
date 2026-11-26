import { resolve } from 'node:path';
import { z } from 'zod';

import { CodecSchema } from '@magicarena/shared/protocol';
import { normalizeAllowedOrigin } from './network/origin.ts';

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

  GIT_SHA: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? '';
      return trimmed.length > 0 ? trimmed : null;
    }),

  BUILD_ID: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim() ?? '';
      return trimmed.length > 0 ? trimmed : null;
    }),

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

  ALLOWED_ORIGINS: z.string().optional(),

  ALLOW_MISSING_ORIGIN: z
    .string()
    .optional()
    .refine(
      (value) => value === undefined || value === '0' || value === '1',
      'ALLOW_MISSING_ORIGIN must be "0" or "1"',
    ),

  MAX_CONNECTIONS_PER_IP: envNumber(10, z.number().int().min(1).max(1000)),

  MAX_ROOMS: envNumber(20, z.number().int().min(1).max(500)),

  MAX_PLAYERS_PER_ROOM: envNumber(4, z.number().int().min(1).max(64)),

  MAX_TOTAL_PLAYERS: envNumber(80, z.number().int().min(1).max(2000)),

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
  )
  .transform((data, ctx) => {
    const isProduction = data.NODE_ENV === 'production';
    const rawOrigins = data.ALLOWED_ORIGINS?.trim() ?? '';

    let allowedOrigins: string[];
    if (rawOrigins.length === 0) {
      if (isProduction) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ALLOWED_ORIGINS'],
          message: 'ALLOWED_ORIGINS is required when NODE_ENV=production',
        });
        return z.NEVER;
      }

      allowedOrigins = [
        `http://127.0.0.1:${data.PORT}`,
        `http://localhost:${data.PORT}`,
        'http://127.0.0.1:5173',
        'http://localhost:5173',
      ];
    } else {
      const entries = rawOrigins.split(',');
      const normalized = new Set<string>();

      for (const entry of entries) {
        const origin = normalizeAllowedOrigin(entry);
        if (origin === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['ALLOWED_ORIGINS'],
            message: `Invalid ALLOWED_ORIGINS entry: "${entry.trim()}"`,
          });
          return z.NEVER;
        }
        normalized.add(origin);
      }

      allowedOrigins = [...normalized];
    }

    const allowMissingOrigin =
      data.ALLOW_MISSING_ORIGIN !== undefined
        ? data.ALLOW_MISSING_ORIGIN === '1'
        : !isProduction;

    return {
      ...data,
      ALLOWED_ORIGINS: allowedOrigins,
      ALLOW_MISSING_ORIGIN: allowMissingOrigin,
    };
  });

export const readConfig = (env: unknown) => {
  const data = EnvSchema.parse(env);

  return {
    nodeEnv: data.NODE_ENV,
    isProduction: data.NODE_ENV === 'production',
    gitSha: data.GIT_SHA,
    buildId: data.BUILD_ID,
    port: data.PORT,
    host: data.HOST,
    logDir: resolve(data.LOG_DIR),
    logLevel: data.LOG_LEVEL,

    allowedOrigins: data.ALLOWED_ORIGINS,
    allowMissingOrigin: data.ALLOW_MISSING_ORIGIN,
    maxConnectionsPerIp: data.MAX_CONNECTIONS_PER_IP,
    maxRooms: data.MAX_ROOMS,
    maxPlayersPerRoom: data.MAX_PLAYERS_PER_ROOM,
    maxTotalPlayers: data.MAX_TOTAL_PLAYERS,

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

