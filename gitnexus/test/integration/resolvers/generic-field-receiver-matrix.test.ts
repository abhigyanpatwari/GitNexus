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
 * Python was affected twice over: it spells type application with SQUARE
 * brackets (`Repo[User]`), and the generic branch of the shared lookup is gated
 * on `.includes('<')`. That is why Python lost its local and parameter rows too,
 * where TypeScript and C# kept theirs, and why the shared lookup change alone
 * did not lift it. Its interpreter now reduces a subscripted type its container
 * allow-lists do not claim to the base name — the same rule Java and Swift
 * already applied to `<…>`.
 *
 * C++ failed for a third reason entirely, and it was a CAPTURE gap rather than a
 * resolution one: all three `field_declaration` type-binding rules required
 * `type: (type_identifier)`, so `Repo<User> repo;` — a `template_type` — matched
 * none of them and the member got no type binding at all. Both spellings failed
 * while a LOCAL of the same type resolved, because the local declaration rules
 * had gained their `template_type` variant long ago. Three mirrored rules close
 * the bare spelling. The QUALIFIED spelling (`std::vector<Item>`, `ns::Address`)
 * is a `qualified_identifier` WRAPPING either node, so it matched none of the
 * six — GENERIC OR NOT, which is why `std::string name;` bound nothing either —
 * and three further rules match that outer node directly. Matching the outer
 * node rather than enumerating the inner one is what makes them depth-agnostic:
 * there is no longer a qualifier depth at which a member field stops being
 * captured, and `cppQualifiedTail` in `interpret.ts` reduces `a::b::c::Deeper<T>`
 * to `Deeper<T>` the way the bare spelling already resolved.
 *
 * ── MEASURED STATE (all rows below are measured, none predicted) ─────────────
 *
 *   language     generic field   why
 *   -----------  --------------  ------------------------------------------
 *   TypeScript   fixed           shared lookup now generic-aware
 *   C#           fixed           same
 *   C++          fixed           + new template_type/qualified field captures
 *   Python       fixed           + base-name erasure for `Name[...]`
 *   Java         already ok      erases generics at interpret time
 *   Kotlin       already ok      same
 *   Go           fixed           + generic-interface instantiation fan-out
 *   Rust         already ok      erases generics at interpret time
 *   Swift        already ok      same
 *   Dart         already ok      same
 *   JavaScript   fixed           + `@type {Repo<User>}` docblock field capture
 *   PHP          fixed           + `@var Repo<User>` docblock property capture;
 *                                its native typed property has no generic syntax
 *   Ruby, C,     n/a             no generics in the language
 *   COBOL
 *
 * ── BASE-NAME ERASURE IS THE WIDEST STEP HERE, AND IT IS GROUNDED ────────────
 *
 * Reaching a declaration by NAME ALONE binds whatever the workspace happens to
 * declare under that name, so a third-party `Mapped[User]` beside an unrelated
 * workspace `class Mapped` would become a confident WRONG edge — strictly worse
 * than the missing one it replaced. `resolveClassBindingForName` therefore
 * admits an erased base name only on grounds that connect the SITE to the
 * declaration (the scope chain binds the name; the declaration is in the same
 * file; the index proves the name is a template family; the file has no
 * cross-file class channel to be absent from). `py-erased-grounding` pins the
 * refusal and `py-generic-grounding-mirrors`, `cpp-csharp-index-channel` and the
 * `-crossfile` rows pin the four shapes that would break if it were stricter.
 *
 * ── GAPS THIS FILE ONCE PINNED, NOW CLOSED ───────────────────────────────────
 *
 * Every one of these was a measured empty row here, each with a CONTROL that
 * failed identically — which is what classified it as a gap in some other
 * mechanism rather than in generic typing. The mechanism named is what closed
 * it, and every row below is now asserted non-empty:
 *
 *   - C++ `this->field.m()` emitted nothing even for a NON-generic field: a
 *     `this`-head seed gap. The compound fold now seeds the head from the
 *     enclosing class for a language that sets `resolveThisViaEnclosingClass`
 *     (`cpp-this-head-field`).
 *   - JavaScript `@type {…}` and PHP `@var …` docblock field types bound nothing
 *     at all — the only way either language can spell a field's type at all in
 *     the generic case. Both now synthesize the same annotation-strength binding
 *     the native syntax emits (`js-docblock-field`, `php-docblock-property`).
 *   - A STATIC/class-level member receiver (`Holder.repo.save(u)`) emitted
 *     nothing, and so did `Holder.plain.save(u)`. Case 6 types the receiver off
 *     the static field DEF, which is the thing a per-scope `typeBindings` map
 *     cannot hold for a class declaring both a static and an instance member of
 *     one name (`ts-reach-shapes`, `kotlin-companion-static-member`).
 *   - A C++ generic field qualified THREE deep was not captured; that was the
 *     cost of one query pattern per qualifier depth, and the depth-agnostic
 *     rules removed the boundary rather than raising it
 *     (`cpp-qualified-generic-field`, now pinned at depth 3 AND 4).
 *   - A C++ PRIMARY template did not bind cross-file when the instantiating file
 *     named it nowhere lexically. The base-name route now re-decides over the
 *     declarations that pin no template arguments of their own, and exactly one
 *     of the two `Vec` declarations does (`cpp-spec-cross-file`).
 *   - A workspace `class T` shadowed a type PARAMETER named `T` and answered for
 *     it. Declarations now carry their declared `typeParameters`, and a name a
 *     lexically enclosing declaration binds as a parameter is refused
 *     (`neg-type-parameter`).
 *
 * ── DELIBERATE LIMITS STILL PINNED HERE ──────────────────────────────────────
 *
 * These rows are NOT gaps waiting to be closed. Each states a decision, and
 * changing one is a semantics change to argue for, not a bug to fix quietly:
 *
 *   - C++ partial-specialization SELECTION resolves to the PRIMARY template.
 *     Selecting `Vec<T*>` for `Vec<int*>` needs template-argument DEDUCTION,
 *     ruled out of scope; what IS pinned is that the answer does not depend on
 *     declaration order (`cpp-partial-spec-*`).
 *   - `std::unique_ptr<Payload>` types to `unique_ptr`, NOT to the pointee.
 *     Smart-pointer transparency is not applied on this path.
 *   - A C++ node id drops the namespace, so two same-named specializations in
 *     ONE file collapse to one node. `cpp-spec-lexical-shadowing` puts its two
 *     `Box<bool>` declarations in two FILES for exactly that reason.
 *   - A chain HEAD whose own type was erased still binds through the
 *     bare-identifier branch's callable-alias retry: `m.inner.ping()` where
 *     `m: Mapped[User]` resolves, while the one-segment-shallower `m.save(u)`
 *     correctly refuses. `py-erased-grounding` / `run_head_chain` pins it.
 *
 * ── THE NEGATIVE CONTROLS ─────────────────────────────────────────────────────
 *
 * Erasing `Repo<User>` to `Repo` is right for finding a DECLARATION — one
 * declaration serves every instantiation in each language here. Four shapes must
 * not be swept up with it, and each gets a row:
 *
 *   - A bare TYPE PARAMETER (`class Box<TItem> { t: TItem }`) denotes no
 *     declaration at all. Inventing one is a false edge, which is strictly worse
 *     than the missing edge #2833 is about. `Box2<T>` beside a workspace class
 *     literally named `T` is the hard case, because `T` carries no type
 *     arguments and so never enters the generic path at all — visibility was
 *     never the defect, and no grounding rule could have declined it. Only the
 *     enclosing declaration's own parameter list records that the name means
 *     something else here.
 *   - A C++ explicit specialization (`template<> struct Vec<bool>`) genuinely IS
 *     a different class from the primary template. Erasing to `Vec` before
 *     trying an exact argument match would silently retarget it, which is why
 *     `resolveClassBindingForName` matches `templateArguments` FIRST and only
 *     then falls back to the base name — and why, when the base-name walk lands
 *     on a declaration that pinned arguments the caller did NOT write, it
 *     re-decides over the parameterized declarations instead of keeping it.
 *     Without that last step the answer depended on SOURCE ORDER: `Vec<int> vi`
 *     bound `Vec<bool>` when the specialization happened to be written above the
 *     primary. `cpp-spec-order-*` pins both arrangements.
 *   - A workspace class whose name collides with a CONTAINER
 *     (`class Map` beside `m: Map<string, User>`) now binds where it did not
 *     before, because base-name erasure reaches it. `container-name-collision`
 *     makes that policy visible instead of accidental, and the C++ qualified
 *     rows state the same policy for `std::string name;` when the workspace
 *     really does declare a `string`.
 *   - Go interface satisfaction against a generic interface is SUBSTITUTION, not
 *     erasure: `Repo[Order]` instantiates to `Save(x Order)`, which an
 *     implementor of `Save(x User)` does not satisfy and must not fan out to
 *     (`go-instantiation-mismatch`).
 *
 * A BOUNDED type parameter (`T extends Repo`) now resolves through its bound,
 * because the parameter list that declines the unbounded case carries the bound
 * with it. The row asserts the fan-out that the bound's own field produces,
 * beside that sibling in the same fixture, so neither can be the sound of a
 * fixture that stopped parsing.
 *
 * ── WHY THIS IS STILL ONE FILE ────────────────────────────────────────────────
 *
 * Four assertions at the bottom compare cases AGAINST EACH OTHER: the
 * control/generic pairing sweep, the control-non-emptiness sweep, the
 * duplicate-edge sweep, and the C++ source-order property (which is only
 * meaningful as an equality between two separately-built fixtures). Splitting
 * out, say, a `-cpp` sibling would either duplicate those sweeps or drop the
 * cases they cover, and a matrix whose sweeps do not see every row is the thing
 * this file exists to prevent. The cost is linear in cases — one pipeline run
 * each, in one vitest worker — not quadratic, so the file grows in wall time the
 * way a list does, not the way a matrix does.
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
   *  exists, in a fixture some other row proves resolved, so an empty
   *  expectation can never pass vacuously. */
  readonly targets: readonly string[];
  readonly note: string;
}

