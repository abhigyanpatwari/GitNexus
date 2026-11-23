import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { writeFixtureRepo } from '../../integration/resolvers/helpers.js';

/**
 * Characterization of Java type-import-on-demand (`import pkg.*;`) against the
 * rules of JLS SE 21 (7.5.2, 6.4.1, 6.5.5.1, 6.5.4.2, 6.6.1), for #3695.
 *
 * Every expectation is what the resolver emits TODAY. `status` says whether
 * that agrees with the JLS. A row marked "known semantic gap" is pinned so a
 * change of import representation cannot move it by accident; it is not a
 * statement that the behaviour is correct Java. Closing a gap is a deliberate
 * change to that row alone.
 *
 * Unless a scenario says otherwise, the importer uses `T` as a constructor, a
 * parameter type and a field type. S12 uses it as a parameter and field type
 * only, since `T` is its type parameter there; S14 uses it as a superclass.
 */
const USES = [
  '  void viaNew() { new T().run(); }',
  '  void viaParam(T t) { t.run(); }',
  '  T field;',
  '  void viaField() { field.run(); }',
].join('\n');
const OUTER = 'package a;\npublic class Outer { public static class T { public void run() {} } }\n';

const type = (pkg: string, modifier = 'public '): string =>
  `package ${pkg};\n${modifier}class T { public void run() {} }\n`;
const importer = (imports: string, body = USES, declaration = 'public class U'): string =>
  `package app;\n${imports}\n${declaration} {\n${body}\n}\n`;

interface Scenario {
  readonly name: string;
  readonly status: string;
  readonly files: Readonly<Record<string, string>>;
  readonly edges: readonly string[];
}

