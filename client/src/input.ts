import type { InputState } from './types.ts';

export const createInput = (target: Window = window) => {
  const pressedKeys = new Set<string>();
  const newPresses = new Set<string>();

  const onKeyDown = (event: KeyboardEvent): void => {
    const code = event.code;

    if (!pressedKeys.has(code)) {
      newPresses.add(code);
    }

    pressedKeys.add(code);

    if (code.startsWith('Arrow') || code === 'Space') {
      event.preventDefault();
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    pressedKeys.delete(event.code);
  };

  const clearKeys = (): void => {
    pressedKeys.clear();
    newPresses.clear();
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', clearKeys);

  const isDown = (code: string): boolean => pressedKeys.has(code);

  const justPressed = (code: string): boolean => {
    if (!newPresses.has(code)) return false;

    newPresses.delete(code);
    return true;
  };

  const getState = (): InputState => ({
    left: isDown('KeyA') || isDown('ArrowLeft'),
    right: isDown('KeyD') || isDown('ArrowRight'),
    forward: isDown('KeyW') || isDown('ArrowUp'),
    brake: isDown('KeyS') || isDown('ArrowDown'),
  });

  const destroy = (): void => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', clearKeys);

    clearKeys();
  };

  return { isDown, justPressed, getState, destroy };
};

