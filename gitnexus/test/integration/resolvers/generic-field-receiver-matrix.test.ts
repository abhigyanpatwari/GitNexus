/**
 * Cross-language matrix for #2833: can a class field whose declared type carries
 * a TYPE ARGUMENT (`repo: Repo<User>`) act as a call receiver?
 *
 * ── HOW TO READ A ROW ─────────────────────────────────────────────────────────
 *
 * Every language runs the same two statements — one call through a field whose
 * type is generic, one through a field whose type is not — and the question is
 * never "did edges appear" but **does the generic field behave like that
 * language's own control field**. Languages differ in how many edges one call
 * site produces (an interface receiver fans out to its implementations since
 * #2829/#2842; a concrete receiver does not), so an absolute count would accuse
 * and clear the wrong languages. The control row is the yardstick.
 *
 * ── WHY THE LANGUAGES SPLIT ───────────────────────────────────────────────────
 *
 * A field receiver is spelled `this.repo` — dotted — so it types through the
 * receiver-chain fold and the text cascade, both of which reach
 * `findClassBindingInScope`, which has no notion of type arguments. A local or a
 * parameter of the IDENTICAL type is a bare name, so it types through Case 4 and
 * `resolveClassBindingForName`, which strips them. That asymmetry is #2833, and
 * it is the same shape as #2813/#2829 (Case 0 lacked Case 4's fan-out) and
 * #2832/#2842 (Case 3b lacked it too): a property of how the receiver is
 * SPELLED rather than of what it resolves to.
 *
 * Six languages never reach that asymmetry because they erase type arguments at
 * INTERPRET time — `java/interpret.ts` runs `stripGeneric` over the annotation
 * (F41, #1928) and Swift does the same — so their `rawName` is already `Repo`.
 * TypeScript, C# and Python do not: their `stripGeneric` is a container
 * ALLOW-LIST (`Promise<X>`, `Array<X>`, `list[X]`…) that returns the type
 * ARGUMENT, and a user-defined `Repo<User>` matches nothing in it, so the
 * literal spelling survives into a lookup that binds nothing.
 *
 * Python is affected twice over: it spells type application with SQUARE brackets
 * (`Repo[User]`), and the generic branch of `resolveClassBindingForName` is
 * gated on `.includes('<')`. That is why Python loses its local and parameter
 * rows too, where TypeScript and C# keep theirs — and why the shared fix alone
 * does not lift it.
 *
 * C++ is affected for a third, still-undiagnosed reason (#2833 step 5): it
 * writes the receiver bare (`repo.save(u)`, no `this->`), so it already takes
 * Case 4 and the generic-aware lookup — and still fails, while a C++ LOCAL of
 * the same type and a C++ non-generic FIELD both resolve.
 *
 * ── THE NEGATIVE CONTROLS ─────────────────────────────────────────────────────
 *
 * Erasing `Repo<User>` to `Repo` is right for finding a DECLARATION — one
 * declaration serves every instantiation in each language here. Two shapes must
 * not be swept up with it, and each gets a row:
 *
 *   - A bare TYPE PARAMETER (`class Box<TItem> { t: TItem }`) denotes no
 *     declaration at all. Inventing one is a false edge, which is strictly worse
 *     than the missing edge #2833 is about. `Box2<T>` beside a workspace class
 *     literally named `T` pins the PRE-EXISTING collision: `T` carries no type
 *     arguments, so it never enters the generic path, and that edge is measured
 *     unchanged by the fix. It is pinned here so it cannot be mistaken for
 *     fallout — and so it stays visible until it gets its own fix.
 *   - A C++ explicit specialization (`template<> struct Vec<bool>`) genuinely IS
 *     a different class from the primary template. Erasing to `Vec` before
 *     trying an exact argument match would silently retarget it, which is why
 *     `resolveClassBindingForName` matches `templateArguments` FIRST and only
 *     then falls back to the base name.
 *
 * A bounded type parameter (`T extends Repo`) resolves to nothing today. Making
 * it resolve to its bound is defensible but is a semantics EXPANSION beyond this
 * bug, so the row pins current behaviour rather than asserting a wish.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

/** One measured call site: the method the call is written in, and every distinct
 *  CALLS target it emits, by node id. */
