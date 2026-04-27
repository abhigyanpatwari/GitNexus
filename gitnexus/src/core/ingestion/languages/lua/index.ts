/**
 * Lua scope-resolution hooks (RFC #909 Ring 3, RFC §5).
 *
 * Public API barrel for the Lua language provider.
 *
 * Module layout:
 *   - `query.ts`    — LUA_SCOPE_QUERY string + lazy parser/query singletons
 *   - `captures.ts` — `emitLuaScopeCaptures` (top-level orchestrator)
 */

export { emitLuaScopeCaptures } from './captures.js';