const scenarios: readonly Scenario[] = [
  {
    name: 'S1 unique name through a package wildcard',
    status: 'matches JLS 7.5.2',
    files: { 'src/a/T.java': type('a'), 'src/app/U.java': importer('import a.*;') },
    edges: [
      'CALLS Method:viaField -> Method:src/a/T.java:run',
      'CALLS Method:viaNew -> Class:src/a/T.java:T',
      'CALLS Method:viaNew -> Method:src/a/T.java:run',
      'CALLS Method:viaParam -> Method:src/a/T.java:run',
      'IMPORTS File:U.java -> File:src/a/T.java:T.java',
    ],
  },
  {
    name: 'S2 ambiguous name, only one package imported on demand',
    status: 'known semantic gap: JLS 7.5.2 selects a.T for every use; only the class link resolves',
    files: {
      'src/a/T.java': type('a'),
      'src/b/T.java': type('b'),
      'src/app/U.java': importer('import a.*;'),
    },
    edges: [
      'CALLS Method:viaNew -> Class:src/a/T.java:T',
      'IMPORTS File:U.java -> File:src/a/T.java:T.java',
    ],
  },
  {
    name: 'S3 two package wildcards supply the same name',
    status: 'matches JLS 6.5.5.1: ambiguous, so no use resolves',
    files: {
      'src/a/T.java': type('a'),
      'src/b/T.java': type('b'),
      'src/app/U.java': importer('import a.*;\nimport b.*;'),
    },
    edges: [
      'IMPORTS File:U.java -> File:src/a/T.java:T.java',
      'IMPORTS File:U.java -> File:src/b/T.java:T.java',
    ],
  },
  {
    name: 'S4 single-type import shadows a package wildcard',
    status: 'matches JLS 6.4.1',
    files: {
      'src/a/T.java': type('a'),
      'src/b/T.java': type('b'),
      'src/app/U.java': importer('import a.*;\nimport b.T;'),
    },
    edges: [
      'CALLS Method:viaField -> Method:src/b/T.java:run',
      'CALLS Method:viaNew -> Class:src/b/T.java:T',
      'CALLS Method:viaNew -> Method:src/b/T.java:run',
      'CALLS Method:viaParam -> Method:src/b/T.java:run',
      'IMPORTS File:U.java -> File:src/b/T.java:T.java',
    ],
  },
  {
    name: 'S5 same-package type shadows a package wildcard',
    status: 'matches JLS 6.4.1',
    files: {
      'src/a/T.java': type('a'),
      'src/app/T.java': type('app'),
      'src/app/U.java': importer('import a.*;'),
    },
    edges: [
      'CALLS Method:viaField -> Method:src/app/T.java:run',
      'CALLS Method:viaNew -> Class:src/app/T.java:T',
      'CALLS Method:viaNew -> Method:src/app/T.java:run',
      'CALLS Method:viaParam -> Method:src/app/T.java:run',
    ],
  },
  {
    name: 'S6 package-private type in one of two wildcard packages',
    status:
      'known semantic gap: JLS 7.5.2 and 6.6.1 select b.T; the IMPORTS edge to a/T.java is conservative dependency policy',
    files: {
      'src/a/T.java': type('a', ''),
      'src/b/T.java': type('b'),
      'src/app/U.java': importer('import a.*;\nimport b.*;'),
    },
    edges: [
      'IMPORTS File:U.java -> File:src/a/T.java:T.java',
      'IMPORTS File:U.java -> File:src/b/T.java:T.java',
    ],
  },
  {
    name: 'S7 wildcard over the member types of a class',
    status: 'known semantic gap: JLS 7.5.2 and 6.5.4.2 import a.Outer.T',
    files: { 'src/a/Outer.java': OUTER, 'src/app/U.java': importer('import a.Outer.*;') },
    edges: [],
  },
  {
    name: 'S8 package wildcard does not reach a subpackage',
    status: 'known semantic gap for receivers: JLS selects c.T for every use; imports match',
    files: {
      'src/a/sub/T.java': type('a.sub'),
      'src/a/X.java': 'package a;\npublic class X {}\n',
      'src/c/T.java': type('c'),
      'src/app/U.java': importer('import a.*;\nimport c.*;'),
    },
    edges: [
      'CALLS Method:viaNew -> Class:src/c/T.java:T',
      'IMPORTS File:U.java -> File:src/c/T.java:T.java',
    ],
  },
  {
    name: "S9 wildcard over the importer's own package",
    status: 'matches JLS 7.5.2: ignored',
    files: { 'src/app/T.java': type('app'), 'src/app/U.java': importer('import app.*;') },
    edges: [
      'CALLS Method:viaField -> Method:src/app/T.java:run',
      'CALLS Method:viaNew -> Class:src/app/T.java:T',
      'CALLS Method:viaNew -> Method:src/app/T.java:run',
      'CALLS Method:viaParam -> Method:src/app/T.java:run',
    ],
  },
  {
    name: 'S10 the same package wildcard written twice',
    status: 'imports match JLS 7.5.2 (imported once); receivers share the S2 gap',
    files: {
      'src/a/T.java': type('a'),
      'src/b/T.java': type('b'),
      'src/app/U.java': importer('import a.*;\nimport a.*;'),
    },
    edges: [
      'CALLS Method:viaNew -> Class:src/a/T.java:T',
      'IMPORTS File:U.java -> File:src/a/T.java:T.java',
    ],
  },
  {
    name: 'S11 nested type shadows a package wildcard',
    status: 'matches JLS 6.4.1',
    files: {
      'src/a/T.java': type('a'),
      'src/app/U.java': importer(
        'import a.*;',
        `${USES}\n  static class T { public void run() {} }`,
      ),
    },
    edges: [
      'CALLS Method:viaField -> Method:src/app/U.java:run',
      'CALLS Method:viaNew -> Class:src/app/U.java:T',
      'CALLS Method:viaNew -> Method:src/app/U.java:run',
      'CALLS Method:viaParam -> Method:src/app/U.java:run',
    ],
  },
  {
    name: 'S12 type parameter shadows a package wildcard',
    status: 'matches JLS 6.4.1',
    files: {
      'src/a/T.java': type('a'),
      'src/app/U.java': importer(
        'import a.*;',
        '  void viaParam(T t) { t.toString(); }\n  T field;',
        'public class U<T>',
      ),
    },
    edges: [],
  },
  {
    name: 'S13 package wildcard does not reach a nested type',
    status: 'matches JLS 7.5.2',
    files: {
      'src/a/Outer.java': OUTER,
      'src/b/T.java': type('b'),
      'src/app/U.java': importer('import a.*;\nimport b.*;'),
    },
    edges: [
      'CALLS Method:viaField -> Method:src/b/T.java:run',
      'CALLS Method:viaNew -> Class:src/b/T.java:T',
      'CALLS Method:viaNew -> Method:src/b/T.java:run',
      'CALLS Method:viaParam -> Method:src/b/T.java:run',
      'IMPORTS File:U.java -> File:src/b/T.java:T.java',
    ],
  },
  {
    name: 'S14 superclass named through a package wildcard',
    status: 'matches JLS 7.5.2',
    files: {
      'src/a/T.java': type('a'),
      'src/b/T.java': type('b'),
      'src/app/U.java':
        'package app;\nimport a.*;\npublic class U extends T { void go() { run(); } }\n',
    },
    edges: [
      'CALLS Method:go -> Method:src/a/T.java:run',
      'EXTENDS Class:U -> Class:src/a/T.java:T',
      'IMPORTS File:U.java -> File:src/a/T.java:T.java',
    ],
  },
];

const IMPORTER = 'src/app/U.java';
const EDGE_TYPES: ReadonlySet<string> = new Set(['CALLS', 'EXTENDS', 'IMPORTS']);

/** Every CALLS / EXTENDS / IMPORTS edge leaving the importing file, with both endpoints named. */
function importerEdges(result: PipelineResult): string[] {
  return [...result.graph.iterRelationships()]
    .filter((rel) => EDGE_TYPES.has(rel.type))
    .map((rel) => ({
      type: rel.type,
      source: result.graph.getNode(rel.sourceId),
      target: result.graph.getNode(rel.targetId),
    }))
    .filter(({ source }) => source?.properties.filePath === IMPORTER)
    .map(
      ({ type, source, target }) =>
        `${type} ${source?.label}:${source?.properties.name} -> ` +
        `${target?.label}:${target?.properties.filePath}:${target?.properties.name}`,
    )
    .sort();
}

