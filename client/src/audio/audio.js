// Web Audio is isolated from the simulation; it only subscribes to World events.
export const createGameAudio = (context, buffers = {}) => {
  const play = (id, volume = 0.55) => {
    if (!context || context.state !== 'running' || !buffers[id]) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffers[id];
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(context.destination);
    source.start();
  };

  const unlock = () => {
    if (!context) return Promise.resolve();
    return context.resume();
  };

  const subscribe = (world, { shouldPlay = null } = {}) => {
    const onFired = (event) => {
      if (shouldPlay && !shouldPlay(event)) return;
      play('shoot', 0.2);
    };
    const onHit = () => play('hit', 0.15);
    const onExploded = () => play('explosion', 0.05);
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
