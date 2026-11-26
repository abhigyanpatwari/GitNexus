import { twice as simple } from './simple.js';
import { twice as loop } from './loop.js';

export function compare(x: number) { return [simple(x), loop(x)]; }
