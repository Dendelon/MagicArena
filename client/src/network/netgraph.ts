import './netgraph.css';

import type { Connection, ConnectionEvents } from './connection.ts';
import type { TypedEvent } from '../events.ts';
import type { ReconciliationResult } from '../types.ts';
import type { NetSim } from '@magicarena/shared';

import {
  DEFAULT_INTERPOLATION_DELAY_MS,
  MAX_INTERPOLATION_DELAY_MS,
  MIN_INTERPOLATION_DELAY_MS,
} from './interpolation.ts';

const MAX_PENDING_PINGS = 32;
const TRAFFIC_WINDOW_MS = 1000;
const PING_INTERVAL_MS = 1000;
const RENDER_INTERVAL_MS = 100;

interface TrafficSample {
  readonly t: number;
  readonly bytes: number;
}

interface SliderOptions {
  labelText: string;
  min: number;
  max: number;
  step: number;
  value: number;

  onInput: (value: number) => void;
}

interface NetgraphOptions {
  initialInterpolationDelayMs?: number;

  onInterpolationDelayChange?: ((value: number) => void) | null;
}

const formatBytesPerSecond = (bytesPerSec: number): string => {
  if (bytesPerSec >= 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  }

  return `${Math.round(bytesPerSec)} B/s`;
};

