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
 *   Dart        Outer.inner    Outer.inner (#2807)     Outer.inner (#2807)
 *   Swift       both links     both links  (#2807)     optional field (#2807)
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
 * ── THE OTHER HALF: A FIELD MUST NOT BE TYPED BY AN ALIEN `this` ─────────────
 *
 * Typing a field from `this.p = new Outer()` is only half the question; the
 * other half is WHICH `this`. The first cut of the TypeScript pattern was
 * context-free, so it typed a class's field from any `this.p = new …` in the
 * file — inside a non-arrow callback, an object-literal method, a static
 * method, or at module top level, none of which are that class's instance. The
 * TypeScript section carries one guard row per shape; see the comment on them.
 * They are written so a regression SWAPS a target rather than emptying the set,
 * because a row that asserts an empty result passes just as well when the
 * fixture stopped working.
 *
 * A `static` member reaches the same Class scope by a SECOND route that has no
 * `this` in it at all — its own declaration. JavaScript and TypeScript keep
 * static and instance members in separate namespaces, so `p = new Outer();
 * static p = new Alien();` is legal and `this.p` is `Outer`; both bindings
 * landed on one scope at one strength and the `>=` tie-break gave the field to
 * whichever matched last. Dart forbids that same-name pair outright, so its
 * version of the defect is a static METHOD's receiver-less write
 * (`libraryZ = Other()`, which in Dart's static scope names a library variable)
 * displacing the constructor's binding. All three languages carry a row, and
 * Dart carries the counterweight too: a static field DECLARATION is read by
 * bare name from instance methods in ordinary Dart, so its binding must survive.
 *
 * ── HOW THE HARD CASES WERE FIXED ─────────────────────────────────────────────
 *
 * Dart is the one language here that writes a field with NO receiver prefix, so
 * `r = Outer()` in a constructor is syntactically identical to assigning a
 * local. It binds only when the class declares that field AND the enclosing
 * member binds no name that shadows it — exactly when Dart itself resolves the
 * bare name to the field. A `this.`-prefixed write needs neither test. The
 * shadowing cases are asserted, not described: a body-local, a formal parameter,
 * a closure parameter, a catch binding and a for-in variable each get a row.
 * "Local declarations" alone was the first attempt and was wrong in both
 * directions — a parameter write retyped the field to the wrong class AND
 * displaced the constructor's correct binding, so the shadow rows below assert
 * the SURVIVING correct target rather than an absence.
 *
 * That shadow set gated WRITES only, which left the mirror-image defect on the
 * READ side: a bare-name read of a shadowing binder the resolver cannot type
 * (`for (final conn in xs) { conn.inner(); }`) walked past the local and picked
 * up the very class binding the write side had just minted, so a missing edge
 * became a WRONG one. The fix publishes `shadows ∩ fields` on the member's
 * Function scope as `Scope.ownsReceivers` (#2701) — the same language-neutral
 * masking primitive TypeScript uses for a non-arrow `this`. Because the receiver
 * walk consults `typeBindings` before the mask at every scope, a shadow the
 * resolver CAN type still wins, which the annotated-parameter and typed-local
 * rows pin. Two costs are taken knowingly and are visible in the rows: the mask
 * is body-wide, so a read of the genuine field elsewhere in a shadowing member
 * loses its edge; and only names the class declares as FIELDS are masked, so the
 * same defect against a library-level variable is still open. Both are recorded
 * on `dartShadowedFieldsCapture` in `languages/dart/captures.ts`.
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
import { cleanupTempDirSync } from '../../helpers/test-db.js';
import { getDartParser } from '../../../src/core/ingestion/languages/dart/query.js';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';

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
export class Alien { inner(): Inner { return new Inner(); } }
export class CallbackThis {
  private p = new Outer();
  attach(el: any): void { el.addEventListener('click', function () { this.p = new Alien(); }); }
  run(x: number): number { return this.p.inner().compute(x); }
}
export class ObjectLiteralThis {
  private p = new Outer();
  build(): unknown { return { m() { this.p = new Alien(); } }; }
  run(x: number): number { return this.p.inner().compute(x); }
}
export class StaticThis {
  private p = new Outer();
  static make(): void { this.p = new Alien(); }
  run(x: number): number { return this.p.inner().compute(x); }
}
export class StaticFieldSameName {
  private p = new Outer();
  static p = new Alien();
  run(x: number): number { return this.p.inner().compute(x); }
}
export class StaticAnnotatedFieldSameName {
  private r: Outer = new Outer();
  static r: Alien = new Alien();
  run(x: number): number { return this.r.inner().compute(x); }
}
export const moduleLocal = new Outer();
export function runModuleLocal(x: number): number { return moduleLocal.inner().compute(x); }
this.moduleLocal = new Alien();
`;

// ── JavaScript ───────────────────────────────────────────────────────────────
const JS_FILE = 'src/app.js';
const JS_SOURCE = `export class Inner { compute(v) { return v * 2; } }
export class Outer { inner() { return new Inner(); } }
export class ControlLocal { run(x) { const o = new Outer(); return o.inner().compute(x); } }
export class InferredField { p = new Outer(); run(x) { return this.p.inner().compute(x); } }
export class AssignedField { constructor() { this.q = new Outer(); } run(x) { return this.q.inner().compute(x); } }
export class Alien { inner() { return new Inner(); } }
export class ObjectLiteralCtorThis {
  p = new Outer();
  build() { return { constructor() { this.p = new Alien(); } }; }
  run(x) { return this.p.inner().compute(x); }
}
export class StaticFieldSameName {
  p = new Outer();
  static p = new Alien();
  run(x) { return this.p.inner().compute(x); }
}
export class StaticCtorThis {
  p = new Outer();
  static constructor() { this.p = new Alien(); }
  run(x) { return this.p.inner().compute(x); }
}
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

class SingletonMethodSelfField
  def self.build
    @pool = Outer.new
  end

  def initialize
    @q = Outer.new
  end

  def run_self_ivar(x)
    @pool.inner.compute(x)
  end

  def run(x)
    @q.inner.compute(x)
  end
end

class SingletonClassSelfField
  class << self
    def build
      @cache = Outer.new
    end
  end

  def initialize
    @q = Outer.new
  end

  def run_self_ivar(x)
    @cache.inner.compute(x)
  end

  def run(x)
    @q.inner.compute(x)
  end
end

class ClassBodySelfField
  @shared = Outer.new

  def initialize
    @q = Outer.new
  end

  def run_self_ivar(x)
    @shared.inner.compute(x)
  end

  def run(x)
    @q.inner.compute(x)
  end
end

class Alien
  def inner
    Inner.new
  end
end

class ClassEvalBlockField
  Alien.class_eval do
    def warm
      @shared = Alien.new
    end
  end

  def initialize
    @q = Outer.new
  end

  def run_self_ivar(x)
    @shared.inner.compute(x)
  end

  def run(x)
    @q.inner.compute(x)
  end
end

class ClassNewBlockField
  Anon = Class.new do
    def warm
      @shared = Alien.new
    end
  end

  def initialize
    @q = Outer.new
  end

  def run_self_ivar(x)
    @shared.inner.compute(x)
  end

  def run(x)
    @q.inner.compute(x)
  end
end

class StructNewBlockField
  Pair = Struct.new(:x) do
    def warm
      @shared = Alien.new
    end
  end

  def initialize
    @q = Outer.new
  end

  def run_self_ivar(x)
    @shared.inner.compute(x)
  end

  def run(x)
    @q.inner.compute(x)
  end
end

class InstanceEvalBlockField
  def seed(other)
    other.instance_eval { @shared = Alien.new }
  end

  def initialize
    @q = Outer.new
  end

  def run_self_ivar(x)
    @shared.inner.compute(x)
  end

  def run(x)
    @q.inner.compute(x)
  end
end

class InstanceExecBlockField
  def seed(other)
    other.instance_exec { @shared = Alien.new }
  end

  def initialize
    @q = Outer.new
  end

  def run_self_ivar(x)
    @shared.inner.compute(x)
  end

  def run(x)
    @q.inner.compute(x)
  end
end

class DefineMethodBlockField
  define_method(:warm) { @shared = Alien.new }

  def initialize
    @q = Outer.new
  end

  def run_self_ivar(x)
    @shared.inner.compute(x)
  end

  def run(x)
    @q.inner.compute(x)
  end
end

class PlainBlockField
  def seed
    [1].each { @shared = Alien.new }
  end

  def initialize
    @q = Outer.new
  end

  def run_self_ivar(x)
    @shared.inner.compute(x)
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
const DART_SOURCE = `Other libraryZ = Other();

class Inner {
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

class ShadowedAssignedField {
  var s;
  ShadowedAssignedField() {
    var s;
    s = Outer();
  }
  int run(int x) {
    return s.inner().compute(x);
  }
}

class Other {
  Other inner() {
    return Other();
  }
}

class ParamShadowedField {
  var t;
  ParamShadowedField() {
    t = Outer();
  }
  void reset(Other t) {
    t = Other();
  }
  int run(int x) {
    return t.inner().compute(x);
  }
}

class ClosureShadowedField {
  var u;
  ClosureShadowedField() {
    u = Outer();
  }
  void reset(xs) {
    xs.forEach((u) {
      u = Other();
    });
  }
  int run(int x) {
    return u.inner().compute(x);
  }
}

class CatchShadowedField {
  var w;
  CatchShadowedField() {
    w = Outer();
  }
  void reset() {
    try {} on Err catch (w) {
      w = Other();
    }
  }
  int run(int x) {
    return w.inner().compute(x);
  }
}

class LoopShadowedField {
  var y;
  LoopShadowedField() {
    y = Outer();
  }
  void reset(xs) {
    for (var y in xs) {
      y = Other();
    }
  }
  int run(int x) {
    return y.inner().compute(x);
  }
}

class MultiDeclaratorField {
  var m = Other(), n = Outer();
  int run(int x) {
    return n.inner().compute(x);
  }
}

class RecordPatternShadowedField {
  var pa;
  RecordPatternShadowedField() {
    pa = Outer();
  }
  void reset(xs) {
    var (pa, _) = xs;
    pa = Other();
  }
  int run(int x) {
    return pa.inner().compute(x);
  }
}

class ListPatternShadowedField {
  var pb;
  ListPatternShadowedField() {
    pb = Outer();
  }
  void reset(xs) {
    var [pb, _] = xs;
    pb = Other();
  }
  int run(int x) {
    return pb.inner().compute(x);
  }
}

class RestPatternShadowedField {
  var pc;
  RestPatternShadowedField() {
    pc = Outer();
  }
  void reset(xs) {
    var [_, ...pc] = xs;
    pc = Other();
  }
  int run(int x) {
    return pc.inner().compute(x);
  }
}

class MapPatternShadowedField {
  var pd;
  MapPatternShadowedField() {
    pd = Outer();
  }
  void reset(xs) {
    var {'k': pd} = xs;
    pd = Other();
  }
  int run(int x) {
    return pd.inner().compute(x);
  }
}

class ObjectPatternShadowedField {
  var pe;
  ObjectPatternShadowedField() {
    pe = Outer();
  }
  void reset(o) {
    var Outer(inner: pe) = o;
    pe = Other();
  }
  int run(int x) {
    return pe.inner().compute(x);
  }
}

class ObjectShorthandPatternShadowedField {
  var pf;
  ObjectShorthandPatternShadowedField() {
    pf = Outer();
  }
  void reset(o) {
    var Outer(:pf) = o;
    pf = Other();
  }
  int run(int x) {
    return pf.inner().compute(x);
  }
}

class IfCasePatternShadowedField {
  var pg;
  IfCasePatternShadowedField() {
    pg = Outer();
  }
  void reset(o) {
    if (o case Other pg) {
      pg = Other();
    }
  }
  int run(int x) {
    return pg.inner().compute(x);
  }
}

class CastPatternShadowedField {
  var ph;
  CastPatternShadowedField() {
    ph = Outer();
  }
  void reset(o) {
    if (o case var ph as Other) {
      ph = Other();
    }
  }
  int run(int x) {
    return ph.inner().compute(x);
  }
}

class NullCheckPatternShadowedField {
  var pj;
  NullCheckPatternShadowedField() {
    pj = Outer();
  }
  void reset(o) {
    if (o case var pj?) {
      pj = Other();
    }
  }
  int run(int x) {
    return pj.inner().compute(x);
  }
}

class NullAssertPatternShadowedField {
  var pk;
  NullAssertPatternShadowedField() {
    pk = Outer();
  }
  void reset(o) {
    if (o case var pk!) {
      pk = Other();
    }
  }
  int run(int x) {
    return pk.inner().compute(x);
  }
}

class OrPatternShadowedField {
  var pl;
  OrPatternShadowedField() {
    pl = Outer();
  }
  void reset(o) {
    if (o case Other pl || Other pl) {
      pl = Other();
    }
  }
  int run(int x) {
    return pl.inner().compute(x);
  }
}

class SwitchCasePatternShadowedField {
  var pm;
  SwitchCasePatternShadowedField() {
    pm = Outer();
  }
  void reset(o) {
    switch (o) {
      case Other pm:
        pm = Other();
    }
  }
  int run(int x) {
    return pm.inner().compute(x);
  }
}

class SwitchExpressionPatternShadowedField {
  var pn;
  SwitchExpressionPatternShadowedField() {
    pn = Outer();
  }
  void reset(o) {
    var v = switch (o) { Other pn => pn = Other(), _ => o };
  }
  int run(int x) {
    return pn.inner().compute(x);
  }
}

class ForInPatternShadowedField {
  var pp;
  ForInPatternShadowedField() {
    pp = Outer();
  }
  void reset(xs) {
    for (var (pp, _) in xs) {
      pp = Other();
    }
  }
  int run(int x) {
    return pp.inner().compute(x);
  }
}

class PatternAssignmentShadowedField {
  var pq;
  PatternAssignmentShadowedField() {
    pq = Outer();
  }
  void reset(xs) {
    (pq, _) = xs;
    pq = Other();
  }
  int run(int x) {
    return pq.inner().compute(x);
  }
}

class CollectionIfElementPatternShadowedField {
  var pr;
  CollectionIfElementPatternShadowedField() {
    pr = Outer();
  }
  void reset(o) {
    var l = [if (o case Other pr) pr = Other()];
  }
  int run(int x) {
    return pr.inner().compute(x);
  }
}

class CollectionForElementPatternShadowedField {
  var ps;
  CollectionForElementPatternShadowedField() {
    ps = Outer();
  }
  void reset(xs) {
    var l = [for (var (ps, _) in xs) ps = Other()];
  }
  int run(int x) {
    return ps.inner().compute(x);
  }
}

class StaticMethodBareWrite {
  var libraryZ;
  StaticMethodBareWrite() {
    libraryZ = Outer();
  }
  static void make() {
    libraryZ = Other();
  }
  int run(int x) {
    return libraryZ.inner().compute(x);
  }
}

class StaticFieldDecl {
  static var sd = Other();
  int run(int x) {
    return sd.inner().compute(x);
  }
}

class Alien {
  Inner inner() {
    return Inner();
  }
}

class LoopVarReadShadowedField {
  var za;
  LoopVarReadShadowedField() {
    za = Outer();
  }
  int probe(xs) {
    var wit = Alien();
    for (final za in xs) {
      za.inner();
    }
    return wit.inner().compute(1);
  }
  int use(int x) {
    return za.inner().compute(x);
  }
  int annotated(Other za) {
    return za.inner().compute(1);
  }
}

class PatternReadShadowedField {
  var zb;
  PatternReadShadowedField() {
    zb = Outer();
  }
  int probe(xs) {
    var wit = Alien();
    var (zb, _) = xs;
    zb.inner();
    return wit.inner().compute(1);
  }
}

class TypedLocalReadShadowedField {
  var zc;
  TypedLocalReadShadowedField() {
    zc = Outer();
  }
  int probe(int x) {
    var zc = Other();
    return zc.inner().compute(x);
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

class OptionalAssignedField {
  var q: Outer?
  init() {
    self.q = Outer()
  }
  func run(_ x: Int) -> Int {
    return self.q!.inner().compute(x)
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
      // ── The wrong-`this` guard rows ────────────────────────────────────────
      //
      // Each of the next four writes `this.p = new Alien()` from a context
      // where `this` is NOT an instance of the class the binding would land on,
      // and each one is a shape the context-free version of the `this.<field> =
      // new …` pattern accepted. The receiver they must NOT retype is
      // `private p = new Outer()`, already typed by its initializer, so the
      // pattern's `>=` tie-break (later match wins at equal source strength)
      // OVERWROTE the field's real type.
      //
      // `Alien` deliberately declares `inner()` too. That is what keeps these
      // rows honest: a wrong binding does not empty the target set, it swaps
      // `Outer.inner#0` for `Alien.inner#0`. Asserting the exact set therefore
      // fails on the defect instead of passing vacuously the way an
      // expected-empty row would — and the last row is a module local, not a
      // field, so it also pins that the marker cannot escape a class at all.
      {
        name: 'callback-this-does-not-retype-the-field',
        callerId: `Method:${TS_FILE}:CallbackThis.run#1`,
        targets: [`Method:${TS_FILE}:Inner.compute#1`, `Method:${TS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'object-literal-this-does-not-retype-the-field',
        callerId: `Method:${TS_FILE}:ObjectLiteralThis.run#1`,
        targets: [`Method:${TS_FILE}:Inner.compute#1`, `Method:${TS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'static-this-does-not-retype-the-instance-field',
        callerId: `Method:${TS_FILE}:StaticThis.run#1`,
        targets: [`Method:${TS_FILE}:Inner.compute#1`, `Method:${TS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'module-level-this-does-not-retype-a-module-local',
        callerId: `Function:${TS_FILE}:runModuleLocal`,
        targets: [`Method:${TS_FILE}:Inner.compute#1`, `Method:${TS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // ── …and a static FIELD is not the instance field of that name ────────
      //
      // The four rows above all guard the ASSIGNMENT form (`this.x = new …`).
      // A static field DECLARATION reaches the same Class scope without any
      // `this` at all, and JS/TS keep static and instance members in separate
      // namespaces, so `p = new Outer(); static p = new Alien();` is legal and
      // `this.p` is `Outer`. Both bindings carried the same source strength, so
      // the `>=` tie-break handed the field to whichever pattern matched LAST —
      // the static one — and `this.p.inner()` resolved to `Alien.inner`.
      //
      // Written the same swap-not-empty way as the guard rows: `Alien` declares
      // `inner()`, so the defect produces a DIFFERENT non-empty target set and
      // this positive assertion cannot pass vacuously.
      //
      // The annotated twin is a separate row because it is a separate pattern
      // (`@type-binding.annotation`, not `@type-binding.constructor`) and it
      // collides at the `annotation` strength rather than `constructor-inferred`
      // — a fix that only guarded the initializer form would leave it red.
      {
        name: 'static-field-does-not-retype-the-instance-field',
        callerId: `Method:${TS_FILE}:StaticFieldSameName.run#1`,
        targets: [`Method:${TS_FILE}:Inner.compute#1`, `Method:${TS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'static-annotated-field-does-not-retype-the-instance-field',
        callerId: `Method:${TS_FILE}:StaticAnnotatedFieldSameName.run#1`,
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
      // JavaScript's half of the wrong-`this` guard above. Its binding comes
      // from `synthesizeConstructorFieldBindings`, which was already bounded to
      // a `constructor` body's direct statements — but matched a
      // `method_definition` anywhere, and an object literal's members are
      // `method_definition` too. So a literal named-`constructor` method typed
      // the enclosing class's field, the one shape where `.js` still read this
      // source differently from `.ts` once TypeScript's pattern was nested.
      // Same swap-not-empty construction: `Alien` declares `inner()`.
      {
        name: 'object-literal-constructor-this-does-not-retype-the-field',
        callerId: `Method:${JS_FILE}:ObjectLiteralCtorThis.run#1`,
        targets: [`Method:${JS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // JavaScript's half of the static-FIELD guard. Class fields are the one
      // place `.js` and `.ts` write the same declaration under different grammar
      // node names (`field_definition` vs `public_field_definition`), so the
      // predicate that reads `static` off them is shared rather than duplicated
      // — this row is what proves the JavaScript spelling is actually covered.
      {
        name: 'static-field-does-not-retype-the-instance-field',
        callerId: `Method:${JS_FILE}:StaticFieldSameName.run#1`,
        targets: [`Method:${JS_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // `static constructor() {}` is legal JavaScript — the reserved-name rule
      // applies to instance methods only — and its `this` is the CLASS. The
      // JavaScript constructor-field walk matched on the NAME alone, so this
      // shape typed the instance field exactly the way TypeScript's static
      // method did before `isStaticMethodThis`. Same swap-not-empty shape.
      {
        name: 'static-constructor-this-does-not-retype-the-field',
        callerId: `Method:${JS_FILE}:StaticCtorThis.run#1`,
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
      // ── An `@ivar` is only an INSTANCE field when `self` is an instance ────
      //
      // The three `*-self-ivar` rows below all write `@x = Outer.new` where
      // Ruby's `self` is the CLASS object, not an instance: inside
      // `def self.build`, inside a `class << self` body, and directly in the
      // class body. None of those ivars exists on an instance, so an instance
      // method reading them reads `nil` and must resolve NOTHING. Hoisting the
      // binding to the Class scope regardless of whose `self` owns it fabricated
      // an `Outer.inner` edge from a receiver that is never assigned.
      //
      // Each is PAIRED with an `*-instance-ivar` row on the SAME class that
      // writes `@q` from `initialize` and must still resolve both links. The
      // pairing is what keeps the empty rows honest: an empty expectation passes
      // vacuously if the fixture never reached the ivar-field machinery at all,
      // so the partner row asserts a NON-empty result through the very same
      // class. Break the hoist entirely and the partner goes red; keep the
      // unconditional hoist and the empty row goes red.
      {
        name: 'singleton-method-self-ivar',
        callerId: `Method:${RB_FILE}:SingletonMethodSelfField.run_self_ivar#1`,
        targets: [],
        status: 'known-gap',
      },
      {
        name: 'singleton-method-instance-ivar',
        callerId: `Method:${RB_FILE}:SingletonMethodSelfField.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'singleton-class-self-ivar',
        callerId: `Method:${RB_FILE}:SingletonClassSelfField.run_self_ivar#1`,
        targets: [],
        status: 'known-gap',
      },
      {
        name: 'singleton-class-instance-ivar',
        callerId: `Method:${RB_FILE}:SingletonClassSelfField.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'class-body-self-ivar',
        callerId: `Method:${RB_FILE}:ClassBodySelfField.run_self_ivar#1`,
        targets: [],
        status: 'known-gap',
      },
      {
        name: 'class-body-instance-ivar',
        callerId: `Method:${RB_FILE}:ClassBodySelfField.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // ── A BLOCK's `self` is chosen by its RECEIVER, not by where it is written ─
      //
      // The three shapes above are the ones a `self`-keyword search finds. They
      // are not the whole family: a `def` written inside a BLOCK attaches to
      // whatever that block's receiver made the default definee, so
      // `Other.class_eval do def warm; @shared = Alien.new; end end` writes a
      // field of `Other` — while the walk that only knew about singletons fell
      // straight through the block, reached the enclosing LEXICAL class, and
      // published `Alien` as that class's field type. Measured, before the fix:
      // every `run_self_ivar` below emitted `Alien.inner#0` + `Inner.compute#1`
      // from a receiver that is `nil` on every instance of its own class.
      //
      // The rows use `Alien` rather than `Outer` on purpose. A wrong bind then
      // shows up as the ALIEN type's edge, which is unmistakably an ownership
      // failure; had they reused `Outer` a regression would emit the same
      // targets the correct rows expect and read as an ordinary miss.
      //
      // The fix keys on the block NODES (`do … end`, `{ … }`), never on the
      // call that owns them, so these row names are representative rather than
      // exhaustive: `module_eval`, `class_exec`, `Module.new`, `Data.define`
      // and `refine` all parse to one of the same two block nodes and are
      // covered by the identical path. An enumeration of rebinding call NAMES
      // could not be complete anyway — `def helper(&b) = Foo.class_eval(&b)`
      // rebinds a block it merely receives, and nothing at the block's own
      // syntax reveals that.
      {
        name: 'class-eval-block-self-ivar',
        callerId: `Method:${RB_FILE}:ClassEvalBlockField.run_self_ivar#1`,
        targets: [],
        status: 'known-gap',
      },
      {
        name: 'class-eval-block-instance-ivar',
        callerId: `Method:${RB_FILE}:ClassEvalBlockField.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'class-new-block-self-ivar',
        callerId: `Method:${RB_FILE}:ClassNewBlockField.run_self_ivar#1`,
        targets: [],
        status: 'known-gap',
      },
      {
        name: 'class-new-block-instance-ivar',
        callerId: `Method:${RB_FILE}:ClassNewBlockField.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'struct-new-block-self-ivar',
        callerId: `Method:${RB_FILE}:StructNewBlockField.run_self_ivar#1`,
        targets: [],
        status: 'known-gap',
      },
      {
        name: 'struct-new-block-instance-ivar',
        callerId: `Method:${RB_FILE}:StructNewBlockField.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // `instance_eval` / `instance_exec` differ from the three above in shape,
      // not just in name: the write is DIRECT in a brace block inside an
      // ordinary instance method, with no `def` between it and the block. The
      // old walk reached `method(seed)`, set its flag, and bound the field —
      // the same wrong answer by a different route, so it needs its own row.
      {
        name: 'instance-eval-block-self-ivar',
        callerId: `Method:${RB_FILE}:InstanceEvalBlockField.run_self_ivar#1`,
        targets: [],
        status: 'known-gap',
      },
      {
        name: 'instance-eval-block-instance-ivar',
        callerId: `Method:${RB_FILE}:InstanceEvalBlockField.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'instance-exec-block-self-ivar',
        callerId: `Method:${RB_FILE}:InstanceExecBlockField.run_self_ivar#1`,
        targets: [],
        status: 'known-gap',
      },
      {
        name: 'instance-exec-block-instance-ivar',
        callerId: `Method:${RB_FILE}:InstanceExecBlockField.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // `define_method` is the one member of the family the ORIGINAL walk
      // already answered correctly, and only by accident: its block holds the
      // write directly in a class body, so the walk hit `class` with the
      // `method` flag still false. Pinned so the block rule cannot be removed
      // in favour of "it already worked" — under a name-based deny-list this
      // row would be the only survivor, and it is the least informative one.
      {
        name: 'define-method-block-self-ivar',
        callerId: `Method:${RB_FILE}:DefineMethodBlockField.run_self_ivar#1`,
        targets: [],
        status: 'known-gap',
      },
      {
        name: 'define-method-block-instance-ivar',
        callerId: `Method:${RB_FILE}:DefineMethodBlockField.run#1`,
        targets: [`Method:${RB_FILE}:Inner.compute#1`, `Method:${RB_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // A DELIBERATE over-discard, asserted so the cost is visible rather than
      // discovered. `[1].each { @shared = Alien.new }` inside an instance method
      // really does write that instance's field — Ruby's `each` does not rebind
      // `self` — and this row records that the fix drops it anyway. It has to:
      // the block's syntax is identical to the `instance_eval` block two rows
      // up, and only the receiver's IMPLEMENTATION distinguishes them. Per the
      // safety doctrine (`scope-resolution/passes/compound-receiver.ts`) a
      // missed edge is the acceptable cost of never inventing a wrong one. If a
      // later change makes ownership provable, this row is the one to flip.
      {
        name: 'plain-block-self-ivar',
        callerId: `Method:${RB_FILE}:PlainBlockField.run_self_ivar#1`,
        targets: [],
        status: 'known-gap',
      },
      {
        name: 'plain-block-instance-ivar',
        callerId: `Method:${RB_FILE}:PlainBlockField.run#1`,
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
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // The shadowing guard, asserted rather than asserted-in-a-comment. Dart
      // writes a field with no receiver prefix, so `s = Outer()` is
      // syntactically identical to assigning a constructor-local. Here the
      // constructor declares its OWN `var s`, so the write targets that local
      // and the FIELD must stay untyped — `run` reads the field and must
      // therefore resolve nothing. Without the `locals.has(...)` guard in
      // `emitDartFieldAssignmentBindings` this row goes green with a WRONG edge,
      // which is the failure mode the guard exists to prevent.
      {
        name: 'shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:ShadowedAssignedField.run#1`,
        targets: [],
        status: 'known-gap',
      },
      // A local `var` is only ONE of Dart's binders. These four rows each write
      // the field's name under a DIFFERENT binder — a formal parameter, a
      // closure parameter, a catch binding, a for-in variable — in a method
      // that is not the constructor, while the constructor has already typed
      // that field `Outer` correctly.
      //
      // They assert a POSITIVE target on purpose. An empty-result row passes
      // vacuously whenever the fixture stops reaching the guard at all, so the
      // thing being pinned is that the CORRECT `Outer` binding SURVIVES the
      // shadowed write. Before `collectDartBodyShadows` looked past local
      // declarations, every one of these bare writes was read as a write to the
      // field: it retyped the field to `Other` — measured as the WRONG edge
      // `Other.inner#0`, not merely a missing one — and destroyed the
      // constructor's binding at the same time. `Other` therefore declares its
      // own `inner()`, so the fabricated edge is a visible wrong target rather
      // than silence that an unrelated regression could also produce.
      {
        name: 'param-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:ParamShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'closure-param-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:ClosureShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'catch-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:CatchShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'loop-var-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:LoopShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // ONE `declaration` can hold SEVERAL declarators — `var m = Other(), n =
      // Outer();` — and the field query matches it once per declarator with the
      // SAME `@declaration.property` node. `dartFieldConstructorCallee` therefore
      // cannot search DOWN from that node for an initializer: it would hand every
      // declarator the FIRST one's, typing `n` as `Other`. It reads the
      // initializer as the next named sibling of the declarator's OWN name node
      // instead.
      //
      // Ordered so the declarator under test is the SECOND and the first has a
      // DIFFERENT type: under the first-descendant search `n` took `Other` and
      // this row went green on the WRONG edge `Other.inner#0` — a visible wrong
      // target, not silence an unrelated regression could also produce.
      {
        name: 'multi-declarator-inferred-field',
        callerId: `Method:${DART_FILE}:MultiDeclaratorField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // ── Dart 3 PATTERN binders ────────────────────────────────────────────
      //
      // The four rows above cover the binders that existed before Dart 3. A
      // pattern binds too, and every pattern form parses into node types that
      // the pre-Dart-3 list did not name — so each write below was read as a
      // write to the FIELD and retyped it to `Other`, exactly the way the
      // parameter case did. Same construction as the rows above and for the same
      // reason: `Other` declares its own `inner()`, so the pre-fix value of each
      // row is the WRONG target `Other.inner#0`, not an empty set. Nothing here
      // can pass vacuously — an unrelated regression that stopped the fixture
      // reaching this machinery empties the set and the row still fails.
      //
      // One row per grammar shape, not per bug report. `_pattern_field`,
      // `_map_pattern_entry`, `_list_pattern_element`, `_parenthesized_pattern`,
      // `_outer_pattern` and `_guarded_pattern` are all HIDDEN rules, so the
      // twelve visible pattern node types below are the entire surface, and the
      // fixture is checked to produce all twelve.
      //
      // Declaring contexts — `pattern_variable_declaration` over each of the
      // five `_outer_pattern` alternatives, plus the nested `rest_pattern`. The
      // bare names in these (`pa`, `pb`, …) are `constant_pattern` nodes: Dart
      // reads a bare pattern name as a binder only because the enclosing `var`
      // distributes over it, and the grammar records no such distinction.
      {
        name: 'record-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:RecordPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'list-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:ListPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'rest-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:RestPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'map-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:MapPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // `var Outer(inner: pe) = o;` — the getter name `inner` is a NON-binder
      // identifier that the hidden `_pattern_field` drops directly onto
      // `object_pattern`, next to the binder. That inlining is why the container
      // pattern types are handled and not only the two leaf types.
      {
        name: 'object-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:ObjectPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'object-shorthand-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:ObjectShorthandPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // Matching contexts — `variable_pattern` (`Other pg` / `var ph`) reached
      // through if-case, the three `_unary_pattern` wrappers, an or-pattern, a
      // switch statement case and a switch EXPRESSION arm. The or-pattern binds
      // the same name at the same type in both branches because Dart requires
      // that; the redundancy is the point, not an oversight.
      {
        name: 'if-case-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:IfCasePatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'cast-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:CastPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'null-check-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:NullCheckPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'null-assert-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:NullAssertPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'or-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:OrPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'switch-case-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:SwitchCasePatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'switch-expression-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:SwitchExpressionPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // `for (var (pp, _) in xs)` is the pattern arm of `_for_loop_parts`, which
      // carries NO `name` field — so the `for_loop_parts` case that handles
      // `for (var y in xs)` reads null here and saw no binder at all.
      {
        name: 'for-in-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:ForInPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // `pattern_assignment` — `(pq, _) = xs;` — is the one shape here that
      // DECLARES nothing; it writes names that already exist. Shadowing it is
      // deliberate over-approximation: if those names are locals some other
      // binder already shadows them, and if they are fields the write is real
      // but produces no binding either way, so declining costs at most an edge.
      {
        name: 'pattern-assignment-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:PatternAssignmentShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // Collection-literal `if_element` / `for_element` — the same patterns in
      // the one context that is an ELEMENT rather than a statement, so a walk
      // keyed on statement nodes would miss them.
      {
        name: 'collection-if-element-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:CollectionIfElementPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      {
        name: 'collection-for-element-pattern-shadowed-assigned-field',
        callerId: `Method:${DART_FILE}:CollectionForElementPatternShadowedField.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // ── A STATIC member's bare write is not an instance-field write ───────
      //
      // Dart's static scope holds only the class's STATIC members, so the bare
      // `libraryZ = Other()` inside `static void make()` binds the LIBRARY-level
      // `libraryZ` this fixture declares at the top — never the same-named
      // instance field. (The library variable is what makes the fixture legal
      // Dart: without it a static method naming an instance field is a compile
      // error. Dart also forbids a class from declaring a static and an instance
      // member of one name, which is why the TypeScript/JavaScript same-name
      // field collision has no Dart twin and this is the only shape the defect
      // takes here.)
      //
      // Treating it as a field write did not just add an edge: it landed on the
      // Class scope at the same `constructor-inferred` strength as the
      // constructor's own binding and DISPLACED it, so `run` resolved
      // `Other.inner#0`. Asserting the surviving `Outer` — the same construction
      // the shadow rows above use, and for the same reason.
      {
        name: 'static-method-bare-write-does-not-retype-the-field',
        callerId: `Method:${DART_FILE}:StaticMethodBareWrite.run#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // The counterweight, and the reason the guard above is scoped to member
      // BODIES rather than to `static` anywhere. A static field DECLARATION is
      // read by a bare name from an instance method in ordinary Dart
      // (`sd.inner()` below is how you read a static), so its type binding must
      // SURVIVE. Over-correcting the row above into "drop every static field
      // binding" turns this row red instead — which is exactly the signal
      // wanted, since Dart, unlike TypeScript, loses nothing by keeping it.
      {
        name: 'static-field-declaration-still-types-its-receiver',
        callerId: `Method:${DART_FILE}:StaticFieldDecl.run#1`,
        targets: [`Method:${DART_FILE}:Other.inner#0`],
        status: 'resolves',
      },
      // ── The READ side of the same shadow set ──────────────────────────────
      //
      // Every Dart row above tests the WRITE: does a shadowed bare-name
      // assignment retype the field. The shadow set gated writes ONLY, and a
      // bare-name READ of a shadowing binder the resolver cannot type walked
      // straight past the local to the class binding this feature mints. In
      // `probe` below, `za` is an ELEMENT of `xs`; measured pre-fix it resolved
      // to `Outer.inner#0` — the constructor's type — turning "no edge" into a
      // WRONG edge, the failure mode `compound-receiver.ts:519-537` forbids.
      // The field binding is what made it wrong, not a pre-existing gap: delete
      // the constructor and the same read emits nothing at all.
      //
      // `Alien` exists so these two rows keep a SURVIVING POSITIVE target. `za`
      // untyped is correctly typeless, so the row's own call has nothing to
      // assert; `var wit = Alien(); wit.inner()` in the same method is the
      // witness, and the pre-fix value is the strictly LARGER set
      // {Alien, Alien.inner, Outer.inner}. A regression that merely breaks the
      // fixture empties the set and the row still fails — it cannot pass
      // vacuously in either direction.
      {
        name: 'loop-var-read-does-not-see-the-field',
        callerId: `Method:${DART_FILE}:LoopVarReadShadowedField.probe#1`,
        targets: [`Class:${DART_FILE}:Alien`, `Method:${DART_FILE}:Alien.inner#0`],
        status: 'resolves',
      },
      // Dart 3 patterns are the binder family this branch widened twice, so the
      // read side gets one too — `var (zb, _) = xs;` binds through node types
      // the pre-Dart-3 list never named.
      {
        name: 'pattern-read-does-not-see-the-field',
        callerId: `Method:${DART_FILE}:PatternReadShadowedField.probe#1`,
        targets: [`Class:${DART_FILE}:Alien`, `Method:${DART_FILE}:Alien.inner#0`],
        status: 'resolves',
      },
      // THE COUNTERWEIGHT. `use` reads the same field by bare name and binds
      // NOTHING, so it must still resolve to the constructor's `Outer`. It sits
      // in the SAME class as the masked `probe` above deliberately: it is the
      // row that distinguishes "mask the names THIS BODY rebinds" from "mask
      // every field name the class declares". Measured: dropping the
      // `shadows.has(name)` test in `dartShadowedFieldsCapture` — the exact
      // over-widening this guards — turns 28 Dart rows red, and this row is one
      // of them, while the fix as written leaves it green.
      {
        name: 'unshadowed-read-in-a-shadowing-class-still-resolves',
        callerId: `Method:${DART_FILE}:LoopVarReadShadowedField.use#1`,
        targets: [`Method:${DART_FILE}:Outer.inner#0`],
        status: 'resolves',
      },
      // THE OVERREACH CONTROL, and the reason the mask is `ownsReceivers` rather
      // than a deletion. `collectDartBodyShadows` includes formal parameters, so
      // an ANNOTATED `Other za` is masked exactly like the loop variable — but
      // `findReceiverTypeBinding` consults `typeBindings` FIRST at every scope
      // and `synthesizeDartSignatureBindings` anchors parameter bindings on this
      // same body node, so the annotation wins on the same scope the mask sits
      // on. Asserted rather than assumed: if the mask were placed anywhere the
      // parameter binding is not, this row would go from `Other` to empty.
      {
        name: 'annotated-param-read-keeps-its-own-type',
        callerId: `Method:${DART_FILE}:LoopVarReadShadowedField.annotated#1`,
        targets: [`Method:${DART_FILE}:Other.inner#0`],
        status: 'resolves',
      },
      // The same precedence one level in: a typed LOCAL (`var zc = Other();`)
      // shadowing the field keeps `Other`, because its binding lands at or below
      // the masked Function scope. Together with the row above this pins both
      // halves of "a shadow the resolver CAN type still wins".
      {
        name: 'typed-local-read-keeps-its-own-type',
        callerId: `Method:${DART_FILE}:TypedLocalReadShadowedField.probe#1`,
        targets: [`Class:${DART_FILE}:Other`, `Method:${DART_FILE}:Other.inner#0`],
        status: 'resolves',
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
      // Swift cannot declare a stored property with neither a type nor an
      // initializer, so its "assigned later" shape is an OPTIONAL field written
      // in `init` and read through a force-unwrap. Both halves were broken:
      // `var q: Outer?` put an `optional_type` between the annotation and the
      // `user_type` the query matched, so the field was never typed at all; and
      // `self.q!` is a `postfix_expression`, which the receiver walk did not
      // peel. Fixed together — this row needs both.
      {
        name: 'optional-assigned-field',
        callerId: `Function:${SWIFT_FILE}:OptionalAssignedField.run#1`,
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
        // Not a bare `rmSync`: a pipeline run can still hold a handle open when
        // this fires, which surfaces as EBUSY/EPERM on Windows — `force` does
        // not suppress that — and this suite runs in the sharded Windows CI.
        cleanupTempDirSync(dir);
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

  // The Dart pattern rows above were written to cover a FAMILY, not the handful
  // of shapes a bug report carried — because an incomplete enumeration of binder
  // forms is precisely what this file has now had to fix twice (formal
  // parameters, then patterns). A comment claiming full coverage rots silently,
  // so the claim is derived from the grammar instead of asserted: tree-sitter
  // ships the node types it can produce in `nodeTypeInfo`, and every NAMED one
  // whose name contains `pattern` must appear somewhere in the Dart fixture.
  //
  // A grammar bump that adds a thirteenth pattern node type therefore turns this
  // red, which is the whole point — it forces someone back to
  // `addDartBinderName` before the new form can silently retype a field. It goes
  // red on removal too, which catches a fixture edit that quietly drops a shape.
  it('the Dart fixture exercises every pattern node type the grammar declares', () => {
    const parser = getDartParser();
    const language = parser.getLanguage() as {
      readonly nodeTypeInfo: readonly { readonly type: string; readonly named: boolean }[];
    };
    const declared = language.nodeTypeInfo
      .filter((entry) => entry.named && entry.type.includes('pattern'))
      .map((entry) => entry.type)
      .sort();

    const exercised = new Set<string>();
    const walk = (node: SyntaxNode): void => {
      if (node.type.includes('pattern')) exercised.add(node.type);
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child !== null) walk(child);
      }
    };
    walk(parser.parse(DART_SOURCE).rootNode);

    // Compared as sorted lists, not "size >= n": a set comparison names the
    // missing type in the failure output, which is the fact the next reader needs.
    expect([...exercised].sort()).toEqual(declared);
  });
});
