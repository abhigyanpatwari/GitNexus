/**
 * `export *` collision detection honours EXPORT EVIDENCE (`SymbolDefinition.
 * isExported`, tri-state) — review findings on #3182 (finalize-algorithm.ts:1026
 * and typescript/scope-resolver.ts:138).
 *
 * Two defects, one mechanism:
 *
 *  1. `Variable` was excluded from the collision candidates while the closure
 *     path (`indexTopLevelExportsByName`) retained it, so two sources each
 *     exporting `const alpha` were BOTH published and first-wins silently bound
 *     one of them despite `exclusiveWildcardReexports`.
 *  2. A module-PRIVATE `function foo` in one source counted as a provider, so a
 *     genuinely exported `foo` in the other source was refused as a collision —
 *     and, without the refusal, the private one could have been the closure's
 *     first-listed winner.
 *
 * With evidence: an exported `Variable` collides; a private `function` neither
 * collides nor binds. Without evidence the prior behaviour is unchanged.
 */
import { describe, it, expect } from 'vitest';
import type { ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import { finalizeScopeModel } from '../../../src/core/ingestion/finalize-orchestrator.js';

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
  scopes: [mkScope(`scope:${filePath}#module`, filePath)],
  parsedImports: overrides.parsedImports ?? [],
  localDefs: overrides.localDefs ?? [],
  referenceSites: [],
});

const def = (
  nodeId: string,
  filePath: string,
  type: SymbolDefinition['type'],
  name: string,
  isExported?: boolean,
): SymbolDefinition => ({
  nodeId,
  filePath,
  type,
  qualifiedName: name,
  ...(isExported !== undefined ? { isExported } : {}),
});

/** barrel.ts: `export * from './a'; export * from './b'`; c.ts imports `name` from it. */
function run(aDefs: SymbolDefinition[], bDefs: SymbolDefinition[], name: string) {
  const a = mkFile('a.ts', { localDefs: aDefs });
  const b = mkFile('b.ts', { localDefs: bDefs });
  const barrel = mkFile('barrel.ts', {
    parsedImports: [
      { kind: 'wildcard', targetRaw: 'a.ts' },
      { kind: 'wildcard', targetRaw: 'b.ts' },
    ],
  });
  const c = mkFile('c.ts', {
    parsedImports: [{ kind: 'named', localName: name, importedName: name, targetRaw: 'barrel.ts' }],
  });
  const out = finalizeScopeModel([a, b, barrel, c], {
    hooks: {
      resolveImportTarget: (targetRaw) => targetRaw,
      namedImportsBindTopLevelOnly: true,
      wildcardCollisionIsAmbiguous: true,
    },
  });
  return {
    edge: out.imports.get(c.moduleScope)?.[0],
    ambiguous: out.stats.ambiguousWildcardExports,
  };
}

