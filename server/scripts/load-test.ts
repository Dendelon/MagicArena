import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  computeEluMetrics,
  type LoadTestResult,
  type LoadTestState,
} from '../src/performance/LoadProfiler.ts';
import {
  analyzeCapacity,
  type CapacityAnalysis,
  type ScenarioClientSummary,
  type ScenarioReport,
  type SummaryReport,
} from './load-test/capacity.ts';
import {
  collectSystemEnvironment,
  formatLoadTestUsage,
  parseLoadTestCli,
  type LoadTestCliConfig,
  type SystemEnvironmentInfo,
} from './load-test/cli.ts';
import { HeadlessClient } from './load-test/HeadlessClient.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const SERVER_ENTRY = path.resolve(REPO_ROOT, 'server/src/index.ts');
const LOAD_OUTPUT_DIR = path.resolve(REPO_ROOT, 'docs/lab07/load');
const LOAD_LOG_DIR = path.resolve(REPO_ROOT, 'server/logs/load-test');
const LOAD_TEST_ROOM_ID = 'load-test';

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_INTERVAL_MS = 100;
const CONNECT_BATCH_SIZE = 16;
const SAMPLE_POLL_INTERVAL_MS = 250;
const RESULT_WAIT_TIMEOUT_MS = 15_000;
const CHILD_SHUTDOWN_TIMEOUT_MS = 4000;

export interface ScenarioRunnerConfig {
  readonly clientCount: number;
  readonly port: number;
  readonly warmupMs: number;
  readonly durationMs: number;
  readonly seed: number;
  readonly environment: SystemEnvironmentInfo;
}

export interface LoadTestTableRow {
  readonly Clients: number;
  readonly Joined: string;
  readonly 'Tick p99 (ms)': string;
  readonly 'Tick rate (Hz)': string;
  readonly 'Over 33 ms': string;
  readonly 'ELU (%)': string;
  readonly 'Peak RSS (MiB)': string;
  readonly 'RX (KiB/s)': string;
  readonly 'TX (KiB/s)': string;
  readonly Disconnects: number;
  readonly Valid: string;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const formatOptionalNumber = (value: number | null | undefined, decimals: number): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'n/a';
  }
  return roundTo(value, decimals).toFixed(decimals);
};

/**
 * Formats one scenario report into the console summary table schema.
 */
export const formatSummaryTableRow = (report: ScenarioReport): LoadTestTableRow => {
  const server = report.server;
  const peakRssMiB =
    server !== null ? server.memory.rssPeakBytes / (1024 * 1024) : null;
  const rxKiBs =
    server !== null ? server.network.receivedBytesPerSecond / 1024 : null;
  const txKiBs =
    server !== null ? server.network.sentBytesPerSecond / 1024 : null;
  const over33Text =
    server !== null
      ? `${server.ticksOver33Ms} (${(server.over33MsShare * 100).toFixed(2)}%)`
      : 'n/a';

  return {
    Clients: report.requestedClients,
    Joined: `${report.clients.joinedClients}/${report.requestedClients}`,
    'Tick p99 (ms)': formatOptionalNumber(server?.tickMs?.p99, 3),
    'Tick rate (Hz)': formatOptionalNumber(server?.actualTickRateHz, 2),
    'Over 33 ms': over33Text,
    'ELU (%)': formatOptionalNumber(server?.elu.utilizationPercent, 1),
    'Peak RSS (MiB)': formatOptionalNumber(peakRssMiB, 1),
    'RX (KiB/s)': formatOptionalNumber(rxKiBs, 1),
    'TX (KiB/s)': formatOptionalNumber(txKiBs, 1),
    Disconnects: report.clients.disconnects,
    Valid: report.valid ? 'yes' : 'no',
  };
};

const buildServerEnv = (port: number): NodeJS.ProcessEnv => ({
  ...process.env,
  HOST: '127.0.0.1',
  PORT: String(port),
  NET_CODEC: 'binary',
  NET_DELAY_MS: '0',
  NET_JITTER_MS: '0',
  NET_DROP_RATE: '0',
  ENABLE_LOAD_TEST: '1',
  ENABLE_BOTS: '0',
  ENABLE_PROFILE: '0',
  RSS_PROFILE: '0',
  ENABLE_SLOW_DEMO: '0',
  LOG_DIR: LOAD_LOG_DIR,
});

