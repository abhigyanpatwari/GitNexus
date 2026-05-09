/**
 * Test-only helpers.
 *
 * Symbols here are reachable from `gitnexus-shared/test-helpers` so test
 * suites can reset shared registries or exercise internal classifiers,
 * but they are deliberately NOT re-exported from the main `gitnexus-shared`
 * barrel. Production consumers should never import this module — calling
 * `__resetBreakerRegistry__()` from a tool implementation would silently
 * nuke every circuit breaker process-wide.
 */

export { __resetBreakerRegistry__ } from './integrations/circuit-breaker.js';
export { classifyOutcome } from './integrations/resilient-fetch.js';
