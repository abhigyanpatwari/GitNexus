/**
 * DART-10 — a getter / setter body and a function whose body is separated from
 * its signature by a comment must each own a Function scope
 * (docs/languages/dart-ingestion-gaps.md).
 *
 * Dart's `function_signature` and `function_body` are SIBLINGS, so the emitter
 * synthesizes a Function scope from the pair. Two shapes opened none:
 *
 *   - accessors — top-level `getter_signature` / `setter_signature` were not
 *     captured at all, and a member accessor was handled as a field, so their
 *     parameters and locals landed in the enclosing Module / Class scope
 *     (one flow-insensitive binding per name) and typed same-named receivers
 *     in other functions: `final v = User()` inside a getter typed
 *     `commentedBare() { v.save(); }` as `User.save`;
 *   - `void commented(User v) // note` + `{ … }` — tree-sitter keeps the
 *     comment (`comment` or `documentation_comment`) as a named sibling, so
 *     the body was never found and the parameter bound nothing.
 *
 * Contract:
 *   - every accessor and comment-separated function opens exactly one scope;
 *     a bodiless signature never takes a later member's body;
 *   - an accessor's NAME still binds on its Class / Module scope, so a bare
 *     read of it in a sibling member stops at `this.name` instead of climbing
 *     to a same-named hoisted return binding of another class;
 *   - an accessor publishes no return binding — it would be hoisted to the
 *     Module scope and type an untyped same-named receiver elsewhere (a wrong
 *     owner, where the accessor published nothing before it had a scope);
 *   - a member parameter that shadows a field masks it for a bare read in its
 *     body even with a comment before that body (the shadow set, like the
 *     binder census, walks back past comments to the signature);
 *   - a parameter annotation is withheld when its OWN scope declares the name
 *     again, because that scope keeps one binding per name. A binder in a
 *     closure, local function, nested block, loop, case or catch body has a
 *     scope of its own (DART-11) and leaves the annotation alone; a plain
 *     assignment, a pattern assignment, a pattern field label and a
 *     function-typed parameter's own parameter declare nothing. A withheld
 *     name stays the scope's untyped binder, so its sites stop there and
 *     never reach a same-named binding further out.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import path from 'node:path';
import type { CaptureMatch } from 'gitnexus-shared';
import { emitDartScopeCaptures } from '../../../src/core/ingestion/languages/dart/captures.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import {
  FIXTURES,
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

const SOURCE = `set u(User v) { v.save(); }
User get topGetter { final v = User(); return v; }
void commented(User v)
// comment sibling
{ v.save(); }
class Box {
  set member(User v) { v.save(); }
  User get memberGetter { final v = User(); return v; }
}`;

const parameterBindingsOf = (captures: readonly CaptureMatch[]): string[] =>
  captures
    .filter((m) => m['@type-binding.parameter'] !== undefined)
    .map((m) => `${m['@type-binding.name']?.text}:${m['@type-binding.type']?.text}`);

const thisBindingLines = (captures: readonly CaptureMatch[]): string[] =>
  captures.flatMap((m) => {
    const self = m['@type-binding.self'];
    return self === undefined || m['@type-binding.name']?.text !== 'this'
      ? []
      : [`${self.range.startLine}:${m['@type-binding.type']?.text}`];
  });

const functionScopeLines = (captures: readonly CaptureMatch[]): number[] =>
  captures
    .flatMap((m) => {
      const scope = m['@scope.function'];
      return scope === undefined ? [] : [scope.range.startLine];
    })
    .sort((a, b) => a - b);

describe.skipIf(!dartAvailable)('DART-10 — Dart scope openers', () => {
  it('opens Function scopes for top-level/member getters and setters and commented signatures', () => {
    const captures = emitDartScopeCaptures(SOURCE, 'scope-openers.dart') as CaptureMatch[];
    // set u, get topGetter, commented, set member, get memberGetter.
    expect(functionScopeLines(captures)).toEqual([1, 2, 3, 7, 8]);
    const parameterBindings = captures
      .filter((m) => m['@type-binding.parameter'] !== undefined)
      .map((m) => `${m['@type-binding.name']?.text}:${m['@type-binding.type']?.text}`);
    expect(parameterBindings).toEqual(['v:User', 'v:User', 'v:User']);
  });

  it('publishes no return binding for a top-level or a member getter', () => {
    const returns = (emitDartScopeCaptures(SOURCE, 'scope-openers.dart') as CaptureMatch[])
      .filter((m) => m['@type-binding.return'] !== undefined)
      .map((m) => m['@type-binding.name']?.text);
    expect(returns).toEqual([]);
  });

  it('opens accessor scopes in static, extension, and mixin members without a static receiver', () => {
    const captures = emitDartScopeCaptures(
      `class User {}
class StaticBox { static User get value => User(); }
extension UserExtension on User { User get copy => User(); }
mixin UserMixin { User get copy => User(); }`,
      'accessor-kinds.dart',
    ) as CaptureMatch[];
    expect(functionScopeLines(captures)).toEqual([2, 3, 4]);
    // The static getter on line 2 binds no `this`.
    expect(thisBindingLines(captures)).toEqual(['3:UserExtension', '4:UserMixin']);
  });

  it('opens accessor scopes in enum and extension-type members and a static setter', () => {
    const captures = emitDartScopeCaptures(
      `class User {}
enum Kind { a; User get u => User(); }
extension type Wrap(User raw) { User get copy => raw; }
class StaticSink { static set st(User v) { use(v); } }`,
      'accessor-kinds-2.dart',
    ) as CaptureMatch[];
    expect(functionScopeLines(captures)).toEqual([2, 3, 4]);
    // The static setter on line 4 binds its parameter but no `this`.
    expect(thisBindingLines(captures)).toEqual(['2:Kind', '3:Wrap']);
    expect(parameterBindingsOf(captures)).toEqual(['v:User']);
  });

  it('opens a scope past a documentation comment between a signature and its body', () => {
    const captures = emitDartScopeCaptures(
      `void lineDoc(User v)
/// a line doc comment
{ v.save(); }
void blockDoc(User v)
/** a block doc comment */
{ v.save(); }`,
      'doc-comments.dart',
    ) as CaptureMatch[];
    expect(functionScopeLines(captures)).toEqual([1, 4]);
    expect(parameterBindingsOf(captures)).toEqual(['v:User', 'v:User']);
  });

  it('does not attach a later member body after a bodiless signature and a comment', () => {
    const captures = emitDartScopeCaptures(
      `abstract class Contract {
  void missing();
  // a comment is a named sibling, like the body the walk looks for
  User get present => User();
  void undocumented();
  /// so is a documentation comment
  User get later => User();
}`,
      'bodiless-signature.dart',
    ) as CaptureMatch[];
    // Only `present` (line 4) and `later` (line 7) have a body; neither
    // bodiless signature may take the next member's.
    expect(functionScopeLines(captures)).toEqual([4, 7]);
  });

  it('withholds a parameter annotation only when its own scope declares the name again', () => {
    const PRE =
      'class User { void save() {} }\nclass Address { void save() {} }\nUser make() => User();\n';
    const bindingsFor = (name: string, source: string): string[] =>
      (emitDartScopeCaptures(PRE + source, 'rebound.dart') as CaptureMatch[])
        .filter(
          (m) =>
            m['@type-binding.name']?.text === name &&
            (m['@type-binding.parameter'] !== undefined ||
              m['@type-binding.constructor'] !== undefined),
        )
        .map(
          (m) =>
            `${m['@type-binding.parameter'] ? 'param' : 'local'} ${name}:${m['@type-binding.type']?.text}`,
        );
    // The function's own scope declares `cs` twice, so neither the annotation
    // nor the declarator's call-result inference types it — behind a comment
    // and in a top-level setter alike.
    expect(
      bindingsFor('cs', 'void f(Address cs) /* c */ { final cs = make(); cs.save(); }\n'),
    ).toEqual([]);
    expect(bindingsFor('cs', 'set s(Address cs) { final cs = make(); cs.save(); }\n')).toEqual([]);
    // A collection `for` element shares the function's scope: withheld.
    expect(
      bindingsFor(
        'cs',
        'void c(Address cs, List<User> us) { final t = [for (final cs in us) cs]; }\n',
      ),
    ).toEqual([]);
    // A different local name, or a plain assignment, keeps the annotation.
    expect(
      bindingsFor('cs', 'void g(Address cs) /* c */ { final w = make(); cs.save(); }\n'),
    ).toEqual(['param cs:Address']);
    expect(bindingsFor('cs', 'void h(Address cs) { cs = Address(); cs.save(); }\n')).toEqual([
      'param cs:Address',
    ]);
    // A closure, a for-in, a catch body, an if-case, a closure bound to a
    // local and a nested block each declare in a scope of their own: the
    // outer annotation is kept. (The block local itself is not inferred: the
    // call-result census still counts per outermost body.)
    const KEPT = ['param x:Address'];
    expect(
      bindingsFor('x', 'void closure(Address x) { items.forEach((x) => use(x)); x.save(); }\n'),
    ).toEqual(KEPT);
    expect(
      bindingsFor('x', 'void loop(Address x) { for (final x in items) { use(x); } x.save(); }\n'),
    ).toEqual(KEPT);
    expect(
      bindingsFor('x', 'void caught(Address x) { try {} catch (x) { use(x); } x.save(); }\n'),
    ).toEqual(KEPT);
    expect(
      bindingsFor(
        'x',
        'void pat(Object o, Address x) { if (o case Address x) { use(x); } x.save(); }\n',
      ),
    ).toEqual(KEPT);
    expect(
      bindingsFor('x', 'void bound(Address x) { final g = (x) => use(x); g(x); x.save(); }\n'),
    ).toEqual(KEPT);
    expect(
      bindingsFor('x', 'void block(Address x) { { final x = make(); use(x); } x.save(); }\n'),
    ).toEqual(KEPT);
  });

  it('keeps a parameter annotation when the second spelling declares nothing', () => {
    const PRE =
      'class Address { void save() {} }\nclass Point { final Object x = 0; }\nvoid use(Object o) {}\n';
    const bindingFor = (name: string, source: string): string[] =>
      parameterBindingsOf(emitDartScopeCaptures(PRE + source, 'declares-nothing.dart')).filter(
        (binding) => binding.startsWith(`${name}:`),
      );
    // The parameter of a function-typed parameter names the callback's
    // parameter, not a variable of this function.
    expect(bindingFor('x', 'void fnTyped(Address x, void cb(Address x)) { x.save(); }\n')).toEqual([
      'x:Address',
    ]);
    // An object-pattern field label and a record-pattern field label bind
    // nothing; the nested `var q` / `q` is the binder.
    expect(
      bindingFor(
        'x',
        'void objectLabel(Address x, Object o) { switch (o) { case Point(x: var q): use(q); } x.save(); }\n',
      ),
    ).toEqual(['x:Address']);
    expect(
      bindingFor(
        'x',
        'void recordLabel(Address x, ({Object x, Object n}) o) { final (x: q, n: m) = o; use(q); x.save(); }\n',
      ),
    ).toEqual(['x:Address']);
    // A pattern assignment assigns the existing variables; their declared
    // types still hold.
    expect(
      bindingFor('x', 'void swap(Address x, Address y) { (x, y) = (y, x); x.save(); }\n'),
    ).toEqual(['x:Address']);
  });

  describe('edge ownership', () => {
    let result: PipelineResult;

    beforeAll(async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-scope-openers'), () => {});
    }, 60_000);

    const callEdges = (member: string, file: string): string[] =>
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.target === member && edge.sourceFilePath.endsWith(file))
        .map((edge) => `${edge.rel.sourceId} -> ${edge.rel.targetId}`)
        .sort();

    /** Every outcome in `file`, whatever its kind; only some kinds carry a range. */
    const outcomesIn = (file: string): string[] =>
      getResolutionOutcomes(result)
        .filter((outcome) => outcome.filePath.endsWith(file))
        .map((outcome) => {
          const site =
            'range' in outcome ? `${outcome.range.startLine}:${outcome.range.startCol}` : '-';
          const what = outcome.kind === 'suppressed' ? outcome.reason : outcome.kind;
          return `${site} ${outcome.name} ${what}`;
        })
        .sort();

    it('keeps setter and comment-separated parameter calls; the leaked locals type nothing', () => {
      // `set u` (File: an accessor is a Property, not a call owner), `commented`
      // and `documented` (each typed by its own `User v`) and `set member`
      // (Class Box). No edge from `commentedBare` / `memberLocalBare`: they
      // read the untyped library variable / field `v`, which a getter's local
      // `v` used to leak into and type. No edge from `topLevelBare` /
      // `memberBare`: a getter publishes no return binding — pinned recall
      // gaps. The closure `(cs)` in `moduleVarRebound` owns its own `cs`, so
      // the outer `Address cs` keeps its annotation and `Factory.cs`'s hoisted
      // `Other` never answers.
      expect(callEdges('save', 'main.dart')).toEqual([
        'Class:main.dart:Box -> Method:models.dart:User.save#0',
        'File:main.dart -> Method:models.dart:User.save#0',
        'Function:main.dart:commented -> Method:models.dart:User.save#0',
        'Function:main.dart:documented -> Method:models.dart:User.save#0',
        'Function:main.dart:moduleVarRebound -> Method:models.dart:Address.save#0',
      ]);
      expect(outcomesIn('main.dart')).toEqual([]);
    });

    it('a nested rebinding keeps the annotation; a same-scope one stops at the untyped binder', () => {
      // A for-in, a catch body and an enum method's for-in each rebind the
      // name in a scope of their own, so the outer typed parameter answers —
      // never the same-named hoisted return of `Other ds()` / `Depot.es()` or
      // the enum field `Kind.depot`. In `collect` the collection `for` shares
      // the function's scope: `fs` is withheld, and both `fs.save()` sites —
      // the `Other` element inside the closure and the `Address` parameter
      // after it — stop at the untyped binder rather than reach `Depot.fs()`.
      // `docUntyped`'s parameter, behind a `///` comment, is still its
      // function's binder, so `Depot.gs()` never answers it either.
      expect(callEdges('save', 'nested_rebinding.dart')).toEqual([
        'Function:nested_rebinding.dart:caught -> Method:models.dart:Address.save#0',
        'Function:nested_rebinding.dart:forIn -> Method:models.dart:Address.save#0',
        'Method:nested_rebinding.dart:Kind.moved#1 -> Method:models.dart:Address.save#0',
      ]);
      expect(outcomesIn('nested_rebinding.dart')).toEqual([
        '49:52 save receiver-type-unresolved',
        '51:5 save receiver-type-unresolved',
        '57:5 save receiver-type-unresolved',
      ]);
    });

    it('a second spelling that declares nothing keeps the annotation beside a same-named method', () => {
      // `Maker.x()` publishes a hoisted `Other` for `x`. The function-typed
      // parameter's own `x`, the object- and record-pattern labels and the
      // pattern assignment declare nothing, and the for-in variable declares
      // `x` in the loop's own scope, so each `x.save()` stays the `Address`
      // parameter's.
      expect(callEdges('save', 'declares_nothing.dart')).toEqual([
        'Function:declares_nothing.dart:fnTyped -> Method:models.dart:Address.save#0',
        'Function:declares_nothing.dart:loop -> Method:models.dart:Address.save#0',
        'Function:declares_nothing.dart:objectLabel -> Method:models.dart:Address.save#0',
        'Function:declares_nothing.dart:recordLabel -> Method:models.dart:Address.save#0',
        'Function:declares_nothing.dart:swap -> Method:models.dart:Address.save#0',
      ]);
      expect(outcomesIn('declares_nothing.dart')).toEqual([]);
    });

    it("an accessor's name binds on its class, so a bare read in a sibling member stops there", () => {
      // `Gate.probe` / `probePair` read the getter `cs` and the getter + setter
      // pair `wr` (each a `this.` read of an `Address`): no edge, as before
      // accessors opened a scope, and never `Mint.cs` / `Mint.wr`'s hoisted
      // `Other`. The static getter and the field control are unchanged.
      expect(callEdges('save', 'accessor_names.dart')).toEqual([
        'Method:accessor_names.dart:Plain.probeField#0 -> Method:models.dart:Address.save#0',
      ]);
      expect(outcomesIn('accessor_names.dart')).toEqual([]);
    });

    it('a parameter shadowing a field masks it past a comment before the body', () => {
      // All three `conn` parameters are untyped, so the field `var conn =
      // Beta()` must not answer any read; each site is a recorded drop.
      expect(callEdges('inner', 'shadow.dart')).toEqual([]);
      expect(outcomesIn('shadow.dart')).toEqual([
        '11:9 inner receiver-owned-but-unbound',
        '15:9 inner receiver-owned-but-unbound',
        '21:9 inner receiver-owned-but-unbound',
      ]);
    });

    it('no accessor return binding types an untyped same-named receiver', () => {
      // `Box2.own` / `Crate.own` (each class's own getter), `f` / `g` (a local
      // and a `dynamic` parameter named like a member getter), `untypedParam` /
      // `untypedLocal` (named like the top-level getter) and the closure's own
      // `top` in `moduleGetterRebound`: no edge. The untyped binders stop the
      // walk where they are declared (`g`, `untypedParam`, `untypedLocal`, the
      // closure); `f`'s local is typed by its classless initializer.
      expect(callEdges('save', 'getters.dart')).toEqual([]);
      expect(outcomesIn('getters.dart')).toEqual([
        '33:5 save receiver-type-unresolved',
        '39:6 save receiver-type-unresolved',
        '44:6 save receiver-type-unresolved',
        '48:29 save receiver-type-unresolved',
      ]);
    });
  });
});
