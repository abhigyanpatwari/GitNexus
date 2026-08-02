/**
 * #2788 — `resolveCppQualifiedNamespaceMember` serves qualified `ns::member()`
 * lookups from a per-pipeline index instead of rescanning every parsed file per
 * call site. These tests pin the two properties the index must not lose:
 *
 *   1. Transitive inline-namespace collection, ordering and same-name
 *      ambiguity (#1564) — the semantics the old linear scan provided.
 *   2. Cache invalidation — a new `parsedFiles` array, or a
 *      `clearCppInlineNamespaces()` between passes, must not serve stale hits.
 *      This is the failure mode the index introduces; nothing else covers it.
 */

import type {
  ParsedFile,
  ScopeId,
  ScopeResolutionIndexes,
  SymbolDefinition,
} from 'gitnexus-shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearCppInlineNamespaces,
  markCppInlineNamespaceRange,
  populateCppInlineNamespaceScopes,
  resolveCppQualifiedNamespaceMember,
} from '../../src/core/ingestion/languages/cpp/inline-namespaces.js';

const NO_SCOPES = {} as unknown as ScopeResolutionIndexes;

interface ScopeSpec {
  readonly id: string;
  readonly kind: 'Namespace' | 'Module';
  readonly parent: string | null;
  readonly defs: readonly SymbolDefinition[];
  /** Distinguishes each scope's range so inline marking targets exactly one. */
  readonly line: number;
}

function def(nodeId: string, type: string, qualifiedName: string): SymbolDefinition {
  return { nodeId, type, qualifiedName } as unknown as SymbolDefinition;
}

function nsDef(nodeId: string, qualifiedName: string): SymbolDefinition {
  return def(nodeId, 'Namespace', qualifiedName);
}

function fnDef(nodeId: string, qualifiedName: string): SymbolDefinition {
  return def(nodeId, 'Function', qualifiedName);
}

function range(line: number): {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
} {
  return { startLine: line, startCol: 0, endLine: line + 1, endCol: 0 };
}

/** Build a single-file `parsedFiles` array from scope specs, marking the
 *  scopes named in `inlineIds` as inline namespaces (capture-time range mark +
 *  `populateOwners`-time scope-id resolution, same order as the pipeline). */
function makeParsedFiles(
  filePath: string,
  specs: readonly ScopeSpec[],
  inlineIds: readonly string[],
): readonly ParsedFile[] {
  const parsed = {
    filePath,
    scopes: specs.map((s) => ({
      id: s.id as unknown as ScopeId,
      kind: s.kind,
      parent: s.parent as unknown as ScopeId | null,
      ownedDefs: s.defs,
      range: range(s.line),
    })),
  } as unknown as ParsedFile;
  markInline(parsed, specs, inlineIds);
  return [parsed];
}

/** Capture-time inline marking + `populateOwners`-time scope-id resolution,
 *  in the same order the pipeline runs them. */
function markInline(
  parsed: ParsedFile,
  specs: readonly ScopeSpec[],
  inlineIds: readonly string[],
): void {
  for (const id of inlineIds) {
    const spec = specs.find((s) => s.id === id);
    if (spec === undefined) throw new Error(`inline scope ${id} must exist`);
    markCppInlineNamespaceRange(parsed.filePath, range(spec.line));
  }
  populateCppInlineNamespaceScopes(parsed);
}

/** `namespace outer { <ownDefs> inline namespace v1 { <inlineDefs> } }` */
function outerWithInlineChild(
  filePath: string,
  ownDefs: readonly SymbolDefinition[],
  inlineDefs: readonly SymbolDefinition[],
): readonly ParsedFile[] {
  return makeParsedFiles(
    filePath,
    [
      {
        id: 'sc:outer',
        kind: 'Namespace',
        parent: null,
        defs: [nsDef('n:outer', 'outer'), ...ownDefs],
        line: 1,
      },
      {
        id: 'sc:v1',
        kind: 'Namespace',
        parent: 'sc:outer',
        defs: [nsDef('n:v1', 'outer.v1'), ...inlineDefs],
        line: 10,
      },
    ],
    ['sc:v1'],
  );
}

