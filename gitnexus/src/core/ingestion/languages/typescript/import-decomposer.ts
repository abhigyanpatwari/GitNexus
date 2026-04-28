/**
 * Decompose a TypeScript `import_statement` / re-export `export_statement` /
 * dynamic `call_expression(import)` into one `CaptureMatch` per imported
 * name.
 *
 * Why split here? The `LanguageProvider.interpretImport` contract is
 * one `ParsedImport` per call. Tree-sitter delivers
 *
 *   import D, { X as Y, type Z } from './m'
 *
 * as a single `import_statement` match, so without decomposition we'd
 * lose names. The synthesized markers (`@import.kind` / `@import.name`
 * / `@import.alias` / `@import.source`) carry everything
 * `interpretTsImport` needs to recover the `ParsedImport` shape —
 * see `interpret.ts`.
 *
 * Kinds we emit and how `interpret.ts` maps them to `ParsedImport`:
 *
 *   - `default`            : `import D from './m'`          → alias (importedName=default)
 *   - `named`              : `import { X } from './m'`      → named
 *   - `named-alias`        : `import { X as Y } from './m'` → alias
 *   - `namespace`          : `import * as N from './m'`     → namespace
 *   - `reexport`           : `export { X } from './m'`      → reexport
 *   - `reexport-alias`     : `export { X as Y } from './m'` → reexport (with alias)
 *   - `reexport-wildcard`  : `export * from './m'`          → wildcard
 *   - `reexport-namespace` : `export * as ns from './m'`    → namespace (local=ns,imported=source)
 *   - `dynamic`            : `import('./m')` / `import(x)`  → dynamic-resolved or dynamic-unresolved
 *
 * Type-only constructs (`import type { X }`, `import { type X }`,
 * `export type { X }`) emit the same kinds as runtime forms — at the
 * TypeScript scope-resolution layer, types and values share the same
 * lookup; runtime-emission is a downstream concern.
 *
 * Side-effect imports (`import './polyfill'`) produce a single match
 * with `kind: 'side-effect'`. The shared finalize algorithm resolves
 * the target file and emits a file-level IMPORTS edge, but
 * materializes no `BindingRef` (matching the legacy DAG, which counts
 * `import './polyfill'` as a module-reachability dependency only).
 */

import type { Capture, CaptureMatch } from 'gitnexus-shared';
import {
  findChild,
  nodeToCapture,
  syntheticCapture,
  type SyntaxNode,
} from '../../utils/ast-helpers.js';

type ImportKind =
  | 'default'
  | 'named'
  | 'named-alias'
  | 'namespace'
  | 'reexport'
  | 'reexport-alias'
  | 'reexport-wildcard'
  | 'reexport-namespace'
  | 'dynamic'
  | 'side-effect';

interface ImportSpec {
  readonly kind: ImportKind;
  /** Module path as written (quotes stripped): `./m`, `numpy`, `@scope/pkg`.
   *  `null` only for dynamic imports whose argument isn't a string literal. */
  readonly source: string | null;
  /** Imported name from the source (or `''` when N/A, e.g. default imports
   *  use `'default'`, wildcards use `'*'`). */
  readonly name: string;
  /** Local alias — only present for aliased forms. */
  readonly alias?: string;
  /** Node to anchor the synthesized captures (for range + match provenance). */
  readonly atNode: SyntaxNode;
  /** Set on `dynamic` kind imports when the argument is a string literal —
   *  enables `interpretTsImport` to emit `dynamic-resolved`. */
  readonly literalSource?: boolean;
}

/**
 * Decompose an import anchor. Handles three node types:
 *
 *   - `import_statement`             : all static import forms (incl. side-effect)
 *   - `export_statement` (w/ source) : re-exports
 *   - `call_expression` (import fn)  : dynamic `import()`
 */
export function splitImportStatement(stmtNode: SyntaxNode): CaptureMatch[] {
  if (stmtNode.type === 'import_statement') return splitImport(stmtNode);
  if (stmtNode.type === 'export_statement') return splitReexport(stmtNode);
  if (stmtNode.type === 'call_expression') return splitDynamicImport(stmtNode);
  return [];
}

// ─── static imports ─────────────────────────────────────────────────────

