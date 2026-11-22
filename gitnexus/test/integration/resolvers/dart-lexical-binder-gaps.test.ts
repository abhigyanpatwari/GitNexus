/**
 * DART-12 — the six review findings on the DART-11 lexical-binder stop (#3903),
 * re-checked on main after #3903 and #3904 merged.
 *
 * Each finding was reproduced on #3903's first head and fixed in its review
 * round; `receiver-walk-untyped-binder.test.ts` pins the snippet each finding
 * quoted. This file covers the rest of what the findings named:
 *
 *   - REGRESSION PINS (already correct on main, no source change): the
 *     secondary shapes each finding listed beside its snippet, which had no
 *     pin. A pattern assignment inside a local function; matching constants in
 *     an if-case, a switch expression and a logical-or pattern (1). `this` in a
 *     name-binding closure under a setter, an operator and a `late`
 *     initializer, and the `ACCESSES` edge of `this.addr.city` (2). A block or
 *     doc comment between a local function's signature and its body, and a
 *     comment between a closure's parameters and its body (3). A block-local
 *     redeclaration inside `if`, `while`, `try` and a switch case (4). A free
 *     call after a top-level `for (final helper in xs)`, after a braceless
 *     loop, and after a catch in a plain function (5). `_` on an arrow
 *     closure, a for-in variable and a catch parameter is no lexical name and
 *     no receiver type: beside a field `_` it reads the field (6).
 *
 *   - FAIL-FIRST PINS (wrong or lost on main, fixed here):
 *     5. A collection `for` or `if` element bound its variable into the
 *        enclosing scope, so a free or implicit-`this` call of that name after
 *        the literal had no edge and no recorded outcome
 *        (`[for (final tick in xs) tick]; tick();`). The same leak withheld a
 *        parameter's annotation when an element rebinds its name, so the
 *        correct outer site lost its edge (DART-10 recall boundary 1). Each
 *        element now opens a Block scope when it declares a name, like the
 *        `for` and `if` statements, in every position: an element or a
 *        switch-expression case in a field or top-level initializer scopes its
 *        variable too, where it used to borrow a same-named field's type.
 *     6. A typed `_` parameter of a method, function or constructor and a
 *        local `final Other _ = Other()` still bound `_` to their type; only
 *        closure and local-function parameters skipped it. From Dart 3.7 such a
 *        `_` declares nothing, so the `Other` edge was wrong. Every `_`
 *        parameter and local binds no type and does not shadow a field. A
 *        function named `_` has a return type only when called; its bare value
 *        cannot answer a receiver read. Unresolved reads record an outcome.
 *        Explicit pre-3.7 file versions preserve the older binding behavior
 *        (covered in dart-review-followups.test.ts).
 *
 * Every site asserts its exact CALLS edges, and every site whose outcome
 * matters asserts the exact suppression (by call site, kind included).
 */
import { describe, expect, it } from 'vitest';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { getRelationships, getResolutionOutcomes, useFixture } from './helpers.js';

// The Dart grammar is optional; its suites skip where it cannot load.
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}

/**
 * Every `type` edge whose source is declared in `file`, as
 * `source -> target @line:col`; `@-` marks an edge whose id carries no site.
 */
function edgesFrom(result: PipelineResult, type: 'CALLS' | 'ACCESSES', file: string): string[] {
  return getRelationships(result, type)
    .filter((edge) => edge.sourceFilePath === file && edge.targetLabel !== 'Class')
    .map((edge) => {
      const suffix = edge.rel.id.slice(
        edge.rel.id.lastIndexOf(edge.rel.targetId) + edge.rel.targetId.length,
      );
      const site = /^:(\d+):(\d+)/.exec(suffix);
      return `${edge.rel.sourceId} -> ${edge.rel.targetId} @${site === null ? '-' : `${site[1]}:${site[2]}`}`;
    })
    .sort();
}

/** Every suppression recorded in `file`, as `line:col kind name reason detail binder`. */
function outcomesIn(result: PipelineResult, file: string): string[] {
  return getResolutionOutcomes(result)
    .flatMap((outcome) =>
      outcome.kind === 'suppressed' && outcome.filePath === file
        ? [
            [
              `${outcome.range.startLine}:${outcome.range.startCol}`,
              outcome.siteKind,
              outcome.name,
              outcome.reason,
              outcome.declineDetail,
              outcome.binderScopeId,
            ]
              .filter((part) => part !== undefined)
              .join(' '),
          ]
        : [],
    )
    .sort();
}

