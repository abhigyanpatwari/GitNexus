/**
 * Capture-match → semantic-shape interpreters for JavaScript.
 *
 * `interpretJsImport` delegates to `interpretTsImport` for all cases
 * because `emitJsScopeCaptures` synthesizes the same
 * `@import.kind/name/alias/source` markers for both ESM and CJS imports.
 *
 * The `@import.kind` values emitted for CJS by `captures.ts`:
 *
 *   - `'named'`       : `const { X } = require('./m')`     → named import
 *   - `'named-alias'` : `const { X: Y } = require('./m')` → aliased import
 *   - `'namespace'`   : `const X = require('./m')`         → namespace import
 *   - `'side-effect'` : `require('./m')` bare expression   → side-effect
 *
 * These match the kinds `interpretTsImport` already handles for ESM
 * (`import { X }`, `import { X as Y }`, `import * as X`, `import './m'`),
 * so no new branch is needed here.
 *
 * `interpretJsTypeBinding` delegates to `interpretTsTypeBinding` unchanged:
 * the binding-shape produced by JSDoc-synthesized captures is identical
 * to the one produced by TypeScript type-annotation captures.
 */

import type { CaptureMatch, ParsedImport, ParsedTypeBinding } from 'gitnexus-shared';
import { interpretTsImport, interpretTsTypeBinding } from '../typescript/interpret.js';

export function interpretJsImport(captures: CaptureMatch): ParsedImport | null {
  return interpretTsImport(captures);
}

export function interpretJsTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  return interpretTsTypeBinding(captures);
}
