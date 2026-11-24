export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  add(vector) {
    return new Vector2(this.x + vector.x, this.y + vector.y);
  }

  sub(vector) {
    return new Vector2(this.x - vector.x, this.y - vector.y);
  }

  scale(value) {
    return new Vector2(this.x * value, this.y * value);
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  normalize() {
    const len = this.length();

    if (len === 0) return new Vector2();

    return this.scale(1 / len);
  }

  rotate(angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    return new Vector2(this.x * cos - this.y * sin, this.x * sin + this.y * cos);
  }

  dot(vector) {
    return this.x * vector.x + this.y * vector.y;
  }

  static fromAngle(angle) {
    return new Vector2(Math.cos(angle), Math.sin(angle));
  }
}
