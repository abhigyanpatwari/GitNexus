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
 *   - A local callable (a local function, a closure bound to a local) is not a
 *     candidate for the global name guess at a site outside its declaring
 *     scope, in the same file or another.
 *   - An operator and a factory constructor open a scope for their body and
 *     publish no return binding.
 *   - A comment before a cascade section, or inside one, is not the receiver.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import {
  getRelationships,
  getResolutionOutcomes,
  useFixture,
  type PipelineResult,
} from './helpers.js';

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

/** `source -> target` of every CALLS edge to a callable named `callee`. */
function callersOf(result: PipelineResult, callee: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.target === callee)
    .map((edge) => `${edge.sourceFilePath}:${edge.source} -> ${edge.rel.targetId}`)
    .sort();
}

/** `line receiver.name` of every member call the emitter captures. */
function memberCallReceivers(source: string): string[] {
  return (emitDartScopeCaptures(source, 'cascade.dart') as CaptureMatch[])
    .filter((match) => match['@reference.call.member'] !== undefined)
    .map(
      (match) =>
        `${match['@reference.call.member']?.range.startLine} ${match['@reference.receiver']?.text}.${match['@reference.name']?.text}`,
    )
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

    describe('a local callable is no name guess outside its declaring scope', () => {
      const run = useFixture('dart-local-callable-fallback', {
        'near.dart': `class Other {}
void declares() {
  Other onlyHere() => Other();
  onlyHere();
  final bound = () => Other();
  bound();
}
void elsewhere() {
  onlyHere();
  bound();
}
`,
        'far.dart': `void farAway() {
  onlyHere();
}
`,
      });

      it('keeps the calls inside the declaring scope and refuses the ones outside it', () => {
        expect([...callersOf(run(), 'onlyHere'), ...callersOf(run(), 'bound')]).toEqual([
          'near.dart:declares -> Function:near.dart:declares.onlyHere@2:2',
          'near.dart:declares -> Function:near.dart:declares.bound@4:2',
        ]);
        expect(
          getResolutionOutcomes(run())
            .filter((outcome) => outcome.kind === 'fallback-refused')
            .map((outcome) => `${outcome.filePath}:${outcome.range.startLine} ${outcome.name}`)
            .sort(),
        ).toEqual(['far.dart:2 onlyHere', 'near.dart:10 bound', 'near.dart:9 onlyHere']);
      });
    });

    describe('operators and factory constructors', () => {
      it('an operator and a factory constructor open a scope and publish no return binding', () => {
        const captures = emitDartScopeCaptures(
          `class Mat { void save() {} }
class Vec {
  Vec();
  factory Vec.zero() { final t = Vec(); return t; }
  Mat operator *(Vec o) { final m = Mat(); return m; }
  Mat operator [](int i) => Mat();
  Mat scale() => Mat();
}
Mat zero() => Mat();
`,
          'operators.dart',
        ) as CaptureMatch[];
        // Only the method and the top-level function publish one.
        expect(
          captures
            .filter((match) => match['@type-binding.return'] !== undefined)
            .map(
              (match) =>
                `${match['@type-binding.name']?.text}:${match['@type-binding.type']?.text}`,
            )
            .sort(),
        ).toEqual(['scale:Mat', 'zero:Mat']);
        // The factory (line 4) and both operators (5, 6) own their body names.
        expect(
          captures
            .filter(
              (match) =>
                match['@scope.function'] !== undefined &&
                [4, 5, 6].includes(match['@scope.function'].range.startLine),
            )
            .map(
              (match) =>
                `${match['@scope.function']?.range.startLine} ${match['@scope.lexical-names']?.text}`,
            )
            .sort(),
        ).toEqual(['4 ["t"]', '5 ["m","o"]', '6 ["i"]']);
      });
    });

    describe('a comment in a cascade is not the receiver', () => {
      const SOURCE = `class User { Profile profile = Profile(); void apply(dynamic x) {} }
class Other { void apply(dynamic x) {} }
class Profile { void apply(dynamic x) {} }
int helper() => 1;
void commented(User u, Other o) {
  o
    // leading comment
    ..apply(helper()) // trailing comment
    /// documentation comment
    ..apply(2)
    /* block comment */
    ..apply(3);
  u
    ..apply(4) /* after a section */
    ..profile /* inside a section */ .apply(5)
    ..apply /* before the arguments */ (6);
}
`;

      it('reads the receiver past line, block and documentation comments', () => {
        expect(memberCallReceivers(SOURCE)).toEqual([
          '10 o.apply',
          '12 o.apply',
          '14 u.apply',
          '15 u.profile.apply',
          '16 u.apply',
          '8 o.apply',
        ]);
      });

      const run = useFixture('dart-commented-cascade', { 'cascade.dart': SOURCE });

      it('resolves every section of a commented cascade to its receiver owner', () => {
        expect(memberCallsBySite(run(), 'apply')).toEqual([
          'cascade.dart:10 -> Method:cascade.dart:Other.apply#1',
          'cascade.dart:12 -> Method:cascade.dart:Other.apply#1',
          'cascade.dart:14 -> Method:cascade.dart:User.apply#1',
          'cascade.dart:15 -> Method:cascade.dart:Profile.apply#1',
          'cascade.dart:16 -> Method:cascade.dart:User.apply#1',
          'cascade.dart:8 -> Method:cascade.dart:Other.apply#1',
        ]);
      });
    });
  },
);
