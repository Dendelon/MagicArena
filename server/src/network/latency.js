export const createLatencyController = ({ delayMs = 0 } = {}) => {
  const timers = new Set();

  const schedule = (fn) => {
    if (delayMs <= 0) {
      fn();
      return;
    }

    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, delayMs);

    timers.add(timer);
  };

  const clear = () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }

    timers.clear();
  };

  return { delayMs, schedule, clear };
};