export interface LoadTestServerProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stderr: EventEmitter | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: () => void): unknown;
  off(event: 'exit', listener: () => void): unknown;
}

export const spawnLoadTestServer = (
  port: number,
  envOverrides?: NodeJS.ProcessEnv,
): LoadTestServerProcess =>
  spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: envOverrides ?? buildServerEnv(port),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

export const terminateChildProcess = async (child: LoadTestServerProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer !== null) {
        clearTimeout(killTimer);
      }
      child.off('exit', finish);
      resolve();
    };

    child.once('exit', finish);
    child.kill('SIGTERM');

    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      setTimeout(finish, 500);
    }, CHILD_SHUTDOWN_TIMEOUT_MS);
  });
};

const waitForServerReady = async (
  baseUrl: string,
  child: LoadTestServerProcess,
  stderrChunks: string[],
  fetchFn: typeof fetch,
): Promise<void> => {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const stderrText = stderrChunks.join('').trim();
      throw new Error(
        `Server exited prematurely (code=${String(child.exitCode)}, signal=${String(child.signalCode)})${stderrText.length > 0 ? `: ${stderrText}` : ''}`,
      );
    }

    try {
      const response = await fetchFn(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server still booting; continue polling until timeout.
    }

    await delay(HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for load-test server health check at ${baseUrl}/health`);
};

const summarizeClients = (
  clients: readonly HeadlessClient[],
  requestedClients: number,
  minConnectedClients: number,
): ScenarioClientSummary => {
  let joinedClients = 0;
  let disconnects = 0;
  let decodeErrors = 0;
  let clientErrors = 0;
  let inputsSent = 0;
  let snapshotsReceived = 0;

  for (const client of clients) {
    const stats = client.getStats();
    if (stats.joined) {
      joinedClients += 1;
    }
    disconnects += stats.disconnects;
    decodeErrors += stats.decodeErrors;
    clientErrors += stats.clientErrors;
    inputsSent += stats.inputsSent;
    snapshotsReceived += stats.snapshotsReceived;
  }

  return {
    requestedClients,
    joinedClients,
    minConnectedClients,
    disconnects,
    decodeErrors,
    clientErrors,
    inputsSent,
    snapshotsReceived,
  };
};

const countConnectedClients = (clients: readonly HeadlessClient[]): number => {
  let connected = 0;
  for (const client of clients) {
    if (client.getStats().connected) {
      connected += 1;
    }
  }
  return connected;
};

export interface ScenarioDependencies {
  readonly spawnServer?: (port: number) => LoadTestServerProcess;
  readonly createClient?: (options: {
    readonly url: string;
    readonly roomId: string;
    readonly name: string;
    readonly seed: number;
    readonly clientIndex: number;
  }) => HeadlessClient;
  readonly fetchFn?: typeof fetch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isLoadTestState = (value: unknown): value is LoadTestState => {
  if (!isRecord(value) || typeof value.status !== 'string') {
    return false;
  }
  if (value.status === 'idle') {
    return true;
  }
  if (value.status === 'running') {
    return (
      typeof value.durationMs === 'number' &&
      typeof value.expectedClients === 'number' &&
      typeof value.elapsedMs === 'number'
    );
  }
  if (value.status === 'completed') {
    return isRecord(value.result);
  }
  return false;
};

const fetchLoadTestResult = async (
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<LoadTestState> => {
  const response = await fetchFn(`${baseUrl}/api/load-test/result`);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GET /api/load-test/result failed (${response.status}): ${body}`);
  }
  const json: unknown = await response.json();
  if (!isLoadTestState(json)) {
    throw new Error('GET /api/load-test/result returned an invalid payload shape');
  }
  return json;
};