interface Row {
  /** Simple name of the enclosing method — resolved to a node at run time so no
   *  id scheme is hard-coded on the CALLER side. */
  readonly caller: string;
  /** Sorted, deduplicated target node ids AS MEASURED TODAY. An EMPTY array is
   *  only ever written next to a `caller` the suite has separately proven
   *  exists, so an empty expectation can never pass vacuously. */
  readonly targets: readonly string[];
  /** `known-gap` rows are the defect, pinned at its current value so the file
   *  is green on main and flipping it is a visible edit rather than a silent
   *  drift. */
  readonly status: 'resolves' | 'known-gap';
  /** What the row must become once its step lands. Documentation for the
   *  executor and the reviewer; no assertion reads it, because asserting a
   *  wish is how a suite goes red for months. */
  readonly whenFixed?: readonly string[];
  readonly note: string;
}

interface Case {
  readonly name: string;
  readonly file: string;
  readonly source: string;
  readonly rows: readonly Row[];
}

const CASES: readonly Case[] = [
  {
    name: 'typescript',
    file: 'a.ts',
    source: `
export class User {}
export interface Repo<T> { save(x: T): void; }
export class UserRepo implements Repo<User> { save(x: User): void {} }
export interface Plain { save(x: User): void; }
export class PlainRepo implements Plain { save(x: User): void {} }
export class GenericSvc {
  private repo: Repo<User>;
  constructor(r: Repo<User>) { this.repo = r; }
  runGeneric(u: User): void { this.repo.save(u); }
}
export class ControlSvc {
  private plain: Plain;
  constructor(p: Plain) { this.plain = p; }
  runControl(u: User): void { this.plain.save(u); }
}
`,
    rows: [
      {
        caller: 'runControl',
        targets: ['Method:a.ts:Plain.save#1', 'Method:a.ts:PlainRepo.save#1'],
        status: 'resolves',
        note: 'control: interface-typed field, primary + dispatch fan-out',
      },
      {
        caller: 'runGeneric',
        targets: ['Method:a.ts:Repo.save#1', 'Method:a.ts:UserRepo.save#1'],
        status: 'resolves',
        note: '#2833 step 3: generic-typed field must match the control exactly',
      },
    ],
  },
  {
    name: 'csharp',
    file: 'A.cs',
    source: `
class User {}
interface IRepo<T> { void Save(T x); }
class UserRepo : IRepo<User> { public void Save(User x) {} }
interface IPlain { void Save(User x); }
class PlainRepo : IPlain { public void Save(User x) {} }
class GenericSvc {
  private IRepo<User> repo;
  public void RunGeneric(User u) { this.repo.Save(u); }
}
class ControlSvc {
  private IPlain plain;
  public void RunControl(User u) { this.plain.Save(u); }
}
`,
    rows: [
      {
        caller: 'RunControl',
        targets: ['Method:A.cs:IPlain.Save#1', 'Method:A.cs:PlainRepo.Save#1'],
        status: 'resolves',
        note: 'control',
      },
      {
        caller: 'RunGeneric',
        targets: ['Method:A.cs:IRepo.Save#1', 'Method:A.cs:UserRepo.Save#1'],
        status: 'resolves',
        note: '#2833 step 3',
      },
    ],
  },
  {
    name: 'java',
    file: 'A.java',
    source: `
class User {}
interface Repo<T> { void save(T x); }
class UserRepo implements Repo<User> { public void save(User x) {} }
interface Plain { void save(User x); }
class PlainRepo implements Plain { public void save(User x) {} }
class GenericSvc {
  private Repo<User> repo;
  void runGeneric(User u) { this.repo.save(u); }
}
class ControlSvc {
  private Plain plain;
  void runControl(User u) { this.plain.save(u); }
}
`,
    rows: [
      {
        caller: 'runControl',
        targets: ['Method:A.java:Plain.save#1', 'Method:A.java:PlainRepo.save#1'],
        status: 'resolves',
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: ['Method:A.java:Repo.save#1', 'Method:A.java:UserRepo.save#1'],
        status: 'resolves',
        note: 'ALREADY CORRECT — interpret-time erasure. Pinned against regression.',
      },
    ],
  },
  {
    name: 'kotlin',
    file: 'A.kt',
    source: `
class User
interface Repo<T> { fun save(x: T) }
class UserRepo : Repo<User> { override fun save(x: User) {} }
interface Plain { fun save(x: User) }
class PlainRepo : Plain { override fun save(x: User) {} }
class GenericSvc(private val repo: Repo<User>) {
  fun runGeneric(u: User) { repo.save(u) }
}
class ControlSvc(private val plain: Plain) {
  fun runControl(u: User) { plain.save(u) }
}
`,
    rows: [
      {
        caller: 'runControl',
        targets: ['Method:A.kt:Plain.save#1', 'Method:A.kt:PlainRepo.save#1'],
        status: 'resolves',
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: ['Method:A.kt:Repo.save#1', 'Method:A.kt:UserRepo.save#1'],
        status: 'resolves',
        note: 'ALREADY CORRECT. Pinned against regression.',
      },
    ],
  },
  {
    name: 'go',
    file: 'a.go',
    source: `package main

type User struct{}

type Repo[T any] interface{ Save(x T) }

type UserRepo struct{}

func (r UserRepo) Save(x User) {}

type Plain interface{ Save(x User) }

type PlainRepo struct{}

func (r PlainRepo) Save(x User) {}

type GenericSvc struct{ repo Repo[User] }

func (s GenericSvc) RunGeneric(u User) { s.repo.Save(u) }

type ControlSvc struct{ plain Plain }

func (s ControlSvc) RunControl(u User) { s.plain.Save(u) }
`,
    rows: [
      {
        caller: 'RunControl',
        targets: [
          'Method:a.go:Plain.Save#1',
          'Method:a.go:PlainRepo.Save#1',
          'Method:a.go:UserRepo.Save#1',
        ],
        status: 'resolves',
        note: 'control: Go structural satisfaction fans out to both value-receiver impls (#2829)',
      },
      {
        caller: 'RunGeneric',
        targets: ['Method:a.go:Repo.Save#1'],
        status: 'resolves',
        note: 'ALREADY CORRECT for the bracket spelling. Pinned against regression.',
      },
    ],
  },
  {
    name: 'rust',
    file: 'a.rs',
    source: `
pub struct User {}
pub struct Repo<T> { pub item: T }
impl<T> Repo<T> { pub fn save(&self, x: &User) {} }
pub struct Plain {}
impl Plain { pub fn save(&self, x: &User) {} }
pub struct GenericSvc { repo: Repo<User> }
impl GenericSvc { pub fn run_generic(&self, u: &User) { self.repo.save(u); } }
pub struct ControlSvc { plain: Plain }
impl ControlSvc { pub fn run_control(&self, u: &User) { self.plain.save(u); } }
`,
    rows: [
      {
        caller: 'run_control',
        targets: ['Function:a.rs:Plain.save#1'],
        status: 'resolves',
        note: 'control: concrete receiver, no fan-out',
      },
      {
        caller: 'run_generic',
        targets: ['Function:a.rs:Repo.save#1'],
        status: 'resolves',
        note: 'ALREADY CORRECT. Pinned against regression.',
      },
    ],
  },
  {
    name: 'swift',
    file: 'A.swift',
    source: `
class User {}
class BoxRepo<T> { func save(x: User) {} }
class Plain { func save(x: User) {} }
class GenericSvc {
  let repo: BoxRepo<User> = BoxRepo<User>()
  func runGeneric(u: User) { repo.save(x: u) }
}
class ControlSvc {
  let plain: Plain = Plain()
  func runControl(u: User) { plain.save(x: u) }
}
`,
    rows: [
      {
        caller: 'runControl',
        targets: ['Function:A.swift:Plain.save#1'],
        status: 'resolves',
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: ['Function:A.swift:BoxRepo.save#1'],
        status: 'resolves',
        note: 'ALREADY CORRECT. Pinned against regression.',
      },
    ],
  },
  {
    name: 'dart',
    file: 'a.dart',
    source: `
class User {}
class Repo<T> { void save(User x) {} }
class Plain { void save(User x) {} }
class GenericSvc {
  Repo<User> repo = Repo<User>();
  void runGeneric(User u) { this.repo.save(u); }
}
class ControlSvc {
  Plain plain = Plain();
  void runControl(User u) { this.plain.save(u); }
}
`,
    rows: [
      {
        caller: 'runControl',
        targets: ['Method:a.dart:Plain.save#1'],
        status: 'resolves',
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: ['Method:a.dart:Repo.save#1'],
        status: 'resolves',
        note: 'ALREADY CORRECT. Pinned against regression.',
      },
    ],
  },
  {
    name: 'cpp',
    file: 'a.cpp',
    source: `
struct User {};
template <class T> struct Repo { void save(User x) {} };
struct Plain { void save(User x) {} };
struct GenericSvc {
  Repo<User> repo;
  void runGeneric(User u) { repo.save(u); }
};
struct ControlSvc {
  Plain plain;
  void runControl(User u) { plain.save(u); }
};
`,
    rows: [
      {
        caller: 'runControl',
        targets: ['Method:a.cpp:Plain.save#1'],
        status: 'resolves',
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: [],
        status: 'known-gap',
        whenFixed: ['Method:a.cpp:Repo.save#1'],
        note: '#2833 step 5 — C++ takes Case 4 (bare receiver) and still fails',
      },
    ],
  },
  {
    name: 'python',
    file: 'a.py',
    source: `
from typing import Generic, TypeVar

T = TypeVar("T")

class User:
    pass

class Repo(Generic[T]):
    def save(self, x):
        pass

class Plain:
    def save(self, x):
        pass

class GenericSvc:
    def __init__(self, repo: Repo[User]):
        self.repo = repo

    def run_generic(self, u: User) -> None:
        self.repo.save(u)

class ControlSvc:
    def __init__(self, plain: Plain):
        self.plain = plain

    def run_control(self, u: User) -> None:
        self.plain.save(u)
`,
    rows: [
      {
        caller: 'run_control',
        targets: ['Method:a.py:Plain.save#1'],
        status: 'resolves',
        note: 'control',
      },
      {
        caller: 'run_generic',
        targets: [],
        status: 'known-gap',
        whenFixed: ['Method:a.py:Repo.save#1'],
        note: '#2833 step 6 — bracket spelling never enters the `<`-gated generic branch',
      },
    ],
  },
  {
    name: 'ts-local-vs-field',
    file: 'a.ts',
    source: `
export class User {}
export interface Repo<T> { save(x: T): void; }
export class UserRepo implements Repo<User> { save(x: User): void {} }
export class Svc {
  private field: Repo<User>;
  constructor(r: Repo<User>) { this.field = r; }
  viaField(u: User): void { this.field.save(u); }
  viaLocal(u: User): void { const local: Repo<User> = this.field; local.save(u); }
  viaParam(p: Repo<User>, u: User): void { p.save(u); }
}
`,
    rows: [
      {
        caller: 'viaLocal',
        targets: ['Method:a.ts:Repo.save#1', 'Method:a.ts:UserRepo.save#1'],
        status: 'resolves',
        note: 'MUTATION CONTROL: a local of the identical generic type resolves today',
      },
      {
        caller: 'viaParam',
        targets: ['Method:a.ts:Repo.save#1', 'Method:a.ts:UserRepo.save#1'],
        status: 'resolves',
        note: 'MUTATION CONTROL: a parameter of the identical generic type resolves today',
      },
      {
        caller: 'viaField',
        targets: ['Method:a.ts:Repo.save#1', 'Method:a.ts:UserRepo.save#1'],
        status: 'resolves',
        note: 'the whole bug in one file — same type, same class, only the FIELD lost it',
      },
    ],
  },
  {
    name: 'neg-type-parameter',
    file: 'a.ts',
    source: `
export class T { foo(): void {} }
export class Box<TItem> {
  private t: TItem;
  constructor(t: TItem) { this.t = t; }
  run(): void { this.t.foo(); }
}
export class Box2<T> {
  private t: T;
  constructor(t: T) { this.t = t; }
  run2(): void { this.t.foo(); }
}
`,
    rows: [
      {
        caller: 'run',
        targets: [],
        status: 'resolves',
        note: 'NEGATIVE: an unbounded type parameter denotes no declaration — no edge, ever',
      },
      {
        caller: 'run2',
        targets: ['Method:a.ts:T.foo#0'],
        status: 'resolves',
        note: 'PRE-EXISTING GAP, pinned: a workspace class named T shadows the type parameter. `T` carries no type arguments so it never enters the generic path — measured unchanged by the #2833 fix. Tracked separately; this row exists so it cannot be mistaken for fallout.',
      },
    ],
  },
  {
    name: 'neg-bounded-type-parameter',
    file: 'a.ts',
    source: `
export interface Repo { save(): void; }
export class Box<T extends Repo> {
  private t: T;
  constructor(t: T) { this.t = t; }
  run(): void { this.t.save(); }
}
`,
    rows: [
      {
        caller: 'run',
        targets: [],
        status: 'resolves',
        note: 'Pins current behaviour. Resolving a bound is a semantics expansion beyond #2833.',
      },
    ],
  },
  {
    name: 'neg-cpp-specialization',
    file: 'a.cpp',
    source: `
template <class T> struct Vec { void save() {} };
template <> struct Vec<bool> { void save() {} };
struct Svc {
  Vec<bool> vb;
  Vec<int> vi;
  void runBool() { vb.save(); }
  void runInt() { vi.save(); }
};
`,
    rows: [
      {
        caller: 'runBool',
        targets: [],
        status: 'known-gap',
        note: 'NEGATIVE, blocked behind the C++ gap (step 5). Once C++ fields type, this must land on the SPECIALIZATION rather than the primary template — asserted by node id because both members are named `save`. The expected id is deliberately not written here: it must come from measurement in step 5, not from a guess about how a specialization is registered.',
      },
      {
        caller: 'runInt',
        targets: [],
        status: 'known-gap',
        note: 'the primary template instantiation, blocked behind the same C++ gap',
      },
    ],
  },
];

