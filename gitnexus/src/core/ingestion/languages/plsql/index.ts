/**
 * Oracle PL/SQL scope-resolution public API barrel.
 *
 *   - `captures.ts`  — `emitPlSqlScopeCaptures` (wraps the ANTLR fact extractor)
 *   - `interpret.ts` — import / owning-scope / receiver hooks
 *   - `rename.ts`    — rename provider
 *   - `flow.ts`      — CFG hook (none yet)
 */

export { emitPlSqlScopeCaptures } from './captures.js';
export { interpretPlSqlImport, plsqlImportOwningScope, plsqlReceiverBinding } from './interpret.js';
export { plsqlRenameProvider } from './rename.js';
export { collectPlSqlSourceCfgs } from './flow.js';
