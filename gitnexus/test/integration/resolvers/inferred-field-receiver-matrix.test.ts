/**
 * Cross-language matrix for #2807: can a class field whose type is INFERRED —
 * from its initializer, or from a constructor call assigned to it — act as a
 * call receiver?
 *
 * ── HOW TO READ A ROW ─────────────────────────────────────────────────────────
 *
 * Every row in every language runs the SAME statement shape,
 * `<receiver>.inner().compute(x)`, and only the receiver FORM varies. The
 * question this file answers is not "did both links resolve" — it is **does an
 * inference-typed field behave like that language's own control row**.
 *
 * That distinction is the whole design. Several languages lose the SECOND link
 * (`Inner.compute`) even for a plain local, because they have no return-type
 * annotation to carry the chain — JavaScript has none at all, and the Python,
 * Dart and PHP fixtures here declare none. That is a separate
 * return-type-inference gap and NOT what #2807 was about. Comparing an inferred
 * field against the language's control row isolates the field-typing question
 * from it; comparing against "both links present" would have falsely accused
 * four languages and falsely cleared none.
 *
 * ── MEASURED STATE ────────────────────────────────────────────────────────────
 *
 *   language    control        inferred field (init)   assigned field (this/self)
 *   ----------  -------------  ----------------------  --------------------------
 *   TypeScript  both links     both links  (#2807)     both links  (#2807)
 *   JavaScript  Outer.inner    Outer.inner (#2807)     Outer.inner (already ok)
 *   Python      Outer.inner    n/a — no field decls    Outer.inner (#2807)
 *   Ruby        both links     n/a — no field decls    both links  (#2807)
 *   Kotlin      both links     both links (was ok)     n/a — needs a type
 *   PHP         Outer.inner    n/a — see below         Outer.inner (was ok)
 *   Dart        Outer.inner    Outer.inner (#2807)     KNOWN GAP
 *   Swift       both links     both links  (#2807)     n/a — needs a type
 *
 * Shapes marked n/a do not exist in that language: Python and Ruby have no
 * field DECLARATIONS at all (a field is created by assignment, so only the
 * assigned column is meaningful), PHP property initializers accept only
 * constant expressions so `private $p = new Outer();` is not writable, and
 * Kotlin/Swift cannot declare a stored property with neither a type nor an
 * initializer, so their "assigned" shape is always annotated and already
 * resolves through the annotation.
 *
 * Kotlin and PHP were already correct before #2807 and are pinned here so a
 * change to the shared fold cannot regress them unnoticed — the two languages
 * that got receiver typing for free are exactly the ones nobody would think to
 * re-check.
 *
 * ── THE REMAINING GAP ─────────────────────────────────────────────────────────
 *
 * Dart's `assigned-field` row — `var r; C() { r = Outer(); }` — is pinned at its
 * current empty value. Unlike every other assigned shape here, Dart writes the
 * field WITHOUT a receiver prefix (`r = …`, not `this.r = …`), so binding it
 * would mean treating an assignment to a bare identifier as a field write, which
 * is indistinguishable from a constructor-local until the field set is known.
 * Idiomatic Dart writes `final r = Outer();`, which the inferred-field row above
 * now covers.
 *
 * The row asserts the empty value EXACTLY, with a `callerExists` probe in the
 * same object so an empty list can never be read as "resolved fine, wrong node
 * id". It is self-diffing: closing the gap fails this file with the newly
 * resolved ids in the diff, which is the signal to move the row and correct the
 * table above.
 *
 * Swift reached parity only once a SEPARATE defect was fixed alongside: its
 * methods are emitted as `Function` nodes while the scope extractor derives
 * `Method` from the declaration anchor, so every label-scoped bridge key missed
 * and two same-named methods in one file collapsed onto whichever registered
 * first — the second method's calls were attributed to the first. That masked
 * this row entirely; Swift's `let p = Outer()` binding had been correct all
 * along.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

/** One receiver form under test, with the exact CALLS targets it emits today. */
interface Row {
  readonly name: string;
  /** Exact node id of the method holding the chained statement. */
  readonly callerId: string;
  /** Every distinct CALLS target id, sorted. */
  readonly targets: readonly string[];
  readonly status: 'resolves' | 'known-gap';
}

interface LanguageCase {
  readonly language: string;
  readonly file: string;
  readonly source: string;
  readonly rows: readonly Row[];
}