export const mountNetgraph = (
  connection: Connection,
  {
    initialInterpolationDelayMs = DEFAULT_INTERPOLATION_DELAY_MS,
    onInterpolationDelayChange = null,
  }: NetgraphOptions = {},
) => {
  const panel = document.createElement('aside');
  panel.className = 'magic-netgraph';

  const title = document.createElement('div');
  title.className = 'magic-netgraph-title';
  title.textContent = 'NETGRAPH';

  const createRow = (labelText: string): HTMLSpanElement => {
    const row = document.createElement('div');
    row.className = 'magic-netgraph-row';

    const label = document.createElement('span');
    label.className = 'magic-netgraph-label';
    label.textContent = labelText;

    const value = document.createElement('span');
    value.className = 'magic-netgraph-value';
    value.textContent = '—';

    row.append(label, value);
    panel.append(row);
    return value;
  };

  const createSlider = ({
    labelText,
    min,
    max,
    step,
    value,
    onInput,
  }: SliderOptions) => {
    const container = document.createElement('div');
    container.className = 'magic-netgraph-control';

    const row = document.createElement('div');
    row.className = 'magic-netgraph-row';

    const label = document.createElement('span');
    label.className = 'magic-netgraph-label';
    label.textContent = labelText;

    const valueEl = document.createElement('span');
    valueEl.className = 'magic-netgraph-value';

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'magic-netgraph-slider';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);

    // Стрілки слайдера не повинні керувати мечем
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
    });

    input.addEventListener('input', () => {
      onInput(Number(input.value));
    });

    input.addEventListener('change', () => {
      input.blur();
    });

    row.append(label, valueEl);
    container.append(row, input);
    panel.append(container);

    return { container, valueEl, input };
  };

  panel.append(title);

  const rttEl = createRow('RTT');
  const snapshotAgeEl = createRow('Snapshot age');
  const downloadEl = createRow('Download');
  const uploadEl = createRow('Upload');
  const codecEl = createRow('Codec');
  const pendingEl = createRow('Pending inputs');
  const correctionEl = createRow('Correction');
  correctionEl.textContent = '0.0 px';

  const divider = document.createElement('div');
  divider.className = 'magic-netgraph-divider';
  panel.append(divider);

  let interpDelayMs = initialInterpolationDelayMs;

  const interpControl = createSlider({
    labelText: 'Interp delay',
    min: MIN_INTERPOLATION_DELAY_MS,
    max: MAX_INTERPOLATION_DELAY_MS,
    step: 10,
    value: interpDelayMs,
    onInput: (nextDelay) => {
      interpDelayMs = nextDelay;
      interpControl.valueEl.textContent = `${interpDelayMs} ms`;
      onInterpolationDelayChange?.(interpDelayMs);
    },
  });
  interpControl.valueEl.textContent = `${interpDelayMs} ms`;

  const netDebugDivider = document.createElement('div');
  netDebugDivider.className = 'magic-netgraph-divider';
  panel.append(netDebugDivider);

  const delayEl = createRow('Delay');
  const jitterEl = createRow('Jitter');
  const dropRateEl = createRow('Drop rate');

  const applyNetSim = (next: NetSim): void => {
    delayEl.textContent = `${Math.round(next.delayMs)} ms`;
    jitterEl.textContent = `${Math.round(next.jitterMs)} ms`;
    dropRateEl.textContent = `${Math.round(next.dropRate * 100)}%`;
  };

  document.body.append(panel);

  let rttMs: number | null = null;
  let lastSnapshotAt: number | null = null;
  let nextPingId = 1;
  let pendingCount = 0;
  let correctionPx = 0;

  const pendingPings = new Map<number, number>();
  const rxSamples: TrafficSample[] = [];
  const txSamples: TrafficSample[] = [];

  const pruneTraffic = (samples: TrafficSample[], now: number): void => {
    while (true) {
      const first = samples[0];

      if (!first || now - first.t <= TRAFFIC_WINDOW_MS) {
        break;
      }

      samples.shift();
    }
  };

  const sumTraffic = (samples: TrafficSample[], now: number): number => {
    pruneTraffic(samples, now);

    let total = 0;

    for (const sample of samples) {
      total += sample.bytes;
    }

    return total;
  };

  const render = (): void => {
    const now = performance.now();

    rttEl.textContent = rttMs === null ? '—' : `${Math.round(rttMs)} ms`;
    snapshotAgeEl.textContent =
      lastSnapshotAt === null
        ? '—'
        : `${Math.max(0, Math.round(now - lastSnapshotAt))} ms`;
    downloadEl.textContent = formatBytesPerSecond(sumTraffic(rxSamples, now));
    uploadEl.textContent = formatBytesPerSecond(sumTraffic(txSamples, now));
    pendingEl.textContent = String(pendingCount);
    correctionEl.textContent = `${correctionPx.toFixed(1)} px`;
  };

  const sendPing = (): void => {
    if (!connection.isJoined()) return;

    const id = nextPingId++;
    const clientTime = performance.now();

    if (pendingPings.size >= MAX_PENDING_PINGS) {
      const oldest = pendingPings.keys().next();

      if (!oldest.done) {
        pendingPings.delete(oldest.value);
      }
    }

    pendingPings.set(id, clientTime);

    connection.send({
      type: 'ping',
      id,
      clientTime,
    });
  };

  const reset = (): void => {
    rttMs = null;
    lastSnapshotAt = null;
    pendingCount = 0;
    correctionPx = 0;
    pendingPings.clear();
    rxSamples.length = 0;
    txSamples.length = 0;
    codecEl.textContent = '—';
    render();
  };

  const onJoined = (event: TypedEvent<ConnectionEvents['joined']>): void => {
    reset();
    codecEl.textContent = event.detail.codec === 'binary' ? 'Binary' : 'JSON';
    applyNetSim(event.detail.netSim);
    sendPing();
  };

  const onStatus = (event: TypedEvent<ConnectionEvents['status']>): void => {
    if (
      event.detail === 'Connecting...' ||
      event.detail.startsWith('Reconnecting')
    ) {
      reset();
    }
  };

  const onSnapshot = (): void => {
    lastSnapshotAt = performance.now();
    render();
  };

  const onPong = (event: TypedEvent<ConnectionEvents['pong']>): void => {
    const { id, clientTime } = event.detail;
    const sentAt = pendingPings.get(id) ?? clientTime;

    pendingPings.delete(id);

    if (Number.isFinite(sentAt)) {
      rttMs = Math.max(0, performance.now() - sentAt);
      render();
    }
  };

  const onRx = (event: TypedEvent<ConnectionEvents['rx']>): void => {
    const now = performance.now();
    rxSamples.push({ t: now, bytes: event.detail.bytes });
    pruneTraffic(rxSamples, now);
  };

  const onTx = (event: TypedEvent<ConnectionEvents['tx']>): void => {
    const now = performance.now();
    txSamples.push({ t: now, bytes: event.detail.bytes });
    pruneTraffic(txSamples, now);
  };

  const onDisconnected = (): void => {
    reset();
  };

  connection.addEventListener('joined', onJoined);
  connection.addEventListener('disconnected', onDisconnected);
  connection.addEventListener('status', onStatus);
  connection.addEventListener('snapshot', onSnapshot);
  connection.addEventListener('pong', onPong);
  connection.addEventListener('rx', onRx);
  connection.addEventListener('tx', onTx);

  const pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
  const renderTimer = setInterval(render, RENDER_INTERVAL_MS);

  render();

  const setPendingCount = (count: number): void => {
    pendingCount = count;
    pendingEl.textContent = String(pendingCount);
  };

  const recordReconciliation = ({
    pendingCount: nextPendingCount = 0,
    correctionPx: nextCorrectionPx = 0,
  }: Partial<ReconciliationResult> = {}): void => {
    pendingCount = nextPendingCount;
    correctionPx = nextCorrectionPx;
    render();
  };

  const destroy = (): void => {
    clearInterval(pingTimer);
    clearInterval(renderTimer);

    connection.removeEventListener('joined', onJoined);
    connection.removeEventListener('disconnected', onDisconnected);
    connection.removeEventListener('status', onStatus);
    connection.removeEventListener('snapshot', onSnapshot);
    connection.removeEventListener('pong', onPong);
    connection.removeEventListener('rx', onRx);
    connection.removeEventListener('tx', onTx);

    reset();
    panel.remove();
  };

  return {
    setPendingCount,
    recordReconciliation,
    getRttMs: (): number => rttMs ?? 0,
    destroy,
  };
};

export type Netgraph = ReturnType<typeof mountNetgraph>;

