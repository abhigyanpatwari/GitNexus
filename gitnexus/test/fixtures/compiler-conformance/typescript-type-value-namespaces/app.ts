import { run, Base, Shape } from './target';
interface run {}
export function kept() { return run(); }
export function erasedAlias() { type run = string; return run(); }
export class Child extends Base implements Shape {}
export interface More extends Shape {}
