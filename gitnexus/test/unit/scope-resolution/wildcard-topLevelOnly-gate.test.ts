/**
 * M17 — the `export *` wildcard fan-out in `populateFileClosure`
 * (gitnexus-shared/src/scope-resolution/finalize-algorithm.ts) is gated by the
 * SAME `namedImportsBindTopLevelOnly` hook as the named-import path:
 *
 *   for (const [name, def] of (topLevelOnly ? indexTopLevelExportsByName : indexExportsByName)(...))
 *
 * Before this fix, the wildcard fan-out ALWAYS used the narrow (top-level-only)
 * index, regardless of the hook — silently adopting ECMAScript's `export *`
 * semantics (a class member can never be published by a bare wildcard
 * re-export) for every language, including ones (Python, Java, ...) whose
 * wildcard/star import legitimately republishes class members by name.
 *
 * This is below the extraction layer (RFC #909 Ring 2 PKG #921) — synthetic
 * `ParsedFile` input against `finalizeScopeModel` with a FAKE resolver
 * (`namedImportsBindTopLevelOnly` toggled directly), same technique as
 * `finalize-orchestrator.test.ts`. No real language parser involved; the
 * fixture below is deliberately language-agnostic (Vue, TypeScript, and
 * JavaScript all opt in through their language-specific scope resolvers).
 *
 * Fixture shape, held constant across both hook settings:
 *   B.ts:  class Foo with method `beta` — NO top-level `beta` declaration.
 *   A.ts:  `export * from './B'` (wildcard re-export; populates A's closure).
 *   C.ts:  `import { beta } from './A'` — resolves through A's closure, which
 *          the direct check on A's own (empty) localDefs never satisfies.
 */
import { describe, it, expect } from 'vitest';
import type { ParsedFile, ParsedImport, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';
import { vueScopeResolver } from '../../../src/core/ingestion/languages/vue/scope-resolver.js';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { javascriptScopeResolver } from '../../../src/core/ingestion/languages/javascript/scope-resolver.js';

const mkScope = (id: ScopeId, filePath: string): Scope => ({
  id,
  parent: null,
  kind: 'Module',
  range: { startLine: 1, startCol: 0, endLine: 100, endCol: 0 },
  filePath,
  bindings: new Map(),
  ownedDefs: [],
  imports: [],
  typeBindings: new Map(),
});

const mkFile = (filePath: string, overrides: Partial<ParsedFile> = {}): ParsedFile => ({
  filePath,
  moduleScope: `scope:${filePath}#module`,
  scopes: overrides.scopes ?? [mkScope(`scope:${filePath}#module`, filePath)],
  parsedImports: overrides.parsedImports ?? [],
  localDefs: overrides.localDefs ?? [],
  referenceSites: overrides.referenceSites ?? [],
});

function buildFixture(topLevelOnly: boolean) {
  // B.ts: a class with a method `beta`, and NO top-level `beta` of any kind.
  const fooClass: SymbolDefinition = {
    nodeId: 'def:Foo',
    filePath: 'B.ts',
    type: 'Class',
    qualifiedName: 'B.Foo',
  };
  const fooBetaMethod: SymbolDefinition = {
    nodeId: 'def:Foo.beta',
    filePath: 'B.ts',
    type: 'Method',
    ownerId: 'def:Foo',
    qualifiedName: 'B.Foo.beta',
  };
  const fileB = mkFile('B.ts', { localDefs: [fooClass, fooBetaMethod] });

  // A.ts: `export * from './B'` — a wildcard re-export, no local defs of its own.
  const wildcardImport: ParsedImport = { kind: 'wildcard', targetRaw: 'B.ts' };
  const fileA = mkFile('A.ts', { parsedImports: [wildcardImport] });

  // C.ts: `import { beta } from './A'`.
  const namedImport: ParsedImport = {
    kind: 'named',
    localName: 'beta',
    importedName: 'beta',
    targetRaw: 'A.ts',
  };
  const fileC = mkFile('C.ts', { parsedImports: [namedImport] });

  const out = finalizeScopeModel([fileB, fileA, fileC], {
    hooks: {
      resolveImportTarget: (targetRaw) => targetRaw,
      namedImportsBindTopLevelOnly: topLevelOnly,
    },
  });

  const cImports = out.imports.get(fileC.moduleScope) ?? [];
  return { out, fileC, fooBetaMethod, betaImport: cImports[0] };
}

describe('M17 — export * wildcard fan-out gated by namedImportsBindTopLevelOnly', () => {
  it('a language that does NOT opt in (Python/Java-shaped: hook false) publishes the class method through the wildcard — wide index preserved', () => {
    const { betaImport, fooBetaMethod } = buildFixture(false);
    expect(betaImport).toBeDefined();
    expect(betaImport!.linkStatus).toBeUndefined();
    expect(betaImport!.targetFile).toBe('A.ts');
    expect(betaImport!.targetDefId).toBe(fooBetaMethod.nodeId);
  });

  it('a language that DOES opt in (ECMAScript-shaped: hook true) refuses — the wildcard fan-out narrows to module-level declarations only', () => {
    const { betaImport } = buildFixture(true);
    expect(betaImport).toBeDefined();
    // Neither A's own (empty) localDefs nor A's wildcard-populated closure
    // (narrowed to MEMBER_LABELS-excluded defs) ever publish `beta` — the
    // import stays unresolved rather than binding a class member no
    // top-level name legitimizes.
    expect(betaImport!.linkStatus).toBe('unresolved');
    expect(betaImport!.targetDefId).toBeUndefined();
  });

  it('mutation check: a top-level (non-member) def behind the same wildcard still binds under EITHER setting', () => {
    // Control — proves the gate narrows MEMBER labels specifically, not
    // wildcard re-exports wholesale.
    for (const topLevelOnly of [false, true]) {
      const alphaVar: SymbolDefinition = {
        nodeId: 'def:alpha',
        filePath: 'B.ts',
        type: 'Variable',
        qualifiedName: 'B.alpha',
      };
      const fileB = mkFile('B.ts', { localDefs: [alphaVar] });
      const fileA = mkFile('A.ts', {
        parsedImports: [{ kind: 'wildcard', targetRaw: 'B.ts' }],
      });
      const fileC = mkFile('C.ts', {
        parsedImports: [
          { kind: 'named', localName: 'alpha', importedName: 'alpha', targetRaw: 'A.ts' },
        ],
      });
      const out = finalizeScopeModel([fileB, fileA, fileC], {
        hooks: {
          resolveImportTarget: (targetRaw) => targetRaw,
          namedImportsBindTopLevelOnly: topLevelOnly,
        },
      });
      const edge = out.imports.get(fileC.moduleScope)?.[0];
      expect(edge?.linkStatus, `topLevelOnly=${topLevelOnly}`).toBeUndefined();
      expect(edge?.targetDefId, `topLevelOnly=${topLevelOnly}`).toBe('def:alpha');
    }
  });

  it('Vue opts in (TS semantics); JS/TS themselves already do — every migrated resolver that sets the hook does so as `true`', () => {
    expect(vueScopeResolver.namedImportsBindTopLevelOnly).toBe(true);
    expect(typescriptScopeResolver.namedImportsBindTopLevelOnly).toBe(true);
    expect(javascriptScopeResolver.namedImportsBindTopLevelOnly).toBe(true);
  });
});
