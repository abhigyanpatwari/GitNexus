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
 * `interpretJsTypeBinding` handles the JS-only `@type-binding.class-field`
 * tag before delegating to `interpretTsTypeBinding`.  The class-field tag
 * is emitted by `synthesizeConstructorFieldBindings` and should produce
 * `source = 'annotation'` — the same strength as an explicit type
 * annotation. Remapping it to `@type-binding.annotation` achieves this
 * without adding a JS-specific branch to the shared TS interpreter
 * (DoD.md §2.2).
 */

import type { CaptureMatch, ParsedImport, ParsedTypeBinding } from 'gitnexus-shared';
import { interpretTsImport, interpretTsTypeBinding } from '../typescript/interpret.js';

export function interpretJsImport(captures: CaptureMatch): ParsedImport | null {
  return interpretTsImport(captures);
}

export function interpretJsTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  // @type-binding.class-field is a JS-only tag emitted by
  // synthesizeConstructorFieldBindings. Remap it to the standard
  // @type-binding.annotation tag so interpretTsTypeBinding assigns
  // source = 'annotation' without a JS-specific branch in shared code.
  if (captures['@type-binding.class-field'] !== undefined) {
    const { '@type-binding.class-field': classField, ...rest } = captures;
    return interpretTsTypeBinding({ ...rest, '@type-binding.annotation': classField });
  }
  return interpretTsTypeBinding(captures);
}
