import { double } from './forward.js';

export function quad(x) {
  return double(double(x));
}
