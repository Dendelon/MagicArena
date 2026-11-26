import { describe, expect, test, vi } from 'vitest';

import { createTypedEvents } from '../src/events.ts';

interface TestEvents {
  message: {
    text: string;
  };

  count: number;
}

describe('Typed events', () => {
  test('Passes event payload to listener', () => {
    const events = createTypedEvents<TestEvents>();

    const listener = vi.fn();

    events.addEventListener('message', listener);

    events.emit('message', {
      text: 'Hello',
    });

    expect(listener).toHaveBeenCalledWith({
      detail: {
        text: 'Hello',
      },
    });
  });

  test('Removes event listener', () => {
    const events = createTypedEvents<TestEvents>();

    const listener = vi.fn();

    events.addEventListener('count', listener);
    events.removeEventListener('count', listener);

    events.emit('count', 1);

    expect(listener).not.toHaveBeenCalled();
  });

  test('Once listener runs only once', () => {
    const events = createTypedEvents<TestEvents>();

    const listener = vi.fn();

    events.addEventListener('count', listener, { once: true });

    events.emit('count', 1);
    events.emit('count', 2);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  test('Isolates listeners between different event types', () => {
    const events = createTypedEvents<TestEvents>();

    const messageListener = vi.fn();
    const countListener = vi.fn();

    events.addEventListener('message', messageListener);
    events.addEventListener('count', countListener);

    events.emit('message', { text: 'Arena' });

    expect(messageListener).toHaveBeenCalledTimes(1);
    expect(countListener).not.toHaveBeenCalled();
  });

  test('Does not duplicate the same listener registered twice', () => {
    const events = createTypedEvents<TestEvents>();

    const listener = vi.fn();

    events.addEventListener('count', listener);
    events.addEventListener('count', listener);

    events.emit('count', 42);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ detail: 42 });
  });
});