// ── TypeScript ───────────────────────────────────────────────────────────────
const TS_FILE = 'src/app.ts';
const TS_SOURCE = `export class Inner { compute(v: number): number { return v * 2; } }
export class Outer { inner(): Inner { return new Inner(); } }
export class ControlLocal { run(x: number): number { const o = new Outer(); return o.inner().compute(x); } }
export class ControlTypedField { private p: Outer = new Outer(); run(x: number): number { return this.p.inner().compute(x); } }
export class InferredField { private p = new Outer(); run(x: number): number { return this.p.inner().compute(x); } }
export class AssignedField { private q; constructor() { this.q = new Outer(); } run(x: number): number { return this.q.inner().compute(x); } }
`;

// ── JavaScript ───────────────────────────────────────────────────────────────
const JS_FILE = 'src/app.js';
const JS_SOURCE = `export class Inner { compute(v) { return v * 2; } }
export class Outer { inner() { return new Inner(); } }
export class ControlLocal { run(x) { const o = new Outer(); return o.inner().compute(x); } }
export class InferredField { p = new Outer(); run(x) { return this.p.inner().compute(x); } }
export class AssignedField { constructor() { this.q = new Outer(); } run(x) { return this.q.inner().compute(x); } }
`;

// ── Python ───────────────────────────────────────────────────────────────────
const PY_FILE = 'src/app.py';
const PY_SOURCE = `class Inner:
    def compute(self, v):
        return v * 2


class Outer:
    def inner(self):
        return Inner()


class ControlLocal:
    def run(self, x):
        o = Outer()
        return o.inner().compute(x)


class AnnotatedField:
    def __init__(self):
        self.p: Outer = Outer()

    def run(self, x):
        return self.p.inner().compute(x)


class AssignedField:
    def __init__(self):
        self.q = Outer()

    def run(self, x):
        return self.q.inner().compute(x)


class ReassignedField:
    def __init__(self):
        self.r = Outer()
        self.r = self.rebuild()

    def rebuild(self):
        return Outer()

    def run(self, x):
        return self.r.inner().compute(x)
`;

// ── Ruby ─────────────────────────────────────────────────────────────────────
const RB_FILE = 'src/app.rb';
const RB_SOURCE = `class Inner
  def compute(v)
    v * 2
  end
end

class Outer
  def inner
    Inner.new
  end
end

class ControlLocal
  def run(x)
    o = Outer.new
    o.inner.compute(x)
  end
end

class AssignedField
  def initialize
    @q = Outer.new
  end

  def run(x)
    @q.inner.compute(x)
  end
end
`;

// ── Kotlin ───────────────────────────────────────────────────────────────────
const KT_FILE = 'src/app.kt';
const KT_SOURCE = `class Inner {
    fun compute(v: Int): Int { return v * 2 }
}

class Outer {
    fun inner(): Inner { return Inner() }
}

class ControlLocal {
    fun run(x: Int): Int {
        val o = Outer()
        return o.inner().compute(x)
    }
}

class InferredField {
    val p = Outer()
    fun run(x: Int): Int {
        return this.p.inner().compute(x)
    }
}
`;

// ── PHP ──────────────────────────────────────────────────────────────────────
const PHP_FILE = 'src/app.php';
const PHP_SOURCE = `<?php
class Inner { public function compute($v) { return $v * 2; } }
class Outer { public function inner() { return new Inner(); } }
class ControlLocal {
  public function run($x) { $o = new Outer(); return $o->inner()->compute($x); }
}
class ControlTypedField {
  private Outer $p;
  public function __construct() { $this->p = new Outer(); }
  public function run($x) { return $this->p->inner()->compute($x); }
}
class AssignedField {
  private $q;
  public function __construct() { $this->q = new Outer(); }
  public function run($x) { return $this->q->inner()->compute($x); }
}
`;

// ── Dart ─────────────────────────────────────────────────────────────────────
const DART_FILE = 'src/app.dart';
const DART_SOURCE = `class Inner {
  int compute(int v) {
    return v * 2;
  }
}

class Outer {
  Inner inner() {
    return Inner();
  }
}

class ControlLocal {
  int run(int x) {
    var o = Outer();
    return o.inner().compute(x);
  }
}

class ControlTypedField {
  Outer p = Outer();
  int run(int x) {
    return p.inner().compute(x);
  }
}

class InferredField {
  var q = Outer();
  int run(int x) {
    return q.inner().compute(x);
  }
}

class AssignedField {
  var r;
  AssignedField() {
    r = Outer();
  }
  int run(int x) {
    return r.inner().compute(x);
  }
}
`;

