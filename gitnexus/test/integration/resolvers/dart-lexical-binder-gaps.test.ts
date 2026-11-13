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
 *     loop, and after a catch in a plain function (5). A typed `_` on an arrow
 *     closure, a for-in variable and a catch parameter (6).
 *
 *   - FAIL-FIRST PINS (wrong or lost on main, fixed here):
 *     5. A collection `for` or `if` element bound its variable into the
 *        enclosing scope, so a free or implicit-`this` call of that name after
 *        the literal had no edge and no recorded outcome
 *        (`[for (final tick in xs) tick]; tick();`). The same leak withheld a
 *        parameter's annotation when an element rebinds its name, so the
 *        correct outer site lost its edge (DART-10 recall boundary 1). Each
 *        element now opens a Block scope when it declares a name, like the
 *        `for` and `if` statements.
 *     6. A typed `_` parameter of a method, function or constructor and a
 *        local `final Other _ = Other()` still bound `_` to their type; only
 *        closure and local-function parameters skipped it. From Dart 3.7 such a
 *        `_` declares nothing, so `_.save()` reads an enclosing `_` (here the
 *        class field), and the `Other` edge was wrong. Every `_` parameter and
 *        local now binds no type. As for closures, this is not version-gated:
 *        before Dart 3.7 the `Other` edge was right, so pre-3.7 sources lose it.
 *
 * Every site asserts its exact CALLS edges, and every site whose outcome
 * matters asserts the exact suppression (by call site, kind included).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import {
  isLanguageAvailable,
  loadLanguage,
  loadParser,
} from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { getRelationships, getResolutionOutcomes, writeFixtureRepo } from './helpers.js';

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

/** Materialize `files`, run the pipeline once, and clean up after the block. */
function useFixture(prefix: string, files: Record<string, string>): () => PipelineResult {
  let root = '';
  let result: PipelineResult | undefined;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), `gitnexus-${prefix}-`));
    writeFixtureRepo(root, files);
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);
  afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
  });
  return () => {
    if (result === undefined) throw new Error('pipeline did not run');
    return result;
  };
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
      // (6) A typed `_` closure, for-in or catch variable declares nothing.
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
        'Function:declares_nothing.dart:assignsLocal -> Method:models.dart:Address.save#0 @6:7',
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
        'Function:comments.dart:k2 -> Method:models.dart:Other.run#0 @5:7',
        'Function:comments.dart:k3 -> Method:models.dart:Address.save#0 @16:5',
        'Function:comments.dart:k3 -> Method:models.dart:Other.run#0 @14:7',
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

    it('(6) a typed `_` arrow-closure, for-in or catch variable is not a receiver type', () => {
      expect(edgesFrom(run(), 'CALLS', 'wildcard_closures.dart')).toEqual([]);
      expect(
        outcomesIn(run(), 'wildcard_closures.dart').filter((o) => !o.includes(' forEach ')),
      ).toEqual([
        '12:34 call run receiver-owned-but-unbound',
        '6:33 call save receiver-owned-but-unbound',
        '9:37 call save receiver-owned-but-unbound',
      ]);
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
        `25:52 call save ${UNTYPED} scope:elements.dart#25:18-25:58:Block`,
        `30:37 call save ${UNTYPED} scope:elements.dart#30:13-30:43:Block`,
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
`,
    });

    it('`_` in a method, constructor or local is the field, never an `Other`', () => {
      expect(edgesFrom(run(), 'CALLS', 'wildcard.dart')).toEqual([]);
      expect(outcomesIn(run(), 'wildcard.dart').filter((o) => /^(6|9|11|14):/.test(o))).toEqual([
        '11:32 call run receiver-owned-but-unbound',
        '14:6 call save receiver-owned-but-unbound',
        '6:6 call run receiver-owned-but-unbound',
        '9:6 call save receiver-owned-but-unbound',
      ]);
    });

    it('a top-level function with a typed `_` parameter binds no `Other` (pre-3.7 recall cost)', () => {
      expect(
        edgesFrom(run(), 'CALLS', 'wildcard.dart').filter((e) => e.includes('topParam')),
      ).toEqual([]);
    });
  },
);
