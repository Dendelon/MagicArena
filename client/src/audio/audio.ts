import type { World, WorldEvent, WorldEventMap } from '@magicarena/shared';

interface FiredEvent {
  readonly type: 'fired';

  readonly detail: WorldEventMap['fired'];
}

interface SubscribeOptions {
  shouldPlay?: ((event: FiredEvent) => boolean) | null;
}

const isFiredDetail = (
  detail: WorldEvent['detail'],
): detail is WorldEventMap['fired'] =>
  'entityId' in detail &&
  'ownerId' in detail &&
  'ownerPlayerId' in detail &&
  'originSeq' in detail;

// Web Audio is isolated from the simulation; it only subscribes to World events.
export const createGameAudio = (
  context: AudioContext | null,
  buffers: Readonly<Record<string, AudioBuffer>> = {},
) => {
  const play = (id: string, volume = 0.55): void => {
    const buffer = buffers[id];

    if (!context || context.state !== 'running' || !buffer) {
      return;
    }

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
  };

  const unlock = (): Promise<void> => {
    if (!context) return Promise.resolve();
    return context.resume();
  };

  const subscribe = (
    world: World,
    { shouldPlay = null }: SubscribeOptions = {},
  ): (() => void) => {
    const onFired = (event: WorldEvent): void => {
      if (event.type !== 'fired' || !isFiredDetail(event.detail)) return;
      if (shouldPlay && !shouldPlay({ type: 'fired', detail: event.detail })) {
        return;
      }
      play('shoot', 0.2);
    };
    const onHit = (): void => play('hit', 0.15);
    const onExploded = (): void => play('explosion', 0.05);
    world.addEventListener('fired', onFired);
    world.addEventListener('hit', onHit);
    world.addEventListener('exploded', onExploded);
    return () => {
      world.removeEventListener('fired', onFired);
      world.removeEventListener('hit', onHit);
      world.removeEventListener('exploded', onExploded);
    };
  };

  return { unlock, play, subscribe };
};