function splitImport(stmtNode: SyntaxNode): CaptureMatch[] {
  // `import_statement` shape:
  //   import_clause? "from" string          (static form with bindings)
  //   string                                (side-effect `import './m'`)
  //
  // The `source` field is the string literal — we strip its surrounding
  // quotes. An import without an `import_clause` child is side-effect
  // only and still emits one non-binding match.
  const source = extractSource(stmtNode);
  if (source === null) return [];

  const importClause = findChild(stmtNode, 'import_clause');
  if (importClause === null) {
    // `import './polyfill'` — no clause, no local binding. Emit a
    // side-effect match so the finalize layer still produces a
    // file-level IMPORTS edge (parity with the legacy DAG).
    return [
      buildImportMatch(stmtNode, {
        kind: 'side-effect',
        source,
        name: '',
        atNode: stmtNode,
      }),
    ];
  }

  const out: CaptureMatch[] = [];
  // An import_clause can have any combination of:
  //   - leading identifier  (default import)
  //   - namespace_import    (* as N)
  //   - named_imports       ({ X, Y as Z })
  for (let i = 0; i < importClause.namedChildCount; i++) {
    const child = importClause.namedChild(i);
    if (child === null) continue;

    if (child.type === 'identifier') {
      // Default import: `import D from './m'`.
      out.push(
        buildImportMatch(stmtNode, {
          kind: 'default',
          source,
          name: 'default',
          alias: child.text,
          atNode: child,
        }),
      );
      continue;
    }

    if (child.type === 'namespace_import') {
      // `* as N` — the identifier child is the local binding.
      const aliasId = findChild(child, 'identifier');
      if (aliasId !== null) {
        out.push(
          buildImportMatch(stmtNode, {
            kind: 'namespace',
            source,
            name: source,
            alias: aliasId.text,
            atNode: child,
          }),
        );
      }
      continue;
    }

    if (child.type === 'named_imports') {
      for (let j = 0; j < child.namedChildCount; j++) {
        const spec = child.namedChild(j);
        if (spec === null || spec.type !== 'import_specifier') continue;
        const decomposed = decomposeNamedSpecifier(spec, source, stmtNode);
        if (decomposed !== null) out.push(decomposed);
      }
      continue;
    }
    // Other children (e.g. `type` keyword token for `import type { ... }`)
    // are ignored — they carry no per-specifier info; we fold type-only
    // semantics into the same emitted kinds.
  }

  return out;
}

/**
 * Decompose a single `import_specifier` into one match. Handles:
 *
 *   - `{ X }`            → named
 *   - `{ X as Y }`       → named-alias
 *   - `{ type X }`       → named (type-only; same shape)
 *   - `{ type X as Y }`  → named-alias (type-only)
 */
function decomposeNamedSpecifier(
  spec: SyntaxNode,
  source: string,
  stmtNode: SyntaxNode,
): CaptureMatch | null {
  // `import_specifier` layout:
  //   name: identifier
  //   alias: identifier?            (only when `as` is present)
  //   plus an optional `type` keyword token in front (per-specifier type-only)
  //
  // tree-sitter-typescript exposes `name` and `alias` as named fields.
  // If `name` is absent, fail closed rather than guessing positionally:
  // binding the alias as the imported name would invert the edge.
  const nameNode = spec.childForFieldName('name');
  const aliasNode = spec.childForFieldName('alias');
  if (nameNode === null) return null;
  const name = nameNode.text;

  if (aliasNode !== null && aliasNode.startIndex !== nameNode.startIndex) {
    return buildImportMatch(stmtNode, {
      kind: 'named-alias',
      source,
      name,
      alias: aliasNode.text,
      atNode: spec,
    });
  }
  return buildImportMatch(stmtNode, {
    kind: 'named',
    source,
    name,
    atNode: spec,
  });
}

// ─── re-exports ──────────────────────────────────────────────────────────

function splitReexport(stmtNode: SyntaxNode): CaptureMatch[] {
  // `export_statement` with a `source:` field is a re-export. Forms:
  //
  //   export { X, Y as Z } from './m'          → export_clause children
  //   export * from './m'                      → no clause
  //   export * as ns from './m'                → namespace_export child
  //   export type { X } from './m'             → same clause path
  //
  // Local `export { X }` (no `from`) is visibility metadata, not an
  // import; the captures-layer query guards with a `source: (string)`
  // predicate so we always have a source here — but we defend
  // structurally anyway.
  const source = extractSource(stmtNode);
  if (source === null) return [];

  const exportClause = findChild(stmtNode, 'export_clause');
  if (exportClause !== null) {
    const out: CaptureMatch[] = [];
    for (let i = 0; i < exportClause.namedChildCount; i++) {
      const spec = exportClause.namedChild(i);
      if (spec === null || spec.type !== 'export_specifier') continue;
      const decomposed = decomposeReexportSpecifier(spec, source, stmtNode);
      if (decomposed !== null) out.push(decomposed);
    }
    return out;
  }

  // `export * as ns from './m'` — tree-sitter-typescript emits a
  // `namespace_export` child whose identifier is the local re-export
  // name. Two facts are emitted:
  //
  //   1. An `@import.statement` (kind `reexport-namespace`) so finalize
  //      knows the barrel imports `./m` as `ns` (binds `ns` locally
  //      inside the barrel for consumers like `barrel.ts` calling
  //      `ns.X()`).
  //   2. A synthetic `@declaration.namespace` so the central
  //      scope-extractor adds a `Namespace` SymbolDefinition for `ns`
  //      to the barrel's `localDefs`. Without this, downstream files
  //      doing `import { ns } from './barrel'` cannot resolve `ns`:
  //      `findExportByName` and the precomputed re-export closure only
  //      consult `localDefs` / `reexport` / `wildcard` drafts, never
  //      `namespace`-kind imports. The synthetic declaration fixes that
  //      without growing the shared finalizer's surface.
  const namespaceExport = findChild(stmtNode, 'namespace_export');
  if (namespaceExport !== null) {
    const aliasId = findChild(namespaceExport, 'identifier');
    if (aliasId !== null) {
      return [
        buildImportMatch(stmtNode, {
          kind: 'reexport-namespace',
          source,
          name: source,
          alias: aliasId.text,
          atNode: namespaceExport,
        }),
        buildNamespaceDeclarationMatch(namespaceExport, aliasId),
      ];
    }
  }

  // `export * from './m'` — no clause, no namespace_export. The bare
  // `*` token is the only remaining marker; we don't need to inspect
  // it since the shape alone says "wildcard".
  return [
    buildImportMatch(stmtNode, {
      kind: 'reexport-wildcard',
      source,
      name: '*',
      atNode: stmtNode,
    }),
  ];
}

