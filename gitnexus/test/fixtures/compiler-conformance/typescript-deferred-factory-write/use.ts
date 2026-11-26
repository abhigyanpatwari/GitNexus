import value from './index';
import initialized from './after';
export function consume() { return value(); }
export function consumeInitialized() { return initialized(); }
