/**
 * Dart plain imports: the file-level IMPORTS edge of every directive, the
 * names a directive brings into scope (through barrels, `show` / `hide`, two
 * imports of one name), and the export-only veto on the name fallback.
 *
 * A plain import is ONE import per directive. Its names come from the
 * library's shared namespace table, not from per-name imports, so a directive
 * that brings in no name (or only filtered-out names) still has its file edge.
 * Every method name probed here has two owners, so no edge can come from a
 * workspace-unique name.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { TransitionalScopeTree } from '../../../src/storage/scope-index-store.js';
import {
  getRelationships,
  runPipelineFromRepo,
  useFixture,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

// `isLanguageAvailable` only proves the grammar module loaded; tree-sitter-dart
// can still fail in `setLanguage`. Probe the parser for a reliable skip guard.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

const importEdges = (result: PipelineResult): string[] =>
  getRelationships(result, 'IMPORTS')
    .map((edge) => `${edge.rel.sourceId} -> ${edge.rel.targetId}`)
    .sort();

/** Targets of the CALLS edges out of the function or method named `source`. */
const callTargets = (result: PipelineResult, source: string): string[] =>
  getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === source)
    .map((edge) => edge.rel.targetId)
    .sort();

describe.skipIf(!dartAvailable)('Dart IMPORTS edge of an import that binds no name', () => {
  const run = useFixture('dart-import-edges', {
    'pubspec.yaml': 'name: app\nenvironment:\n  sdk: ^3.8.0\n',
    // A conditional export is not followed, so the barrel publishes no name.
    'lib/k/barrel.dart': "export 'stub.dart' if (dart.library.io) 'io.dart';\n",
    'lib/k/stub.dart': 'class KPlatform { void save() {} }\n',
    'lib/k/io.dart': 'class KPlatform { void save() {} }\n',
    'lib/k/main.dart': "import 'barrel.dart';\nvoid kmain(KPlatform p) { p.save(); }\n",
    // Every declaration of the library lives in a `part` file.
    'lib/p/lib.dart': "library plib;\npart 'impl.dart';\n",
    'lib/p/impl.dart': "part of 'lib.dart';\nclass PImpl { void save() {} }\n",
    'lib/p/decoy.dart': 'class PImpl { void save() {} }\n',
    'lib/p/main.dart': "import 'lib.dart';\nvoid pmain(PImpl p) { p.save(); }\n",
    // Only private declarations and an unnamed extension.
    'lib/s/priv.dart':
      'class _Hidden { void save() {} }\nextension on String { void shout() {} }\n',
    'lib/s/main.dart': "import 'priv.dart';\nvoid smain() { 'x'.shout(); }\n",
    // `show` of a getter/setter pair: two declarations, so no single export.
    'lib/t/a.dart':
      'class TRepo { void save() {} }\nTRepo get tcurrent => TRepo();\nset tcurrent(TRepo r) {}\n',
    'lib/t/main.dart': "import 'a.dart' show tcurrent;\nvoid tmain() { tcurrent.save(); }\n",
    // `hide` of the library's only name.
    'lib/h/pub.dart': 'void helper() {}\n',
    'lib/h/main.dart': "import 'pub.dart' hide helper;\nvoid hmain() {}\n",
    // The same through a `package:` URI, which also depends on the pubspec.
    'lib/g/platform.dart': "export 'src/stub.dart' if (dart.library.io) 'src/io.dart';\n",
    'lib/g/src/stub.dart': 'class GPlat { void save() {} }\n',
    'lib/g/src/io.dart': 'class GPlat { void save() {} }\n',
    'lib/g/tool.dart': "import 'package:app/g/platform.dart';\nvoid gtool(GPlat p) { p.save(); }\n",
  });

  it.each([
    ['a conditional-export barrel', 'File:lib/k/main.dart -> File:lib/k/barrel.dart'],
    ['a library made only of part directives', 'File:lib/p/main.dart -> File:lib/p/lib.dart'],
    ['a library with only private declarations', 'File:lib/s/main.dart -> File:lib/s/priv.dart'],
    ['a show of a getter/setter pair', 'File:lib/t/main.dart -> File:lib/t/a.dart'],
    ['a hide of every exported name', 'File:lib/h/main.dart -> File:lib/h/pub.dart'],
    ['a package: URI of a nameless barrel', 'File:lib/g/tool.dart -> File:lib/g/platform.dart'],
  ])('keeps the file edge for %s', (_shape, edge) => {
    expect(importEdges(run())).toContain(edge);
  });

  it('keeps the importer to pubspec.yaml edge of a package: import that binds no name', () => {
    expect(importEdges(run())).toContain('File:lib/g/tool.dart -> File:pubspec.yaml');
  });

  it('emits exactly one IMPORTS edge per import directive and target', () => {
    expect(importEdges(run())).toEqual([
      'File:lib/g/tool.dart -> File:lib/g/platform.dart',
      'File:lib/g/tool.dart -> File:pubspec.yaml',
      'File:lib/h/main.dart -> File:lib/h/pub.dart',
      'File:lib/k/main.dart -> File:lib/k/barrel.dart',
      'File:lib/p/main.dart -> File:lib/p/lib.dart',
      'File:lib/s/main.dart -> File:lib/s/priv.dart',
      'File:lib/t/main.dart -> File:lib/t/a.dart',
    ]);
  });
});

