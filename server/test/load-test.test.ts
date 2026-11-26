import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  createSnapshotMessage,
  getCodec,
} from '@magicarena/shared';

import {
  parseLoadTestCli,
} from '../scripts/load-test/cli.ts';
import {
  createScriptedPlayer,
  type ScriptedControls,
} from '../scripts/load-test/scriptedInput.ts';
import {
  analyzeCapacity,
  type ScenarioReport,
} from '../scripts/load-test/capacity.ts';
import {
  HeadlessClient,
} from '../scripts/load-test/HeadlessClient.ts';
import {
  formatSummaryTableRow,
  runLoadTestScenario,
} from '../scripts/load-test.ts';
import type { LoadTestResult } from '../src/performance/LoadProfiler.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SAMPLE_ENV = {
  platform: 'linux',
  release: '6.8.0',
  arch: 'x64',
  nodeVersion: 'v24.0.0',
  cpuModel: 'Test CPU',
  cpuCores: 8,
  totalMemoryMiB: 16384,
} as const;

const makeServerResult = (
  expectedClients: number,
  overrides: {
    readonly p99?: number;
    readonly actualTickRateHz?: number;
    readonly ticksOver33Ms?: number;
    readonly over33MsShare?: number;
    readonly utilizationPercent?: number;
    readonly backpressureEvents?: number;
  } = {},
): LoadTestResult => ({
  durationMs: 60_000,
  expectedClients,
  ticks: 1800,
  actualTickRateHz: overrides.actualTickRateHz ?? 30,
  ticksOver33Ms: overrides.ticksOver33Ms ?? 0,
  over33MsShare: overrides.over33MsShare ?? 0,
  tickMs: {
    count: 1800,
    min: 0.5,
    mean: 2.0,
    p50: 1.8,
    p95: 4.5,
    p99: overrides.p99 ?? 6.2,
    max: (overrides.p99 ?? 6.2) + 1.5,
  },
  elu: {
    utilization: (overrides.utilizationPercent ?? 20) / 100,
    utilizationPercent: overrides.utilizationPercent ?? 20,
    activeMs: 12_000,
    idleMs: 48_000,
  },
  memory: {
    rssStartBytes: 90 * 1024 * 1024,
    rssEndBytes: 120 * 1024 * 1024,
    rssPeakBytes: 128 * 1024 * 1024,
    heapUsedStartBytes: 30 * 1024 * 1024,
    heapUsedEndBytes: 42 * 1024 * 1024,
  },
  network: {
    receivedBytes: 120_000,
    sentBytes: 2_400_000,
    receivedMessages: 1800 * expectedClients,
    sentMessages: 1800 * expectedClients,
    receivedBytesPerSecond: 2000,
    sentBytesPerSecond: 40_000,
    totalBytesPerSecond: 42_000,
    droppedMessages: 0,
    backpressureEvents: overrides.backpressureEvents ?? 0,
    scopeNote: 'WebSocket application payload throughput only',
  },
  entities: {
    avg: expectedClients + 5,
    max: expectedClients + 12,
  },
  players: expectedClients,
});

const makeScenario = (
  n: number,
  options: {
    readonly valid?: boolean;
    readonly invalidReason?: string;
    readonly p99?: number;
    readonly actualTickRateHz?: number;
    readonly disconnects?: number;
  } = {},
): ScenarioReport => ({
  scenario: `clients-${n}`,
  recordedAt: '2026-11-26T12:00:00.000Z',
  valid: options.valid ?? true,
  ...(options.invalidReason !== undefined
    ? { invalidReason: options.invalidReason }
    : {}),
  requestedClients: n,
  warmupMs: 15_000,
  durationMs: 60_000,
  seed: 1337,
  environment: SAMPLE_ENV,
  clients: {
    requestedClients: n,
    joinedClients: n,
    minConnectedClients: n - (options.disconnects ?? 0),
    disconnects: options.disconnects ?? 0,
    decodeErrors: 0,
    clientErrors: 0,
    inputsSent: n * 1800,
    snapshotsReceived: n * 1800,
  },
  loadGeneratorElu: {
    utilization: 0.15,
    utilizationPercent: 15,
    activeMs: 9000,
    idleMs: 51_000,
  },
  server:
    options.valid === false
      ? null
      : makeServerResult(n, {
          ...(options.p99 !== undefined ? { p99: options.p99 } : {}),
          ...(options.actualTickRateHz !== undefined
            ? { actualTickRateHz: options.actualTickRateHz }
            : {}),
        }),
});

