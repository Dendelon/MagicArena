import type { EluMetrics, LoadTestResult } from '../../src/performance/LoadProfiler.ts';
import type { SystemEnvironmentInfo } from './cli.ts';

export interface ScenarioClientSummary {
  readonly requestedClients: number;
  readonly joinedClients: number;
  readonly minConnectedClients: number;
  readonly disconnects: number;
  readonly decodeErrors: number;
  readonly clientErrors: number;
  readonly inputsSent: number;
  readonly snapshotsReceived: number;
}

export interface ScenarioReport {
  readonly scenario: string;
  readonly recordedAt: string;
  readonly valid: boolean;
  readonly invalidReason?: string;
  readonly requestedClients: number;
  readonly warmupMs: number;
  readonly durationMs: number;
  readonly seed: number;
  readonly environment: SystemEnvironmentInfo;
  readonly clients: ScenarioClientSummary;
  readonly loadGeneratorElu: EluMetrics | null;
  readonly server: LoadTestResult | null;
}

export interface ScenarioThresholdEvaluation {
  readonly N: number;
  readonly valid: boolean;
  readonly passedBudget: boolean;
  readonly p99TickMs: number | null;
  readonly actualTickRateHz: number | null;
  readonly over33MsShare: number | null;
  readonly disconnects: number;
  readonly warnings: readonly string[];
}

export interface CapacityAnalysis {
  readonly tickBudgetMs: number;
  readonly targetTickRateHz: number;
  readonly largestPassingTestedN: number | null;
  readonly firstFailingTestedN: number | null;
  readonly capacityLowerBound: string;
  readonly bottleneckSummary: string;
  readonly warnings: readonly string[];
  readonly evaluations: readonly ScenarioThresholdEvaluation[];
}

export interface SummaryReport {
  readonly recordedAt: string;
  readonly environment: SystemEnvironmentInfo;
  readonly tickBudgetMs: number;
  readonly warmupMs: number;
  readonly durationMs: number;
  readonly seed: number;
  readonly scenarios: readonly ScenarioReport[];
  readonly capacity: CapacityAnalysis;
}

export const TICK_BUDGET_MS = 33;
export const TARGET_TICK_RATE_HZ = 30;
const TICK_RATE_WARNING_THRESHOLD_HZ = 28.5;

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const evaluateScenario = (report: ScenarioReport): ScenarioThresholdEvaluation => {
  const warnings: string[] = [];

  if (!report.valid || report.server === null || report.server.tickMs === null) {
    warnings.push(report.invalidReason ?? 'Scenario run did not produce valid server metrics.');
    return {
      N: report.requestedClients,
      valid: false,
      passedBudget: false,
      p99TickMs: report.server?.tickMs?.p99 ?? null,
      actualTickRateHz: report.server?.actualTickRateHz ?? null,
      over33MsShare: report.server?.over33MsShare ?? null,
      disconnects: report.clients.disconnects,
      warnings,
    };
  }

  const { tickMs, actualTickRateHz, over33MsShare } = report.server;
  const disconnects = report.clients.disconnects;
  const p99TickMs = tickMs.p99;

  if (actualTickRateHz < TICK_RATE_WARNING_THRESHOLD_HZ) {
    warnings.push(
      `N=${report.requestedClients}: actualTickRateHz=${roundTo(actualTickRateHz, 2)} Hz is below ${TICK_RATE_WARNING_THRESHOLD_HZ} Hz stability threshold.`,
    );
  }
  if (disconnects > 0) {
    warnings.push(
      `N=${report.requestedClients}: observed ${disconnects} client disconnect(s) during measurement.`,
    );
  }
  if (report.clients.decodeErrors > 0 || report.clients.clientErrors > 0) {
    warnings.push(
      `N=${report.requestedClients}: decodeErrors=${report.clients.decodeErrors}, clientErrors=${report.clients.clientErrors}.`,
    );
  }
  if (report.loadGeneratorElu !== null && report.loadGeneratorElu.utilizationPercent >= 80) {
    warnings.push(
      `N=${report.requestedClients}: load generator ELU reached ${roundTo(report.loadGeneratorElu.utilizationPercent, 1)}%, which may bias client pacing.`,
    );
  }

  const passedBudget = p99TickMs <= TICK_BUDGET_MS && actualTickRateHz >= TICK_RATE_WARNING_THRESHOLD_HZ && disconnects === 0;

  return {
    N: report.requestedClients,
    valid: true,
    passedBudget,
    p99TickMs,
    actualTickRateHz,
    over33MsShare,
    disconnects,
    warnings,
  };
};

