import { add, square, SCALE } from './math.js';

export function twice(x) {
  return add(x, x) * SCALE;
}

export function norm(x, y) {
  return square(x) + square(y);
}
