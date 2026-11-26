export interface RenderedSword {
  readonly entityId: number | string;
  readonly ownerId: string | null;
  readonly isOwnSword: boolean;

  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

export interface E2ERenderFrame {
  readonly tick: number | null;
  readonly width: number;
  readonly height: number;
  readonly swords: readonly RenderedSword[];
}

export const createRenderProbe = (canvas: HTMLCanvasElement) => {
  const enabled = import.meta.env.VITE_E2E === '1';
  let frameSwords: RenderedSword[] | null = null;

  const beginFrame = (): void => {
    if (!enabled) return;
    frameSwords = [];
  };

  const recordSword = (
    entityId: number | string,
    ownerId: string | null,
    isOwnSword: boolean,
    x: number,
    y: number,
    angle: number,
  ): void => {
    if (!enabled || !frameSwords) return;

    frameSwords.push({
      entityId,
      ownerId,
      isOwnSword,
      x,
      y,
      angle,
    });
  };

  const endFrame = (
    tick: number | null,
    width: number,
    height: number,
  ): void => {
    if (!enabled || !frameSwords) return;

    const payload: E2ERenderFrame = {
      tick,
      width,
      height,
      swords: frameSwords,
    };

    canvas.dataset.e2eSwords = JSON.stringify(payload);
    frameSwords = null;
  };

  return {
    beginFrame,
    recordSword,
    endFrame,
  };
};

