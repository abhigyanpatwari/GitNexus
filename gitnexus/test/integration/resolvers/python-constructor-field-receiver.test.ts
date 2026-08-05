import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';
import { writeFixtureRepo } from './helpers.js';
import { cleanupTempDirSync } from '../../helpers/test-db.js';

describe('Python calls through constructor-assigned receiver fields', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'python-constructor-field-receiver'),
      () => {},
    );
  }, 60_000);

  it('resolves all production callers to the receiver-constrained method', () => {
    const productionCalls = getRelationships(result, 'CALLS').filter(
      (edge) =>
        edge.target === 'extract_and_store_graph' &&
        edge.targetFilePath === 'knowledge_graph_service.py',
    );

    expect(productionCalls.map((edge) => `${edge.sourceFilePath}:${edge.source}`).sort()).toEqual([
      'memory_service.py:archive_memory',
      'memory_service.py:ingest_memory',
      'memory_service.py:restore_memory',
      'memory_service.py:store_memory',
    ]);
    expect(productionCalls.every((edge) => edge.rel.confidence >= 0.85)).toBe(true);
  });

  it('does not redirect production calls to the same-named decoy', () => {
    const misresolved = getRelationships(result, 'CALLS').filter(
      (edge) =>
        edge.sourceFilePath === 'memory_service.py' &&
        edge.target === 'extract_and_store_graph' &&
        edge.targetFilePath === 'test_fixture.py',
    );

    expect(misresolved).toEqual([]);
  });
});

/**
 * `constructorCallTypeName` accepts a BARE-NAME callee only (#2807 review).
 *
 * ── WHY A DOTTED CALLEE IS REFUSED ───────────────────────────────────────────
 *
 * The first cut of #2807 handed a dotted callee's full text to the resolver, on
 * the theory that `models.User` resolves through `QualifiedNameIndex` the way
 * the module-level `u = models.User()` capture in `query.ts` does. Measured
 * here, that arm never produced a correct edge and did produce wrong ones. Both
 * halves of that claim have rows below, because the fix is only defensible if
 * BOTH hold — refusing a shape that worked would be a regression, not a fix.
 *
 * The wrong edge: a dotted rawName is matched by its TRAILING segment against a
 * same-named class, so `self.svc = f.Alpha()` — where `Alpha` is a METHOD on an
 * unrelated object and `Alpha` is also a class — typed the field as `Alpha` and
 * `self.svc.ping()` emitted a FABRICATED `Alpha.ping`. `Factory.Alpha` returns
 * a `str`; there is no sense in which that field is an `Alpha`.
 *
 * The absent right edge: `self.u = models.User()` emitted nothing with the arm
 * or without it, because an instance field's binding lands in CLASS scope,
 * which never reaches the namespace split that makes the module-level LOCAL
 * form resolve. That local form is pinned below and is untouched by this
 * change — it comes from `query.ts`, not from `receiver-binding.ts` — which is
 * what keeps "dotted construction works somewhere" true while this module
 * refuses it.
 *
 * ── HOW TO READ A ROW ────────────────────────────────────────────────────────
 *
 * No row asserts an empty set. Where the correct outcome IS "this field does
 * not type", the method also calls `Alien.ping()`, so the assertion is
 * `{Alien.ping}` and a regression SWAPS a target in rather than emptying the
 * set — an empty-set row would pass just as well if the fixture stopped
 * parsing. `Alien` exists only to be that witness.
 *
 * ── THE DISPLACEMENT THIS ALSO CLOSED ────────────────────────────────────────
 *
 * `self.conn = Outer()` followed by `self.conn = Registry.get()` used to emit NO
 * edge at all: both candidates sat in the weakest tier, so the later dotted one
 * — which resolves to nothing — displaced the real constructor binding under
 * the tier tie-break's last-write-wins. It needed no separate mechanism. Once a
 * dotted callee yields no candidate, `Registry.get()` is not a candidate to
 * displace with, and `Outer` survives. The tie-break is deliberately left as
 * last-write-wins: between two REAL constructions the last write in `__init__`
 * genuinely is the live one, so tightening it would have been the wrong fix to
 * a symptom of this one.
 */
const PY_FILE = 'src/app.py';
const PY_SOURCE = `class Inner:
    def compute(self, v):
        return v * 2


class Outer:
    def inner(self):
        return Inner()


class Alpha:
    def ping(self):
        return 1


class Alien:
    def ping(self):
        return 2


class Factory:
    # A METHOD whose name collides with the class \`Alpha\`. The collision is the
    # entire trigger — without it a dotted callee's trailing segment matches
    # nothing and the defect is invisible.
    def Alpha(self):
        return "not an Alpha"

    def build(self):
        return Outer()


class Registry:
    def get(self):
        return Outer()


class ParamRootCollision:
    def __init__(self, f):
        self.svc = f.Alpha()

    def run(self):
        witness = Alien()
        witness.ping()
        return self.svc.ping()


class ModuleRootCollision:
    def __init__(self):
        self.svc = shared_factory.Alpha()

    def run(self):
        witness = Alien()
        witness.ping()
        return self.svc.ping()


class PlainMethodCallControl:
    def __init__(self, factory):
        self.svc = factory.build()

    def run(self):
        witness = Alien()
        witness.ping()
        return self.svc.inner()


class DoubleAssign:
    def __init__(self):
        self.conn = Outer()
        self.conn = Registry.get()

    def run(self):
        return self.conn.inner()


class SingleAssign:
    def __init__(self):
        self.conn = Outer()

    def run(self):
        return self.conn.inner()


shared_factory = Factory()
`;

const MODELS_FILE = 'src/models.py';
const MODELS_SOURCE = `class User:
    def greet(self):
        return "hi"
`;

