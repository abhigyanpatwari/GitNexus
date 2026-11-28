
export * as operations from './left.js';
export function wrongLocal() {
  // A namespace re-export creates no local binding.
  operations.publish();
}