/** Every CALLS edge leaving a file of package `app`: caller, target file and target name. */
function appCalls(result: PipelineResult): string[] {
  return [...result.graph.iterRelationshipsByType('CALLS')]
    .map((rel) => ({
      source: result.graph.getNode(rel.sourceId),
      target: result.graph.getNode(rel.targetId),
    }))
    .filter(({ source }) => String(source?.properties.filePath).startsWith('src/app/'))
    .map(
      ({ source, target }) =>
        `${source?.properties.name} -> ${target?.properties.filePath}:${target?.properties.name}`,
    )
    .sort();
}

/**
 * Both ways of storing an on-demand import must give these edges. This goes
 * through the whole pipeline, so reference resolution runs with its lookup
 * cache installed, which the unit tests of the storage forms do not.
 */
const STORAGE_FORMS = [
  { form: 'grouped', disableGroups: '' },
  { form: 'one edge per file', disableGroups: '1' },
] as const;

afterEach(() => vi.unstubAllEnvs());

describe.each(STORAGE_FORMS)(
  'Java on-demand imports: JLS scenarios pinned to current behaviour (#3695), $form',
  ({ form, disableGroups }) => {
    it('does not expose imported members as members of the importing class', async () => {
      vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', disableGroups);
      const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-private-wildcard-'));
      // `Util` imports the static members of `b.Tools` on demand. They are in
      // scope inside Util.java but are not members of `Util` (JLS 7.5.4), so
      // `import static a.Util.helper;` and `import static a.Util.Inner;` name
      // nothing (JLS 7.5.3). `d.Tools` repeats every name so that none of them
      // is unique in the workspace.
      const tools = (pkg: string): string =>
        `package ${pkg}; public class Tools { public static void helper() {} ` +
        'public static class Inner { public static void in() {} } }';
      try {
        writeFixtureRepo(root, {
          'src/b/Tools.java': tools('b'),
          'src/d/Tools.java': tools('d'),
          'src/a/Util.java': 'package a; import static b.Tools.*; public class Util {}',
          'src/app/U.java':
            'package app; import static a.Util.helper; import static a.Util.Inner; ' +
            'public class U { void wrong() { helper(); Inner.in(); } }',
          'src/app/Direct.java':
            'package app; import static b.Tools.helper; import static b.Tools.Inner; ' +
            'public class Direct { void correct() { helper(); Inner.in(); } }',
        });
        const result = await runPipelineFromRepo(root, () => {});
        expect(appCalls(result)).toEqual([
          'correct -> src/b/Tools.java:helper',
          'correct -> src/b/Tools.java:in',
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it('does not re-export a type imported on demand to an importer of the importing file', async () => {
      vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', disableGroups);
      const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-on-demand-reexport-'));
      // `Util` imports package `c` on demand, which puts `Lib` in scope inside
      // Util.java only (JLS 7.5.2). `b.Util.Lib` is not the canonical name of
      // any type, so the single-type import in Named.java names nothing
      // (JLS 7.5.1), and `import b.*;` in Star.java declares only `Util`.
      // `d.Lib` keeps `Lib` from being unique in the workspace.
      const lib = (pkg: string): string =>
        `package ${pkg}; public class Lib { public static void make() {} public void run() {} }`;
      const body = '{ new Lib().run(); Lib.make(); }';
      try {
        writeFixtureRepo(root, {
          'src/c/Lib.java': lib('c'),
          'src/d/Lib.java': lib('d'),
          'src/b/Util.java': 'package b; import c.*; public class Util { Lib held; }',
          'src/app/Named.java': `package app; import b.Util.Lib; public class Named { void named() ${body} }`,
          'src/app/Star.java': `package app; import b.*; public class Star { void star() ${body} }`,
          'src/app/Direct.java': `package app; import c.Lib; public class Direct { void correct() ${body} }`,
        });
        const result = await runPipelineFromRepo(root, () => {});
        expect(appCalls(result)).toEqual([
          'correct -> src/c/Lib.java:Lib',
          'correct -> src/c/Lib.java:make',
          'correct -> src/c/Lib.java:run',
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it.each(scenarios)(`$name [${form}]`, async ({ files, edges }) => {
      vi.stubEnv('GITNEXUS_DISABLE_IMPORT_GROUPS', disableGroups);
      const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-on-demand-jls-'));
      try {
        writeFixtureRepo(root, { ...files });
        const result = await runPipelineFromRepo(root, () => {});
        expect(importerEdges(result)).toEqual(edges);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);

describe('Java on-demand imports: JLS scenario labels', () => {
  it('labels every scenario as matching the JLS or as a known gap', () => {
    const unlabelled = scenarios.filter(
      (scenario) => !/^(matches JLS|known semantic gap|imports match JLS)/.test(scenario.status),
    );
    expect(unlabelled).toEqual([]);
  });
});