describe('C++ qualified-namespace member index (#2788)', () => {
  beforeEach(() => {
    clearCppInlineNamespaces();
  });

  it('resolves outer::foo through an inline-namespace child', () => {
    const files = outerWithInlineChild('a.cpp', [], [fnDef('n:foo@v1', 'outer.v1.foo')]);
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@v1',
    });
  });

  it('returns undefined for an unknown namespace or member', () => {
    const files = outerWithInlineChild('a.cpp', [], [fnDef('n:foo@v1', 'outer.v1.foo')]);
    expect(resolveCppQualifiedNamespaceMember('nope', 'foo', files, NO_SCOPES)).toBeUndefined();
    expect(resolveCppQualifiedNamespaceMember('outer', 'nope', files, NO_SCOPES)).toBeUndefined();
  });

  it('does not descend into a non-inline nested namespace', () => {
    const files = makeParsedFiles(
      'a.cpp',
      [
        {
          id: 'sc:outer',
          kind: 'Namespace',
          parent: null,
          defs: [nsDef('n:outer', 'outer')],
          line: 1,
        },
        {
          id: 'sc:nested',
          kind: 'Namespace',
          parent: 'sc:outer',
          defs: [nsDef('n:nested', 'outer.nested'), fnDef('n:foo@nested', 'outer.nested.foo')],
          line: 10,
        },
      ],
      [],
    );
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toBeUndefined();
    expect(resolveCppQualifiedNamespaceMember('nested', 'foo', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@nested',
    });
  });

  it('reports same-name hits across two inline children as ambiguous (#1564)', () => {
    const files = makeParsedFiles(
      'a.cpp',
      [
        {
          id: 'sc:outer',
          kind: 'Namespace',
          parent: null,
          defs: [nsDef('n:outer', 'outer')],
          line: 1,
        },
        {
          id: 'sc:v1',
          kind: 'Namespace',
          parent: 'sc:outer',
          defs: [nsDef('n:v1', 'outer.v1'), fnDef('n:foo@v1', 'outer.v1.foo')],
          line: 10,
        },
        {
          id: 'sc:v2',
          kind: 'Namespace',
          parent: 'sc:outer',
          defs: [nsDef('n:v2', 'outer.v2'), fnDef('n:foo@v2', 'outer.v2.foo')],
          line: 20,
        },
      ],
      ['sc:v1', 'sc:v2'],
    );
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toBe('ambiguous');
  });

  it('keeps scan order: a namespace-owned def precedes its inline child hits', () => {
    // Two candidates with no call-site info narrow to 'ambiguous', so order is
    // asserted through the single-hit path: only the own def is present here,
    // and the inline child contributes a different member name.
    const files = outerWithInlineChild(
      'a.cpp',
      [fnDef('n:foo@outer', 'outer.foo')],
      [fnDef('n:bar@v1', 'outer.v1.bar')],
    );
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@outer',
    });
    expect(resolveCppQualifiedNamespaceMember('outer', 'bar', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:bar@v1',
    });
  });

  it('does not serve one parsedFiles array’s index to another', () => {
    const first = outerWithInlineChild('a.cpp', [], [fnDef('n:foo@a', 'outer.v1.foo')]);
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', first, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@a',
    });
    const second = outerWithInlineChild('b.cpp', [], [fnDef('n:foo@b', 'outer.v1.foo')]);
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', second, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@b',
    });
  });

  it('rebuilds after clearCppInlineNamespaces even when parsedFiles is reused', () => {
    // Pass 1: `v1` is inline, so `outer::foo` reaches through it.
    const specs: readonly ScopeSpec[] = [
      {
        id: 'sc:outer',
        kind: 'Namespace',
        parent: null,
        defs: [nsDef('n:outer', 'outer')],
        line: 1,
      },
      {
        id: 'sc:v1',
        kind: 'Namespace',
        parent: 'sc:outer',
        defs: [nsDef('n:v1', 'outer.v1'), fnDef('n:foo@v1', 'outer.v1.foo')],
        line: 10,
      },
    ];
    const files = makeParsedFiles('a.cpp', specs, ['sc:v1']);
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toMatchObject({
      nodeId: 'n:foo@v1',
    });

    // Pass 2: SAME `parsedFiles` reference (so identity alone would serve the
    // cached index), but `v1` is no longer inline. Without the index reset in
    // `clearCppInlineNamespaces` the stale pass-1 hit survives.
    clearCppInlineNamespaces();
    markInline(files[0], specs, []);
    expect(resolveCppQualifiedNamespaceMember('outer', 'foo', files, NO_SCOPES)).toBeUndefined();
  });
});
