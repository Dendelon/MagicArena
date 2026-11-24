const abortReason = (signal) =>
  signal?.reason ?? new DOMException('Aborted', 'AbortError');

const assertNotAborted = (signal) => {
  if (signal?.aborted) throw abortReason(signal);
};

export const fetchJson = async (url, { signal } = {}) => {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${url}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
};

export const loadJson = (url, { signal } = {}) => fetchJson(url, { signal });

export const loadImage = async (url, { signal } = {}) => {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${url}`);
    error.status = response.status;
    throw error;
  }
  const blob = await response.blob();
  assertNotAborted(signal);
  const bitmap = await createImageBitmap(blob);
  if (signal?.aborted) {
    bitmap.close();
    throw abortReason(signal);
  }
  return bitmap;
};

export const loadAudio = async (audioContext, url, { signal } = {}) => {
  if (!audioContext) throw new Error('AudioContext is required for loadAudio');
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${url}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.arrayBuffer();
  assertNotAborted(signal);
  const buffer = await audioContext.decodeAudioData(data);
  assertNotAborted(signal);
  return buffer;
};

const wait = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export const withRetry = async (fn, { attempts = 3, baseMs = 250, signal } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    assertNotAborted(signal);
    try {
      return await fn();
    } catch (error) {
      const clientError = error.status >= 400 && error.status < 500;
      const interrupted =
        signal?.aborted || error.name === 'AbortError' || error.name === 'TimeoutError';
      const invalidData = error instanceof SyntaxError;
      if (clientError || interrupted || invalidData || attempt === attempts - 1)
        throw error;
      const delay = baseMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
      await wait(delay, signal);
    }
  }
  throw new Error('No attempts configured');
};

export const loadAll = async (
  manifest,
  { audioContext = null, onProgress = () => {}, signal } = {},
) => {
  const result = { sprites: {}, audio: {}, json: {} };
  const entries = [
    ...(manifest.sprites ?? []).map((asset) => ({ kind: 'sprites', ...asset })),
    ...(manifest.audio ?? []).map((asset) => ({ kind: 'audio', ...asset })),
    ...(manifest.arena ? [{ kind: 'json', ...manifest.arena }] : []),
  ];

  let completed = 0;
  onProgress(completed, entries.length);

  const tasks = entries.map(async ({ kind, id, url }) => {
    const value = await withRetry(
      () => {
        if (kind === 'sprites') return loadImage(url, { signal });
        if (kind === 'audio') return loadAudio(audioContext, url, { signal });
        return loadJson(url, { signal });
      },
      { signal },
    );

    result[kind][id] = value;
    completed++;
    onProgress(completed, entries.length);
  });

  await Promise.all(tasks);
  return result;
};
