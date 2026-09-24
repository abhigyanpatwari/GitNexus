import { DEFAULT_FETCH_LIMIT, INLINE_LIMIT, pageSize } from './config.js';

// A2 cross-file: a named-import reference to a module-scope const.
export function consumerLimit() {
  return DEFAULT_FETCH_LIMIT;
}

// Control: same shape, but the const was exported inline.
export function consumerInline() {
  return INLINE_LIMIT;
}

// Control: a cross-file CALL through the same import statement resolves today.
export function consumerCall() {
  return pageSize();
}

// Guard: a BLOCK-LOCAL const read in this same file must NOT gain an edge.
// findValueBindingInScope accepts Const/Variable, so without the same-file
// guard this pass would resurrect exactly the inert locals pruneLocalSymbols
// exists to drop.
export function localOnly() {
  const localScratchValue = 7;
  return Math.max(localScratchValue, 1);
}