describe.skipIf(!dartAvailable)('Dart show / hide on a plain import', () => {
  const run = useFixture('dart-import-combinators', {
    'a.dart':
      'class Alpha { void save() {} }\nclass Beta { void save() {} }\nAlpha pick() => Alpha();\nAlpha makeA() => Alpha();\n',
    'b.dart':
      'class Alpha { void save() {} }\nclass Beta { void save() {} }\nBeta pick() => Beta();\n',
    'show.dart': `import 'a.dart' show Alpha, pick;
import 'b.dart' show Beta;
void shown(Alpha x, Beta y) { x.save(); y.save(); pick().save(); }
`,
    'hide.dart': `import 'a.dart' hide Beta, pick;
import 'b.dart' hide Alpha;
void hidden(Alpha x, Beta y) { x.save(); y.save(); pick().save(); makeA().save(); }
`,
    'sequence.dart': `import 'a.dart' show Alpha, Beta, pick hide Beta;
import 'b.dart' hide Alpha hide pick;
void sequenced(Alpha x, Beta y) { x.save(); y.save(); pick().save(); }
`,
  });

  it('binds only the names a show lists', () => {
    // `Beta` and `pick` exist in both libraries: `b.dart` shows only `Beta`, so
    // `pick` is a.dart's and returns a.dart's Alpha.
    expect(callTargets(run(), 'shown')).toEqual([
      'Function:a.dart:pick',
      'Method:a.dart:Alpha.save#0',
      'Method:a.dart:Alpha.save#0',
      'Method:b.dart:Beta.save#0',
    ]);
  });

  it('binds every name a hide does not list', () => {
    expect(callTargets(run(), 'hidden')).toEqual([
      'Function:a.dart:makeA',
      'Function:b.dart:pick',
      'Method:a.dart:Alpha.save#0',
      'Method:a.dart:Alpha.save#0',
      'Method:b.dart:Beta.save#0',
      'Method:b.dart:Beta.save#0',
    ]);
  });

  it('applies two combinators of one directive in order', () => {
    expect(callTargets(run(), 'sequenced')).toEqual([
      'Function:a.dart:pick',
      'Method:a.dart:Alpha.save#0',
      'Method:a.dart:Alpha.save#0',
      'Method:b.dart:Beta.save#0',
    ]);
  });
});

describe.skipIf(!dartAvailable)('Dart names visible through a plain import', () => {
  const run = useFixture('dart-import-namespaces', {
    'lib.dart': 'class Repo { void save() {} }\nRepo make() => Repo();\n',
    'other.dart': 'class Repo { void save() {} }\nRepo make() => Repo();\n',
    'barrel.dart': "export 'lib.dart';\n",
    'via_barrel.dart': `import 'barrel.dart';
class Sub extends Repo { void go() { save(); } }
void viaBarrel(Repo r) { r.save(); make().save(); }
`,
    'twice.dart': `import 'barrel.dart';
import 'lib.dart';
void twice(Repo r) { r.save(); make().save(); }
`,
    'clash.dart': `import 'lib.dart';
import 'other.dart';
void clash() { make().save(); }
`,
    'own.dart': `import 'lib.dart';
class Repo { void save() {} }
Repo make() => Repo();
void own(Repo r) { r.save(); make().save(); }
`,
  });

  it('resolves a superclass named through a barrel', () => {
    expect(
      getRelationships(run(), 'EXTENDS').map(
        (edge) => `${edge.rel.sourceId} -> ${edge.rel.targetId}`,
      ),
    ).toEqual(['Class:via_barrel.dart:Sub -> Class:lib.dart:Repo']);
    expect(callTargets(run(), 'go')).toEqual(['Method:lib.dart:Repo.save#0']);
  });

  it('resolves types and call results through a barrel as import-resolved edges', () => {
    const edges = getRelationships(run(), 'CALLS').filter((edge) => edge.source === 'viaBarrel');
    expect(edges.map((edge) => `${edge.rel.targetId} ${edge.rel.reason}`).sort()).toEqual([
      'Function:lib.dart:make import-resolved',
      'Method:lib.dart:Repo.save#0 import-resolved',
      'Method:lib.dart:Repo.save#0 import-resolved',
    ]);
  });

  it('binds one declaration once when a barrel and its library are both imported', () => {
    expect(callTargets(run(), 'twice')).toEqual([
      'Function:lib.dart:make',
      'Method:lib.dart:Repo.save#0',
      'Method:lib.dart:Repo.save#0',
    ]);
  });

  it('does not type a call result through a name two imports declare differently', () => {
    expect(callTargets(run(), 'clash').filter((target) => target.includes('.save'))).toEqual([]);
  });

  it("lets the importing file's own declaration hide an imported one", () => {
    expect(callTargets(run(), 'own')).toEqual([
      'Function:own.dart:make',
      'Method:own.dart:Repo.save#0',
      'Method:own.dart:Repo.save#0',
    ]);
  });
});