const summarizeBottleneck = (
  scenarios: readonly ScenarioReport[],
  evaluations: readonly ScenarioThresholdEvaluation[],
): string => {
  const validScenarios = scenarios.filter((item) => item.valid && item.server !== null);
  const highest = validScenarios[validScenarios.length - 1];
  if (highest === undefined || highest.server === null) {
    return 'No valid scenarios completed; unable to determine primary server bottleneck.';
  }

  const { server } = highest;
  const firstFail = evaluations.find((item) => item.valid && !item.passedBudget);
  const targetReport =
    firstFail !== undefined
      ? validScenarios.find((item) => item.requestedClients === firstFail.N) ?? highest
      : highest;
  const targetServer = targetReport.server ?? server;

  const causes: string[] = [];
  if (targetServer.tickMs !== null && targetServer.tickMs.p99 > TICK_BUDGET_MS) {
    causes.push(`tick p99 ${roundTo(targetServer.tickMs.p99, 2)} ms > ${TICK_BUDGET_MS} ms`);
  }
  if (targetServer.elu.utilizationPercent >= 70) {
    causes.push(`server ELU ${roundTo(targetServer.elu.utilizationPercent, 1)}%`);
  }
  if (targetServer.network.backpressureEvents > 0 || targetServer.network.droppedMessages > 0) {
    causes.push(
      `WS backpressure=${targetServer.network.backpressureEvents}, dropped=${targetServer.network.droppedMessages}`,
    );
  }
  if (targetReport.clients.disconnects > 0) {
    causes.push(`disconnects=${targetReport.clients.disconnects}`);
  }

  if (causes.length === 0) {
    return `At N=${targetReport.requestedClients}, tick p99=${roundTo(targetServer.tickMs?.p99 ?? 0, 2)} ms and server ELU=${roundTo(targetServer.elu.utilizationPercent, 1)}% stayed within the ${TICK_BUDGET_MS} ms budget.`;
  }

  return `At N=${targetReport.requestedClients}, limiting factors: ${causes.join('; ')}.`;
};

/**
 * Evaluates load-test scenario reports against the 33 ms tick budget and computes server capacity bounds.
 */
export const analyzeCapacity = (scenarios: readonly ScenarioReport[]): CapacityAnalysis => {
  const orderedScenarios = [...scenarios].sort((a, b) => a.requestedClients - b.requestedClients);
  const evaluations = orderedScenarios.map(evaluateScenario);
  const allWarnings = evaluations.flatMap((item) => item.warnings);

  const validEvaluations = evaluations.filter((item) => item.valid);
  const firstFailing = validEvaluations.find((item) => !item.passedBudget);
  const firstFailingTestedN = firstFailing?.N ?? null;

  let largestPassingTestedN: number | null = null;
  for (const evaluation of validEvaluations) {
    if (firstFailingTestedN !== null && evaluation.N >= firstFailingTestedN) {
      break;
    }
    if (evaluation.passedBudget) {
      largestPassingTestedN = evaluation.N;
    }
  }

  let capacityLowerBound: string;
  if (validEvaluations.length === 0) {
    capacityLowerBound = 'undetermined (no valid runs)';
  } else if (largestPassingTestedN === null && firstFailingTestedN !== null) {
    capacityLowerBound = `< ${firstFailingTestedN} concurrent clients (smallest tested N failed budget)`;
  } else if (largestPassingTestedN !== null && firstFailingTestedN !== null) {
    capacityLowerBound = `between ${largestPassingTestedN} and ${firstFailingTestedN - 1} concurrent clients (passed N=${largestPassingTestedN}, failed N=${firstFailingTestedN})`;
  } else if (largestPassingTestedN !== null) {
    capacityLowerBound = `>= ${largestPassingTestedN} concurrent clients (highest tested N passed 33 ms budget)`;
  } else {
    capacityLowerBound = 'undetermined';
  }

  return {
    tickBudgetMs: TICK_BUDGET_MS,
    targetTickRateHz: TARGET_TICK_RATE_HZ,
    largestPassingTestedN,
    firstFailingTestedN,
    capacityLowerBound,
    bottleneckSummary: summarizeBottleneck(orderedScenarios, evaluations),
    warnings: allWarnings,
    evaluations,
  };
};