describe('generic-typed field receivers across languages (#2833)', () => {
  const results = new Map<string, PipelineResult>();

  beforeAll(async () => {
    for (const testCase of CASES) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gn-2833-${testCase.name}-`));
      writeFixtureRepo(dir, { [testCase.file]: testCase.source });
      // CALLS resolution is complete before the graph phases run and nothing
      // here reads what they produce, so skipping them narrows each run to the
      // phase under test.
      results.set(
        testCase.name,
        await runPipelineFromRepo(dir, () => {}, { skipGraphPhases: true }),
      );
    }
  }, 1800000);

  function resultFor(name: string): PipelineResult {
    const result = results.get(name);
    if (result === undefined) throw new Error(`no pipeline result for ${name}`);
    return result;
  }

  /** Node ids of every function-like node whose simple name is `caller`.
   *  Returned as a list so the suite can assert there is exactly ONE — an id
   *  scheme change or fixture drift would otherwise turn a row into a
   *  vacuous empty-vs-empty comparison, which is how a pinned gap rots into a
   *  passing lie. */
  function callerIds(name: string, caller: string): string[] {
    const ids: string[] = [];
    resultFor(name).graph.forEachNode((node) => {
      if (node.properties.name === caller) ids.push(node.id);
    });
    return ids.sort();
  }

  /** Distinct CALLS target ids emitted by the one node named `caller`, sorted.
   *  Deduplicated deliberately: Swift emits the same edge more than once for a
   *  single call site, and edge MULTIPLICITY is a different question from
   *  whether the receiver typed at all. */
  function callTargets(name: string, caller: string): string[] {
    const ids = new Set(callerIds(name, caller));
    return [
      ...new Set(
        getRelationships(resultFor(name), 'CALLS')
          .filter((edge) => ids.has(edge.rel.sourceId))
          .map((edge) => edge.rel.targetId),
      ),
    ].sort();
  }

  for (const testCase of CASES) {
    describe(testCase.name, () => {
      it('every row names exactly one live caller node', () => {
        const found = Object.fromEntries(
          testCase.rows.map((row) => [row.caller, callerIds(testCase.name, row.caller).length]),
        );
        expect(found).toEqual(Object.fromEntries(testCase.rows.map((row) => [row.caller, 1])));
      });

      for (const row of testCase.rows) {
        it(`${row.caller}: ${row.note}`, () => {
          expect(callTargets(testCase.name, row.caller)).toEqual([...row.targets].sort());
        });
      }
    });
  }

  // A generic-typed field must not merely emit SOMETHING — it must emit exactly
  // as many targets as the SAME language's non-generic control field. Asserted
  // across the whole matrix in one place so adding a language cannot quietly
  // skip it, and stated as an explicit per-language map rather than "all true"
  // so the four open gaps are visible in the expectation itself. Steps 3, 5 and
  // 6 flip their entries to `true`; nothing else in this file needs to change.
  const PAIRED = [
    { name: 'typescript', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'csharp', control: 'RunControl', generic: 'RunGeneric', matches: true },
    { name: 'cpp', control: 'runControl', generic: 'runGeneric', matches: false },
    { name: 'python', control: 'run_control', generic: 'run_generic', matches: false },
    { name: 'java', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'kotlin', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'dart', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'swift', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'rust', control: 'run_control', generic: 'run_generic', matches: true },
  ] as const;

  it('each language generic field matches (or, where pinned, does not match) its own control row', () => {
    const observed = Object.fromEntries(
      PAIRED.map((p) => [
        p.name,
        callTargets(p.name, p.generic).length === callTargets(p.name, p.control).length,
      ]),
    );
    expect(observed).toEqual(Object.fromEntries(PAIRED.map((p) => [p.name, p.matches])));
  });

  // Every control row must emit SOMETHING. Without this, a fixture that stopped
  // parsing would make the comparison above pass by emptying both sides — the
  // exact way a matrix rots into a green lie.
  it('every control row emits at least one edge', () => {
    const observed = Object.fromEntries(
      PAIRED.map((p) => [p.name, callTargets(p.name, p.control).length > 0]),
    );
    expect(observed).toEqual(Object.fromEntries(PAIRED.map((p) => [p.name, true])));
  });
});