const startServerLoadProfile = async (
  baseUrl: string,
  durationMs: number,
  expectedClients: number,
  fetchFn: typeof fetch,
): Promise<void> => {
  const response = await fetchFn(`${baseUrl}/api/load-test/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ durationMs, expectedClients }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`POST /api/load-test/start failed (${response.status}): ${body}`);
  }
};

const connectClientBatches = async (
  clients: readonly HeadlessClient[],
  child: LoadTestServerProcess,
): Promise<void> => {
  for (let start = 0; start < clients.length; start += CONNECT_BATCH_SIZE) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Server exited while connecting load-test clients');
    }
    const batch = clients.slice(start, start + CONNECT_BATCH_SIZE);
    await Promise.all(batch.map((client) => client.connect()));
  }
};

const waitWithDisconnectCheck = async (
  durationMs: number,
  clients: readonly HeadlessClient[],
  child: LoadTestServerProcess,
): Promise<number> => {
  const deadline = Date.now() + durationMs;
  let minConnected = countConnectedClients(clients);

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server exited unexpectedly during scenario (code=${String(child.exitCode)})`);
    }

    const connected = countConnectedClients(clients);
    if (connected < minConnected) {
      minConnected = connected;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    await delay(Math.min(SAMPLE_POLL_INTERVAL_MS, remaining));
  }

  return minConnected;
};

const waitForCompletedServerResult = async (
  baseUrl: string,
  child: LoadTestServerProcess,
  fetchFn: typeof fetch,
): Promise<LoadTestResult> => {
  const deadline = Date.now() + RESULT_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Server exited before completing LoadProfiler measurement');
    }

    const state = await fetchLoadTestResult(baseUrl, fetchFn);
    if (state.status === 'completed') {
      return state.result;
    }

    await delay(SAMPLE_POLL_INTERVAL_MS);
  }

  throw new Error('Timed out waiting for LoadProfiler to reach completed state');
};

/**
 * Runs one isolated server + N headless WebSocket client scenario and returns its structured report.
 */
export const runLoadTestScenario = async (
  config: ScenarioRunnerConfig,
  deps: ScenarioDependencies = {},
): Promise<ScenarioReport> => {
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const wsUrl = `ws://127.0.0.1:${config.port}/ws`;
  const scenarioName = `clients-${config.clientCount}`;
  const spawnFn = deps.spawnServer ?? spawnLoadTestServer;
  const fetchFn = deps.fetchFn ?? fetch;

  const child = spawnFn(config.port);
  const stderrChunks: string[] = [];
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });

  const clients: HeadlessClient[] = [];
  for (let i = 0; i < config.clientCount; i += 1) {
    const clientOptions = {
      url: wsUrl,
      roomId: LOAD_TEST_ROOM_ID,
      name: `LoadClient-${String(i + 1).padStart(3, '0')}`,
      seed: config.seed,
      clientIndex: i,
    };
    clients.push(
      deps.createClient !== undefined
        ? deps.createClient(clientOptions)
        : new HeadlessClient(clientOptions),
    );
  }

  const cleanupResources = async (): Promise<void> => {
    for (const client of clients) {
      client.close();
    }
    await terminateChildProcess(child);
  };

  let signalTriggered: string | null = null;
  const onSignal = (signal: NodeJS.Signals): void => {
    signalTriggered = signal;
    void cleanupResources();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let serverResult: LoadTestResult | null = null;
  let loadGeneratorElu = null;
  let minConnectedClients = 0;
  let valid = false;
  let invalidReason: string | undefined;

  try {
    await waitForServerReady(baseUrl, child, stderrChunks, fetchFn);
    await connectClientBatches(clients, child);

    for (const client of clients) {
      client.startSending(30);
    }

    if (config.warmupMs > 0) {
      await waitWithDisconnectCheck(config.warmupMs, clients, child);
    }

    const connectedAfterWarmup = countConnectedClients(clients);
    if (connectedAfterWarmup !== config.clientCount) {
      throw new Error(
        `Connected client count dropped during warmup (${connectedAfterWarmup}/${config.clientCount})`,
      );
    }

    for (const client of clients) {
      client.resetMeasurementCounters();
    }

    const eluBaseline = performance.eventLoopUtilization();
    await startServerLoadProfile(baseUrl, config.durationMs, config.clientCount, fetchFn);
    minConnectedClients = await waitWithDisconnectCheck(config.durationMs, clients, child);
    serverResult = await waitForCompletedServerResult(baseUrl, child, fetchFn);
    loadGeneratorElu = computeEluMetrics(performance.eventLoopUtilization(eluBaseline));
    valid = signalTriggered === null;
    if (signalTriggered !== null) {
      invalidReason = `Aborted by signal ${signalTriggered}`;
    }
  } catch (err) {
    invalidReason = err instanceof Error ? err.message : String(err);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanupResources();
  }

  return {
    scenario: scenarioName,
    recordedAt: new Date().toISOString(),
    valid,
    ...(invalidReason !== undefined ? { invalidReason } : {}),
    requestedClients: config.clientCount,
    warmupMs: config.warmupMs,
    durationMs: config.durationMs,
    seed: config.seed,
    environment: config.environment,
    clients: summarizeClients(clients, config.clientCount, minConnectedClients),
    loadGeneratorElu,
    server: serverResult,
  };
};

