import type { run, Base, Shape } from './target';
export function forbidden() { return run(); }
export class Forbidden extends Base {}
export interface Allowed extends Shape {}
