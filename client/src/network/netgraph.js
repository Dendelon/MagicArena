import './netgraph.css';

const MAX_PENDING_INPUTS = 256;
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

export const mountNetgraph = (connection) => {
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

  panel.append(title);

  const rttEl = createRow('RTT');
  const snapshotAgeEl = createRow('Snapshot age');
  const downloadEl = createRow('Download');
  const uploadEl = createRow('Upload');
  const pendingEl = createRow('Pending inputs');
  const correctionEl = createRow('Correction');
  correctionEl.textContent = '0 px (inactive)';

  document.body.append(panel);

  let rttMs = null;
  let lastSnapshotAt = null;
  let nextPingId = 1;

  const pendingInputs = [];
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
    pendingEl.textContent = String(pendingInputs.length);
  };

  const sendPing = () => {
    if (!connection.isOpen?.()) return;

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
    pendingInputs.length = 0;
    pendingPings.clear();
    rxSamples.length = 0;
    txSamples.length = 0;
    render();
  };

  const onJoined = () => {
    reset();
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

  const onSnapshot = (event) => {
    lastSnapshotAt = performance.now();

    const ackSeq = event.detail.lastProcessedSeq ?? 0;

    while (pendingInputs.length > 0 && pendingInputs[0].seq <= ackSeq) {
      pendingInputs.shift();
    }

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

  connection.addEventListener('joined', onJoined);
  connection.addEventListener('status', onStatus);
  connection.addEventListener('snapshot', onSnapshot);
  connection.addEventListener('pong', onPong);
  connection.addEventListener('rx', onRx);
  connection.addEventListener('tx', onTx);

  const pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
  const renderTimer = setInterval(render, RENDER_INTERVAL_MS);

  render();

  const trackInput = (seq) => {
    if (pendingInputs.length >= MAX_PENDING_INPUTS) {
      pendingInputs.shift();
    }

    pendingInputs.push({
      seq,
      sentAt: performance.now(),
    });
  };

  const destroy = () => {
    clearInterval(pingTimer);
    clearInterval(renderTimer);

    connection.removeEventListener('joined', onJoined);
    connection.removeEventListener('status', onStatus);
    connection.removeEventListener('snapshot', onSnapshot);
    connection.removeEventListener('pong', onPong);
    connection.removeEventListener('rx', onRx);
    connection.removeEventListener('tx', onTx);

    reset();
    panel.remove();
  };

  return { trackInput, destroy };
};

