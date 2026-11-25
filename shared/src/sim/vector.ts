import type { Vec2Like } from '../types.ts';

export class Vector2 implements Vec2Like {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  add(vector: Vec2Like): Vector2 {
    return new Vector2(this.x + vector.x, this.y + vector.y);
  }

  sub(vector: Vec2Like): Vector2 {
    return new Vector2(this.x - vector.x, this.y - vector.y);
  }

  scale(value: number): Vector2 {
    return new Vector2(this.x * value, this.y * value);
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  normalize(): Vector2 {
    const len = this.length();

    if (len === 0) return new Vector2();

    return this.scale(1 / len);
  }

  rotate(angle: number): Vector2 {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    return new Vector2(
      this.x * cos - this.y * sin,
      this.x * sin + this.y * cos,
    );
  }

  dot(vector: Vec2Like): number {
    return this.x * vector.x + this.y * vector.y;
  }

  toJSON(): Vec2Like {
    return {
      x: this.x,
      y: this.y,
    };
  }

  static fromAngle(angle: number): Vector2 {
    return new Vector2(Math.cos(angle), Math.sin(angle));
  }

  static fromJSON(data?: Partial<Vec2Like> | null): Vector2 {
    if (data instanceof Vector2) {
      return new Vector2(data.x, data.y);
    }

    return new Vector2(data?.x ?? 0, data?.y ?? 0);
  }
}

