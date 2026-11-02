/**
 * Unit coverage for `resolveSameNamespaceInheritanceBase`, the shared body of
 * `ScopeResolver.resolveImplicitInheritanceBase`. The inheritance pre-pass runs
 * before same-namespace sibling bindings exist, so this is what binds
 * `class C extends B` to the `B` of C's own namespace when another namespace
 * also declares a `B`. Rules pinned here:
 *
 *   - only candidates sharing the deriving class's namespace count
 *   - an unknown namespace (deriving class or candidate) never matches
 *   - several same-namespace candidates: nearest by shared leading path
 *     segments wins, a tie at that distance refuses
 *   - the deriving class itself and non-class-like defs are never answers
 *
 * Drives the function through a minimal cast `ScopeResolutionIndexes` (only
 * `qualifiedNames` / `defs`, the accessors it reads).
 */
import { describe, it, expect } from 'vitest';
import type { SymbolDefinition } from 'gitnexus-shared';
import { resolveSameNamespaceInheritanceBase } from '../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import type { ScopeResolutionIndexes } from '../../../src/core/ingestion/model/scope-resolution-indexes.js';

const BASE = 'B';
const DERIVING_FILE = 'app/src/main/java/com/acme/core/C.java';

interface Candidate {
  readonly nodeId: string;
  readonly filePath: string;
  readonly type?: string;
}

/** `filePath -> namespace`; a path missing from the table has no known namespace. */
const NAMESPACES: Readonly<Record<string, string>> = {
  [DERIVING_FILE]: 'com.acme.core',
  'app/src/main/java/com/acme/core/B.java': 'com.acme.core',
  'app/src/test/java/com/acme/core/B.java': 'com.acme.core',
  'lib/src/main/java/com/acme/core/B.java': 'com.acme.core',
  'tools/src/main/java/com/acme/core/B.java': 'com.acme.core',
  'app/src/main/java/com/acme/legacy/B.java': 'com.acme.legacy',
};

function resolve(
  candidates: readonly Candidate[],
  derivingFile = DERIVING_FILE,
): string | undefined {
  const defs = new Map<string, SymbolDefinition>();
  for (const c of candidates) {
    defs.set(c.nodeId, {
      nodeId: c.nodeId,
      filePath: c.filePath,
      type: c.type ?? 'Class',
    } as SymbolDefinition);
  }
  const ids = candidates.map((c) => c.nodeId);
  const scopes = {
    qualifiedNames: { get: (name: string) => (name === BASE ? ids : []) },
    defs: { get: (id: string) => defs.get(id) },
  } as unknown as ScopeResolutionIndexes;
  const deriving = { nodeId: 'd:self', filePath: derivingFile, type: 'Class' } as SymbolDefinition;
  return resolveSameNamespaceInheritanceBase(
    BASE,
    deriving,
    scopes,
    (def) => NAMESPACES[def.filePath],
  )?.nodeId;
}

const CORE_B = { nodeId: 'd:core', filePath: 'app/src/main/java/com/acme/core/B.java' };
const LEGACY_B = { nodeId: 'd:legacy', filePath: 'app/src/main/java/com/acme/legacy/B.java' };
const TEST_ROOT_B = { nodeId: 'd:test', filePath: 'app/src/test/java/com/acme/core/B.java' };
const LIB_B = { nodeId: 'd:lib', filePath: 'lib/src/main/java/com/acme/core/B.java' };
const TOOLS_B = { nodeId: 'd:tools', filePath: 'tools/src/main/java/com/acme/core/B.java' };

describe('resolveSameNamespaceInheritanceBase', () => {
  it.each<[string, readonly Candidate[], string | undefined]>([
    ['binds the one candidate in its own namespace', [LEGACY_B, CORE_B], 'd:core'],
    ['declines when no candidate shares its namespace', [LEGACY_B], undefined],
    ['prefers the nearest of several same-namespace candidates', [LIB_B, TEST_ROOT_B], 'd:test'],
    ['refuses a tie at the nearest distance', [LIB_B, TOOLS_B], undefined],
    [
      'never answers with a candidate whose namespace is unknown',
      [{ nodeId: 'd:unknown', filePath: 'gen/B.java' }],
      undefined,
    ],
    [
      'never answers with the deriving class itself',
      [{ nodeId: 'd:self', filePath: DERIVING_FILE }],
      undefined,
    ],
    ['ignores a non-class-like def', [{ ...CORE_B, type: 'Method' }], undefined],
  ])('%s', (_title, candidates, expected) => {
    expect(resolve(candidates)).toBe(expected);
  });

  it('declines when the deriving class has no known namespace', () => {
    expect(resolve([CORE_B], 'gen/C.java')).toBeUndefined();
  });
});
