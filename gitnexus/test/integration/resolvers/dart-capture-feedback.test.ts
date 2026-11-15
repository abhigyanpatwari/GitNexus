/**
 * Dart capture review feedback: local functions, operators and factory
 * constructors, and commented cascades. Every probed member name has two
 * owners, so an edge to the wrong one cannot pass as the right one.
 *
 *   - A LOCAL function's return type is visible where the function's name is —
 *     the scope that declares it — and nowhere else. Published file-wide it
 *     retyped the result of every other callable of that name: the top-level or
 *     imported function called from another function, a method of the same
 *     name, and (through the exporting file) call sites in importing files.
 */
import { describe, expect, it } from 'vitest';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { getRelationships, useFixture, type PipelineResult } from './helpers.js';

/** `file:line -> target` of every CALLS edge to a member named `member`. */
function memberCallsBySite(result: PipelineResult, member: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.target === member)
    .map((edge) => {
      const site = edge.rel.id.slice(
        edge.rel.id.lastIndexOf(edge.rel.targetId) + edge.rel.targetId.length,
      );
      const line = /^:(\d+):\d+/.exec(site)?.[1] ?? '-';
      return `${edge.sourceFilePath}:${line} -> ${edge.rel.targetId}`;
    })
    .sort();
}

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Dart))(
  'Dart capture review feedback',
  () => {
    describe('a local function return type stays in its declaring scope', () => {
      const run = useFixture('dart-local-function-returns', {
        'lib.dart': `class User { void save() {} }
class Other { void save() {} }
User fetch() => User();
User make() => User();
void shadowsOwnTopLevel() {
  Other make() => Other();
  final s = make();
  s.save();
}
void usesOwnTopLevel() {
  final t = make();
  t.save();
}
`,
        'main.dart': `import 'lib.dart';
void localResult() {
  Other fetch() => Other();
  final x = fetch();
  x.save();
}
void importedResult() {
  final y = fetch();
  y.save();
}
void importedShadowedElsewhere() {
  final m = make();
  m.save();
}
void firstLocal() {
  Other mk() => Other();
  final a = mk();
  a.save();
}
void secondLocal() {
  User mk() => User();
  final b = mk();
  b.save();
}
void blockLocal() {
  {
    Other fetch() => Other();
    final inner = fetch();
    inner.save();
  }
  final outer = fetch();
  outer.save();
}
void closureUse(List<int> xs) {
  Other fetch() => Other();
  xs.forEach((i) {
    final c = fetch();
    c.save();
  });
}
`,
        'members.dart': `class Widget { void save() {} }
class Finder { void save() {} }
class Page {
  Widget build() => Widget();
  void render() {
    final w = build();
    w.save();
  }
}
void testBody() {
  Finder build() => Finder();
  final f = build();
  f.save();
}
class Base {
  Widget load() => Widget();
}
class Box extends Base {
  void work() {
    Finder load() => Finder();
    final l = load();
    l.save();
  }
  void other() {
    final x = load();
    x.save();
  }
}
void outside(Box b) {
  final y = b.load();
  y.save();
}
`,
      });

      it('types a call result by the local function only inside the scope that declares it', () => {
        expect(
          memberCallsBySite(run(), 'save').filter((edge) => edge.startsWith('main.dart')),
        ).toEqual([
          // importedShadowedElsewhere: `make`, shadowed only inside lib.dart
          'main.dart:13 -> Method:lib.dart:User.save#0',
          // firstLocal / secondLocal: two locals of one name, each its own type
          'main.dart:18 -> Method:lib.dart:Other.save#0',
          'main.dart:23 -> Method:lib.dart:User.save#0',
          // blockLocal: inside the block the local, after it the import
          'main.dart:29 -> Method:lib.dart:Other.save#0',
          'main.dart:32 -> Method:lib.dart:User.save#0',
          // closureUse: the closure sits inside the declaring scope
          'main.dart:38 -> Method:lib.dart:Other.save#0',
          // localResult: the local `Other fetch()`
          'main.dart:5 -> Method:lib.dart:Other.save#0',
          // importedResult: the imported top-level `User fetch()`
          'main.dart:9 -> Method:lib.dart:User.save#0',
        ]);
      });

      it('leaves the declaring file and its importers the top-level return type', () => {
        expect(
          memberCallsBySite(run(), 'save').filter((edge) => edge.startsWith('lib.dart')),
        ).toEqual([
          'lib.dart:12 -> Method:lib.dart:User.save#0',
          'lib.dart:8 -> Method:lib.dart:Other.save#0',
        ]);
      });

      it('leaves a method of the same name, own or inherited, its return type', () => {
        expect(
          memberCallsBySite(run(), 'save').filter((edge) => edge.startsWith('members.dart')),
        ).toEqual([
          // testBody: the local `Finder build()`
          'members.dart:13 -> Method:members.dart:Finder.save#0',
          // Box.work: the local `Finder load()`
          'members.dart:22 -> Method:members.dart:Finder.save#0',
          // Box.other: the inherited `Widget load()`
          'members.dart:26 -> Method:members.dart:Widget.save#0',
          // outside: `b.load()`
          'members.dart:31 -> Method:members.dart:Widget.save#0',
          // Page.render: the method `Widget build()`
          'members.dart:7 -> Method:members.dart:Widget.save#0',
        ]);
      });
    });
  },
);