describe.skipIf(!dartAvailable)('Dart export-only names and the name fallback', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // The veto is decided after disk scope mode has replaced every ParsedFile by
  // a scope-stripped copy, so it must hold in both modes.
  it.each([
    ['resident scopes', '0', 0],
    ['disk-sealed scopes', '1', 1],
  ])(
    'refuses a bare call to a name the file only exports (%s)',
    async (_mode, diskScopeIndex, sealCalls) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dart-export-only-'));
      const store = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dart-export-only-store-'));
      const seal = vi.spyOn(TransitionalScopeTree.prototype, 'seal');
      vi.stubEnv('GITNEXUS_DISK_SCOPE_INDEX', diskScopeIndex);
      try {
        writeFixtureRepo(root, {
          'leaf.dart': 'void make() {}\n',
          'facade.dart': "export 'leaf.dart';\nvoid run() { make(); }\n",
          'user.dart': "import 'facade.dart';\nvoid use() { make(); }\n",
        });
        const result = await runPipelineFromRepo(root, () => {}, { parsedFileStorePath: store });
        expect(seal).toHaveBeenCalledTimes(sealCalls);
        expect(callTargets(result, 'run')).toEqual([]);
        // The same name IS visible to a file that imports the facade.
        expect(callTargets(result, 'use')).toEqual(['Function:leaf.dart:make']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(store, { recursive: true, force: true });
      }
    },
    120000,
  );

  // Same boundary for the local-callable refusal: its index of the file's
  // scopes is read after the seal has stripped them.
  it.each([
    ['resident scopes', '0', 0],
    ['disk-sealed scopes', '1', 1],
  ])(
    "refuses a bare call to another function's local function (%s)",
    async (_mode, diskScopeIndex, sealCalls) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dart-local-callable-'));
      const store = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dart-local-callable-store-'));
      const seal = vi.spyOn(TransitionalScopeTree.prototype, 'seal');
      vi.stubEnv('GITNEXUS_DISK_SCOPE_INDEX', diskScopeIndex);
      try {
        writeFixtureRepo(root, {
          'a.dart': 'void f() {\n  void helper() {}\n  helper();\n}\nvoid g() { helper(); }\n',
          'b.dart': 'void h() { helper(); }\n',
        });
        const result = await runPipelineFromRepo(root, () => {}, { parsedFileStorePath: store });
        expect(seal).toHaveBeenCalledTimes(sealCalls);
        expect(callTargets(result, 'f')).toEqual(['Function:a.dart:f.helper@1:2']);
        expect(callTargets(result, 'g')).toEqual([]);
        expect(callTargets(result, 'h')).toEqual([]);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(store, { recursive: true, force: true });
      }
    },
    120000,
  );

  it('keeps the fallback for a name an unresolved package: import of the same file brings in', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-dart-export-unresolved-'));
    try {
      // No pubspec maps `package:app`, so the import does not resolve; it still
      // names lib/src/user.dart, the file `emake` is declared in.
      writeFixtureRepo(root, {
        'lib/barrel.dart': `import 'package:app/src/user.dart';
export 'src/user.dart';
export 'src/other.dart';
void inBarrel() { emake(); omake(); }
`,
        'lib/src/user.dart': 'void emake() {}\n',
        'lib/src/other.dart': 'void omake() {}\n',
      });
      const result = await runPipelineFromRepo(root, () => {});
      expect(callTargets(result, 'inBarrel')).toEqual(['Function:lib/src/user.dart:emake']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120000);
});
