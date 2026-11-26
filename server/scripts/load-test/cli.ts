import os from 'node:os';

export interface LoadTestCliConfig {
  readonly clients: readonly number[];
  readonly warmupMs: number;
  readonly durationMs: number;
  readonly seed: number;
  readonly port: number;
  readonly help: boolean;
}

export interface SystemEnvironmentInfo {
  readonly platform: string;
  readonly release: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly cpuModel: string;
  readonly cpuCores: number;
  readonly totalMemoryMiB: number;
}

const DEFAULT_CLIENTS: readonly number[] = [8, 32, 64, 128];
const DEFAULT_WARMUP_MS = 15_000;
const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_SEED = 1337;
const DEFAULT_PORT = 3200;
const MAX_CLIENTS = 128;

const parsePositiveInt = (raw: string, flagName: string, min: number, max?: number): number => {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid integer for ${flagName}: "${raw}"`);
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    const rangeDesc = max === undefined ? `>= ${min}` : `${min}..${max}`;
    throw new Error(`Out-of-range value for ${flagName}: ${raw} (expected ${rangeDesc})`);
  }

  return parsed;
};

const parseClientList = (raw: string): readonly number[] => {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    throw new Error('Expected at least one client count in --clients');
  }

  const values: number[] = [];
  const seen = new Set<number>();

  for (const part of parts) {
    const count = parsePositiveInt(part, '--clients', 1, MAX_CLIENTS);
    if (seen.has(count)) {
      throw new Error(`Duplicate client count in --clients: ${count}`);
    }
    seen.add(count);
    values.push(count);
  }

  return values;
};

const readFlagValue = (args: readonly string[], index: number, flag: string): { value: string; nextIndex: number } => {
  const current = args[index] ?? '';
  const eqIndex = current.indexOf('=');
  if (eqIndex !== -1) {
    return {
      value: current.slice(eqIndex + 1),
      nextIndex: index,
    };
  }

  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }

  return {
    value: next,
    nextIndex: index + 1,
  };
};

/**
 * Parses and validates CLI flags for the M4.3 automated server load test runner.
 */
export const parseLoadTestCli = (argv: readonly string[]): LoadTestCliConfig => {
  let clients: readonly number[] = DEFAULT_CLIENTS;
  let warmupMs = DEFAULT_WARMUP_MS;
  let durationMs = DEFAULT_DURATION_MS;
  let seed = DEFAULT_SEED;
  let port = DEFAULT_PORT;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);

    switch (flag) {
      case '--clients': {
        const { value, nextIndex } = readFlagValue(argv, i, flag);
        clients = parseClientList(value);
        i = nextIndex;
        break;
      }
      case '--warmup-ms': {
        const { value, nextIndex } = readFlagValue(argv, i, flag);
        warmupMs = parsePositiveInt(value, flag, 0);
        i = nextIndex;
        break;
      }
      case '--duration-ms': {
        const { value, nextIndex } = readFlagValue(argv, i, flag);
        durationMs = parsePositiveInt(value, flag, 1000, 600_000);
        i = nextIndex;
        break;
      }
      case '--seed': {
        const { value, nextIndex } = readFlagValue(argv, i, flag);
        seed = parsePositiveInt(value, flag, 0);
        i = nextIndex;
        break;
      }
      case '--port': {
        const { value, nextIndex } = readFlagValue(argv, i, flag);
        port = parsePositiveInt(value, flag, 1, 65_535);
        i = nextIndex;
        break;
      }
      default:
        throw new Error(`Unknown CLI flag: ${arg}`);
    }
  }

  return {
    clients,
    warmupMs,
    durationMs,
    seed,
    port,
    help,
  };
};

/**
 * Returns formatted CLI usage instructions for the load test script.
 */
export const formatLoadTestUsage = (): string =>
  [
    'Usage: npm run test:load -- [options]',
    '',
    'Options:',
    '  --clients=8,32,64,128   Comma-separated client counts (1..128)',
    '  --warmup-ms=15000       Warmup duration in ms (>= 0)',
    '  --duration-ms=60000     Measured duration in ms (1000..600000)',
    '  --seed=1337             Base deterministic PRNG seed (>= 0)',
    '  --port=3200             Starting loopback HTTP/WS port (1..65535)',
    '  --help, -h              Show this help message',
  ].join('\n');

/**
 * Collects hardware and runtime metadata for reproducible load-test reports.
 */
export const collectSystemEnvironment = (): SystemEnvironmentInfo => {
  const cpuList = os.cpus();
  const cpuModel = cpuList[0]?.model.trim() || 'unknown';
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    nodeVersion: process.version,
    cpuModel,
    cpuCores: cpuList.length,
    totalMemoryMiB: Math.round((os.totalmem() / (1024 * 1024)) * 100) / 100,
  };
};

