/**
 * TypeScript `import type` → `IMPORTS` edge `reason`, end to end.
 *
 * The erasure fact crosses four modules on its way to `check --cycles`:
 * `import-decomposer.ts` reads the `type` keyword, `interpret.ts` puts it on
 * the `ParsedImport`, `finalize-algorithm.ts` carries it onto the `ImportEdge`,
 * and `imports-to-edges.ts` turns it into a reason suffix. Each has its own
 * unit coverage; this file asserts the joint, because a break anywhere in the
 * chain looks the same from the end — an erased import counted as a module
 * initialization dependency, which is what makes `check --cycles` report eight
 * cycles `tsc` erases.
 *
 * Real source text goes in and a reason string comes out. Nothing in between
 * is posed except the workspace's file list and the scope tree, which stand in
 * for the parts of the pipeline this fact does not travel through.
 */
import { describe, expect, it } from 'vitest';
import {
  finalize,
  type FinalizeFile,
  type FinalizeHooks,
  type ParsedImport,
} from 'gitnexus-shared';
import { emitTsScopeCaptures } from '../../../../src/core/ingestion/languages/typescript/captures.js';
import { interpretTsImport } from '../../../../src/core/ingestion/languages/typescript/interpret.js';
import {
  DEFERRED_IMPORT_REASON_SUFFIX,
  TYPE_ONLY_IMPORT_REASON_SUFFIX,
  emitImportEdges,
} from '../../../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.js';

const SOURCE_FILE = 'src/a.ts';
const TARGET_FILE = 'src/b.ts';
const MODULE_SCOPE = 'scope:src/a.ts#1:0-9999:0:Module';
const BASE_REASON = 'typescript-scope: import';

/** Every `ParsedImport` the real TypeScript capture + interpret path yields. */
function parseImports(src: string): ParsedImport[] {
  return emitTsScopeCaptures(src, SOURCE_FILE)
    .filter((m) => m['@import.statement'] !== undefined)
    .map((m) => interpretTsImport(m))
    .filter((p): p is ParsedImport => p !== null);
}

/** `resolveImportTarget` that knows exactly one module: `./b` → src/b.ts. */
const hooks: FinalizeHooks = {
  resolveImportTarget: (targetRaw) => (targetRaw === './b' ? TARGET_FILE : null),
  expandsWildcardTo: () => [],
  mergeBindings: (existing, incoming) => [...existing, ...incoming],
};

/**
 * The `reason` on the single `src/a.ts → src/b.ts` edge that `src` produces.
 *
 * `scopeKind` is the scope the imports are attached to — `'Module'` for the
 * top level, `'Function'` to pose the deferred case that has to lose to a real
 * import and beat an erased one.
 */
function reasonFor(src: string, scopeKind: 'Module' | 'Function' = 'Module'): string | undefined {
  const a: FinalizeFile = {
    filePath: SOURCE_FILE,
    moduleScope: MODULE_SCOPE as FinalizeFile['moduleScope'],
    localDefs: [],
    parsedImports: parseImports(src),
  };
  const b: FinalizeFile = {
    filePath: TARGET_FILE,
    moduleScope: 'scope:src/b.ts#1:0-9999:0:Module' as FinalizeFile['moduleScope'],
    localDefs: [
      { nodeId: 'def:b.X', filePath: TARGET_FILE, type: 'Class', qualifiedName: 'b.X' },
      { nodeId: 'def:b.Y', filePath: TARGET_FILE, type: 'Class', qualifiedName: 'b.Y' },
      { nodeId: 'def:b.default', filePath: TARGET_FILE, type: 'Class', qualifiedName: 'b.default' },
    ],
    parsedImports: [],
  };
  const out = finalize({ files: [a, b], workspaceIndex: undefined }, hooks);

  const rels: Array<{ reason: string }> = [];
  const scopeTree = {
    getScope: () => ({ id: MODULE_SCOPE, parent: null, kind: scopeKind, filePath: SOURCE_FILE }),
  };
  emitImportEdges(
    { addRelationship: (r: { reason: string }) => rels.push(r) } as never,
    out.imports as never,
    scopeTree as never,
    BASE_REASON,
  );
  expect(rels.length).toBeLessThanOrEqual(1);
  return rels[0]?.reason;
}

const PLAIN = BASE_REASON;
const TYPE_ONLY = `${BASE_REASON}${TYPE_ONLY_IMPORT_REASON_SUFFIX}`;
const DEFERRED = `${BASE_REASON}${DEFERRED_IMPORT_REASON_SUFFIX}`;

describe('type-only imports reach the IMPORTS reason', () => {
  it.each([
    ['import type { X } from "./b";', TYPE_ONLY],
    ['import type { X, Y } from "./b";', TYPE_ONLY],
    ['import { type X } from "./b";', TYPE_ONLY],
    ['import { type X as Y } from "./b";', TYPE_ONLY],
    ['import type D from "./b";', TYPE_ONLY],
    ['import type * as N from "./b";', TYPE_ONLY],
    ['export type { X } from "./b";', TYPE_ONLY],
    ['export { type X } from "./b";', TYPE_ONLY],
  ])('%s → %s', (src, expected) => {
    expect(reasonFor(src)).toBe(expected);
  });

  it.each([
    ['import { X } from "./b";', PLAIN],
    ['import D from "./b";', PLAIN],
    ['import * as N from "./b";', PLAIN],
    ['export { X } from "./b";', PLAIN],
    ['import "./b";', PLAIN],
  ])('%s stays a real initialization dependency → %s', (src, expected) => {
    expect(reasonFor(src)).toBe(expected);
  });
});

describe('a mixed statement is an initialization dependency', () => {
  it.each([
    'import { type X, Y } from "./b";',
    'import { X, type Y } from "./b";',
    'import { type X as A, Y } from "./b";',
    'export { type X, Y } from "./b";',
  ])('%s — one runtime specifier carries the pair', (src) => {
    // The whole reason the marker is per specifier. Treating the clause as
    // type-only because SOME specifier is would hide `Y`, a real runtime
    // import of `./b`, and with it any cycle it takes part in.
    expect(reasonFor(src)).toBe(PLAIN);
  });

  it('separate statements compose the same way', () => {
    expect(reasonFor('import type { X } from "./b";\nimport { Y } from "./b";')).toBe(PLAIN);
    expect(reasonFor('import { Y } from "./b";\nimport type { X } from "./b";')).toBe(PLAIN);
  });

  it('every specifier type-only, spread over statements, still erases', () => {
    expect(reasonFor('import type { X } from "./b";\nimport type { Y } from "./b";')).toBe(
      TYPE_ONLY,
    );
  });
});

describe('type-only against deferred', () => {
  it('a deferred import beside a type-only one wins — the module does load', () => {
    // `scopeKind: 'Function'` makes the plain `import { Y }` deferred; the
    // `import type { X }` beside it is erased. Deferred is the honest answer.
    expect(reasonFor('import type { X } from "./b";\nimport { Y } from "./b";', 'Function')).toBe(
      DEFERRED,
    );
  });

  it('erasure still wins when the erased import is the only one', () => {
    expect(reasonFor('import type { X } from "./b";', 'Function')).toBe(TYPE_ONLY);
  });
});