const UNTYPED = 'receiver-type-unresolved untyped-binder';

const MODELS = `class Address {
  String city = '';
  void save() {}
  void run() {}
}

class Other {
  void save() {}
  void run() {}
}

void helper() {}
`;

// ── Regression pins: correct on main since #3903's review round ────────────
describe.skipIf(!dartAvailable)(
  'Dart — review shapes beside the quoted snippets (regression pins)',
  () => {
    const run = useFixture('dart12-regression', {
      'models.dart': MODELS,
      // (1) Names that declare nothing.
      'declares_nothing.dart': `import 'models.dart';

void assignsLocal(Address cs) {
  void inner() {
    (cs,) = (Address(),);
    cs.save();
  }
}

void ifConst(Object value, Address cs) {
  if (value case Address) {
    cs.save();
  }
}

Object swExpr(Object value, Address cs) => switch (value) { Address => cs.run(), _ => 0 };

void orPattern(Object value, Address cs) {
  switch (value) {
    case Address || Other:
      cs.save();
  }
}
`,
      // (2) `this` in a closure under a member with no scope of its own.
      'accessor_this.dart': `import 'models.dart';

class Svc {
  Address addr = Address();
  List<int> seed = [];
  set viaSetter(Other v) {
    seed.forEach((x) { this.addr.run(); });
  }
  Other operator +(Other o) {
    seed.forEach((x) { this.addr.save(); });
    return o;
  }
  late final Other lazy = () {
    seed.forEach((x) { this.addr.run(); });
    return Other();
  }();
  String get viaRead {
    var out = '';
    seed.forEach((x) { out = this.addr.city; });
    return out;
  }
}
`,
      // (3) A comment between a signature and its body.
      'comments.dart': `import 'models.dart';

void k2(Address cs) {
  void inner(Other cs) /* note */ {
    cs.run();
  }
  cs.save();
}

void k3(Address cs) {
  void inner(Other cs)
  /// doc
  {
    cs.run();
  }
  cs.save();
}

void k4(Address cs, List<Other> xs) {
  xs.forEach((Other cs) /* note */ {
    cs.run();
  });
  cs.save();
}
`,
      // (4) A block-local redeclaration hides the parameter.
      'blocks.dart': `import 'models.dart';

void bIf(Other cs, dynamic r, bool c) {
  if (c) { var cs = r; cs.save(); }
  cs.run();
}

void bWhile(Other cs, dynamic r, bool c) {
  while (c) { var cs = r; cs.save(); }
}

void bTry(Other cs, dynamic r) {
  try { var cs = r; cs.save(); } catch (e) {}
}

void bCase(Other cs, dynamic r, int k) {
  switch (k) { case 1: var cs = r; cs.save(); }
}
`,
      // (5) A loop or catch binder no longer hides a call after its statement.
      'statements.dart': `import 'models.dart';

void g1(List<int> xs) {
  for (final helper in xs) { print(helper); }
  helper();
}

void g2(List<int> xs) {
  try {} catch (helper) { print(helper); }
  helper();
}

class Tk {
  void tick() {}
  void m3b(List<int> xs) {
    for (final tick in xs) print(tick);
    tick();
  }
}
`,
      // (6) `_` on a closure, for-in or catch variable is no lexical name: beside
      // the field `_` each site is the field's masked read, not a binder stop.
      'wildcard_closures.dart': `import 'models.dart';

class Holder {
  final Address _ = Address();
  void arrow(List<Other> items) {
    items.forEach((Other _) => _.save());
  }
  void forIn(List<Other> items) {
    for (final Other _ in items) { _.save(); }
  }
  void caught() {
    try {} on Other catch (_) { _.run(); }
  }
}
`,
    });

    it('(1) a pattern assignment in a local function and matching constants declare nothing', () => {
      expect(edgesFrom(run(), 'CALLS', 'declares_nothing.dart')).toEqual([
        'Function:declares_nothing.dart:assignsLocal.inner@3:2 -> Method:models.dart:Address.save#0 @6:7',
        'Function:declares_nothing.dart:ifConst -> Method:models.dart:Address.save#0 @12:7',
        'Function:declares_nothing.dart:orPattern -> Method:models.dart:Address.save#0 @21:9',
        'Function:declares_nothing.dart:swExpr -> Method:models.dart:Address.run#0 @16:74',
      ]);
      expect(outcomesIn(run(), 'declares_nothing.dart')).toEqual([]);
    });

    it('(2) a closure under a setter, an operator or a `late` initializer keeps the class as `this`', () => {
      expect(edgesFrom(run(), 'CALLS', 'accessor_this.dart')).toEqual([
        'Class:accessor_this.dart:Svc -> Method:models.dart:Address.run#0 @7:33',
        'Class:accessor_this.dart:Svc -> Method:models.dart:Address.save#0 @10:33',
        'Property:accessor_this.dart:Svc.lazy -> Method:models.dart:Address.run#0 @14:33',
      ]);
      expect(edgesFrom(run(), 'ACCESSES', 'accessor_this.dart')).toContain(
        'Class:accessor_this.dart:Svc -> Property:models.dart:Address.city @-',
      );
      expect(outcomesIn(run(), 'accessor_this.dart')).toEqual([]);
    });

    it('(3) a block or doc comment keeps the typed parameter inside the local function or closure', () => {
      expect(edgesFrom(run(), 'CALLS', 'comments.dart')).toEqual([
        'Function:comments.dart:k2 -> Method:models.dart:Address.save#0 @7:5',
        'Function:comments.dart:k2.inner@3:2 -> Method:models.dart:Other.run#0 @5:7',
        'Function:comments.dart:k3 -> Method:models.dart:Address.save#0 @16:5',
        'Function:comments.dart:k3.inner@10:2 -> Method:models.dart:Other.run#0 @14:7',
        'Function:comments.dart:k4 -> Method:models.dart:Address.save#0 @23:5',
        'Function:comments.dart:k4 -> Method:models.dart:Other.run#0 @21:7',
      ]);
    });

    it('(4) a block-local in `if`, `while`, `try` or a case hides the typed parameter only inside', () => {
      expect(edgesFrom(run(), 'CALLS', 'blocks.dart')).toEqual([
        'Function:blocks.dart:bIf -> Method:models.dart:Other.run#0 @5:5',
      ]);
      expect(outcomesIn(run(), 'blocks.dart')).toEqual([
        `13:23 call save ${UNTYPED} scope:blocks.dart#13:6-13:32:Block`,
        `17:38 call save ${UNTYPED} scope:blocks.dart#17:15-17:45:Block`,
        `4:26 call save ${UNTYPED} scope:blocks.dart#4:9-4:35:Block`,
        `9:29 call save ${UNTYPED} scope:blocks.dart#9:12-9:38:Block`,
      ]);
    });

    it('(5) a free or implicit-`this` call after a loop or catch reaches its target', () => {
      expect(edgesFrom(run(), 'CALLS', 'statements.dart')).toEqual([
        'Function:statements.dart:g1 -> Function:models.dart:helper @-',
        'Function:statements.dart:g2 -> Function:models.dart:helper @-',
        'Method:statements.dart:Tk.m3b#1 -> Method:statements.dart:Tk.tick#0 @-',
      ]);
    });

    it('(6) `_` on an arrow closure, a for-in or a catch variable is no lexical name and no receiver type', () => {
      expect(edgesFrom(run(), 'CALLS', 'wildcard_closures.dart')).toEqual([
        'Method:wildcard_closures.dart:Holder.arrow#1 -> Method:models.dart:Address.save#0 @6:33',
        'Method:wildcard_closures.dart:Holder.caught#0 -> Method:models.dart:Address.run#0 @12:34',
        'Method:wildcard_closures.dart:Holder.forIn#1 -> Method:models.dart:Address.save#0 @9:37',
      ]);
      expect(
        outcomesIn(run(), 'wildcard_closures.dart').filter((o) => !o.includes(' forEach ')),
      ).toEqual([]);
    });
  },
);

