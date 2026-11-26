export interface ServiceWorkerContainerLike {
  readonly register: (
    scriptUrl: string,
    options?: RegistrationOptions,
  ) => Promise<unknown>;
}

export interface RegisterServiceWorkerOptions {
  readonly enabled?: boolean;
  readonly isSecureContext?: boolean;
  readonly serviceWorker?: ServiceWorkerContainerLike | undefined;
  readonly readyState?: DocumentReadyState;
  readonly onLoad?: (callback: () => void) => void;
  readonly onError?: (error: unknown) => void;
}

const defaultOnLoad = (callback: () => void): void => {
  window.addEventListener('load', callback, { once: true });
};

/**
 * Registers the PWA Service Worker in production secure contexts without interfering
 * with Vite HMR in development or blocking multiplayer startup on failure.
 */
export const registerServiceWorker = (
  options: RegisterServiceWorkerOptions = {},
): Promise<boolean> => {
  const enabled = options.enabled ?? import.meta.env.PROD;
  const isSecureContext =
    options.isSecureContext ??
    (typeof window !== 'undefined' && window.isSecureContext);
  const serviceWorker =
    options.serviceWorker ??
    (typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? navigator.serviceWorker
      : undefined);

  if (!enabled || !isSecureContext || !serviceWorker) {
    return Promise.resolve(false);
  }

  const readyState =
    options.readyState ??
    (typeof document !== 'undefined' ? document.readyState : 'complete');
  const onLoad = options.onLoad ?? defaultOnLoad;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.warn('[PWA] Service Worker registration failed:', error);
    });

  const performRegister = async (): Promise<boolean> => {
    try {
      await serviceWorker.register('/sw.js', { scope: '/' });
      return true;
    } catch (error: unknown) {
      onError(error);
      return false;
    }
  };

  if (readyState === 'complete') {
    return performRegister();
  }

  return new Promise<boolean>((resolve) => {
    onLoad(() => {
      void performRegister().then(resolve);
    });
  });
};