const IMPORTS_FILE = 'src/imports_app.py';
const IMPORTS_SOURCE = `import models
from models import User as User2


class ImportedBareConstructor:
    def __init__(self):
        self.u = User2()

    def run(self):
        return self.u.greet()


def module_level_dotted_local():
    u = models.User()
    return u.greet()
`;

interface Row {
  readonly name: string;
  /** Exact node id of the method holding the statement under test. */
  readonly callerId: string;
  /** Every distinct CALLS target id this caller emits, sorted. */
  readonly targets: readonly string[];
}

const ROWS: readonly Row[] = [
  // ── S4: the fabrication, and that it is not about the root's binding form ──
  //
  // Pre-fix both of these also emitted `Alpha.ping`. The root is a PARAMETER in
  // the first and a MODULE-LEVEL VARIABLE in the second; both fabricate, which
  // is why the fix tests the callee's SHAPE and not what its root binds to.
  {
    name: 's4-param-rooted-dotted-callee-does-not-type-the-field',
    callerId: `Method:${PY_FILE}:ParamRootCollision.run#0`,
    targets: [`Method:${PY_FILE}:Alien.ping#0`],
  },
  {
    name: 's4-module-rooted-dotted-callee-does-not-type-the-field',
    callerId: `Method:${PY_FILE}:ModuleRootCollision.run#0`,
    targets: [`Method:${PY_FILE}:Alien.ping#0`],
  },
  // The control the fix must not disturb: an ordinary `factory.build()` has a
  // trailing segment that names no class, so it never fabricated and must still
  // emit nothing for the field. Unchanged by the fix in both directions.
  {
    name: 's4-control-ordinary-method-call-still-emits-no-field-edge',
    callerId: `Method:${PY_FILE}:PlainMethodCallControl.run#0`,
    targets: [`Method:${PY_FILE}:Alien.ping#0`],
  },

  // ── S5: the displacement, closed by the same change ────────────────────────
  //
  // Pre-fix this row's target set was EMPTY — the one place this file asserts a
  // recovered edge rather than a removed one.
  {
    name: 's5-later-dotted-assignment-no-longer-displaces-the-constructor',
    callerId: `Method:${PY_FILE}:DoubleAssign.run#0`,
    targets: [`Method:${PY_FILE}:Outer.inner#0`],
  },
  {
    name: 's5-control-single-assignment-types-the-field',
    callerId: `Method:${PY_FILE}:SingleAssign.run#0`,
    targets: [`Method:${PY_FILE}:Outer.inner#0`],
  },

  // ── The over-tightening guards ─────────────────────────────────────────────
  //
  // These are the rows that go red if the bare-name arm is narrowed past the
  // dotted case — a same-file construction (`SingleAssign` above) and an
  // IMPORTED one, which is the shape that dies first if the rule is written
  // against the callee's binding rather than its syntax.
  {
    name: 'bare-name-imported-constructor-still-types-the-field',
    callerId: `Method:${IMPORTS_FILE}:ImportedBareConstructor.run#0`,
    targets: [`Method:${MODELS_FILE}:User.greet#0`],
  },
  // Dotted construction still resolves where it is actually implemented: a
  // module-level LOCAL, via `query.ts`'s own capture. This row is what makes
  // the docblock's "re-enabling dotted callees is a resolution-side change"
  // checkable — it is untouched by `receiver-binding.ts` and must stay green.
  {
    name: 'module-level-dotted-local-construction-is-untouched',
    callerId: `Function:${IMPORTS_FILE}:module_level_dotted_local`,
    targets: [`Class:${MODELS_FILE}:User`, `Method:${MODELS_FILE}:User.greet#0`],
  },
];

describe('Python constructor-field receiver typing refuses a dotted callee (#2807 review)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-py-ctor-field-'));
    try {
      writeFixtureRepo(dir, {
        [PY_FILE]: PY_SOURCE,
        [MODELS_FILE]: MODELS_SOURCE,
        [IMPORTS_FILE]: IMPORTS_SOURCE,
      });
      // CALLS resolution is complete before the graph phases run and nothing
      // here reads what they produce.
      result = await runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true });
    } finally {
      // Not a bare `rmSync`: a pipeline run can still hold a handle open when
      // this fires, which surfaces as EBUSY/EPERM on Windows.
      cleanupTempDirSync(dir);
    }
  }, 600_000);

  function callTargets(callerId: string): string[] {
    return [
      ...new Set(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.rel.sourceId === callerId)
          .map((edge) => edge.rel.targetId),
      ),
    ].sort();
  }

  // Every row's caller must exist before any target assertion means anything:
  // an id-scheme change or fixture drift would otherwise turn a row into a
  // silently vacuous empty-vs-empty comparison.
  it('every row has a live caller node', () => {
    const found = Object.fromEntries(
      ROWS.map((row) => [row.name, result.graph.getNode(row.callerId) !== undefined]),
    );
    expect(found).toEqual(Object.fromEntries(ROWS.map((row) => [row.name, true])));
  });

  // Non-vacuity, the other half: the two fabrication rows are only meaningful
  // while a class named `Alpha` and a same-named METHOD both exist for the
  // trailing-segment match to find. If either disappears the rows keep passing
  // for the wrong reason, so assert the collision itself.
  it('the name collision the fabrication needs is actually present', () => {
    expect({
      classAlpha: result.graph.getNode(`Class:${PY_FILE}:Alpha`) !== undefined,
      methodAlpha: result.graph.getNode(`Method:${PY_FILE}:Factory.Alpha#0`) !== undefined,
    }).toEqual({ classAlpha: true, methodAlpha: true });
  });

  for (const row of ROWS) {
    it(row.name, () => {
      expect(callTargets(row.callerId)).toEqual([...row.targets].sort());
    });
  }
});
