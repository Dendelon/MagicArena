import './netgraph.css';
import {
  DEFAULT_INTERPOLATION_DELAY_MS,
  MAX_INTERPOLATION_DELAY_MS,
  MIN_INTERPOLATION_DELAY_MS,
} from './interpolation.js';

const MAX_PENDING_PINGS = 32;
const TRAFFIC_WINDOW_MS = 1000;
const PING_INTERVAL_MS = 1000;
const RENDER_INTERVAL_MS = 100;

const formatBytesPerSecond = (bytesPerSec) => {
  if (bytesPerSec >= 1024) {
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  }

  return `${Math.round(bytesPerSec)} B/s`;
};

export const mountNetgraph = (
  connection,
  {
    initialInterpolationDelayMs = DEFAULT_INTERPOLATION_DELAY_MS,
    onInterpolationDelayChange = null,
  } = {},
) => {
  const panel = document.createElement('aside');
  panel.className = 'magic-netgraph';

  const title = document.createElement('div');
  title.className = 'magic-netgraph-title';
  title.textContent = 'NETGRAPH';

  const createRow = (labelText) => {
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

  const createSlider = ({ labelText, min, max, step, value, onInput }) => {
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

  const applyNetSim = (next) => {
    if (!next) return;

    delayEl.textContent = `${Math.round(next.delayMs ?? 0)} ms`;
    jitterEl.textContent = `${Math.round(next.jitterMs ?? 0)} ms`;
    dropRateEl.textContent = `${Math.round((next.dropRate ?? 0) * 100)}%`;
  };

  document.body.append(panel);

  let rttMs = null;
  let lastSnapshotAt = null;
  let nextPingId = 1;
  let pendingCount = 0;
  let correctionPx = 0;

  const pendingPings = new Map();
  const rxSamples = [];
  const txSamples = [];

  const pruneTraffic = (samples, now) => {
    while (samples.length > 0 && now - samples[0].t > TRAFFIC_WINDOW_MS) {
      samples.shift();
    }
  };

  const sumTraffic = (samples, now) => {
    pruneTraffic(samples, now);

    let total = 0;

    for (const sample of samples) {
      total += sample.bytes;
    }

    return total;
  };

  const render = () => {
    const now = performance.now();

    rttEl.textContent = rttMs === null ? '—' : `${Math.round(rttMs)} ms`;
    snapshotAgeEl.textContent =
      lastSnapshotAt === null ? '—' : `${Math.max(0, Math.round(now - lastSnapshotAt))} ms`;
    downloadEl.textContent = formatBytesPerSecond(sumTraffic(rxSamples, now));
    uploadEl.textContent = formatBytesPerSecond(sumTraffic(txSamples, now));
    pendingEl.textContent = String(pendingCount);
    correctionEl.textContent = `${correctionPx.toFixed(1)} px`;
  };

  const sendPing = () => {
    if (!connection.isJoined?.()) return;

    const id = nextPingId++;
    const clientTime = performance.now();

    if (pendingPings.size >= MAX_PENDING_PINGS) {
      const oldestKey = pendingPings.keys().next().value;
      pendingPings.delete(oldestKey);
    }

    pendingPings.set(id, clientTime);

    connection.send({
      type: 'ping',
      id,
      clientTime,
    });
  };

  const reset = () => {
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

  const onJoined = (event) => {
    reset();
    codecEl.textContent = event.detail.codec === 'binary' ? 'Binary' : 'JSON';
    applyNetSim(event.detail?.netSim);
    sendPing();
  };

  const onStatus = (event) => {
    if (
      event.detail === 'Connecting...' ||
      String(event.detail).startsWith('Reconnecting')
    ) {
      reset();
    }
  };

  const onSnapshot = () => {
    lastSnapshotAt = performance.now();
    render();
  };

  const onPong = (event) => {
    const { id, clientTime } = event.detail ?? {};
    const sentAt = pendingPings.has(id) ? pendingPings.get(id) : clientTime;

    pendingPings.delete(id);

    if (typeof sentAt === 'number' && Number.isFinite(sentAt)) {
      rttMs = Math.max(0, performance.now() - sentAt);
      render();
    }
  };

  const onRx = (event) => {
    const now = performance.now();
    rxSamples.push({ t: now, bytes: event.detail.bytes ?? 0 });
    pruneTraffic(rxSamples, now);
  };

  const onTx = (event) => {
    const now = performance.now();
    txSamples.push({ t: now, bytes: event.detail.bytes ?? 0 });
    pruneTraffic(txSamples, now);
  };

  const onDisconnected = () => {
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

  const setPendingCount = (count) => {
    pendingCount = count;
    pendingEl.textContent = String(pendingCount);
  };

  const recordReconciliation = ({
    pendingCount: nextPendingCount = 0,
    correctionPx: nextCorrectionPx = 0,
  } = {}) => {
    pendingCount = nextPendingCount;
    correctionPx = nextCorrectionPx;
    render();
  };

  const destroy = () => {
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
    getRttMs: () => rttMs ?? 0,
    destroy,
  };
};
