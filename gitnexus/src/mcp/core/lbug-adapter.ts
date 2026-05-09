/**
 * LadybugDB connection pool — re-exported from core.
 *
 * KEEP THIS FILE. It is intentionally a shim re-export of
 * `../../core/lbug/pool-adapter.js`. The MCP test suite uses this path as
 * a vi.mock seam so unit tests can stub LadybugDB without affecting other
 * importers of `core/lbug/pool-adapter.js` (which is shared with the
 * analyze pipeline). New non-test code MAY import from `pool-adapter.js`
 * directly, but the shim must continue to exist for the mock seam to work.
 */
export * from '../../core/lbug/pool-adapter.js';
