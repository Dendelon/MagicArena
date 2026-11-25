import type {
  EntityId,
  SwordState,
  Seq,
  Tick,
  Vec2Like,
} from '@magicarena/shared/types';

export interface CanvasSize {
  width: number;
  height: number;
}

export interface FrameStats {
  readonly fps: number;
  readonly sps: number;
  readonly frameTimeMs: number;
}

export interface HudStats extends FrameStats {
  readonly hp: number;
  readonly score: number;
  readonly respawnSeconds: number | null;
}

export interface InputState {
  readonly left: boolean;
  readonly right: boolean;
  readonly forward: boolean;
  readonly brake: boolean;
}

export interface PredictedSwordState extends SwordState {
  entityId: EntityId | null;
  alive: boolean;
  thrust: boolean;
}

export interface RenderState {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly thrust: boolean;
}

export interface PendingInput {
  readonly seq: Seq;
  readonly tick: Tick;

  readonly input: {
    readonly thrust: boolean;
    readonly turn: number;
    readonly brake: boolean;
  };
}

export interface ReconciliationResult {
  readonly correctionPx: number;
  readonly pendingCount: number;
  readonly entityId: EntityId | null;
}

export interface RenderBullet extends Vec2Like {
  readonly radius: number;
  readonly isHoming: boolean;
}

export interface LoadedAssets {
  readonly sprites: Record<string, ImageBitmap>;
  readonly audio: Record<string, AudioBuffer>;
  readonly json: Record<string, unknown>;
}

