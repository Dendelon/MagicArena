export interface LatencyOptions {
  delayMs?: number;
  jitterMs?: number;
  dropRate?: number;
}

interface ScheduleOptions {
  allowDrop?: boolean;
}

export const createLatencyController = ({
  delayMs = 0,
  jitterMs = 0,
  dropRate = 0,
}: LatencyOptions = {}) => {
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const schedule = (
    fn: () => void,
    { allowDrop = false }: ScheduleOptions = {},
  ): boolean => {
    if (allowDrop && dropRate > 0 && Math.random() < dropRate) {
      return false;
    }

    const jitterDelta = jitterMs > 0 ? (Math.random() * 2 - 1) * jitterMs : 0;
    const effectiveDelay = Math.max(0, Math.round(delayMs + jitterDelta));

    if (effectiveDelay <= 0) {
      fn();
      return true;
    }

    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, effectiveDelay);

    timers.add(timer);
    return true;
  };

  const clear = (): void => {
    for (const timer of timers) {
      clearTimeout(timer);
    }

    timers.clear();
  };

  return {
    delayMs,
    jitterMs,
    dropRate,
    schedule,
    clear,
  };
};