describe('export * collisions with export evidence', () => {
  it('refuses conflicting named re-exports without reporting an export-star collision', () => {
    const a = mkFile('a.ts', { localDefs: [def('a:alpha', 'a.ts', 'Function', 'alpha', true)] });
    const b = mkFile('b.ts', { localDefs: [def('b:alpha', 'b.ts', 'Function', 'alpha', true)] });
    const barrel = mkFile('barrel.ts', {
      parsedImports: [
        {
          kind: 'named',
          targetRaw: 'a.ts',
          localName: 'alpha',
          importedName: 'alpha',
          reexportsName: true,
        },
        {
          kind: 'named',
          targetRaw: 'b.ts',
          localName: 'alpha',
          importedName: 'alpha',
          reexportsName: true,
        },
      ],
    });
    const caller = mkFile('caller.ts', {
      parsedImports: [
        { kind: 'named', targetRaw: 'barrel.ts', localName: 'alpha', importedName: 'alpha' },
      ],
    });
    const out = finalizeScopeModel([a, b, barrel, caller], {
      hooks: {
        resolveImportTarget: (targetRaw) => targetRaw,
        namedImportsBindTopLevelOnly: true,
        wildcardCollisionIsAmbiguous: true,
      },
    });
    expect(out.imports.get(caller.moduleScope)?.[0]?.linkStatus).toBe('unresolved');
    expect(out.stats.ambiguousWildcardExports).toEqual([]);
  });

  it('two sources each EXPORTING `const alpha` collide — refused, not first-wins', () => {
    const { edge, ambiguous } = run(
      [def('def:a.alpha', 'a.ts', 'Variable', 'alpha', true)],
      [def('def:b.alpha', 'b.ts', 'Variable', 'alpha', true)],
      'alpha',
    );
    expect(edge?.linkStatus).toBe('unresolved');
    expect(edge?.targetDefId).toBeUndefined();
    expect(ambiguous.map((x) => x.name)).toEqual(['alpha']);
    expect([...(ambiguous[0]?.candidateDefIds ?? [])].sort()).toEqual([
      'def:a.alpha',
      'def:b.alpha',
    ]);
  });

  it('a module-PRIVATE `function foo` beside an exported one is not a provider: the export binds', () => {
    const { edge, ambiguous } = run(
      [def('def:a.foo', 'a.ts', 'Function', 'foo', true)],
      [def('def:b.foo', 'b.ts', 'Function', 'foo', false)],
      'foo',
    );
    expect(ambiguous).toEqual([]);
    expect(edge?.linkStatus).toBeUndefined();
    expect(edge?.targetDefId).toBe('def:a.foo');
  });

  it('the private one is never the closure winner either, whichever source is listed first', () => {
    // b (private) is listed AFTER a here, but a is the one that exports — swap
    // the roles so the private def sits in the FIRST wildcard source.
    const { edge } = run(
      [def('def:a.foo', 'a.ts', 'Function', 'foo', false)],
      [def('def:b.foo', 'b.ts', 'Function', 'foo', true)],
      'foo',
    );
    expect(edge?.targetDefId).toBe('def:b.foo');
  });

  it('a private def alone behind the barrel is NOT published through `export *`', () => {
    const { edge } = run([def('def:a.foo', 'a.ts', 'Function', 'foo', false)], [], 'foo');
    expect(edge?.linkStatus).toBe('unresolved');
  });

  it('a class MEMBER of the barrel named like the collision does not shadow it (magyargergo)', () => {
    // `export class Unrelated { clash() {} }` in the barrel made `clash` a local
    // name, switched the collision check off, and a confident edge to a.ts went out.
    const a = mkFile('a.ts', {
      localDefs: [def('def:a.clash', 'a.ts', 'Function', 'clash', true)],
    });
    const b = mkFile('b.ts', {
      localDefs: [def('def:b.clash', 'b.ts', 'Function', 'clash', true)],
    });
    const unrelated = def('def:Unrelated', 'barrel.ts', 'Class', 'Unrelated', true);
    const member: SymbolDefinition = {
      nodeId: 'def:Unrelated.clash',
      filePath: 'barrel.ts',
      type: 'Method',
      qualifiedName: 'Unrelated.clash',
      ownerId: 'def:Unrelated',
      isExported: false,
    };
    const barrel = mkFile('barrel.ts', {
      localDefs: [unrelated, member],
      parsedImports: [
        { kind: 'wildcard', targetRaw: 'a.ts' },
        { kind: 'wildcard', targetRaw: 'b.ts' },
      ],
    });
    const c = mkFile('c.ts', {
      parsedImports: [
        { kind: 'named', localName: 'clash', importedName: 'clash', targetRaw: 'barrel.ts' },
      ],
    });
    for (const memberEvidence of [member, { ...member, isExported: undefined }]) {
      const out = finalizeScopeModel(
        [a, b, { ...barrel, localDefs: [unrelated, memberEvidence] }, c],
        {
          hooks: {
            resolveImportTarget: (targetRaw) => targetRaw,
            namedImportsBindTopLevelOnly: true,
            wildcardCollisionIsAmbiguous: true,
          },
        },
      );
      const edge = out.imports.get(c.moduleScope)?.[0];
      expect(edge?.linkStatus).toBe('unresolved');
      expect(out.stats.ambiguousWildcardExports.map((x) => x.name)).toEqual(['clash']);
    }
  });

  it('without evidence, behaviour is unchanged: functions collide, Variables do not', () => {
    const fns = run(
      [def('def:a.foo', 'a.ts', 'Function', 'foo')],
      [def('def:b.foo', 'b.ts', 'Function', 'foo')],
      'foo',
    );
    expect(fns.edge?.linkStatus).toBe('unresolved');
    expect(fns.ambiguous.map((x) => x.name)).toEqual(['foo']);
    const vars = run(
      [def('def:a.alpha', 'a.ts', 'Variable', 'alpha')],
      [def('def:b.alpha', 'b.ts', 'Variable', 'alpha')],
      'alpha',
    );
    expect(vars.ambiguous).toEqual([]);
    expect(vars.edge?.targetDefId).toBe('def:a.alpha');
  });
});