function decomposeReexportSpecifier(
  spec: SyntaxNode,
  source: string,
  stmtNode: SyntaxNode,
): CaptureMatch | null {
  const nameNode = spec.childForFieldName('name');
  const aliasNode = spec.childForFieldName('alias');
  if (nameNode === null) return null;
  const name = nameNode.text;

  if (aliasNode !== null && aliasNode.startIndex !== nameNode.startIndex) {
    return buildImportMatch(stmtNode, {
      kind: 'reexport-alias',
      source,
      name,
      alias: aliasNode.text,
      atNode: spec,
    });
  }
  return buildImportMatch(stmtNode, {
    kind: 'reexport',
    source,
    name,
    atNode: spec,
  });
}

// ─── dynamic imports ─────────────────────────────────────────────────────

function splitDynamicImport(callNode: SyntaxNode): CaptureMatch[] {
  // `call_expression` shape for dynamic imports:
  //   function: (import)                   — named leaf node in tree-sitter-typescript
  //   arguments: (arguments (string) ...)  — first arg is the path
  //
  // When the argument is a string literal, preserve its value. When it's
  // anything else (variable, template literal, member access), surface
  // the raw text for diagnostics and let `interpretTsImport` emit
  // `dynamic-unresolved` with a `targetRaw` hint.
  const args = callNode.childForFieldName('arguments');
  if (args === null) {
    return [
      buildImportMatch(callNode, {
        kind: 'dynamic',
        source: null,
        name: '',
        atNode: callNode,
      }),
    ];
  }

  const firstArg = args.namedChild(0);
  if (firstArg === null) {
    return [
      buildImportMatch(callNode, {
        kind: 'dynamic',
        source: null,
        name: '',
        atNode: callNode,
      }),
    ];
  }

  if (firstArg.type === 'string') {
    const source = stripQuotes(firstArg.text);
    return [
      buildImportMatch(callNode, {
        kind: 'dynamic',
        source,
        name: '',
        atNode: callNode,
        literalSource: true,
      }),
    ];
  }

  // Non-literal argument — preserve source text so downstream
  // diagnostics show what the user wrote.
  return [
    buildImportMatch(callNode, {
      kind: 'dynamic',
      source: firstArg.text,
      name: '',
      atNode: callNode,
    }),
  ];
}

// ─── helpers ─────────────────────────────────────────────────────────────

function extractSource(stmtNode: SyntaxNode): string | null {
  // Both `import_statement` and `export_statement` expose the module
  // path through the `source:` field. It's typed as `string` in the
  // grammar; we strip its surrounding quotes.
  const sourceField = stmtNode.childForFieldName('source');
  if (sourceField === null || sourceField.type !== 'string') return null;
  return stripQuotes(sourceField.text);
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed.charAt(0);
  const last = trimmed.charAt(trimmed.length - 1);
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === '`' && last === '`')
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function buildImportMatch(stmtNode: SyntaxNode, spec: ImportSpec): CaptureMatch {
  const m: Record<string, Capture> = {
    '@import.statement': nodeToCapture('@import.statement', stmtNode),
    '@import.kind': syntheticCapture('@import.kind', spec.atNode, spec.kind),
    '@import.name': syntheticCapture('@import.name', spec.atNode, spec.name),
  };
  if (spec.source !== null) {
    m['@import.source'] = syntheticCapture('@import.source', spec.atNode, spec.source);
  }
  if (spec.alias !== undefined) {
    m['@import.alias'] = syntheticCapture('@import.alias', spec.atNode, spec.alias);
  }
  if (spec.literalSource === true) {
    m['@import.literal'] = syntheticCapture('@import.literal', spec.atNode, '');
  }
  return m;
}

/** Synthesize a `@declaration.namespace` match for `export * as ns from './m'`.
 *  The central scope-extractor turns this into a `SymbolDefinition` of type
 *  `Namespace` in the barrel's `localDefs`, which makes `findExportByName`
 *  resolve `ns` for downstream `import { ns } from './barrel'` consumers. */
function buildNamespaceDeclarationMatch(
  namespaceExportNode: SyntaxNode,
  aliasId: SyntaxNode,
): CaptureMatch {
  return {
    '@declaration.namespace': nodeToCapture('@declaration.namespace', namespaceExportNode),
    '@declaration.name': nodeToCapture('@declaration.name', aliasId),
  };
}