describe('CLI flag parsing', () => {
  test('uses expected M4.3 defaults when invoked without arguments', () => {
    const config = parseLoadTestCli([]);
    expect(config).toEqual({
      clients: [8, 32, 64, 128],
      warmupMs: 15_000,
      durationMs: 60_000,
      seed: 1337,
      port: 3200,
      help: false,
    });
  });

  test('parses valid --key=value and --key value flags', () => {
    const config = parseLoadTestCli([
      '--clients=8,32,64',
      '--warmup-ms',
      '500',
      '--duration-ms=2500',
      '--seed=99',
      '--port',
      '3400',
    ]);

    expect(config).toEqual({
      clients: [8, 32, 64],
      warmupMs: 500,
      durationMs: 2500,
      seed: 99,
      port: 3400,
      help: false,
    });
  });

  test('rejects invalid client counts, duplicates, and unknown flags', () => {
    expect(() => parseLoadTestCli(['--clients=0'])).toThrow();
    expect(() => parseLoadTestCli(['--clients=129'])).toThrow();
    expect(() => parseLoadTestCli(['--clients=8,8'])).toThrow();
    expect(() => parseLoadTestCli(['--duration-ms=500'])).toThrow();
    expect(() => parseLoadTestCli(['--unknown=1'])).toThrow();
  });
});

describe('Scripted player input generator', () => {
  test('is deterministic per seed + clientIndex and staggers fire phases', () => {
    const runSequence = (seed: number, clientIndex: number): ScriptedControls[] => {
      const stepFn = createScriptedPlayer(seed, clientIndex);
      const steps: ScriptedControls[] = [];
      for (let i = 0; i < 180; i += 1) {
        steps.push(stepFn(i));
      }
      return steps;
    };

    const client0RunA = runSequence(1337, 0);
    const client0RunB = runSequence(1337, 0);
    const client1Run = runSequence(1337, 1);

    expect(client0RunA).toEqual(client0RunB);
    expect(client1Run).not.toEqual(client0RunA);

    let lastFireSeq = 0;
    for (const controls of client0RunA) {
      expect([-1, 0, 1]).toContain(controls.turn);
      expect(controls.thrust).toBe(!controls.brake);
      expect(controls.fire && controls.homingFire).toBe(false);
      if (controls.fire || controls.homingFire) {
        expect(controls.fireSeq).toBe(lastFireSeq + 1);
        lastFireSeq = controls.fireSeq ?? 0;
      }
    }
    expect(lastFireSeq).toBeGreaterThan(0);
  });
});

describe('Capacity analysis and table formatting', () => {
  test('identifies capacity bound when N=64 passes and N=128 fails tick budget', () => {
    const analysis = analyzeCapacity([
      makeScenario(8, { p99: 4.1 }),
      makeScenario(32, { p99: 11.4 }),
      makeScenario(64, { p99: 24.8 }),
      makeScenario(128, { p99: 41.2 }),
    ]);

    expect(analysis.largestPassingTestedN).toBe(64);
    expect(analysis.firstFailingTestedN).toBe(128);
    expect(analysis.capacityLowerBound).toContain('between 64 and 127');
    expect(analysis.bottleneckSummary).toContain('N=128');
  });

  test('reports lower bound >= highest tested N when all scenarios pass', () => {
    const analysis = analyzeCapacity([
      makeScenario(8, { p99: 2 }),
      makeScenario(32, { p99: 5 }),
      makeScenario(64, { p99: 9 }),
      makeScenario(128, { p99: 19 }),
    ]);

    expect(analysis.largestPassingTestedN).toBe(128);
    expect(analysis.firstFailingTestedN).toBeNull();
    expect(analysis.capacityLowerBound).toContain('>= 128');
  });

  test('excludes invalid runs and emits warnings for low tick rate or disconnects', () => {
    const analysis = analyzeCapacity([
      makeScenario(8, { p99: 5, actualTickRateHz: 25 }),
      makeScenario(32, { valid: false, invalidReason: 'boom' }),
      makeScenario(64, { p99: 12, disconnects: 2 }),
    ]);

    expect(analysis.largestPassingTestedN).toBeNull();
    expect(analysis.firstFailingTestedN).toBe(8);
    expect(analysis.warnings.some((w) => w.includes('stability threshold'))).toBe(true);
    expect(analysis.warnings.some((w) => w.includes('boom'))).toBe(true);
    expect(analysis.warnings.some((w) => w.includes('disconnect'))).toBe(true);
  });

  test('formats console.table rows with all required columns', () => {
    const validRow = formatSummaryTableRow(makeScenario(32, { p99: 8.125 }));
    const invalidRow = formatSummaryTableRow(
      makeScenario(64, { valid: false, invalidReason: 'failed' }),
    );

    expect(Object.keys(validRow)).toEqual([
      'Clients',
      'Joined',
      'Tick p99 (ms)',
      'Tick rate (Hz)',
      'Over 33 ms',
      'ELU (%)',
      'Peak RSS (MiB)',
      'RX (KiB/s)',
      'TX (KiB/s)',
      'Disconnects',
      'Valid',
    ]);
    expect(validRow.Valid).toBe('yes');
    expect(validRow['Tick p99 (ms)']).toBe('8.125');
    expect(invalidRow.Valid).toBe('no');
    expect(invalidRow['Tick p99 (ms)']).toBe('n/a');
  });
});

