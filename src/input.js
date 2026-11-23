export const createInput = (target = window) => {
  const pressedKeys = new Set();
  const newPresses = new Set();

  const onKeyDown = (event) => {
    const code = event.code;

    if (!pressedKeys.has(code)) {
      newPresses.add(code);
    }

    pressedKeys.add(code);

    if (code.startsWith('Arrow') || code === 'Space') {
      event.preventDefault();
    }
  };

  const onKeyUp = (event) => {
    pressedKeys.delete(event.code);
  };

  const clearKeys = () => {
    pressedKeys.clear();
    newPresses.clear();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', clearKeys);

  const isDown = (code) => pressedKeys.has(code);

  const justPressed = (code) => {
    if (!newPresses.has(code)) return false;

    newPresses.delete(code);
    return true;
  };

  const getState = () => ({
    left: isDown('KeyA') || isDown('ArrowLeft'),
    right: isDown('KeyD') || isDown('ArrowRight'),
    forward: isDown('KeyW') || isDown('ArrowUp'),
    brake: isDown('KeyS') || isDown('ArrowDown'),
  });

  const destroy = () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', clearKeys);

    clearKeys();
  };

  return { isDown, justPressed, getState, destroy };
};
