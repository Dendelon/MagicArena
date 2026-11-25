export interface TypedEvent<T> {
  readonly detail: T;
}

export type TypedListener<T> = (event: TypedEvent<T>) => void;

interface ListenerOptions {
  once?: boolean;
}

export const createTypedEvents = <Events extends object>() => {
  const listeners: {
    [K in keyof Events]?: Map<TypedListener<Events[K]>, boolean>;
  } = {};

  const addEventListener = <K extends keyof Events>(
    type: K,
    listener: TypedListener<Events[K]>,
    options: ListenerOptions = {},
  ): void => {
    let entries = listeners[type];

    if (!entries) {
      entries = new Map<TypedListener<Events[K]>, boolean>();

      listeners[type] = entries;
    }

    if (!entries.has(listener)) {
      entries.set(listener, options.once ?? false);
    }
  };

  const removeEventListener = <K extends keyof Events>(
    type: K,
    listener: TypedListener<Events[K]>,
  ): void => {
    listeners[type]?.delete(listener);
  };

  const emit = <K extends keyof Events>(type: K, detail: Events[K]): void => {
    const entries = listeners[type];

    if (!entries) return;

    for (const [listener, once] of [...entries]) {
      if (!entries.has(listener)) continue;

      if (once) {
        entries.delete(listener);
      }

      try {
        listener({ detail });
      } catch (error: unknown) {
        reportError(error);
      }
    }
  };

  return {
    addEventListener,
    removeEventListener,
    emit,
  };
};