describe('HeadlessClient and scenario cleanup', () => {
  test('connects, exchanges binary game messages, counts unexpected disconnect, and cleans timers', async () => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    const codec = getCodec('binary');
    let serverSocket: WebSocket | null = null;
    const requireServerSocket = (): WebSocket => {
      if (serverSocket === null) {
        throw new Error('Expected server WebSocket connection to be established');
      }
      return serverSocket;
    };
    let receivedBinaryInputs = 0;

    wss.on('connection', (socket) => {
      serverSocket = socket;
      socket.on('message', (_data, isBinary) => {
        if (!isBinary) {
          socket.send(
            JSON.stringify({
              v: PROTOCOL_VERSION,
              type: 'joined',
              room: {
                id: 'load-test',
                name: 'Load Test Arena',
                players: 1,
                maxPlayers: 128,
                obstacleCount: 3,
              },
              player: { id: 'p-1', name: 'LoadClient-001', entityId: 1 },
              entityId: 1,
              bounds: { width: 1600, height: 1200 },
              codec: 'binary',
              netSim: { delayMs: 0, jitterMs: 0, dropRate: 0 },
            }),
          );
          const snapshot = codec.encode(createSnapshotMessage({ tick: 5 }));
          socket.send(snapshot);
        } else {
          receivedBinaryInputs += 1;
        }
      });
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });

    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address');
    }

    const client = new HeadlessClient({
      url: `ws://127.0.0.1:${address.port}/ws`,
      roomId: 'load-test',
      name: 'LoadClient-001',
      seed: 1337,
      clientIndex: 0,
    });

    await client.connect();
    expect(serverSocket).not.toBeNull();
    client.startSending(30);

    await vi.waitFor(() => {
      expect(receivedBinaryInputs).toBeGreaterThanOrEqual(2);
    });

    const beforeCloseStats = client.getStats();
    expect(beforeCloseStats.joined).toBe(true);
    expect(beforeCloseStats.clientErrors).toBe(0);
    expect(beforeCloseStats.decodeErrors).toBe(0);
    expect(beforeCloseStats.inputsSent).toBeGreaterThanOrEqual(2);
    expect(beforeCloseStats.snapshotsReceived).toBe(1);
    expect(beforeCloseStats.disconnects).toBe(0);

    requireServerSocket().close(1011, 'simulated server drop');

    await vi.waitFor(() => {
      expect(client.getStats().disconnects).toBe(1);
    });

    client.close();
    expect(client.getStats().connected).toBe(false);
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  test('marks scenario invalid and cleans up clients + child process on failure', async () => {
    class FakeChildProcess extends EventEmitter {
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      stderr = new EventEmitter();
      killedSignals: Array<NodeJS.Signals | number | undefined> = [];

      kill(signal?: NodeJS.Signals | number): boolean {
        this.killedSignals.push(signal);
        this.signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
        this.emit('exit', null, this.signalCode);
        return true;
      }
    }

    const fakeChild = new FakeChildProcess();
    const closedClients: string[] = [];

    const createFakeClient = (options: {
      readonly url: string;
      readonly roomId: string;
      readonly name: string;
      readonly seed: number;
      readonly clientIndex: number;
    }): HeadlessClient => {
      const real = new HeadlessClient(options);
      real.connect = async () => Promise.reject(new Error('WS handshake refused'));
      const originalClose = real.close.bind(real);
      real.close = () => {
        closedClients.push(options.name);
        originalClose();
      };
      return real;
    };

    const report = await runLoadTestScenario(
      {
        clientCount: 2,
        port: 3999,
        warmupMs: 0,
        durationMs: 1000,
        seed: 1337,
        environment: SAMPLE_ENV,
      },
      {
        spawnServer: () => fakeChild,
        createClient: createFakeClient,
        fetchFn: async () => new Response('ok', { status: 200 }),
      },
    );

    expect(report.valid).toBe(false);
    expect(report.invalidReason).toContain('WS handshake refused');
    expect(closedClients).toEqual(['LoadClient-001', 'LoadClient-002']);
    expect(fakeChild.killedSignals).toContain('SIGTERM');
  });
});