interface Case {
  readonly name: string;
  readonly file: string;
  readonly source: string;
  /** Further files in the same fixture repo, for the shapes a single file
   *  cannot express: a declaration split across files, a specialization
   *  declared away from its instantiation, or two languages whose answers are
   *  compared side by side. Written after `file`, in literal order. */
  readonly extraFiles?: Readonly<Record<string, string>>;
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
        note: 'control: interface-typed field, primary + dispatch fan-out',
      },
      {
        caller: 'runGeneric',
        targets: ['Method:a.ts:Repo.save#1', 'Method:a.ts:UserRepo.save#1'],
        note: '#2833: generic-typed field matches the control exactly, primary + fan-out',
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
        note: 'control',
      },
      {
        caller: 'RunGeneric',
        targets: ['Method:A.cs:IRepo.Save#1', 'Method:A.cs:UserRepo.Save#1'],
        note: '#2833: matches the control exactly, primary + fan-out',
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
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: ['Method:A.java:Repo.save#1', 'Method:A.java:UserRepo.save#1'],
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
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: ['Method:A.kt:Repo.save#1', 'Method:A.kt:UserRepo.save#1'],
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
        note: 'control: Go structural satisfaction fans out to both value-receiver impls (#2829)',
      },
      {
        caller: 'RunGeneric',
        targets: [
          'Method:a.go:PlainRepo.Save#1',
          'Method:a.go:Repo.Save#1',
          'Method:a.go:UserRepo.Save#1',
        ],
        note: 'the bracket spelling always typed the receiver; what it lacked was structural satisfaction against a GENERIC interface. `Repo[User]` now instantiates to `interface{ Save(x User) }`, which both value-receiver impls satisfy — so Go finally matches its own control instead of stopping at the declaration.',
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
        note: 'control: concrete receiver, no fan-out',
      },
      {
        caller: 'run_generic',
        targets: ['Function:a.rs:Repo.save#1'],
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
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: ['Function:A.swift:BoxRepo.save#1'],
        note: 'ALREADY CORRECT — but the initializer is a constructor of the SAME generic type, so this row cannot separate "the annotation resolved" from "the construction resolved". It pins the INITIALIZER path only; `annotation-only-swift-dart` pins the annotation on its own.',
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
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: ['Method:a.dart:Repo.save#1'],
        note: 'ALREADY CORRECT — same caveat as the Swift row: initializer of the identical generic type, so it pins the INITIALIZER path. `annotation-only-swift-dart` pins the annotation on its own.',
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
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: ['Method:a.cpp:Repo.save#1~c:16619u1'],
        note: '#2833: fixed by the new template_type field_declaration captures — a C++ member whose type carried template arguments previously bound nothing at all',
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
        note: 'control',
      },
      {
        caller: 'run_generic',
        targets: ['Method:a.py:Repo.save#1'],
        note: '#2833: fixed by base-name erasure in the Python interpreter — the bracket spelling never reached the `<`-gated generic branch',
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
        note: 'MUTATION CONTROL: a local of the identical generic type resolves today',
      },
      {
        caller: 'viaParam',
        targets: ['Method:a.ts:Repo.save#1', 'Method:a.ts:UserRepo.save#1'],
        note: 'MUTATION CONTROL: a parameter of the identical generic type resolves today',
      },
      {
        caller: 'viaField',
        targets: ['Method:a.ts:Repo.save#1', 'Method:a.ts:UserRepo.save#1'],
        note: 'the whole bug in one file — same type, same class, only the FIELD lost it',
      },
    ],
  },
  {
    name: 'neg-type-parameter',
    file: 'a.ts',
    source: `
export class T { foo(): void {} }
export class Plain { foo(): void {} }
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
export class BoxControl {
  private p: Plain;
  constructor(p: Plain) { this.p = p; }
  runPlain(): void { this.p.foo(); }
}
`,
    rows: [
      {
        caller: 'runPlain',
        targets: ['Method:a.ts:Plain.foo#0'],
        note: 'ANTI-VACUITY CONTROL for the two negatives below, and the reason it must be here: both of them are empty now, so without an ordinary field receiver resolving in this same fixture the case could go green on a repo that never parsed.',
      },
      {
        caller: 'run',
        targets: [],
        note: 'NEGATIVE: an unbounded type parameter denotes no declaration — no edge, ever',
      },
      {
        caller: 'run2',
        targets: [],
        note: "THE FALSE EDGE, now closed: a workspace `class T` used to answer for the type parameter `T`. Visibility was never the defect — `export class T` is declared, exported and lexically in scope, so no grounding rule could decline it, and `T` carries no type arguments so it never entered the generic path either. Only `Box2`'s own declared `typeParameters` record that `T` means something else inside it, and `findClassBindingInScope` now refuses a name a lexically enclosing declaration binds as a parameter.",
      },
    ],
  },
  {
    name: 'neg-bounded-type-parameter',
    file: 'a.ts',
    source: `
export interface Repo { save(): void; }
export class RepoImpl implements Repo { save(): void {} }
export class Box<T extends Repo> {
  private t: T;
  private direct: Repo;
  constructor(t: T, d: Repo) { this.t = t; this.direct = d; }
  run(): void { this.t.save(); }
  runDirect(): void { this.direct.save(); }
}
`,
    rows: [
      {
        caller: 'run',
        targets: ['Method:a.ts:Repo.save#0', 'Method:a.ts:RepoImpl.save#0'],
        note: 'a BOUNDED type parameter now resolves THROUGH its bound, with the same interface-dispatch fan-out a field of the bound produces. It comes for free with the parameter list that declines the UNBOUNDED case one fixture up: refusing `T` requires knowing `Box` declares it, and the same entry carries `extends Repo`. Resolving to the bound is the sound direction — every `T` here IS a `Repo` — so this is a deliberate semantics expansion, not fallout.',
      },
      {
        caller: 'runDirect',
        targets: ['Method:a.ts:Repo.save#0', 'Method:a.ts:RepoImpl.save#0'],
        note: 'THE YARDSTICK for the row above: a field of the BOUND itself, in the same class of the same fixture. The two are now asserted to the same target set, which is the whole claim — resolving through a bound must land where naming the bound lands, not merely somewhere.',
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
        targets: ['Method:a.cpp:Vec<bool>.save#0'],
        note: 'NEGATIVE: lands on the SPECIALIZATION, not the primary template. Asserted by node id because both members are named `save` — the ids differ (`Vec<bool>.save` vs `Vec.save~c:…`), which is exactly what would collapse if a naive strip ran before the arity/token match.',
      },
      {
        caller: 'runInt',
        targets: ['Method:a.cpp:Vec.save#0~c:16619u1'],
        note: 'the primary template instantiation — distinct target id from the specialization above',
      },
    ],
  },
  // ── C++ specialization must not depend on SOURCE ORDER ────────────────────
  // The two cases below are byte-identical except for the order of the two
  // `Vec` declarations, and both are asserted to the SAME target ids. That is
  // the property, and it was measured false before the fix: with the
  // specialization written first, `Vec<int> vi` bound `Vec<bool>`, because the
  // base-name walk returned whichever declaration it reached first and
  // `Vec<bool>` had pinned arguments the instantiation never wrote. A wrong
  // edge, not a missing one — which is why the base-name route now refuses a
  // declaration that carries its own template arguments and re-decides over the
  // parameterized ones.
  //
  // The forward declaration is what makes the specialization-first arrangement
  // legal C++ rather than merely parseable; it registers no definition of its
  // own (the C++ scope extractor records only class specifiers WITH bodies), so
  // it does not itself change what is visible.
  {
    name: 'cpp-spec-order-specialization-first',
    file: 'a.cpp',
    source: `
template <class T> struct Vec;
template <> struct Vec<bool> { void save() {} };
template <class T> struct Vec { void save() {} };
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
        targets: ['Method:a.cpp:Vec<bool>.save#0'],
        note: 'the exact-argument match still wins when the specialization is declared FIRST',
      },
      {
        caller: 'runInt',
        targets: ['Method:a.cpp:Vec.save#0~c:16619u1'],
        note: 'THE ORDER BUG: `Vec<int>` bound the `Vec<bool>` specialization in this arrangement before the fix, purely because that declaration was written above the primary. Must be the primary.',
      },
    ],
  },
  {
    name: 'cpp-spec-order-primary-first',
    file: 'a.cpp',
    source: `
template <class T> struct Vec;
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
        targets: ['Method:a.cpp:Vec<bool>.save#0'],
        note: 'mirror arrangement — same answer as specialization-first',
      },
      {
        caller: 'runInt',
        targets: ['Method:a.cpp:Vec.save#0~c:16619u1'],
        note: 'mirror arrangement — same answer as specialization-first. Asserted as an equality between the two cases as well, below.',
      },
    ],
  },
  // ── Partial specialization: DETERMINISM, not deduction ────────────────────
  // `Vec<int*>` against `template<class T> struct Vec<T*>` would need
  // template-argument DEDUCTION to select the partial specialization, and
  // deduction was ruled out of scope for #2833. So the answer these two rows
  // pin is deliberately the PRIMARY template, and the point of pinning it is
  // that it is the same in both declaration orders instead of whichever
  // declaration the walk happened to reach first.
  //
  // If deduction is ever implemented, these rows SHOULD change to
  // `Vec<T*>.save` — that is a deliberate semantics expansion, not a
  // regression. Do not "fix" them by accident in the other direction.
  {
    name: 'cpp-partial-spec-primary-first',
    file: 'a.cpp',
    source: `
template <class T> struct Vec;
template <class T> struct Vec { void save() {} };
template <class T> struct Vec<T*> { void save() {} };
struct Svc {
  Vec<int*> vp;
  void runPtrArg() { vp.save(); }
};
`,
    rows: [
      {
        caller: 'runPtrArg',
        targets: ['Method:a.cpp:Vec.save#0~c:16619u1'],
        note: 'primary template — `Vec<T*>` would require deduction (out of scope)',
      },
    ],
  },
  {
    name: 'cpp-partial-spec-partial-first',
    file: 'a.cpp',
    source: `
template <class T> struct Vec;
template <class T> struct Vec<T*> { void save() {} };
template <class T> struct Vec { void save() {} };
struct Svc {
  Vec<int*> vp;
  void runPtrArg() { vp.save(); }
};
`,
    rows: [
      {
        caller: 'runPtrArg',
        targets: ['Method:a.cpp:Vec.save#0~c:16619u1'],
        note: 'same target as primary-first: the partial specialization pins `T*`, which is not the `int*` written, so it cannot win the exact match and is excluded from the base-name re-decision',
      },
    ],
  },
  {
    name: 'cpp-spec-lexical-shadowing',
    file: 'global.cpp',
    source: `
template <class T> struct Box { void save() {} };
template <> struct Box<bool> { void save() {} };
struct OuterSvc {
  Box<bool> b;
  void runOuter() { b.save(); }
};
`,
    extraFiles: {
      'ns.cpp': `
namespace N {
template <class T> struct Box { void save() {} };
template <> struct Box<bool> { void save() {} };
struct InnerSvc {
  Box<bool> b;
  void runInner() { b.save(); }
};
}
`,
    },
    rows: [
      {
        caller: 'runOuter',
        targets: ['Method:global.cpp:Box<bool>.save#0'],
        note: 'the GLOBAL specialization, from a field declared at global scope',
      },
      {
        caller: 'runInner',
        targets: ['Method:ns.cpp:Box<bool>.save#0'],
        note: 'LEXICAL SHADOWING: the namespace-local `N::Box<bool>` wins for a field inside `N`. The two specializations are separated into two FILES because a same-named specialization in the same file collapses to one node id, which would make this row unable to tell the two apart. Before the fix the workspace-wide index was consulted first: it offered two `Box<bool>` matches, declined, and fell through to the base-name walk — landing on a PRIMARY template for both services.',
      },
    ],
  },
  {
    name: 'cpp-spec-cross-file',
    file: 'vec_primary.cpp',
    source: `
template <class T> struct Vec { void save() {} };
`,
    extraFiles: {
      'vec_bool.cpp': `
template <class T> struct Vec;
template <> struct Vec<bool> { void save() {} };
`,
      'svc.cpp': `
template <class T> struct Vec;
struct Svc {
  Vec<bool> vb;
  Vec<int> vi;
  void runBoolCrossFile() { vb.save(); }
  void runIntCrossFile() { vi.save(); }
};
`,
    },
    rows: [
      {
        caller: 'runBoolCrossFile',
        targets: ['Method:vec_bool.cpp:Vec<bool>.save#0'],
        note: 'NON-REGRESSION: a specialization declared in a DIFFERENT file than the instantiation binds through the workspace-wide index. This is the row that ruled out narrowing the exact-argument match to lexically visible candidates only — the scope chain of `svc.cpp` offers no `Vec` at all.',
      },
      {
        caller: 'runIntCrossFile',
        targets: ['Method:vec_primary.cpp:Vec.save#0~c:16619u1'],
        note: 'the PRIMARY template now binds cross-file too. Nothing matches `int` exactly and two workspace defs are registered under `Vec`, which used to be a flat decline; the base-name route now re-decides over the declarations that pin NO template arguments of their own, and exactly one of the two does — the primary. `Vec<bool>` is excluded by the same rule that keeps the sibling row above landing on it.',
      },
    ],
  },
  {
    name: 'csharp-partial-generic-cross-file',
    file: 'RepoA.cs',
    source: `
partial class Repo<T> { public void Save(T x) {} }
`,
    extraFiles: {
      'RepoB.cs': `
partial class Repo<T> { public void Load(T x) {} }
`,
      'Svc.cs': `
class User {}
class Plain { public void Save(User x) {} }
class Svc {
  private Repo<User> repo;
  private Plain plain;
  public void RunPartial(User u) { this.repo.Save(u); }
  public void RunPartialControl(User u) { this.plain.Save(u); }
}
`,
    },
    rows: [
      {
        caller: 'RunPartialControl',
        targets: ['Method:Svc.cs:Plain.Save#1'],
        note: 'control',
      },
      {
        caller: 'RunPartial',
        targets: ['Method:RepoA.cs:Repo.Save#1'],
        note: 'NON-REGRESSION: a generic `partial class` split across two files, with the field in a third, resolves — and TWO defs are registered under the base name `Repo`. This is the row that ruled out "return only on exactly one base-name candidate": that rule would have deleted this edge. The base-name route keeps `findClassBindingInScope`\'s own single-match-or-decline behaviour instead, which the partial halves survive because neither pins template arguments.',
      },
    ],
  },
  // ── C++ field DECORATION and QUALIFICATION ────────────────────────────────
  // The bare `Repo<User> repo;` rule was only one of the three the fix added;
  // the pointer and reference forms had no row at all until now, and the
  // qualified forms (three further rules, one per declarator shape and
  // depth-agnostic) none either. `cpp-qualified-non-generic-field` below pins
  // the half of that second group which is not about generics at all.
  {
    name: 'cpp-pointer-reference-generic-field',
    file: 'a.cpp',
    source: `
struct User {};
template <class T> struct Repo { void save(User x) {} };
struct Plain { void save(User x) {} };
struct Svc {
  Repo<User>* gp;
  Repo<User>& gr;
  Repo<Repo<User>> gn;
  Plain* cp;
  Plain& cr;
  void runGenericPtr(User u) { gp->save(u); }
  void runGenericRef(User u) { gr.save(u); }
  void runGenericNested(User u) { gn.save(u); }
  void runControlPtr(User u) { cp->save(u); }
  void runControlRef(User u) { cr.save(u); }
};
`,
    rows: [
      { caller: 'runControlPtr', targets: ['Method:a.cpp:Plain.save#1'], note: 'control, pointer' },
      {
        caller: 'runControlRef',
        targets: ['Method:a.cpp:Plain.save#1'],
        note: 'control, reference',
      },
      {
        caller: 'runGenericPtr',
        targets: ['Method:a.cpp:Repo.save#1~c:16619u1'],
        note: 'the `pointer_declarator` rule of the three the fix added — previously untested',
      },
      {
        caller: 'runGenericRef',
        targets: ['Method:a.cpp:Repo.save#1~c:16619u1'],
        note: 'the `reference_declarator` rule — previously untested',
      },
      {
        caller: 'runGenericNested',
        targets: ['Method:a.cpp:Repo.save#1~c:16619u1'],
        note: 'nested `Repo<Repo<User>>` — the depth-aware argument scan must not stop at the inner `>`',
      },
    ],
  },
  {
    name: 'cpp-qualified-generic-field',
    file: 'a.cpp',
    source: `
struct Item {};
struct User {};
struct Payload { void reset() {} };
struct Plain { void save(User x) {} };
namespace std {
template <class T> struct vector { void push_back(Item x) {} };
template <class T> struct unique_ptr { void reset() {} };
}
namespace ns {
template <class T> struct Repo { void save(User x) {} };
}
namespace a { namespace b {
template <class T> struct Deep { void go(User x) {} };
} }
namespace a { namespace b { namespace c {
template <class T> struct Deeper { void go3(User x) {} };
} } }
namespace a { namespace b { namespace c { namespace d {
template <class T> struct Deepest { void go4(User x) {} };
} } } }
struct Svc {
  std::vector<Item> items;
  ns::Repo<User> r;
  a::b::Deep<User> d;
  std::vector<Item>* pitems;
  ns::Repo<User>& rr;
  std::unique_ptr<Payload> up;
  a::b::c::Deeper<User> deep3;
  a::b::c::d::Deepest<User> deep4;
  Plain plain;
  void runQualStd(Item i) { items.push_back(i); }
  void runQualNs(User u) { r.save(u); }
  void runQualDeep(User u) { d.go(u); }
  void runQualPtr(Item i) { pitems->push_back(i); }
  void runQualRef(User u) { rr.save(u); }
  void runQualUnique() { up.reset(); }
  void runQualDepth3(User u) { deep3.go3(u); }
  void runQualDepth4(User u) { deep4.go4(u); }
  void runQualControl(User u) { plain.save(u); }
};
`,
    rows: [
      {
        caller: 'runQualControl',
        targets: ['Method:a.cpp:Plain.save#1'],
        note: 'control: unqualified, non-generic field in the same struct',
      },
      {
        caller: 'runQualStd',
        targets: ['Method:a.cpp:vector.push_back#1~c:16619u1'],
        note: 'depth-1 qualifier, `std::vector<Item>` — the commonest real spelling of a generic member and the one the qualified rules exist for',
      },
      {
        caller: 'runQualNs',
        targets: ['Method:a.cpp:Repo.save#1~c:16619u1'],
        note: 'depth-1 qualifier, user namespace `ns::Repo<User>`',
      },
      {
        caller: 'runQualPtr',
        targets: ['Method:a.cpp:vector.push_back#1~c:16619u1'],
        note: 'depth-1 qualifier, pointer form',
      },
      {
        caller: 'runQualRef',
        targets: ['Method:a.cpp:Repo.save#1~c:16619u1'],
        note: 'depth-1 qualifier, reference form',
      },
      {
        caller: 'runQualDeep',
        targets: ['Method:a.cpp:Deep.go#1~c:16619u1'],
        note: 'depth-2 qualifier, `a::b::Deep<User>`',
      },
      {
        caller: 'runQualUnique',
        targets: ['Method:a.cpp:unique_ptr.reset#0~c:16619u1'],
        note: 'DELIBERATE LIMIT, measured: `std::unique_ptr<Payload>` types to `unique_ptr`, NOT deref-stripped to `Payload` — `Payload` also declares `reset()` and does not receive the edge. The qualifier is dropped and the template head kept, so smart-pointer transparency is not applied on this path. Flipping this row means implementing that transparency, which is a semantics expansion.',
      },
      {
        caller: 'runQualDepth3',
        targets: ['Method:a.cpp:Deeper.go3#1~c:16619u1'],
        note: 'depth 3 (`a::b::c::Deeper<User>`) was the DOCUMENTED BOUNDARY this file used to pin at empty, because the rules enumerated the INNER node and each level cost three more patterns. The rules now match the outer `qualified_identifier` instead, which is one node type whatever the depth, so the boundary is gone rather than moved.',
      },
      {
        caller: 'runQualDepth4',
        targets: ['Method:a.cpp:Deepest.go4#1~c:16619u1'],
        note: 'depth 4, and the row that says the boundary was REMOVED and not merely raised by one: if depth were still enumerated per level, closing depth 3 would have left this one empty. Nothing in the query mentions a depth, so there is no next boundary to find.',
      },
    ],
  },
  // ── Container-name collision: making an unguarded policy visible ───────────
  // Base-name erasure is not scoped to user-defined types. A workspace class
  // whose name collides with a standard container now answers for a field
  // annotated with that container, and the multi-argument shape is exactly
  // where the container ALLOW-LISTS decline to help, so nothing else competes.
  // Both rows are measured; both are what this project wants when the workspace
  // really does declare the class (the annotation names it, so the edge is
  // right), and both would emit nothing if it did not.
  {
    name: 'container-name-collision',
    file: 'a.ts',
    source: `
export class User { save(): void {} }
export class Map { save(): void {} }
export class Plain { save(): void {} }
export class TsSvc {
  private m: Map<string, User>;
  private plain: Plain;
  constructor(m: Map<string, User>, p: Plain) { this.m = m; this.plain = p; }
  runTsContainer(): void { this.m.save(); }
  runTsControl(): void { this.plain.save(); }
}
`,
    extraFiles: {
      'A.cs': `
class CsUser { public void Save() {} }
class Dictionary { public void Save() {} }
class CsPlain { public void Save() {} }
class CsSvc {
  private Dictionary<string, CsUser> d;
  private CsPlain plain;
  public void RunCsContainer() { this.d.Save(); }
  public void RunCsControl() { this.plain.Save(); }
}
`,
    },
    rows: [
      { caller: 'runTsControl', targets: ['Method:a.ts:Plain.save#0'], note: 'control (TS)' },
      { caller: 'RunCsControl', targets: ['Method:A.cs:CsPlain.Save#0'], note: 'control (C#)' },
      {
        caller: 'runTsContainer',
        targets: ['Method:a.ts:Map.save#0'],
        note: 'INTENDED, and new: `Map<string, User>` binds the workspace `class Map`, not the value type `User`. The annotation names `Map`, so naming `Map` is the right answer; the row exists because base-name erasure reaches it on the shared path with no container guard, and that policy should be readable here rather than inferred from an absence.',
      },
      {
        caller: 'RunCsContainer',
        targets: ['Method:A.cs:Dictionary.Save#0'],
        note: 'INTENDED, and new: same policy in C# for `Dictionary<string, CsUser>`. `CsUser` also declares `Save()` and does NOT receive the edge, which is what proves the base name won rather than the container allow-list unwrapping to the value type.',
      },
    ],
  },
  // ── Generic SPELLINGS ─────────────────────────────────────────────────────
  // The rows above all use the simplest possible generic, `Repo<User>`. A fix
  // that only handles that spelling is not a fix, so these pin the shapes real
  // code actually writes: a nullable generic, a wildcard, a raw type, a nested
  // generic, and a multi-argument one.
  //
  // READ THE LANGUAGE BEFORE READING THE ROW. Java, Kotlin and Rust erase type
  // arguments at INTERPRET time, so their spellings never reach the shared
  // lookup at all and their rows pass with or without it — they are regression
  // pins for the interpret-time path, and they cannot fail on a revert of the
  // shared change. The discriminating spelling rows are the TypeScript, C# and
  // Python ones: `ts-multiarg-generic` and `ts-python-nested-and-multiarg`.
  {
    name: 'kotlin-nullable-generic',
    file: 'A.kt',
    source: `
class User
interface Repo<T> { fun save(x: T) }
class UserRepo : Repo<User> { override fun save(x: User) {} }
class Svc(private val repo: Repo<User>?) {
  fun runNullableGeneric(u: User) { repo?.save(u) }
}
`,
    rows: [
      {
        caller: 'runNullableGeneric',
        targets: ['Method:A.kt:Repo.save#1', 'Method:A.kt:UserRepo.save#1'],
        note: 'nullable generic `Repo<User>?` — decoration and type arguments compose. INTERPRET-TIME PATH: cannot fail on a revert of the shared lookup.',
      },
    ],
  },
  {
    name: 'java-wildcard-and-raw-generic',
    file: 'A.java',
    source: `
class User {}
interface Repo<T> { void save(T x); }
class UserRepo implements Repo<User> { public void save(User x) {} }
class Svc {
  private Repo<? extends User> wild;
  private Repo raw;
  void runWildcard(User u) { this.wild.save(u); }
  void runRaw(User u) { this.raw.save(u); }
}
`,
    rows: [
      {
        caller: 'runWildcard',
        targets: ['Method:A.java:Repo.save#1', 'Method:A.java:UserRepo.save#1'],
        note: 'bounded wildcard `Repo<? extends User>` names the same declaration. INTERPRET-TIME PATH: cannot fail on a revert of the shared lookup.',
      },
      {
        caller: 'runRaw',
        targets: ['Method:A.java:Repo.save#1', 'Method:A.java:UserRepo.save#1'],
        note: 'raw type `Repo` — the erased spelling Java itself permits. Carries no type arguments at all, so it never enters the generic path in any build.',
      },
    ],
  },
  {
    name: 'rust-nested-generic',
    file: 'a.rs',
    source: `
pub struct User {}
pub struct Repo<T> { pub item: T }
impl<T> Repo<T> { pub fn save(&self, x: &User) {} }
pub struct Svc { repo: Repo<Repo<User>> }
impl Svc { pub fn run_nested(&self, u: &User) { self.repo.save(u); } }
`,
    rows: [
      {
        caller: 'run_nested',
        targets: ['Function:a.rs:Repo.save#1'],
        note: 'nested generic `Repo<Repo<User>>` — the depth-aware scan must not stop at the inner `>`. INTERPRET-TIME PATH: cannot fail on a revert of the shared lookup.',
      },
    ],
  },
  {
    name: 'ts-multiarg-generic',
    file: 'a.ts',
    source: `
export class User {}
export class Key {}
export interface Handler<K, V> { handle(k: K, v: V): void; }
export class Svc {
  private h: Handler<Key, User>;
  constructor(h: Handler<Key, User>) { this.h = h; }
  run(k: Key, u: User): void { this.h.handle(k, u); }
}
`,
    rows: [
      {
        caller: 'run',
        targets: ['Method:a.ts:Handler.handle#2'],
        note: 'multi-argument generic `Handler<Key, User>` — the container allow-lists deliberately ignore multi-arg shapes, so this only resolves via base-name erasure. DISCRIMINATING: TypeScript is on the shared path.',
      },
    ],
  },
  {
    name: 'ts-python-nested-and-multiarg',
    file: 'a.ts',
    source: `
export class User {}
export interface Repo<T> { save(x: T): void; }
export class UserRepo implements Repo<User> { save(x: User): void {} }
export class NestSvc {
  private nested: Repo<Repo<User>>;
  constructor(n: Repo<Repo<User>>) { this.nested = n; }
  runTsNested(u: User): void { this.nested.save(u); }
}
`,
    extraFiles: {
      'a.py': `
from typing import Generic, TypeVar

T = TypeVar("T")
K = TypeVar("K")
V = TypeVar("V")

class PyUser:
    pass

class PyKey:
    pass

class PyRepo(Generic[T]):
    def save(self, x):
        pass

class PyHandler(Generic[K, V]):
    def handle(self, k, v):
        pass

class PyNestSvc:
    def __init__(self, nested: PyRepo[PyRepo[PyUser]]):
        self.nested = nested

    def run_py_nested(self, u: PyUser) -> None:
        self.nested.save(u)

class PyMultiSvc:
    def __init__(self, h: PyHandler[PyKey, PyUser]):
        self.h = h

    def run_py_multiarg(self, k: PyKey, u: PyUser) -> None:
        self.h.handle(k, u)
`,
    },
    rows: [
      {
        caller: 'runTsNested',
        targets: ['Method:a.ts:Repo.save#1', 'Method:a.ts:UserRepo.save#1'],
        note: 'DISCRIMINATING nested generic: TypeScript reaches the shared lookup, unlike the Java/Kotlin/Rust spelling rows above',
      },
      {
        caller: 'run_py_nested',
        targets: ['Method:a.py:PyRepo.save#1'],
        note: 'DISCRIMINATING nested generic in the SQUARE-bracket spelling, `PyRepo[PyRepo[PyUser]]`',
      },
      {
        caller: 'run_py_multiarg',
        targets: ['Method:a.py:PyHandler.handle#2'],
        note: 'DISCRIMINATING multi-argument generic in the square-bracket spelling, `PyHandler[PyKey, PyUser]` — the shape the container allow-lists decline',
      },
    ],
  },
  // ── Annotation-only Swift and Dart ────────────────────────────────────────
  // The `swift` and `dart` cases above give the field an initializer of the
  // SAME generic type, so they cannot separate "the annotation resolved" from
  // "the construction resolved". Here the initializer cannot be the source: the
  // Swift property is an optional with no initializer, and the Dart one is
  // `late` with no initializer. Each has a non-generic control declared exactly
  // the same way, so a failure of the DECORATION (`?`, `late`) reads
  // differently from a failure of the type argument.
  {
    name: 'annotation-only-swift-dart',
    file: 'A.swift',
    source: `
class User {}
class BoxRepo<T> { func save(x: User) {} }
class Plain { func save(x: User) {} }
class AnnSvc {
  var repo: BoxRepo<User>?
  func runSwiftAnnotationOnly(u: User) { repo?.save(x: u) }
}
class AnnControl {
  var plain: Plain?
  func runSwiftAnnotationControl(u: User) { plain?.save(x: u) }
}
`,
    extraFiles: {
      'a.dart': `
class DUser {}
class DRepo<T> { void save(DUser x) {} }
class DPlain { void save(DUser x) {} }
class DAnnSvc {
  late DRepo<DUser> repo;
  void runDartAnnotationOnly(DUser u) { this.repo.save(u); }
}
class DAnnControl {
  late DPlain plain;
  void runDartAnnotationControl(DUser u) { this.plain.save(u); }
}
`,
    },
    rows: [
      {
        caller: 'runSwiftAnnotationControl',
        targets: ['Function:A.swift:Plain.save#1'],
        note: 'control (Swift), same optional decoration and no initializer',
      },
      {
        caller: 'runDartAnnotationControl',
        targets: ['Method:a.dart:DPlain.save#1'],
        note: 'control (Dart), same `late` and no initializer',
      },
      {
        caller: 'runSwiftAnnotationOnly',
        targets: ['Function:A.swift:BoxRepo.save#1'],
        note: 'the ANNOTATION alone types the receiver — no initializer exists to be the source',
      },
      {
        caller: 'runDartAnnotationOnly',
        targets: ['Method:a.dart:DRepo.save#1'],
        note: 'the ANNOTATION alone types the receiver — `late` with no initializer',
      },
    ],
  },
  // ── How the field is REACHED ──────────────────────────────────────────────
  // Every row above declares and uses the generic field in one file, in one
  // class, off `this`. These are the other ways `typeOfMemberOnClass` gets
  // there, in one fixture repo: through an import, through the MRO, through a
  // renamed import, through the module-HOISTED type-binding branch (the second
  // `resolveClassBindingForName` call this PR switched, which TypeScript is the
  // only language to reach today), and through a static member.
  {
    name: 'ts-reach-shapes',
    file: 'repo.ts',
    source: `
export class User {}
export interface Repo<T> { save(x: T): void; }
export class UserRepo implements Repo<User> { save(x: User): void {} }
export class Plain { save(x: User): void {} }
`,
    extraFiles: {
      'base.ts': `
import { Repo, User } from './repo';
export class Base {
  protected repo: Repo<User>;
  constructor(r: Repo<User>) { this.repo = r; }
}
`,
      'derived.ts': `
import { Base } from './base';
import { User } from './repo';
export class Derived extends Base {
  runInherited(u: User): void { this.repo.save(u); }
}
`,
      'holder.ts': `
import { Repo, User, Plain } from './repo';
export class Holder {
  static repo: Repo<User>;
  static plain: Plain;
}
export class StaticSvc {
  runStatic(u: User): void { Holder.repo.save(u); }
  runStaticControl(u: User): void { Holder.plain.save(u); }
}
`,
      'aliased.ts': `
import { Repo as R, User } from './repo';
export class AliasSvc {
  private r: R<User>;
  constructor(r: R<User>) { this.r = r; }
  runAliased(u: User): void { this.r.save(u); }
}
`,
      'hoist.ts': `
import { Repo, User } from './repo';
export class HoistSvc {
  private inner: Repo<User>;
  constructor(i: Repo<User>) { this.inner = i; }
  getRepo(): Repo<User> { return this.inner; }
  runHoisted(u: User): void { this.getRepo().save(u); }
}
`,
      'crossfile.ts': `
import { Repo, User } from './repo';
export class CrossSvc {
  private repo: Repo<User>;
  constructor(r: Repo<User>) { this.repo = r; }
  runCrossFile(u: User): void { this.repo.save(u); }
}
`,
    },
    rows: [
      {
        caller: 'runCrossFile',
        targets: ['Method:repo.ts:Repo.save#1', 'Method:repo.ts:UserRepo.save#1'],
        note: 'CROSS-FILE: the generic type is declared and imported from another file. Every other #2833 row is single-file.',
      },
      {
        caller: 'runInherited',
        targets: ['Method:repo.ts:Repo.save#1', 'Method:repo.ts:UserRepo.save#1'],
        note: 'INHERITANCE: the field is declared on the BASE class, so `typeOfMemberOnClass` finds it by walking the MRO — a different owner scope than the one the call is written in',
      },
      {
        caller: 'runAliased',
        targets: ['Method:repo.ts:Repo.save#1', 'Method:repo.ts:UserRepo.save#1'],
        note: 'IMPORT ALIAS: the field is annotated `R<User>` where `R` is `Repo` renamed at import. Base-name erasure yields `R`, which must still resolve through the alias.',
      },
      {
        caller: 'runHoisted',
        targets: [
          'Method:hoist.ts:HoistSvc.getRepo#0',
          'Method:repo.ts:Repo.save#1',
          'Method:repo.ts:UserRepo.save#1',
        ],
        note: 'MODULE-HOIST BRANCH: `this.getRepo().save(u)` types its step off a RETURN-type binding, which TypeScript hoists out of the class body onto the module scope — the second of the two `typeOfMemberOnClass` lookups this PR switched, and the one no other row reaches. The `getRepo` edge is the call itself and is part of the expectation.',
      },
      {
        caller: 'runStaticControl',
        targets: ['Method:repo.ts:Plain.save#1'],
        note: 'the control that CLASSIFIED the gap: a NON-generic static member receiver emitted nothing either, so `Holder.repo.save(u)` was never a generics failure. Case 6 closed both at once, and this row is the half that proves it was not a generics fix.',
      },
      {
        caller: 'runStatic',
        targets: ['Method:repo.ts:Repo.save#1', 'Method:repo.ts:UserRepo.save#1'],
        note: 'STATIC/class-level member receiver: `Holder.repo.save(u)` resolves, with the interface-dispatch fan-out every other reach shape in this fixture gets. A per-scope `typeBindings` map cannot hold both `repo` and `static repo` for one class, so Case 6 types the receiver off the static field DEF instead. The extra target relative to the control is the fan-out, not the staticness — `Repo` is an interface and `Plain` is a class.',
      },
    ],
  },
  {
    name: 'php-typed-property',
    file: 'a.php',
    source: `<?php
class User {}
class Repo { public function save(User $x) {} }
class Plain { public function save(User $x) {} }
class GenericSvc {
    private Repo $repo;
    public function runGeneric(User $u) { $this->repo->save($u); }
}
class ControlSvc {
    private Plain $plain;
    public function runControl(User $u) { $this->plain->save($u); }
}
`,
    rows: [
      {
        caller: 'runControl',
        targets: ['Method:a.php:Plain.save#1'],
        note: 'control',
      },
      {
        caller: 'runGeneric',
        targets: ['Method:a.php:Repo.save#1'],
        note: 'PHP has no generic type syntax — `private Repo<User> $repo;` is a parse error — so a NATIVE typed property is the closest analogue and is pinned so neither the shared change nor the new docblock pass can regress it. The docblock spelling PHP actually uses for generics is a separate capture path with its own case below; this row must keep passing whatever that one does.',
      },
    ],
  },
  // ── DOCBLOCK-declared field types ─────────────────────────────────────────
  // JavaScript has no type annotations at all and PHP cannot spell a generic in
  // its own syntax, so for both languages a docblock is the ONLY way a field
  // declares one — and neither bound anything, generic or not. Both now
  // synthesize the same annotation-strength `@type-binding` the native syntax
  // emits, so no resolution-side code distinguishes them.
  {
    name: 'js-docblock-field',
    file: 'a.js',
    source: `
export class User {}
export class Repo { save(x) {} }
export class Plain { save(x) {} }
export class GenericSvc {
  /** @type {Repo<User>} */
  repo;
  runJsGeneric(u) { this.repo.save(u); }
}
export class ControlSvc {
  /** @type {Plain} */
  plain;
  runJsControl(u) { this.plain.save(u); }
}
`,
    rows: [
      {
        caller: 'runJsControl',
        targets: ['Method:a.js:Plain.save#1'],
        note: 'control, and the row that says this was never a generics gap: a NON-generic `@type {Plain}` bound nothing either before the docblock pass',
      },
      {
        caller: 'runJsGeneric',
        targets: ['Method:a.js:Repo.save#1'],
        note: '`@type {Repo<User>}` on a class field. `Repo` is an ordinary class here because JavaScript has no way to declare a generic one — the type ARGUMENT is the part that has to survive the docblock and then erase, and it does, matching the control exactly.',
      },
    ],
  },
  {
    name: 'php-docblock-property',
    file: 'a.php',
    source: `<?php
class User {}
class Repo { public function save(User $x) {} }
class Plain { public function save(User $x) {} }
class DocSvc {
    /** @var Repo<User> */
    private $repo;
    /** @var Plain */
    private $plain;
    /** @var Repo[] */
    private $many;
    /** @var list<User> */
    private $listed;
    /** @var Repo|Plain */
    private $united;
    public function runPhpDocGeneric(User $u) { $this->repo->save($u); }
    public function runPhpDocControl(User $u) { $this->plain->save($u); }
    public function runPhpDocArray(User $u) { $this->many->save($u); }
    public function runPhpDocList(User $u) { $this->listed->save($u); }
    public function runPhpDocUnion(User $u) { $this->united->save($u); }
}
`,
    rows: [
      {
        caller: 'runPhpDocControl',
        targets: ['Method:a.php:Plain.save#1'],
        note: 'control: a NON-generic `@var Plain` on an untyped property bound nothing either, which is what makes the row below a docblock gap rather than a generics one',
      },
      {
        caller: 'runPhpDocGeneric',
        targets: ['Method:a.php:Repo.save#1'],
        note: '`@var Repo<User>` — the only spelling PHP has for a generic field, and the reason the arguments are erased in the PHP capture rather than left to the shared lookup: `normalizePhpType` reduces `X<Y>` to `Y` for the foreach/element convention, so passing the spelling through bound the field to `User` and emitted `User::save`. A WRONG edge, so the erasure happens before that rule can read it.',
      },
      {
        caller: 'runPhpDocArray',
        targets: [],
        note: 'DECLINE, pinned: `@var Repo[]` types an ARRAY. Binding it to `Repo` would claim `$this->many->find(...)` for a repository class, so the array spelling emits no field binding at all — `extractPropertyElementType` reads the same annotation for `foreach`, and the two readings must not collide.',
      },
      {
        caller: 'runPhpDocList',
        targets: [],
        note: 'DECLINE, pinned: `@var list<User>` erases to `list`, which PHP has no type for — so the only class it could ever bind is a workspace class that happens to be called `list`, i.e. exactly the wrong-edge direction. Compared case-folded rather than by listing spellings.',
      },
      {
        caller: 'runPhpDocUnion',
        targets: [],
        note: 'DECLINE, pinned, and NOT by a rule of the docblock pass: `Repo|Plain` reaches the same `normalizePhpType` a native `private Repo|Plain $x;` goes through and is rejected there. The row is here because "delegated" is a claim about behaviour, and this is the measurement of it.',
      },
    ],
  },
  // ── Class-level (static) member receivers ─────────────────────────────────
  // `ts-reach-shapes` pins the TypeScript spelling among its other reach
  // shapes. Kotlin reaches the same Case 6 by a different syntax — a
  // `companion object` rather than a `static` modifier — and was equally broken
  // for its non-generic control, so it gets its own case rather than a row.
  {
    name: 'kotlin-companion-static-member',
    file: 'A.kt',
    source: `
class User
interface Repo<T> { fun save(x: T) }
class UserRepo : Repo<User> { override fun save(x: User) {} }
interface Plain { fun save(x: User) }
class PlainRepo : Plain { override fun save(x: User) {} }
class Holder {
  companion object {
    lateinit var repo: Repo<User>
    lateinit var plain: Plain
  }
}
class StaticSvc {
  fun runKtStatic(u: User) { Holder.repo.save(u) }
  fun runKtStaticControl(u: User) { Holder.plain.save(u) }
}
`,
    rows: [
      {
        caller: 'runKtStaticControl',
        targets: ['Method:A.kt:Plain.save#1', 'Method:A.kt:PlainRepo.save#1'],
        note: 'control: a NON-generic companion member, emitting nothing before Case 6. Both members here are interface-typed so the pair is count-comparable, unlike the TypeScript one.',
      },
      {
        caller: 'runKtStatic',
        targets: ['Method:A.kt:Repo.save#1', 'Method:A.kt:UserRepo.save#1'],
        note: '`Holder.repo.save(u)` through a `companion object` member matches its control exactly, fan-out included. Kotlin erases type arguments at interpret time, so this row is about the class-level RECEIVER and nothing else — which is the point: the gap was never about generics in any language that reached it.',
      },
    ],
  },
  // ── Erased base names must be GROUNDED ────────────────────────────────────
  // Reaching a declaration by name alone binds whatever the workspace declares
  // under that name. Python is where this bites hardest — it reduces
  // `Mapped[User]` to `Mapped` at capture time, so every such receiver arrives
  // as a bare class name with nothing to distinguish it from one — and
  // `sqlalchemy.orm.Mapped` beside a workspace `class Mapped` is not a
  // hypothetical collision.
  {
    name: 'py-erased-grounding',
    file: 'a.py',
    source: `
from models import User
from sqlalchemy.orm import Mapped

class Local:
    def ping(self, u):
        pass

def run_param(m: Mapped[User], u: User) -> None:
    m.save(u)

def run_local_control(l: Local, u: User) -> None:
    l.ping(u)

def run_head_chain(m: Mapped[User], u: User) -> None:
    m.inner.ping()

class InferredSvc:
    def __init__(self, m: Mapped[User]):
        self.m = m

    def run_inferred_field(self, u: User) -> None:
        self.m.save(u)

class AnnotatedSvc:
    m: Mapped[User]

    def run_annotated_field(self, u: User) -> None:
        self.m.save(u)
`,
    extraFiles: {
      'models.py': `
class User:
    def touch(self):
        pass
`,
      'other.py': `
class Inner:
    def ping(self):
        pass

class Mapped:
    inner: Inner

    def save(self, x):
        pass
`,
      'b.py': `
class BUser:
    pass

def run_no_import_channel(m: Mapped[BUser], u: BUser) -> None:
    m.save(u)
`,
    },
    rows: [
      {
        caller: 'run_local_control',
        targets: ['Method:a.py:Local.ping#1'],
        note: 'ANTI-VACUITY CONTROL: an ordinary same-file parameter receiver in the same module as the refusal below. Without it the empty row would also be what a file that stopped parsing produces.',
      },
      {
        caller: 'run_head_chain',
        targets: ['Method:other.py:Inner.ping#0'],
        note: 'REMAINING WRONG EDGE, pinned at its measured value so closing it is a visible flip. `m.inner.ping()` binds the unrelated workspace `Mapped` through a route that survives the refusal, while the one-segment-shallower `m.save(u)` (`run_param`, above) correctly declines — same receiver, same declared type, one more segment. The obvious one-line guard in the bare-identifier branch (decline every retry once an erased application failed to ground) was tried and MEASURED not to close it, so the surviving route is elsewhere and this needs its own diagnosis rather than a guess. Deliberately not fixed here: a broader refusal would change chain-head resolution for every language without pinning the shape it is meant to fix.',
      },
      {
        caller: 'run_param',
        targets: [],
        note: 'THE REFUSAL: `Mapped[User]` no longer binds the unrelated workspace `class Mapped` in `other.py` (measured as `Method:other.py:Mapped.save#1` before). The erased base name is admitted only on a ground that connects this site to that declaration, and none holds — the name is imported from a module the workspace does not contain, `other.py` is a different file, and the index knows no `Mapped` template family.',
      },
      {
        caller: 'run_no_import_channel',
        targets: ['Method:other.py:Mapped.save#1'],
        note: 'THE GROUND THAT ADMITS, pinned so the refusal above cannot be read as "erased names never resolve": `b.py` imports nothing at all, so its failure to import `Mapped` is no evidence of anything, and the workspace-wide index answers. Identical spelling to `run_param`, opposite answer, and the file\'s import channel is the only difference.',
      },
      {
        caller: 'run_inferred_field',
        targets: [],
        note: 'THE FIELD-SIDE REFUSAL, and the row that says the grounding is no longer PARAMETER-side only: `self.m.save(u)` on a field inferred from the constructor parameter now declines exactly as `run_param` does. The wrong edge was never a defect in the grounding — the structural fold applied it and refused correctly — it was that a declined fold falls THROUGH to the text cascade by design, and the cascade held its own ungrounded copy of the member-typing lookup that re-minted the refused target from the workspace index. Both routes now ask through one lookup.',
      },
      {
        caller: 'run_annotated_field',
        targets: [],
        note: 'THE SAME REFUSAL FROM AN EXPLICIT ANNOTATION, which is what proves the fix is not about the binding SOURCE: a class-level `m: Mapped[User]` and a constructor-inferred `self.m` reach the identical answer, as they always did — both wrong before, both empty now. The receiver spelling was never the discriminator either; the two spellings simply entered different lookups, and only one of them was grounded.',
      },
    ],
  },
  // The mirrors. A grounding rule is only as good as what it still admits, and
  // these are the four shapes that would break if it were tightened: two Python
  // channels (same-file and imported), a C++ `#include` — which materializes no
  // lexical binding whatever, so the index is its only channel — and a C#
  // cross-namespace reference with no `using`.
  {
    name: 'py-generic-grounding-mirrors',
    file: 'a.py',
    source: `
from typing import Generic, TypeVar
from repo import CrossRepo

T = TypeVar("T")

class User:
    pass

class SameRepo(Generic[T]):
    def save(self, x):
        pass

def run_same_file(r: SameRepo[User], u: User) -> None:
    r.save(u)

def run_imported(r: CrossRepo[User], u: User) -> None:
    r.save(u)
`,
    extraFiles: {
      'repo.py': `
from typing import Generic, TypeVar

T = TypeVar("T")

class CrossRepo(Generic[T]):
    def save(self, x):
        pass
`,
    },
    rows: [
      {
        caller: 'run_same_file',
        targets: ['Method:a.py:SameRepo.save#1'],
        note: 'MIRROR: a genuine same-file `SameRepo[User]` still resolves — the declaration is in the file the site is in, which is a ground on its own',
      },
      {
        caller: 'run_imported',
        targets: ['Method:repo.py:CrossRepo.save#1'],
        note: 'MIRROR: a genuine imported `CrossRepo[User]` still resolves — the import binds the name in the scope chain, the strongest ground. The two classes are named differently on purpose so neither can answer for the other.',
      },
    ],
  },
  {
    name: 'cpp-csharp-index-channel',
    file: 'a.cpp',
    source: `
#include "repo.h"
void runCppIncluded(User u) { Repo<User> r; r.save(u); }
`,
    extraFiles: {
      'repo.h': `
class User {};
template <class T> struct Repo { void save(T x) {} };
`,
      'Repo.cs': `
namespace Data {
  class Repo<T> { public void Save(T x) {} }
}
`,
      'A.cs': `
namespace App {
  class User {}
  class Svc {
    public void RunCsNoUsing(User u) { Repo<User> r = null; r.Save(u); }
  }
}
`,
    },
    rows: [
      {
        caller: 'runCppIncluded',
        targets: ['Method:repo.h:Repo.save#1~c:132qlr3'],
        note: 'MIRROR: a C++ `#include` binds no name lexically — it is a textual include, not an import — so the workspace-wide index is the ONLY channel this site has. A grounding rule that required a lexical binding would delete this edge for every C++ program.',
      },
      {
        caller: 'RunCsNoUsing',
        targets: ['Method:Repo.cs:Repo.Save#1'],
        note: "MIRROR: C# resolves `Data.Repo<T>` from `App` with no `using` at all, which is how C# actually behaves. Same shape as the C++ row and a second language, so the ground that admits them is not one language's quirk.",
      },
    ],
  },
  // ── C++ qualified fields that are not generic at all ──────────────────────
  // The qualified rules were written for `std::vector<Item>`, but the node they
  // match is the outer `qualified_identifier` — which is also what wraps a
  // PLAIN `ns::Address`. So the same three rules closed a much larger miss
  // than the generic one, and the rows below are that half.
  {
    name: 'cpp-qualified-non-generic-field',
    file: 'a.cpp',
    source: `
struct User {};
struct Other { void ping() {} };
struct Plain { void save(User x) {} };
namespace std {
struct string { void size() {} };
}
namespace ns {
struct Address { void city() {} };
}
struct Svc {
  std::string name;
  ns::Address addr;
  ns::Address* paddr;
  std::mutex mu;
  Plain plain;
  void runQualStdString() { name.size(); }
  void runQualNsStruct() { addr.city(); }
  void runQualNsPtr() { paddr->city(); }
  void runQualAbsent() { mu.ping(); }
  void runQualNonGenericControl(User u) { plain.save(u); }
};
`,
    rows: [
      {
        caller: 'runQualNonGenericControl',
        targets: ['Method:a.cpp:Plain.save#1'],
        note: 'control: unqualified, non-generic field in the same struct',
      },
      {
        caller: 'runQualStdString',
        targets: ['Method:a.cpp:string.size#0'],
        note: 'INTENDED, and the same accepted policy as `container-name-collision`, stated in C++: the qualifier is dropped and the tail `string` names a class this workspace really declares, so it binds. The annotation names `string`, so naming `string` is the right answer — a resolver that refused it would have to know which names are "someone else\'s", and this pipeline deliberately does not. Where the workspace does NOT declare the tail, the binding is simply absent (`runQualAbsent`), so the policy closes misses without minting edges.',
      },
      {
        caller: 'runQualNsStruct',
        targets: ['Method:a.cpp:Address.city#0'],
        note: 'a plain `ns::Address addr;` — no template arguments anywhere. This member had no type binding at all before the qualified rules, which is why the fix is not describable as a generics fix.',
      },
      {
        caller: 'runQualNsPtr',
        targets: ['Method:a.cpp:Address.city#0'],
        note: 'the `pointer_declarator` shape of the same thing, reached through `->`',
      },
      {
        caller: 'runQualAbsent',
        targets: [],
        note: 'THE OTHER HALF OF THE POLICY, pinned: `std::mutex mu;` reduces to `mutex`, which this workspace declares nowhere, so the field binds nothing and the call emits nothing. `struct Other` declares a `ping()` and does NOT receive the edge — dropping the qualifier widens what can MATCH, it does not invent a match.',
      },
    ],
  },
  // ── C++ `this->field.m()` ─────────────────────────────────────────────────
  // A `this`-head seed gap, not a generics one: the fold reads `this` out of a
  // per-function-scope typeBinding, and C++ deliberately synthesizes none
  // because it declares `this` to BE the enclosing class
  // (`resolveThisViaEnclosingClass`). So every `this->x.m()` chain folded to
  // nothing, for a generic member and a plain one alike.
  {
    name: 'cpp-this-head-field',
    file: 'a.cpp',
    source: `
struct User {};
template <class T> struct Repo { void save(User x) {} };
struct Plain { void save(User x) {} };
struct Svc {
  Repo<User> repo;
  Plain plain;
  void runThisGeneric(User u) { this->repo.save(u); }
  void runThisControl(User u) { this->plain.save(u); }
  void runBareGeneric(User u) { repo.save(u); }
  void runBareControl(User u) { plain.save(u); }
};
`,
    rows: [
      {
        caller: 'runBareControl',
        targets: ['Method:a.cpp:Plain.save#1'],
        note: 'BARE-RECEIVER CONTROL, non-generic: the spelling that always worked, so the two `this->` rows can be read as a statement about the HEAD and not about the member',
      },
      {
        caller: 'runBareGeneric',
        targets: ['Method:a.cpp:Repo.save#1~c:16619u1'],
        note: 'BARE-RECEIVER CONTROL, generic: same member as `runThisGeneric`, same target, different receiver spelling',
      },
      {
        caller: 'runThisControl',
        targets: ['Method:a.cpp:Plain.save#1'],
        note: 'THE CLASSIFYING ROW: `this->plain.save(u)` names no generic anywhere and emitted nothing either. Fixing it required seeding the chain head from the enclosing class for languages that declare `this` that way — the same provider flag Case 0.5 already used for a BARE `this` receiver.',
      },
      {
        caller: 'runThisGeneric',
        targets: ['Method:a.cpp:Repo.save#1~c:16619u1'],
        note: '`this->repo.save(u)` now matches both its non-generic sibling and its bare-receiver twin, which is the definition of fixed for this file',
      },
    ],
  },
  // ── Go: substitution, not erasure ─────────────────────────────────────────
  // The `go` case above pins the fan-out an instantiation SHOULD produce. This
  // one pins that it is positional: an implementor whose method takes the wrong
  // type argument is not an implementor of that instantiation.
  {
    name: 'go-instantiation-mismatch',
    file: 'a.go',
    source: `package main

type User struct{}

type Order struct{}

type Repo[T any] interface{ Save(x T) }

type UserRepo struct{}

func (r UserRepo) Save(x User) {}

type Plain interface{ Ping() }

type Pinger struct{}

func (p Pinger) Ping() {}

type GenericSvc struct{ repo Repo[Order] }

func (s GenericSvc) RunOrderRepo(o Order) { s.repo.Save(o) }

type ControlSvc struct{ plain Plain }

func (s ControlSvc) RunPlainControl() { s.plain.Ping() }
`,
    rows: [
      {
        caller: 'RunPlainControl',
        targets: ['Method:a.go:Pinger.Ping#0', 'Method:a.go:Plain.Ping#0'],
        note: 'ANTI-VACUITY CONTROL: an ordinary non-generic interface field in the same file DOES fan out to its implementor, so the single target below is a refusal and not a dead fixture',
      },
      {
        caller: 'RunOrderRepo',
        targets: ['Method:a.go:Repo.Save#1'],
        note: 'NEGATIVE: `Repo[Order]` substitutes to `interface{ Save(x Order) }`, which `UserRepo.Save(x User)` does not satisfy — so the declaration is the only target and there is no fan-out. `Repo[Order]` is the ONLY instantiation written in this repo, deliberately: GitNexus holds one node per generic DECLARATION, so a repo that also wrote `Repo[User]` would union both method sets onto it and this row could not distinguish substitution from erasure.',
      },
    ],
  },
];

