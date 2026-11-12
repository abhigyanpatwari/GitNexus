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
 *     comment as a named sibling, so the body was never found and the
 *     parameter bound nothing.
 *
 * Contract:
 *   - every accessor and comment-separated function opens exactly one scope;
 *     a bodiless signature never takes a later member's body;
 *   - an accessor publishes no return binding — it would be hoisted to the
 *     Module scope and type an untyped same-named receiver elsewhere (a wrong
 *     owner, where the accessor published nothing before it had a scope);
 *   - a member parameter that shadows a field masks it for a bare read in its
 *     body even with a comment before that body (the shadow set, like the
 *     binder census, walks back past comments to the signature);
 *   - a parameter annotation is withheld when the body binds the name again
 *     (declarator, closure parameter, catch / pattern binder), because the
 *     scope keeps one binding per name; a plain assignment keeps it. The cost
 *     is recall: an outer `cs.save()` beside a closure `(cs) => …` has no edge.
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
    const thisBindings = captures.flatMap((m) => {
      const self = m['@type-binding.self'];
      return self === undefined || m['@type-binding.name']?.text !== 'this'
        ? []
        : [`${self.range.startLine}:${m['@type-binding.type']?.text}`];
    });
    // The static getter on line 2 binds no `this`.
    expect(thisBindings).toEqual(['3:UserExtension', '4:UserMixin']);
  });

  it('does not attach a later member body after a bodiless signature and a comment', () => {
    const captures = emitDartScopeCaptures(
      `abstract class Contract {
  void missing();
  // a comment is a named sibling, like the body the walk looks for
  User get present => User();
}`,
      'bodiless-signature.dart',
    ) as CaptureMatch[];
    // Only `present` (line 4) has a body; `missing` must not take it.
    expect(functionScopeLines(captures)).toEqual([4]);
  });

  it('withholds a parameter annotation the body rebinds under the same name', () => {
    const PRE =
      'class User { void save() {} }\nclass Address { void save() {} }\nUser make() => User();\n';
    const parameterBindings = (source: string): string[] =>
      (emitDartScopeCaptures(PRE + source, 'rebound.dart') as CaptureMatch[])
        .filter((m) => m['@type-binding.parameter'] !== undefined)
        .map((m) => `${m['@type-binding.name']?.text}:${m['@type-binding.type']?.text}`);
    // The scope opens, so without the rule the annotation would type the
    // rebound `cs.save()` as `Address.save`.
    expect(
      parameterBindings('void f(Address cs) /* c */ { final cs = make(); cs.save(); }\n'),
    ).toEqual([]);
    expect(parameterBindings('set s(Address cs) { final cs = make(); cs.save(); }\n')).toEqual([]);
    // A different local name, or a plain assignment, keeps the annotation.
    expect(
      parameterBindings('void g(Address cs) /* c */ { final w = make(); cs.save(); }\n'),
    ).toEqual(['cs:Address']);
    expect(parameterBindings('void h(Address cs) { cs = Address(); cs.save(); }\n')).toEqual([
      'cs:Address',
    ]);
    // A closure parameter is a rebinding too: the outer annotation is lost
    // rather than allowed to type the closure's receiver.
    expect(
      parameterBindings('void closure(Address cs) { items.forEach((cs) => cs.save()); }\n'),
    ).toEqual([]);
  });

  describe('edge ownership', () => {
    let result: PipelineResult;

    beforeAll(async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'dart-scope-openers'), () => {});
    }, 60_000);

    const saveEdges = (file: string): string[] =>
      getRelationships(result, 'CALLS')
        .filter((edge) => edge.target === 'save' && edge.sourceFilePath.endsWith(file))
        .map((edge) => `${edge.rel.sourceId} -> ${edge.rel.targetId}`)
        .sort();

    const saveOutcomes = (file: string) =>
      getResolutionOutcomes(result).filter(
        (outcome) => outcome.name === 'save' && outcome.filePath.endsWith(file),
      );

    it('keeps setter and commented-function parameter calls; the leaked locals type nothing', () => {
      // `set u` (File: an accessor is a Property, not a call owner), `commented`
      // (its own `User v`) and `set member` (Class Box). No edge from
      // `commentedBare` / `memberLocalBare` (a getter's local used to leak and
      // type their `v`), from `topLevelBare` / `memberBare` (an accessor name is
      // not a typed receiver), or from `moduleVarRebound` (its `Address cs` is
      // withheld beside the closure `(cs)` — the recall cost) and nothing from
      // the module variable `Other cs` either.
      expect(saveEdges('main.dart')).toEqual([
        'Class:main.dart:Box -> Method:models.dart:User.save#0',
        'File:main.dart -> Method:models.dart:User.save#0',
        'Function:main.dart:commented -> Method:models.dart:User.save#0',
      ]);
      expect(saveOutcomes('main.dart')).toEqual([]);
    });

    it('a parameter shadowing a field masks it past a comment before the body', () => {
      // Both `conn` parameters are untyped, so the field `var conn = Beta()` must
      // not answer either read; each site is a recorded owned-but-unbound drop.
      const inner = getRelationships(result, 'CALLS').filter(
        (edge) => edge.target === 'inner' && edge.sourceFilePath.endsWith('shadow.dart'),
      );
      expect(inner).toEqual([]);
      const outcomes = getResolutionOutcomes(result)
        .filter((outcome) => outcome.filePath.endsWith('shadow.dart'))
        .map((outcome) =>
          outcome.kind === 'suppressed'
            ? `${outcome.range.startLine}:${outcome.range.startCol} ${outcome.name} ${outcome.reason}`
            : `${outcome.range.startLine}:${outcome.range.startCol} ${outcome.name} resolved`,
        )
        .sort();
      expect(outcomes).toEqual([
        '11:9 inner receiver-owned-but-unbound',
        '15:9 inner receiver-owned-but-unbound',
      ]);
    });

    it('no accessor return binding types an untyped same-named receiver', () => {
      // `Box2.own` / `Crate.own` (each class's own getter), `f` / `g` (a local
      // and a `dynamic` parameter named like a member getter), `untypedParam` /
      // `untypedLocal` (named like the top-level getter) and the closure in
      // `moduleGetterRebound` (its outer annotation withheld): no edge, and no
      // recorded outcome either.
      expect(saveEdges('getters.dart')).toEqual([]);
      expect(saveOutcomes('getters.dart')).toEqual([]);
    });
  });
});
