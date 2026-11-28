import type { PublicClass } from './wrapped-alias';
export function consumeWrapped(x: PublicClass) { return x.value; }
