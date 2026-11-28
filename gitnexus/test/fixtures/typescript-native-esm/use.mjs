import d, { renamed } from './api.mjs';
import * as ns from './barrel.mjs';

export function useDefault() { return d(); }
export function useAlias() { return renamed(); }
export function useStar() { return ns.direct(); }
export function useForward() { return ns.forwarded(); }

export function probeDefault() {
  if ('default' in ns && typeof ns.default === 'function') return ns.default();
}

export function probeHidden() {
  if ('hidden' in ns && typeof ns.hidden === 'function') return ns.hidden();
}