// ── Fail-first (5): collection elements scope their own variables ──────────
describe.skipIf(!dartAvailable)(
  'Dart — a collection `for` or `if` element binds its variable to the element',
  () => {
    const run = useFixture('dart12-elements', {
      'models.dart': MODELS,
      'elements.dart': `import 'models.dart';

class Tk {
  void tick() {}
  void listFor(List<int> xs) {
    final l = [for (final tick in xs) tick];
    tick();
  }
  void mapFor(List<int> xs) {
    final m = {for (final tick in xs) tick: 1};
    tick();
  }
  void listIfCase(Object o) {
    final l = [if (o case int tick) tick];
    tick();
  }
}

void topFor(List<int> xs) {
  final l = [for (final helper in xs) helper];
  helper();
}

void collect(Address fs, List<Other> others) {
  final thunks = [for (final fs in others) () => fs.save()];
  fs.save();
}

void inside(Address cs, List<dynamic> xs) {
  final l = [for (final cs in xs) cs.save()];
}
`,
      'elements_more.dart': `import 'models.dart';

void setFor(Address cs, List<Other> xs) {
  final s = {for (final cs in xs) cs.save()};
  cs.run();
}

void nested(Address cs, List<List<Other>> xss) {
  final l = [for (final row in xss) for (final cs in row) cs.save()];
  cs.run();
}

void ifCase(Address cs, Object o) {
  final l = [if (o case final cs) cs.save()];
  cs.run();
}
`,
      'initializers.dart': `import 'models.dart';

List<Other> others = [];
final topList = [for (final fs in others) fs.save()];

class Fld {
  Address fs = Address();
  List<Other> others = [];
  late final inner = [for (final fs in others) fs.save()];
  late final outer = [for (final gs in others) fs.run()];
  late final cased = switch (others.first) { final fs => fs.save() };
}

class Init {
  final List l;
  Init.bodiless(Address fs, List<Other> others) : l = [for (final fs in others) fs.save()];
}
`,
    });

    it('after the literal, an implicit-`this` or free call reaches the name the element no longer hides', () => {
      expect(
        edgesFrom(run(), 'CALLS', 'elements.dart').filter(
          (e) => e.endsWith('Tk.tick#0 @-') || e.includes('models.dart:helper'),
        ),
      ).toEqual([
        'Function:elements.dart:topFor -> Function:models.dart:helper @-',
        'Method:elements.dart:Tk.listFor#1 -> Method:elements.dart:Tk.tick#0 @-',
        'Method:elements.dart:Tk.listIfCase#1 -> Method:elements.dart:Tk.tick#0 @-',
        'Method:elements.dart:Tk.mapFor#1 -> Method:elements.dart:Tk.tick#0 @-',
      ]);
    });

    it('a parameter an element rebinds keeps its annotation outside the element', () => {
      // DART-10 recall boundary 1: the outer `fs` is the `Address` parameter.
      expect(
        edgesFrom(run(), 'CALLS', 'elements.dart').filter((e) => e.includes('.save#')),
      ).toEqual(['Function:elements.dart:collect -> Method:models.dart:Address.save#0 @26:5']);
    });

    it("inside the element, the element's own variable still stops the walk", () => {
      expect(outcomesIn(run(), 'elements.dart').filter((o) => o.includes(' save '))).toEqual([
        `25:52 call save ${UNTYPED} scope:elements.dart#25:42-25:58:Block`,
        `30:37 call save ${UNTYPED} scope:elements.dart#30:33-30:43:Block`,
      ]);
    });

    it('a set literal, a nested element and an if-case element each scope their own variable', () => {
      expect(edgesFrom(run(), 'CALLS', 'elements_more.dart')).toEqual([
        'Function:elements_more.dart:ifCase -> Method:models.dart:Address.run#0 @15:5',
        'Function:elements_more.dart:nested -> Method:models.dart:Address.run#0 @10:5',
        'Function:elements_more.dart:setFor -> Method:models.dart:Address.run#0 @5:5',
      ]);
      expect(outcomesIn(run(), 'elements_more.dart')).toEqual([
        `14:37 call save ${UNTYPED} scope:elements_more.dart#14:23-14:43:Block`,
        `4:37 call save ${UNTYPED} scope:elements_more.dart#4:33-4:43:Block`,
        `9:61 call save ${UNTYPED} scope:elements_more.dart#9:57-9:67:Block`,
      ]);
    });

    it('an element or a switch-expression case in a field or top-level initializer never borrows a same-named field', () => {
      // `fs` is an `Other` inside each element; only `outer`, whose element
      // binds `gs`, reads the field `Address fs`.
      expect(edgesFrom(run(), 'CALLS', 'initializers.dart')).toEqual([
        'Class:initializers.dart:Fld -> Method:models.dart:Address.run#0 @10:50',
      ]);
      expect(outcomesIn(run(), 'initializers.dart')).toEqual([
        `11:60 call save ${UNTYPED} scope:initializers.dart#11:45-11:66:Block`,
        `16:83 call save ${UNTYPED} scope:initializers.dart#16:79-16:89:Block`,
        `4:45 call save ${UNTYPED} scope:initializers.dart#4:41-4:51:Block`,
        `9:50 call save ${UNTYPED} scope:initializers.dart#9:46-9:56:Block`,
      ]);
    });
  },
);