// ── Swift ────────────────────────────────────────────────────────────────────
const SWIFT_FILE = 'src/app.swift';
const SWIFT_SOURCE = `class Inner {
  func compute(_ v: Int) -> Int { return v * 2 }
}

class Outer {
  func inner() -> Inner { return Inner() }
}

class ControlLocal {
  func run(_ x: Int) -> Int {
    let o = Outer()
    return o.inner().compute(x)
  }
}

class InferredField {
  let p = Outer()
  func run(_ x: Int) -> Int {
    return self.p.inner().compute(x)
  }
}
`;

const CASES: readonly LanguageCase[] = [
  {
    language: 'typescript',
    file: TS_FILE,
    source: TS_SOURCE,
    rows: [
      {
        name: 'control-local',
        callerId: `Method:${TS_FILE}:ControlLocal.run#1`,
        targets: [
          `Class:${TS_FILE}:Outer`,
          `Method:${TS_FILE}:Inner.compute#1`,
          `Method:${TS_FILE}:Outer.inner#0`,
        ],
        status: 'resolves',
      },
      {
        name: 'control-typed-field',
        callerId: `Method:${TS_FILE}:ControlTypedField.run#1`,
        targets: [`Method:${TS_FILE}:Inner.compute#1`, `Method:${TS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'inferred-field',
        callerId: `Method:${TS_FILE}:InferredField.run#1`,
        targets: [`Method:${TS_FILE}:Inner.compute#1`, `Method:${TS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'assigned-field',
        callerId: `Method:${TS_FILE}:AssignedField.run#1`,
        targets: [`Method:${TS_FILE}:Inner.compute#1`, `Method:${TS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
    ],
  },
  {
    language: 'javascript',
    file: JS_FILE,
    source: JS_SOURCE,
    rows: [
      {
        name: 'control-local',
        callerId: `Method:${JS_FILE}:ControlLocal.run#1`,
        targets: [`Class:${JS_FILE}:Outer`, `Method:${JS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'inferred-field',
        callerId: `Method:${JS_FILE}:InferredField.run#1`,
        targets: [`Method:${JS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'assigned-field',
        callerId: `Method:${JS_FILE}:AssignedField.run#1`,
        targets: [`Method:${JS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
    ],
  },
  {
    language: 'python',
    file: PY_FILE,
    source: PY_SOURCE,
    rows: [
      {
        name: 'control-local',
        callerId: `Method:${PY_FILE}:ControlLocal.run#1`,
        targets: [`Method:${PY_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'control-annotated-field',
        callerId: `Method:${PY_FILE}:AnnotatedField.run#1`,
        targets: [`Method:${PY_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'assigned-field',
        callerId: `Method:${PY_FILE}:AssignedField.run#1`,
        targets: [`Method:${PY_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // A method call is not a construction. `self.r = Outer()` followed by
      // `self.r = self.rebuild()` must keep the FIRST binding: both would sit
      // in the weakest tier, so accepting `self.rebuild()` as a constructor let
      // the later one displace the real type and the field went untyped again —
      // measured as zero CALLS edges before `constructorCallTypeName` learned to
      // reject a callee rooted at the receiver. This row fails without that
      // rejection, which is the only reason it exists.
      {
        name: 'reassigned-from-method-call',
        callerId: `Method:${PY_FILE}:ReassignedField.run#1`,
        targets: [`Method:${PY_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
    ],
  },
  {
    language: 'ruby',
    file: RB_FILE,
    source: RB_SOURCE,
    rows: [
      {
        name: 'control-local',
        callerId: `Method:${RB_FILE}:ControlLocal.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'assigned-field',
        callerId: `Method:${RB_FILE}:AssignedField.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
    ],
  },
  {
    language: 'kotlin',
    file: KT_FILE,
    source: KT_SOURCE,
    rows: [
      {
        name: 'control-local',
        callerId: `Method:${KT_FILE}:ControlLocal.run#1`,
        targets: [`Method:${KT_FILE}:Inner.compute#1`, `Method:${KT_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'inferred-field',
        callerId: `Method:${KT_FILE}:InferredField.run#1`,
        targets: [`Method:${KT_FILE}:Inner.compute#1`, `Method:${KT_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
    ],
  },
  {
    language: 'php',
    file: PHP_FILE,
    source: PHP_SOURCE,
    rows: [
      {
        name: 'control-local',
        callerId: `Method:${PHP_FILE}:ControlLocal.run#1`,
        targets: [`Class:${PHP_FILE}:Outer`, `Method:${PHP_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'control-typed-field',
        callerId: `Method:${PHP_FILE}:ControlTypedField.run#1`,
        targets: [`Method:${PHP_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'assigned-field',
        callerId: `Method:${PHP_FILE}:AssignedField.run#1`,
        targets: [`Method:${PHP_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
    ],
  },
  {
    language: 'dart',
    file: DART_FILE,
    source: DART_SOURCE,
    rows: [
      {
        name: 'control-local',
        callerId: `Method:${DART_FILE}:ControlLocal.run#1`,
        targets: [`Class:${DART_FILE}:Outer`, `Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'control-typed-field',
        callerId: `Method:${DART_FILE}:ControlTypedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'inferred-field',
        callerId: `Method:${DART_FILE}:InferredField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'assigned-field',
        callerId: `Method:${DART_FILE}:AssignedField.run#1`,
        targets: [],
        status: 'known-gap',
      },
    ],
  },
  {
    language: 'swift',
    file: SWIFT_FILE,
    source: SWIFT_SOURCE,
    rows: [
      {
        name: 'control-local',
        callerId: `Function:${SWIFT_FILE}:ControlLocal.run#1`,
        targets: [`Class:${SWIFT_FILE}:Outer`, `Function:${SWIFT_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'inferred-field',
        callerId: `Function:${SWIFT_FILE}:InferredField.run#1`,
        targets: [`Function:${SWIFT_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
    ],
  },
];

describe('inference-typed field receivers across languages (#2807)', () => {
  const results = new Map<string, PipelineResult>();

  beforeAll(async () => {
    for (const testCase of CASES) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gn-matrix-${testCase.language}-`));
      try {
        writeFixtureRepo(dir, { [testCase.file]: testCase.source });
        // CALLS resolution is complete before the graph phases run and nothing
        // here reads what they produce, so skipping them narrows each run to
        // the phase under test.
        results.set(
          testCase.language,
          await runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true }),
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 600000);

  /**
   * Distinct CALLS target ids emitted by one exact caller, sorted.
   *
   * Deduplicated on purpose: Swift emits the same edge more than once for one
   * call site, and edge MULTIPLICITY is a different question from whether the
   * receiver typed at all. Deduplicating keeps this file measuring the one
   * thing it claims to measure; a multiplicity regression belongs in a test
   * that says so.
   */
  function callTargets(language: string, callerId: string): string[] {
    const result = results.get(language);
    if (result === undefined) throw new Error(`no pipeline result for ${language}`);
    return [
      ...new Set(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.rel.sourceId === callerId)
          .map((edge) => edge.rel.targetId),
      ),
    ].sort();
  }

  function callerExists(language: string, callerId: string): boolean {
    const result = results.get(language);
    if (result === undefined) throw new Error(`no pipeline result for ${language}`);
    return result.graph.getNode(callerId) !== undefined;
  }

  for (const testCase of CASES) {
    describe(testCase.language, () => {
      // Every row's caller node must exist before any target assertion means
      // anything: an id-scheme change or fixture drift would otherwise turn
      // every row into a silently vacuous empty-vs-empty comparison — which is
      // exactly how a "known gap" row rots into a passing lie.
      it('every row has a live caller node', () => {
        const found = Object.fromEntries(
          testCase.rows.map((row) => [row.name, callerExists(testCase.language, row.callerId)]),
        );
        expect(found).toEqual(Object.fromEntries(testCase.rows.map((row) => [row.name, true])));
      });

      for (const row of testCase.rows.filter((r) => r.status === 'resolves')) {
        it(`${row.name}: resolves`, () => {
          expect(callTargets(testCase.language, row.callerId)).toEqual([...row.targets].sort());
        });
      }

      const gaps = testCase.rows.filter((r) => r.status === 'known-gap');
      if (gaps.length > 0) {
        it(`KNOWN GAP: inference-typed field receivers emit no CALLS edges`, () => {
          const observed = Object.fromEntries(
            gaps.map((row) => [row.name, callTargets(testCase.language, row.callerId)]),
          );
          expect(observed).toEqual(Object.fromEntries(gaps.map((row) => [row.name, []])));
        });
      }
    });
  }

  // A whole-matrix guard: the per-language blocks above would all still pass if
  // a language were quietly deleted from CASES, or if a row lost its control.
  // Every language must keep at least one control row that resolves — that is
  // what makes its gap rows mean "broken" rather than "fixture never worked".
  it('every language keeps a resolving control row', () => {
    const controls = Object.fromEntries(
      CASES.map((testCase) => [
        testCase.language,
        testCase.rows.some((row) => row.name.startsWith('control') && row.status === 'resolves'),
      ]),
    );
    expect(controls).toEqual(Object.fromEntries(CASES.map((c) => [c.language, true])));
  });
});
