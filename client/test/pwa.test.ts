import { describe, expect, test, vi } from 'vitest';

import { registerServiceWorker } from '../src/pwa.ts';

describe('registerServiceWorker', () => {
  test('skips registration when disabled, insecure, or unsupported', async () => {
    const register = vi.fn<
      (scriptUrl: string, options?: RegistrationOptions) => Promise<unknown>
    >(() => Promise.resolve({}));

    await expect(
      registerServiceWorker({
        enabled: false,
        isSecureContext: true,
        serviceWorker: { register },
      }),
    ).resolves.toBe(false);

    await expect(
      registerServiceWorker({
        enabled: true,
        isSecureContext: false,
        serviceWorker: { register },
      }),
    ).resolves.toBe(false);

    await expect(
      registerServiceWorker({
        enabled: true,
        isSecureContext: true,
        serviceWorker: undefined,
      }),
    ).resolves.toBe(false);

    expect(register).not.toHaveBeenCalled();
  });

  test('registers /sw.js immediately when document is already complete', async () => {
    const register = vi.fn<
      (scriptUrl: string, options?: RegistrationOptions) => Promise<unknown>
    >(() => Promise.resolve({ scope: '/' }));

    const registered = await registerServiceWorker({
      enabled: true,
      isSecureContext: true,
      serviceWorker: { register },
      readyState: 'complete',
    });

    expect(registered).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  test('waits for window load event when document is still loading', async () => {
    const register = vi.fn<
      (scriptUrl: string, options?: RegistrationOptions) => Promise<unknown>
    >(() => Promise.resolve({ scope: '/' }));

    const loadCallbacks: Array<() => void> = [];
    const promise = registerServiceWorker({
      enabled: true,
      isSecureContext: true,
      serviceWorker: { register },
      readyState: 'loading',
      onLoad: (cb) => {
        loadCallbacks.push(cb);
      },
    });

    expect(register).not.toHaveBeenCalled();
    expect(loadCallbacks).toHaveLength(1);
    const triggerLoad = loadCallbacks[0];
    if (!triggerLoad) {
      throw new Error('Expected load callback');
    }
    triggerLoad();

    await expect(promise).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  test('handles registration failures gracefully without rejecting', async () => {
    const failure = new Error('SW blocked');
    const onError = vi.fn<(error: unknown) => void>();
    const register = vi.fn<
      (scriptUrl: string, options?: RegistrationOptions) => Promise<unknown>
    >(() => Promise.reject(failure));

    const registered = await registerServiceWorker({
      enabled: true,
      isSecureContext: true,
      serviceWorker: { register },
      readyState: 'complete',
      onError,
    });

    expect(registered).toBe(false);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