// ── Fail-first (6): a typed `_` on a signature or a local binds no type ─────
describe.skipIf(!dartAvailable)(
  'Dart — a typed `_` parameter or local declares nothing (Dart 3.7 wildcard)',
  () => {
    const run = useFixture('dart12-wildcard', {
      'models.dart': MODELS,
      'wildcard.dart': `import 'models.dart';

class Holder {
  final Address _ = Address();
  Holder(Other _) {
    _.run();
  }
  void param(Other _) {
    _.save();
  }
  void arrowParam(Other _) => _.run();
  void local() {
    final Other _ = Other();
    _.save();
  }
}

void topParam(Other _) {
  _.save();
}

class Plain {
  final Address _ = Address();
  void field() {
    _.run();
  }
}
`,
      'wildcard_function.dart': `import 'models.dart';

Address _() => Address();

void param(Other _) {
  _.save();
}

void typedLocal() {
  final Other _ = Other();
  _.save();
}

void inferredLocal() {
  final _ = Other();
  _.save();
}

void closure(List<Other> items) {
  items.forEach((Other _) => _.save());
}

void control(Other o) {
  o.save();
}

void chain() {
  _().run();
}
`,
      'wildcard_method.dart': `import 'models.dart';

class Decoy {
  Address _() => Address();
}

class Host {
  void param(Other _) {
    _.save();
  }
  void control(Other o) {
    o.save();
  }
}

void topParam(Other _) {
  _.save();
}
`,
    });

    it('wildcard parameters and locals do not shadow the field named `_`', () => {
      expect(edgesFrom(run(), 'CALLS', 'wildcard.dart')).toEqual([
        'Constructor:wildcard.dart:Holder.Holder#1 -> Method:models.dart:Address.run#0 @6:6',
        'Method:wildcard.dart:Holder.arrowParam#1 -> Method:models.dart:Address.run#0 @11:32',
        'Method:wildcard.dart:Holder.local#0 -> Method:models.dart:Address.save#0 @14:6',
        'Method:wildcard.dart:Holder.param#1 -> Method:models.dart:Address.save#0 @9:6',
        'Method:wildcard.dart:Plain.field#0 -> Method:models.dart:Address.run#0 @25:6',
      ]);
      expect(outcomesIn(run(), 'wildcard.dart')).toEqual(['19:4 call save receiver-unresolved']);
    });

    it('records an unresolved receiver outside a class with a field `_`', () => {
      expect(outcomesIn(run(), 'wildcard.dart').filter((o) => o.startsWith('19:'))).toEqual([
        '19:4 call save receiver-unresolved',
      ]);
    });

    it('a same-file function named `_` never answers a `_` parameter, local or closure parameter', () => {
      // `Address _()` published `_ -> Address` on the Module scope, which typed
      // every untyped `_` receiver in the file as `Address`.
      expect(edgesFrom(run(), 'CALLS', 'wildcard_function.dart')).toEqual([
        'Function:wildcard_function.dart:chain -> Function:wildcard_function.dart:_ @-',
        'Function:wildcard_function.dart:chain -> Method:models.dart:Address.run#0 @28:6',
        'Function:wildcard_function.dart:control -> Method:models.dart:Other.save#0 @24:4',
      ]);
      expect(
        outcomesIn(run(), 'wildcard_function.dart').filter((o) => !o.includes(' forEach ')),
      ).toEqual([
        '11:4 call save receiver-unresolved',
        '16:4 call save receiver-unresolved',
        '20:31 call save receiver-unresolved',
        '6:4 call save receiver-unresolved',
      ]);
    });

    it('a method named `_` on an unrelated class never answers a `_` parameter', () => {
      expect(edgesFrom(run(), 'CALLS', 'wildcard_method.dart')).toEqual([
        'Method:wildcard_method.dart:Host.control#1 -> Method:models.dart:Other.save#0 @12:6',
      ]);
      expect(outcomesIn(run(), 'wildcard_method.dart')).toEqual([
        '17:4 call save receiver-unresolved',
        '9:6 call save receiver-unresolved',
      ]);
    });
  },
);
