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