const writeJsonReport = async (filePath: string, payload: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const printCapacityReport = (
  scenarios: readonly ScenarioReport[],
  capacity: CapacityAnalysis,
): void => {
  console.log('\n=== Magic Arena M4.3 Load Test Summary ===');
  console.table(scenarios.map(formatSummaryTableRow));
  console.log(`Tick budget: <= ${capacity.tickBudgetMs} ms (target ${capacity.targetTickRateHz} Hz)`);
  console.log(`Largest passing tested N: ${capacity.largestPassingTestedN ?? 'none'}`);
  console.log(`First failing tested N: ${capacity.firstFailingTestedN ?? 'none'}`);
  console.log(`Capacity bound: ${capacity.capacityLowerBound}`);
  console.log(`Bottleneck analysis: ${capacity.bottleneckSummary}`);

  if (capacity.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of capacity.warnings) {
      console.log(`- ${warning}`);
    }
  }
};

/**
 * Executes all requested M4.3 load-test scenarios sequentially and writes JSON artifacts.
 */
export const runLoadTests = async (
  config: LoadTestCliConfig,
  outputDir = LOAD_OUTPUT_DIR,
): Promise<SummaryReport> => {
  const environment = collectSystemEnvironment();
  const scenarios: ScenarioReport[] = [];

  for (let i = 0; i < config.clients.length; i += 1) {
    const clientCount = config.clients[i];
    if (clientCount === undefined) {
      continue;
    }

    const scenarioPort = config.port + i;
    console.log(
      `[load-test] Running N=${clientCount} on 127.0.0.1:${scenarioPort} (warmup=${config.warmupMs}ms, duration=${config.durationMs}ms, seed=${config.seed})...`,
    );

    const report = await runLoadTestScenario({
      clientCount,
      port: scenarioPort,
      warmupMs: config.warmupMs,
      durationMs: config.durationMs,
      seed: config.seed,
      environment,
    });

    scenarios.push(report);
    const scenarioFile = path.join(outputDir, `clients-${clientCount}.json`);
    await writeJsonReport(scenarioFile, report);

    if (!report.valid) {
      console.warn(
        `[load-test] Scenario N=${clientCount} marked invalid: ${report.invalidReason ?? 'unknown reason'}`,
      );
    }
  }

  const capacity = analyzeCapacity(scenarios);
  const summary: SummaryReport = {
    recordedAt: new Date().toISOString(),
    environment,
    tickBudgetMs: capacity.tickBudgetMs,
    warmupMs: config.warmupMs,
    durationMs: config.durationMs,
    seed: config.seed,
    scenarios,
    capacity,
  };

  await writeJsonReport(path.join(outputDir, 'summary.json'), summary);
  printCapacityReport(scenarios, capacity);

  return summary;
};

const isMainModule = (): boolean => {
  const entryPath = process.argv[1];
  if (entryPath === undefined || entryPath.length === 0) {
    return false;
  }
  return pathToFileURL(path.resolve(entryPath)).href === import.meta.url;
};

const main = async (): Promise<void> => {
  const config = parseLoadTestCli(process.argv.slice(2));
  if (config.help) {
    console.log(formatLoadTestUsage());
    return;
  }

  const summary = await runLoadTests(config);
  const hasAnyValid = summary.scenarios.some((item) => item.valid);
  if (!hasAnyValid) {
    process.exitCode = 1;
  }
};

if (isMainModule()) {
  main().catch((err: unknown) => {
    console.error('[load-test] Fatal error:', err);
    process.exitCode = 1;
  });
}