describe('generic-typed field receivers across languages (#2833)', () => {
  const results = new Map<string, PipelineResult>();

  beforeAll(async () => {
    for (const testCase of CASES) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gn-2833-${testCase.name}-`));
      writeFixtureRepo(dir, { [testCase.file]: testCase.source, ...(testCase.extraFiles ?? {}) });
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

  /** Every CALLS target id emitted by the one node named `caller`, sorted and
   *  WITH multiplicity. Row assertions use the deduplicated view below; the
   *  duplicate sweep at the bottom of this file is the only reader of this one,
   *  and exists so that deduplicating cannot hide a double-emit regression. */
  function rawCallTargets(name: string, caller: string): string[] {
    const ids = new Set(callerIds(name, caller));
    return getRelationships(resultFor(name), 'CALLS')
      .filter((edge) => ids.has(edge.rel.sourceId))
      .map((edge) => edge.rel.targetId)
      .sort();
  }

  /** Distinct CALLS target ids emitted by the one node named `caller`, sorted.
   *  Edge MULTIPLICITY is a different question from whether the receiver typed
   *  at all, and every row here asks the second one. */
  function callTargets(name: string, caller: string): string[] {
    return [...new Set(rawCallTargets(name, caller))].sort();
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
  // skip it, and stated as an explicit per-pair map rather than "all true" so
  // the pinned non-matches are visible in the expectation itself. Keyed by
  // case AND generic caller, because one case can pin several pairs (the C++
  // pointer/reference forms, and the two languages of a shared fixture).
  const PAIRED = [
    { name: 'typescript', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'csharp', control: 'RunControl', generic: 'RunGeneric', matches: true },
    { name: 'cpp', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'python', control: 'run_control', generic: 'run_generic', matches: true },
    { name: 'java', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'kotlin', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'dart', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'swift', control: 'runControl', generic: 'runGeneric', matches: true },
    { name: 'rust', control: 'run_control', generic: 'run_generic', matches: true },
    // Go was EXCLUDED from this sweep while its generic field stopped at the
    // declaration and its control fanned out — an exclusion that was the
    // taxonomy quietly admitting a bug rather than describing a language.
    // Generic-interface instantiation closed it, so Go is now an ordinary row.
    { name: 'go', control: 'RunControl', generic: 'RunGeneric', matches: true },
    { name: 'js-docblock-field', control: 'runJsControl', generic: 'runJsGeneric', matches: true },
    {
      name: 'php-docblock-property',
      control: 'runPhpDocControl',
      generic: 'runPhpDocGeneric',
      matches: true,
    },
    {
      name: 'kotlin-companion-static-member',
      control: 'runKtStaticControl',
      generic: 'runKtStatic',
      matches: true,
    },
    {
      name: 'cpp-this-head-field',
      control: 'runThisControl',
      generic: 'runThisGeneric',
      matches: true,
    },
    {
      // The one pair on a different axis: QUALIFIED against UNQUALIFIED rather
      // than generic against plain. It belongs in this sweep because the rules
      // that closed the qualified generic field closed this one with it, so a
      // narrowing of them has to fail here too.
      name: 'cpp-qualified-non-generic-field',
      control: 'runQualNonGenericControl',
      generic: 'runQualNsStruct',
      matches: true,
    },
    {
      // PINNED NON-MATCH, and a DELIBERATE one: `Repo[Order]` must NOT fan out
      // to an implementor of `Save(x User)`, while the non-generic control
      // interface does fan out to its own. Substitution is positional; a match
      // here would mean erasure had crept back in (see the row notes).
      name: 'go-instantiation-mismatch',
      control: 'RunPlainControl',
      generic: 'RunOrderRepo',
      matches: false,
    },
    {
      name: 'cpp-pointer-reference-generic-field',
      control: 'runControlPtr',
      generic: 'runGenericPtr',
      matches: true,
    },
    {
      name: 'cpp-pointer-reference-generic-field',
      control: 'runControlRef',
      generic: 'runGenericRef',
      matches: true,
    },
    {
      name: 'cpp-pointer-reference-generic-field',
      control: 'runControlRef',
      generic: 'runGenericNested',
      matches: true,
    },
    {
      name: 'cpp-qualified-generic-field',
      control: 'runQualControl',
      generic: 'runQualNs',
      matches: true,
    },
    {
      name: 'cpp-qualified-generic-field',
      control: 'runQualControl',
      generic: 'runQualDeep',
      matches: true,
    },
    {
      // Was a PINNED NON-MATCH while qualifier depth 3 was uncaptured. The
      // depth-agnostic rules removed the boundary, so it is an ordinary row.
      name: 'cpp-qualified-generic-field',
      control: 'runQualControl',
      generic: 'runQualDepth3',
      matches: true,
    },
    {
      name: 'cpp-qualified-generic-field',
      control: 'runQualControl',
      generic: 'runQualDepth4',
      matches: true,
    },
    {
      name: 'csharp-partial-generic-cross-file',
      control: 'RunPartialControl',
      generic: 'RunPartial',
      matches: true,
    },
    {
      name: 'container-name-collision',
      control: 'runTsControl',
      generic: 'runTsContainer',
      matches: true,
    },
    {
      name: 'container-name-collision',
      control: 'RunCsControl',
      generic: 'RunCsContainer',
      matches: true,
    },
    {
      name: 'annotation-only-swift-dart',
      control: 'runSwiftAnnotationControl',
      generic: 'runSwiftAnnotationOnly',
      matches: true,
    },
    {
      name: 'annotation-only-swift-dart',
      control: 'runDartAnnotationControl',
      generic: 'runDartAnnotationOnly',
      matches: true,
    },
    {
      // Was a PINNED NON-MATCH while a bounded type parameter resolved to
      // nothing. It now resolves THROUGH the bound, so it matches a field of
      // that bound exactly — which is the claim the row makes.
      name: 'neg-bounded-type-parameter',
      control: 'runDirect',
      generic: 'run',
      matches: true,
    },
  ] as const;

  const pairKey = (pair: { readonly name: string; readonly generic: string }): string =>
    `${pair.name}/${pair.generic}`;

  it('each language generic field matches (or, where pinned, does not match) its own control row', () => {
    const observed = Object.fromEntries(
      PAIRED.map((p) => [
        pairKey(p),
        callTargets(p.name, p.generic).length === callTargets(p.name, p.control).length,
      ]),
    );
    expect(observed).toEqual(Object.fromEntries(PAIRED.map((p) => [pairKey(p), p.matches])));
  });

  // Every control row must emit SOMETHING. Without this, a fixture that stopped
  // parsing would make the comparison above pass by emptying both sides — the
  // exact way a matrix rots into a green lie.
  it('every control row emits at least one edge', () => {
    const observed = Object.fromEntries(
      PAIRED.map((p) => [pairKey(p), callTargets(p.name, p.control).length > 0]),
    );
    expect(observed).toEqual(Object.fromEntries(PAIRED.map((p) => [pairKey(p), true])));
  });

  // Which target a C++ instantiation lands on must be a function of the
  // arguments written, never of which declaration the file happens to write
  // first. Asserted as an EQUALITY between two independently-built fixtures
  // rather than against literals, so it states the property; the literals are
  // pinned by the four rows those fixtures already own.
  it('C++ specialization selection does not depend on declaration order', () => {
    expect({
      explicitBool: callTargets('cpp-spec-order-primary-first', 'runBool'),
      explicitInt: callTargets('cpp-spec-order-primary-first', 'runInt'),
      partial: callTargets('cpp-partial-spec-primary-first', 'runPtrArg'),
    }).toEqual({
      explicitBool: callTargets('cpp-spec-order-specialization-first', 'runBool'),
      explicitInt: callTargets('cpp-spec-order-specialization-first', 'runInt'),
      partial: callTargets('cpp-partial-spec-partial-first', 'runPtrArg'),
    });
  });

  // `callTargets` deduplicates, which is right for the question every row asks
  // and wrong as a blanket policy: a language that started emitting each CALLS
  // edge twice would go unnoticed. This is the counterweight — the number of
  // SURPLUS edges (raw minus distinct) summed over a case's rows, pinned per
  // case. Anything not listed must be exactly zero, so a new duplicate anywhere
  // fails here even though the rows themselves stay green.
  //
  // MEASURED: the map is EMPTY. The dedup was originally justified by Swift
  // emitting the same edge twice for one call site — no fixture in this file
  // reproduces that, Swift's included, so every case is pinned at zero surplus
  // rather than the dedup being excused wholesale on one language's behalf. If
  // a Swift shape that really does double-emit is added here, pin it as a
  // number on that case and leave every other case at zero.
  const SURPLUS_EDGES: Readonly<Record<string, number>> = {};

  it('no case emits a CALLS edge more than once per call site, except where pinned', () => {
    const observed = Object.fromEntries(
      CASES.map((testCase) => [
        testCase.name,
        testCase.rows.reduce(
          (surplus, row) =>
            surplus +
            rawCallTargets(testCase.name, row.caller).length -
            callTargets(testCase.name, row.caller).length,
          0,
        ),
      ]),
    );
    expect(observed).toEqual(
      Object.fromEntries(
        CASES.map((testCase) => [testCase.name, SURPLUS_EDGES[testCase.name] ?? 0]),
      ),
    );
  });
});
