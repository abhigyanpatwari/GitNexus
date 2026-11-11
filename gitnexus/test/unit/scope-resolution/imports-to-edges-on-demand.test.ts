/**
 * On-demand wildcard imports emit an IMPORTS edge only to the files whose
 * names the importer mentions (#3695).
 *
 * `import pkg.*;` resolves to every file declaring `pkg`. Emitting all of them
 * is importers × package size; the narrowing keeps the edges a file can
 * actually use and must never drop one it does.
 */
import { describe, expect, it } from 'vitest';
import type {
  BindingRef,
  GraphRelationship,
  ImportEdge,
  Scope,
  ScopeId,
  ScopeTree,
} from 'gitnexus-shared';
import { buildScopeTree } from 'gitnexus-shared';
import {
  emitImportEdges,
  type MentionedNamesOf,
} from '../../../src/core/ingestion/scope-resolution/graph-bridge/imports-to-edges.js';
import { javaNamesMentionedIn } from '../../../src/core/ingestion/languages/java/mentioned-names.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';

/** A module scope whose lexical bindings are `names` — what a file exports. */
function moduleScope(filePath: string, names: readonly string[] = []): Scope {
  return {
    id: `scope:${filePath}` as ScopeId,
    filePath,
    parent: null,
    kind: 'Module',
    range: { startLine: 0, startCol: 0, endLine: 10, endCol: 0 },
    bindings: new Map(names.map((name): [string, readonly BindingRef[]] => [name, []])),
    typeBindings: new Map(),
    ownedDefs: [],
    imports: [],
  };
}

/** The edge finalize leaves for `import pkg.*;` — unexpanded, one per file. */
function packageWildcard(targetFile: string, extra: Partial<ImportEdge> = {}): ImportEdge {
  return {
    localName: '',
    targetFile,
    targetExportedName: '',
    kind: 'wildcard-expanded',
    targetModuleScope: `scope:${targetFile}` as ScopeId,
    ...extra,
  };
}

function named(targetFile: string, localName: string): ImportEdge {
  return { localName, targetFile, targetExportedName: localName, kind: 'named' };
}

function emit(
  edges: readonly ImportEdge[],
  tree: ScopeTree,
  mentionedNamesOf: MentionedNamesOf | undefined,
): string[] {
  const emitted: GraphRelationship[] = [];
  emitImportEdges(
    { addRelationship: (rel: GraphRelationship) => emitted.push(rel) } as unknown as KnowledgeGraph,
    new Map([['scope:app/Main.java' as ScopeId, Object.freeze([...edges])]]),
    tree,
    'java-scope: import',
    mentionedNamesOf,
  );
  return emitted.map((rel) => `${rel.targetId}${rel.reason.replace('java-scope: import', '')}`);
}

const PACKAGE = [
  moduleScope('app/Main.java', ['Main']),
  moduleScope('models/User.java', ['User']),
  moduleScope('models/Order.java', ['Order']),
  moduleScope('models/Pair.java', ['Pair', 'PairHelper']),
  moduleScope('models/package-info.java'),
];
const WILDCARD = [
  packageWildcard('models/User.java'),
  packageWildcard('models/Order.java'),
  packageWildcard('models/Pair.java'),
  packageWildcard('models/package-info.java'),
];
const mentions =
  (...names: string[]): MentionedNamesOf =>
  () =>
    new Set(names);

