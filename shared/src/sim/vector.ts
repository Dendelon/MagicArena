import type { Vec2Like } from '../types.ts';

export interface Vector2View extends Vec2Like {
  add(vector: Vec2Like): Vector2;
  sub(vector: Vec2Like): Vector2;
  scale(value: number): Vector2;
  length(): number;
  normalize(): Vector2;
  rotate(angle: number): Vector2;
  dot(vector: Vec2Like): number;
  toJSON(): Vec2Like;
}

export class MutableVector2 implements Vector2View {
  x: number;
  y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  set(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  copyFrom(source: Vec2Like): void {
    this.x = source.x;
    this.y = source.y;
  }

  addScaled(source: Vec2Like, scale: number): void {
    this.x += source.x * scale;
    this.y += source.y * scale;
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

    return new Vector2(this.x / len, this.y / len);
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
}

export class Vector2 implements Vector2View {
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

