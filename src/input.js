export const createInput = () => {
  const pressedKeys = new Set();

  const onKeyDown = (event) => {
    pressedKeys.add(event.code);

    if (event.code.startsWith('Arrow')) {
      event.preventDefault();
    }
  };

  const onKeyUp = (event) => {
    pressedKeys.delete(event.code);
  };

  const clearKeys = () => {
    pressedKeys.clear();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', clearKeys);

  const getState = () => ({
    left: pressedKeys.has('KeyA') || pressedKeys.has('ArrowLeft'),
    right: pressedKeys.has('KeyD') || pressedKeys.has('ArrowRight'),
    forward: pressedKeys.has('KeyW') || pressedKeys.has('ArrowUp'),
    brake: pressedKeys.has('KeyS') || pressedKeys.has('ArrowDown'),
  });

  const destroy = () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', clearKeys);
    clearKeys();
  };

  return { getState, destroy };
};
