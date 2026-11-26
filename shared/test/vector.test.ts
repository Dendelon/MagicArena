import { describe, expect, test } from 'vitest';

import { Vector2 } from '../src/index.ts';

describe('Vector2', () => {
  test('Creates a zero vector', () => {
    const vector = new Vector2();

    expect(vector.x).toBe(0);
    expect(vector.y).toBe(0);
  });

  test('Adds two vectors', () => {
    const result = new Vector2(2, 3).add(new Vector2(4, 5));

    expect(result.x).toBe(6);
    expect(result.y).toBe(8);
  });

  test('Subtracts two vectors', () => {
    const result = new Vector2(5, 7).sub(new Vector2(2, 3));

    expect(result.x).toBe(3);
    expect(result.y).toBe(4);
  });

  test('Scales a vector', () => {
    const result = new Vector2(2, -3).scale(2);

    expect(result.x).toBe(4);
    expect(result.y).toBe(-6);
  });

  test('Calculates vector length', () => {
    expect(new Vector2(3, 4).length()).toBe(5);
  });

  test('Normalizes a non-zero vector', () => {
    const result = new Vector2(3, 4).normalize();

    expect(result.x).toBeCloseTo(0.6);
    expect(result.y).toBeCloseTo(0.8);
    expect(result.length()).toBeCloseTo(1);
  });

  test('Normalizes a zero vector safely', () => {
    const result = new Vector2().normalize();

    expect(result.x).toBe(0);
    expect(result.y).toBe(0);
  });

  test('Rotates a vector by 90 degrees', () => {
    const result = new Vector2(1, 0).rotate(Math.PI / 2);

    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(1);
  });

  test('Calculates dot product', () => {
    expect(new Vector2(2, 3).dot(new Vector2(4, 5))).toBe(23);
  });

  test('Creates a unit vector from angle', () => {
    const result = Vector2.fromAngle(Math.PI / 2);

    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(1);
  });

  test('Serializes and restores a vector', () => {
    const original = new Vector2(10, -20);

    const restored = Vector2.fromJSON(original.toJSON());

    expect(restored.x).toBe(10);
    expect(restored.y).toBe(-20);
  });

  test('Arithmetic does not mutate input vectors', () => {
    const original = new Vector2(2, 3);

    original.add(new Vector2(5, 7));
    original.sub(new Vector2(1, 1));
    original.scale(10);
    original.rotate(1);
    original.normalize();

    expect(original.x).toBe(2);
    expect(original.y).toBe(3);
  });
});