describe('emitImportEdges — on-demand wildcard imports', () => {
  it('emits only the package files whose names the importer mentions', () => {
    expect(emit(WILDCARD, buildScopeTree(PACKAGE), mentions('Main', 'User', 'save'))).toEqual([
      'File:models/User.java',
    ]);
  });

  it('keeps a file when any one of its names is mentioned', () => {
    expect(emit(WILDCARD, buildScopeTree(PACKAGE), mentions('PairHelper'))).toEqual([
      'File:models/Pair.java',
    ]);
  });

  it('emits nothing for a wildcard import the file never uses', () => {
    expect(emit(WILDCARD, buildScopeTree(PACKAGE), mentions('Main'))).toEqual([]);
  });

  it('emits every resolved file when the provider does not narrow', () => {
    expect(emit(WILDCARD, buildScopeTree(PACKAGE), undefined)).toEqual([
      'File:models/User.java',
      'File:models/Order.java',
      'File:models/Pair.java',
      'File:models/package-info.java',
    ]);
  });

  it('emits every resolved file when the source text is unavailable', () => {
    expect(emit(WILDCARD, buildScopeTree(PACKAGE), () => undefined)).toEqual([
      'File:models/User.java',
      'File:models/Order.java',
      'File:models/Pair.java',
      'File:models/package-info.java',
    ]);
  });

  it('keeps an edge whose target scope the tree cannot produce', () => {
    const tree = buildScopeTree([moduleScope('app/Main.java', ['Main'])]);
    expect(emit([packageWildcard('models/User.java')], tree, mentions('Main'))).toEqual([
      'File:models/User.java',
    ]);
  });

  it('never narrows an explicit import, used or not', () => {
    const edges = [named('models/Order.java', 'Order'), ...WILDCARD];
    expect(emit(edges, buildScopeTree(PACKAGE), mentions('User'))).toEqual([
      'File:models/Order.java',
      'File:models/User.java',
    ]);
  });

  it('decides an expanded wildcard edge by the name it binds', () => {
    const edges = [
      packageWildcard('models/Pair.java', { localName: 'Pair', targetExportedName: 'Pair' }),
      packageWildcard('models/User.java', { localName: 'User', targetExportedName: 'User' }),
    ];
    // `PairHelper` is bound by Pair.java's module scope but not by this edge.
    expect(emit(edges, buildScopeTree(PACKAGE), mentions('PairHelper', 'User'))).toEqual([
      'File:models/User.java',
    ]);
  });

  it('lets a surviving wildcard edge carry its own presence rank', () => {
    const edges = [
      packageWildcard('models/User.java', { runsOnlyWhenCalled: true }),
      packageWildcard('models/Order.java', { runsOnlyWhenCalled: true }),
    ];
    expect(emit(edges, buildScopeTree(PACKAGE), mentions('User'))).toEqual([
      'File:models/User.java (deferred)',
    ]);
  });

  it('asks for the mention set once per source file and only when a wildcard needs it', () => {
    const asked: string[] = [];
    const recording: MentionedNamesOf = (sourceFile) => {
      asked.push(sourceFile);
      return new Set(['User']);
    };
    emit(WILDCARD, buildScopeTree(PACKAGE), recording);
    emit([named('models/Order.java', 'Order')], buildScopeTree(PACKAGE), recording);
    expect(asked).toEqual(['app/Main.java']);
  });

  it('narrows interleaved source files through the global collector', () => {
    const tree = buildScopeTree([
      ...PACKAGE,
      moduleScope('app/Other.java', ['Other']),
      { ...moduleScope('app/Main.java'), id: 'scope:app/Main.java#late' as ScopeId },
    ]);
    const emitted: GraphRelationship[] = [];
    emitImportEdges(
      {
        addRelationship: (rel: GraphRelationship) => emitted.push(rel),
      } as unknown as KnowledgeGraph,
      new Map([
        ['scope:app/Main.java' as ScopeId, [packageWildcard('models/User.java')]],
        ['scope:app/Other.java' as ScopeId, [packageWildcard('models/User.java')]],
        ['scope:app/Main.java#late' as ScopeId, [packageWildcard('models/Order.java')]],
      ]),
      tree,
      'java-scope: import',
      (sourceFile) => new Set(sourceFile === 'app/Main.java' ? ['Order'] : ['User']),
    );
    expect(emitted.map((rel) => rel.id)).toEqual([
      'IMPORTS:app/Other.java->models/User.java',
      'IMPORTS:app/Main.java->models/Order.java',
    ]);
  });
});

describe('javaNamesMentionedIn', () => {
  it('collects every identifier the source spells', () => {
    const names = javaNamesMentionedIn(
      [
        'package app;',
        'import static models.Utils.*;',
        'public class Main {',
        '  @Audited Object run(Object o) throws BizException {',
        '    return (Order) o instanceof User ? Pair.class : null;',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(
      ['Utils', 'Audited', 'BizException', 'Order', 'User', 'Pair', 'Missing'].filter((name) =>
        names.has(name),
      ),
    ).toEqual(['Utils', 'Audited', 'BizException', 'Order', 'User', 'Pair']);
  });

  it('reads Java identifier characters beyond ASCII letters', () => {
    const names = javaNamesMentionedIn('订单 a = new $Proxy_1(); Größe b; x2y c;');
    expect(['订单', '$Proxy_1', 'Größe', 'x2y', '2y', 'Proxy'].filter((n) => names.has(n))).toEqual(
      ['订单', '$Proxy_1', 'Größe', 'x2y'],
    );
  });

  it('returns an empty set for text without identifiers', () => {
    expect(javaNamesMentionedIn('  \n 123 + 4; ').size).toBe(0);
  });
});
