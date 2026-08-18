/**
 * Zig Language Provider.
 *
 * Key Zig traits:
 *   - mroStrategy: default 'first-wins' is irrelevant — Zig has no inheritance,
 *     and no heritage hooks are provided (Zig queries never produce
 *     `@heritage.*` captures).
 *   - exportChecker: walks to the enclosing variable_declaration /
 *     function_declaration and looks for a `pub` or `export` keyword child.
 *   - importResolver: only resolves local `@import("./foo.zig")` paths;
 *     `@import("std")` and external packages are deliberately external.
 *   - namedBindingExtractor: omitted — `const Foo = @import("x").Foo` is a
 *     const declaration, not import-statement syntax.
 *   - scope-resolution hooks (Ring 3): `emitScopeCaptures` walks the file via
 *     `zig/query.ts` (containers as Class scopes, container-nested fns
 *     relabeled @declaration.method, plain-variable groups filtered for
 *     container/import bindings); `interpretImport` maps
 *     `const x = @import("…")` to a namespace import; receiver dispatch
 *     rides the `self`-parameter convention. The emit-side wiring lives in
 *     `zig/scope-resolver.ts` (SCOPE_RESOLVERS registry).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';
import { ZIG_QUERIES } from '../tree-sitter-queries.js';
import { zigExportChecker } from '../export-detection.js';
import { createImportResolver } from '../import-resolvers/resolver-factory.js';
import { zigImportConfig } from '../import-resolvers/configs/zig.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { zigCallConfig } from '../call-extractors/configs/zig.js';
import { createClassExtractor } from '../class-extractors/generic.js';
import { zigClassConfig } from '../class-extractors/configs/zig.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { zigFieldConfig } from '../field-extractors/configs/zig.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { zigMethodConfig } from '../method-extractors/configs/zig.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { zigVariableConfig } from '../variable-extractors/configs/zig.js';
import { zigTypeConfig } from '../type-extractors/zig.js';
import {
  emitZigScopeCaptures,
  interpretZigImport,
  interpretZigTypeBinding,
  isZigContainerMethod,
  zigArityCompatibility,
  zigBindingScopeFor,
  zigReceiverBinding,
} from './zig/index.js';

export const zigProvider = defineLanguage({
  id: SupportedLanguages.Zig,
  extensions: ['.zig'],
  entryPointPatterns: [
    /^main$/, // standard executable entry point
    /^build$/, // build.zig entry point
  ],
  astFrameworkPatterns: [],
  treeSitterQueries: ZIG_QUERIES,
  typeConfig: zigTypeConfig,
  exportChecker: zigExportChecker,
  importResolver: createImportResolver(zigImportConfig),
  callExtractor: createCallExtractor(zigCallConfig),
  classExtractor: createClassExtractor(zigClassConfig),
  fieldExtractor: createFieldExtractor(zigFieldConfig),
  methodExtractor: createMethodExtractor(zigMethodConfig),
  variableExtractor: createVariableExtractor(zigVariableConfig),
  labelOverride: (functionNode, defaultLabel) => {
    if (defaultLabel !== 'Function') return defaultLabel;
    if (isZigContainerMethod(functionNode)) return 'Method';
    return defaultLabel;
  },

  // ── RFC #909 Ring 3: scope-based resolution hooks ──
  emitScopeCaptures: emitZigScopeCaptures,
  interpretImport: interpretZigImport,
  interpretTypeBinding: interpretZigTypeBinding,
  bindingScopeFor: zigBindingScopeFor,
  receiverBinding: zigReceiverBinding,
  // Provider contract is (def, callsite); the ScopeResolver contract is
  // (callsite, def) — same function, adapted argument order.
  arityCompatibility: (def, callsite) => zigArityCompatibility(callsite, def),
});
