/**
 * Receiver-resolution measurement harness.
 *
 * Answers one question — "how many method calls does GitNexus lose because it
 * could not establish the receiver's type, and which source shapes are they?" —
 * and answers it in a way that can gate a decision.
 *
 * TWO ARMS, because neither one alone is trustworthy:
 *
 *  1. SHAPE ARM (`--shapes`, default). A fixed matrix of receiver spellings —
 *     every SHAPE_ID against every language — each cell classified by what the
 *     graph actually contains:
 *
 *       RESOLVES       edge emitted. A test written against this shape starts
 *                      green and proves nothing. Note this states only that an
 *                      edge EXISTS — not that it points at the right target. A
 *                      name-keyed fallback onto a same-named member reads as
 *                      RESOLVES here, so a shape whose receiver has no
 *                      well-defined type is not a usable control.
 *       VISIBLE-GAP    no edge, and a `receiver-unresolved` drop was recorded.
 *                      Measurable by the count arm below.
 *       INVISIBLE-GAP  no edge, and NO drop was recorded. The call is lost and
 *                      the instrument cannot see it.
 *       N/A            the language's grammar does not admit this spelling.
 *                      Carries a REQUIRED reason — an omitted cell and a
 *                      genuinely inapplicable one look identical in a diff
 *                      otherwise, and that is how coverage silently rots.
 *       GRAMMAR-       the language's parser could not be loaded, so nothing
 *       UNAVAILABLE    about it was measured. Neither passes nor fails the
 *                      gate. Dart, Kotlin and Swift are vendored OPTIONAL
 *                      grammars: they are skipped entirely by
 *                      GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1, and they soft-fail
 *                      when no vendored prebuild matches the host (the set
 *                      covers darwin/linux arm64+x64 and win32-arm64 — a
 *                      win32-x64 or musl host has none). Without this state an
 *                      unloaded grammar emits no edges and every one of its
 *                      cells reads as a resolution gap indistinguishable from a
 *                      real regression.
 *                      NOTE: all 14 load on a glibc linux-x64 host, so this
 *                      state has no producer in the committed baseline. It
 *                      guards the skip-flag and unsupported-host cases.
 *
 *     INVISIBLE-GAP is why this arm exists. Case 0's recorder is reached only
 *     when the receiver text contains `.` or `(` AND the capture layer produced
 *     a reference site at all. Measured on this corpus, `svc?.getUser().save()`,
 *     `svc.getTyped<User>().save()` and `repos[0].save()` are all INVISIBLE —
 *     so fixing them moves the count arm by exactly zero. Gating solely on a
 *     drop count would read a working fix as "no improvement".
 *
 *     COMPLETENESS IS ENFORCED: every language must declare a cell for every
 *     SHAPE_ID, and every N/A must carry a reason. A missing cell fails the run
 *     rather than being silently skipped.
 *
 *  2. COUNT ARM (`--corpus <repoPath>`). Runs the real pipeline over a repo and
 *     reports drops SPLIT BY SITE KIND. The gate number is `call` only: the
 *     recorder's gate tests the receiver's punctuation, not the site's kind, so
 *     property reads (`d.source.kind`) and writes (`x.argtypes = [...]`) land in
 *     the same bucket as lost method calls and would inflate it.
 *
 * KNOWN BLIND SPOTS — reported in every run, deliberately, because the number
 * is a lower bound on a KNOWN-BIASED population and any delta measured later
 * must be read against the same bias:
 *
 *   - Case 0's gate is a C-family punctuation test, so PHP `$this->repo->save()`
 *     and `::` receivers never record a drop.
 *   - `repos[0].save()` has neither `.` nor `(` in its receiver, same result.
 *   - `?.` and explicit type arguments produce no reference site to begin with.
 *
 * MEASUREMENT HYGIENE — a run that skips this is void:
 *
 *   npm run build                       # the parse worker runs from dist/
 *   rm -rf .gitnexus/parse-cache .gitnexus/parsedfile-cache
 *   node --import tsx bench/receiver-resolution/measure.mjs --corpus <repo>
 *
 * `analyze --force` clears NEITHER cache, so a stale shard will happily serve
 * the previous capture set and produce a confident, wrong number.
 *
 * Usage:
 *   node --import tsx bench/receiver-resolution/measure.mjs
 *   node --import tsx bench/receiver-resolution/measure.mjs --corpus /path/to/repo
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.ts';
import { emitTsScopeCaptures } from '../../src/core/ingestion/languages/typescript/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.resolve(__dirname, 'baseline.json');
/** The `--check` corpus. Committed and multi-language, so the gate is
 *  deterministic and does not depend on anything outside the repo. */
const DEFAULT_CORPUS = path.resolve(__dirname, '..', '..', 'test', 'fixtures', 'lang-resolution');

// ---------------------------------------------------------------------------
// Shape corpus
// ---------------------------------------------------------------------------

/**
 * The canonical shape axis. Every language corpus must declare a cell for every
 * id here — a body to measure, or `na` with a reason. `assertMatrixComplete`
 * enforces it, so adding a shape forces every language to answer for it.
 */
const SHAPE_IDS = [
  'plainChain',
  'plainDeepChain',
  'optionalChain',
  'nonNullAssert',
  'awaitParen',
  'explicitTypeArgs',
  'indexElement',
  'fieldReceiverCall',
  'decoratedReceiverBase',
  'decoratedFieldType',
];

/**
 * Languages that carry no receiver-chain emission at all, recorded as
 * language-level rows so the language axis obeys the same no-omitted-cells rule
 * as the shape axis. Their capture emitters do not call
 * `synthesizeReceiverChainCapture`, so there is nothing to measure — but an
 * absent row and an inapplicable row must not look alike in a diff.
 */
const NA_LANGUAGES = {
  vue: 'SFC templates delegate to the TypeScript/JavaScript emitters; no receiver chain is minted for the .vue file itself.',
  cobol: 'No method-call receiver syntax; the emitter mints no receiver chains.',
};

/**
 * Each entry is one receiver spelling. `entry` is the function that contains
 * it; `member` is the method it should reach. Classification asks only two
 * questions of the result — is there a CALLS edge from `entry` to `member`,
 * and was a drop recorded on that line — so it never guesses from an id shape.
 *
 * An entry with `na` declares the shape inapplicable to this language and is
 * never compiled into the fixture.
 */
const CORPORA = [
  {
    lang: 'typescript',
    ext: '.ts',
    // `fourHopChain` exists to make MAX_CHAIN_DEPTH answerable. Without a chain
    // longer than the cap, raising the cap measures nothing and the question
    // "what does depth N buy?" has no instrument behind it.
    extraShapeIds: ['fourHopChain'],
    support: {
      'models.ts': `export class City {
  save(): void {}
}

export class Address {
  save(): void {}
  getCity(): City {
    return new City();
  }
}

export class User {
  name: string = '';
  address: Address = new Address();
  save(): void {}
}

export class Service {
  getUser(): User {
    return new User();
  }
  async getUserAsync(): Promise<User> {
    return new User();
  }
  getTyped<T>(): User {
    return new User();
  }
}
`,
    },
    header: `import { Service, User } from './models';\n`,
    wrap: (entry, body) =>
      `export async function ${entry}(svc: Service, repos: User[]): Promise<void> {\n  ${body}\n}\n`,
    shapes: [
      { id: 'plainChain', member: 'save', body: 'svc.getUser().save();', note: 'control' },
      {
        id: 'plainDeepChain',
        member: 'save',
        body: 'svc.getUser().address.save();',
        note: 'control',
      },
      { id: 'optionalChain', member: 'save', body: 'svc?.getUser().save();', note: 'PF1' },
      { id: 'nonNullAssert', member: 'save', body: 'svc!.getUser().save();', note: 'PF2' },
      {
        id: 'awaitParen',
        member: 'save',
        body: '(await svc.getUserAsync()).save();',
        note: 'PF3',
      },
      { id: 'explicitTypeArgs', member: 'save', body: 'svc.getTyped<User>().save();', note: 'PF4' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save();', note: 'PF5' },
      {
        // FOUR STEPS in the receiver of `save`: getSvc, getUser, address,
        // getCity. One more than the pre-U6 cap of 3, so the chain is DISCARDED
        // WHOLE at depth 3 and types end to end at depth 4 — the whole basis
        // for choosing the number. (An earlier version of this fixture had only
        // three steps and therefore resolved at both depths, measuring nothing.)
        id: 'fourHopChain',
        member: 'save',
        body: 'root.getSvc().getUser().address.getCity().save();',
        raw: `class Root {
  getSvc(): Service {
    return new Service();
  }
}

export function fourHopChain(root: Root): void {
  root.getSvc().getUser().address.getCity().save();
}
`,
      },
      {
        id: 'fieldReceiverCall',
        member: 'save',
        body: 'this.repo.save();',
        raw: `class TsHolder {
  repo: User = new User();
  fieldReceiverCall(): void {
    this.repo.save();
  }
}
`,
        note: 'control — undecorated field receiver',
      },
      {
        id: 'decoratedReceiverBase',
        na: 'TypeScript `this` carries no type decoration — there is no pointer/reference spelling on a method receiver.',
      },
      {
        id: 'decoratedFieldType',
        member: 'save',
        body: 'this.repo!.save();',
        raw: `class TsNullableHolder {
  repo: User | null = null;
  decoratedFieldType(): void {
    this.repo!.save();
  }
}
`,
        note: 'union-with-null field type',
      },
    ],
  },
  {
    lang: 'php',
    ext: '.php',
    // `arrowCallChain` / `arrowPropertyPath` discriminate an unannotated return
    // type from a property-path receiver — neither is expressible on the
    // canonical axis, and both are load-bearing for the PHP diagnosis.
    extraShapeIds: ['arrowCallChain', 'arrowPropertyPath'],
    support: {
      'models.php': `<?php
class Address {
    public function save() {}
}

class User {
    public Address $address;
    public function save() {}
}

class Service {
    // Deliberately UNANNOTATED. \`arrowCallChain\` measures this one, and the
    // missing return type is the suspected cause of its gap — annotating it
    // here would erase the signal instead of explaining it.
    public function getUser() {
        return new User();
    }

    // The annotated twin. \`plainChain\` measures this one, so the two cells
    // together discriminate "PHP cannot chain" from "PHP cannot infer an
    // unannotated return type".
    public function getUserTyped(): User {
        return new User();
    }
}
`,
    },
    header: `<?php\nrequire_once 'models.php';\n`,
    // TYPED parameter. An untyped `$svc` has no type binding to resolve the
    // chain's base against, which would make this row report a language gap
    // that is really a fixture defect. `$repos` is typed as an array for the
    // subscript row for the same reason.
    wrap: (entry, body) => `function ${entry}(Service $svc, array $repos) {\n    ${body}\n}\n`,
    shapes: [
      {
        id: 'arrowCallChain',
        member: 'save',
        body: '$svc->getUser()->save();',
        note: 'PF6 — recorded, because the receiver text contains `(`',
      },
      {
        // The discriminating control for KTD6 defect 2. This receiver
        // (`$this->repo`) contains neither `.` nor `(`, so Case 0's gate never
        // fires and the drop is never recorded — while the call chain above IS
        // recorded. "PHP records no drops" is too coarse: it is the
        // property-path receiver that is invisible, not the language.
        id: 'arrowPropertyPath',
        member: 'save',
        body: '$this->repo->save();',
        raw: `class Holder {
    public User $repo;
    public function arrowPropertyPath() {
        $this->repo->save();
    }
}
`,
        note: 'PF6-control — property-path receiver, no `.` and no `(`',
      },
      {
        id: 'plainChain',
        member: 'save',
        body: '$svc->getUserTyped()->save();',
        note: 'discriminator for arrowCallChain — same chain, ANNOTATED return type',
      },
      {
        id: 'plainDeepChain',
        member: 'save',
        body: '$svc->getUser()->address->save();',
        note: 'deep arrow chain',
      },
      { id: 'optionalChain', member: 'save', body: '$svc?->getUser()->save();', note: 'nullsafe' },
      {
        id: 'nonNullAssert',
        na: 'PHP has no non-null assertion operator.',
      },
      { id: 'awaitParen', na: 'PHP has no await expression in the core language.' },
      {
        id: 'explicitTypeArgs',
        na: 'PHP has no generic type-argument syntax at a call site.',
      },
      { id: 'indexElement', member: 'save', body: '$repos[0]->save();', note: 'array subscript' },
      {
        id: 'fieldReceiverCall',
        na: 'Covered by `arrowPropertyPath` above — the same undecorated field-receiver shape.',
      },
      {
        id: 'decoratedReceiverBase',
        na: 'PHP `$this` carries no type decoration on a method receiver.',
      },
      {
        id: 'decoratedFieldType',
        member: 'save',
        body: '$this->repo->save();',
        raw: `class NullableHolder {
    public ?User $repo;
    public function decoratedFieldType() {
        $this->repo->save();
    }
}
`,
        note: 'nullable field type',
      },
    ],
  },
  {
    lang: 'cpp',
    ext: '.cpp',
    // `pointerArrowChain` / `valueDotChain` discriminate a `->` base from a `.`
    // base on the same chain — the pair is why PF7 was attributable to the base
    // rather than to C++ chaining in general.
    extraShapeIds: ['pointerArrowChain', 'valueDotChain'],
    support: {
      'models.h': `#pragma once

class Address {
public:
    void save();
};

class User {
public:
    Address addr;
    void save();
};

class Service {
public:
    User* getUser();
    template <typename T>
    T* getTyped();
};
`,
    },
    header: `#include "models.h"\n`,
    wrap: (entry, body) =>
      `void ${entry}(Service* svc, Service svc2, User* repos) {\n    ${body}\n}\n`,
    shapes: [
      {
        id: 'pointerArrowChain',
        member: 'save',
        body: 'svc->getUser()->save();',
        note: 'PF7 — no fixture exists today; cpp-chain-call/ uses value `.`',
      },
      {
        // The discriminating control for PF7. Same chain, same `->save()` tail,
        // but a value `.` on the BASE receiver — and it resolves. So the defect
        // is the `->` base specifically, not C++ chaining, and the existing
        // `cpp-chain-call/` fixture cannot catch it because it uses this form.
        id: 'valueDotChain',
        member: 'save',
        body: 'svc2.getUser()->save();',
        note: 'PF7-control — value `.` base resolves',
      },
      {
        id: 'plainChain',
        na: 'C++ spells a chained call through `->` or `.`; both are measured above as pointerArrowChain and valueDotChain.',
      },
      { id: 'plainDeepChain', member: 'save', body: 'svc->getUser()->addr.save();' },
      { id: 'optionalChain', na: 'C++ has no optional-chaining operator.' },
      { id: 'nonNullAssert', na: 'C++ has no non-null assertion operator.' },
      {
        id: 'awaitParen',
        na: 'co_await is a coroutine feature the emitter does not model as an async container.',
      },
      { id: 'explicitTypeArgs', member: 'save', body: 'svc->getTyped<User>()->save();' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save();' },
      {
        id: 'fieldReceiverCall',
        member: 'save',
        body: 'this->repo.save();',
        raw: `struct CppHolder {
    User repo;
    void fieldReceiverCall() {
        this->repo.save();
    }
};
`,
        note: 'control — undecorated field receiver',
      },
      {
        id: 'decoratedReceiverBase',
        na: 'C++ `this` is implicitly a pointer with no written decoration; the pointer base is measured by pointerArrowChain.',
      },
      {
        id: 'decoratedFieldType',
        member: 'save',
        body: 'this->repo->save();',
        raw: `struct CppPtrHolder {
    User* repo;
    void decoratedFieldType() {
        this->repo->save();
    }
};
`,
        note: 'pointer field type',
      },
    ],
  },
  {
    // Go is the language whose root cause this plan proves: a method with a
    // POINTER receiver binds its receiver to the literal string `*Host`, which
    // findClassBindingInScope cannot resolve. The three field-receiver rows
    // below isolate that — they vary receiver decoration and field decoration
    // independently, so a gap can be attributed to one or the other rather than
    // to "Go field receivers" as a whole.
    lang: 'go',
    ext: '.go',
    support: {
      'models.go': `package main

type Address struct{}

func (a *Address) Save() {}

type User struct {
	Address *Address
}

func (u *User) Save() {}

type Service struct{}

func (s *Service) GetUser() *User { return &User{} }

type Tgt struct{}

func (t *Tgt) PtrM() {}

func (t Tgt) ValM() {}
`,
    },
    header: `package main\n`,
    wrap: (entry, body) => `func ${entry}(svc *Service, repos []*User) {\n\t${body}\n}\n`,
    shapes: [
      { id: 'plainChain', member: 'Save', body: 'svc.GetUser().Save()', note: 'control' },
      {
        id: 'plainDeepChain',
        member: 'Save',
        body: 'svc.GetUser().Address.Save()',
        note: 'control',
      },
      { id: 'optionalChain', na: 'Go has no optional-chaining operator.' },
      { id: 'nonNullAssert', na: 'Go has no non-null assertion operator.' },
      { id: 'awaitParen', na: 'Go has no await expression; concurrency is channel-based.' },
      {
        id: 'explicitTypeArgs',
        na: 'Go methods cannot declare type parameters, so there is no call-site type-argument spelling on a method.',
      },
      { id: 'indexElement', member: 'Save', body: 'repos[0].Save()', note: 'slice subscript' },
      {
        // VALUE receiver + VALUE field. Neither side carries decoration, so this
        // is the control that isolates the two rows below.
        id: 'fieldReceiverCall',
        member: 'ValM',
        body: 'h.f.ValM()',
        raw: `type HostVV struct{ f Tgt }

func (h HostVV) fieldReceiverCall() {
	h.f.ValM()
}
`,
        note: 'control — value receiver, value field',
      },
      {
        // POINTER receiver + VALUE field. The receiver binds as `*HostPV` and
        // the class lookup misses every branch (no dot, so the dotted-tail
        // fallback never fires). THE root cause this plan fixes.
        id: 'decoratedReceiverBase',
        member: 'ValM',
        body: 'h.f.ValM()',
        raw: `type HostPV struct{ f Tgt }

func (h *HostPV) decoratedReceiverBase() {
	h.f.ValM()
}
`,
        note: 'pointer receiver, value field — isolates the BASE',
      },
      {
        // VALUE receiver + POINTER field. Go already normalizes field type
        // bindings through normalizeGoTypeName, so this resolves today and
        // proves the step lookup is NOT the defect.
        id: 'decoratedFieldType',
        member: 'PtrM',
        body: 'h.f.PtrM()',
        raw: `type HostVP struct{ f *Tgt }

func (h HostVP) decoratedFieldType() {
	h.f.PtrM()
}
`,
        note: 'value receiver, pointer field — isolates the STEP',
      },
    ],
  },
  {
    lang: 'javascript',
    ext: '.js',
    support: {
      'models.js': `export class Address {
  save() {}
}

export class User {
  constructor() {
    this.address = new Address();
  }
  save() {}
}

export class Service {
  getUser() {
    return new User();
  }
  async getUserAsync() {
    return new User();
  }
}
`,
    },
    header: `import { Service, User } from './models.js';\n`,
    wrap: (entry, body) => `export async function ${entry}(svc, repos) {\n  ${body}\n}\n`,
    shapes: [
      { id: 'plainChain', member: 'save', body: 'svc.getUser().save();' },
      { id: 'plainDeepChain', member: 'save', body: 'svc.getUser().address.save();' },
      { id: 'optionalChain', member: 'save', body: 'svc?.getUser().save();' },
      { id: 'nonNullAssert', na: 'JavaScript has no non-null assertion operator.' },
      { id: 'awaitParen', member: 'save', body: '(await svc.getUserAsync()).save();' },
      { id: 'explicitTypeArgs', na: 'JavaScript has no type-argument syntax.' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save();' },
      {
        id: 'fieldReceiverCall',
        member: 'save',
        body: 'this.repo.save();',
        raw: `class JsHolder {
  constructor() {
    this.repo = new User();
  }
  fieldReceiverCall() {
    this.repo.save();
  }
}
`,
      },
      {
        id: 'decoratedReceiverBase',
        na: 'JavaScript method receivers carry no type decoration.',
      },
      {
        id: 'decoratedFieldType',
        na: 'JavaScript fields carry no declared type, so there is no decoration to strip.',
      },
    ],
  },
  {
    lang: 'python',
    ext: '.py',
    support: {
      'models.py': `class Address:
    def save(self) -> None:
        pass


class User:
    def __init__(self) -> None:
        self.address: Address = Address()

    def save(self) -> None:
        pass


class Service:
    def get_user(self) -> User:
        return User()

    async def get_user_async(self) -> User:
        return User()
`,
    },
    header: `from typing import List, Optional\nfrom models import Address, Service, User\n`,
    wrap: (entry, body) => `def ${entry}(svc: Service, repos: List[User]) -> None:\n    ${body}\n`,
    shapes: [
      { id: 'plainChain', member: 'save', body: 'svc.get_user().save()' },
      { id: 'plainDeepChain', member: 'save', body: 'svc.get_user().address.save()' },
      { id: 'optionalChain', na: 'Python has no optional-chaining operator.' },
      { id: 'nonNullAssert', na: 'Python has no non-null assertion operator.' },
      {
        id: 'awaitParen',
        member: 'save',
        body: '(await svc.get_user_async()).save()',
        raw: `async def awaitParen(svc: Service) -> None:
    (await svc.get_user_async()).save()
`,
        note: 'annotated coroutine — the declared return type IS the awaited type',
      },
      { id: 'explicitTypeArgs', na: 'Python has no call-site type-argument syntax.' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save()' },
      {
        id: 'fieldReceiverCall',
        member: 'save',
        body: 'self.repo.save()',
        raw: `class PyHolder:
    def __init__(self) -> None:
        self.repo: User = User()

    def fieldReceiverCall(self) -> None:
        self.repo.save()
`,
      },
      { id: 'decoratedReceiverBase', na: 'Python `self` carries no type decoration.' },
      {
        id: 'decoratedFieldType',
        member: 'save',
        body: 'self.repo.save()',
        raw: `class PyOptionalHolder:
    def __init__(self) -> None:
        self.repo: Optional[User] = None

    def decoratedFieldType(self) -> None:
        self.repo.save()
`,
        note: 'Optional[...] field annotation',
      },
    ],
  },
  {
    lang: 'java',
    ext: '.java',
    support: {
      'Address.java': `public class Address {
    public void save() {}
}
`,
      'User.java': `public class User {
    public Address address;
    public void save() {}
}
`,
      'Service.java': `import java.util.List;

public class Service {
    public User getUser() { return new User(); }
    public <T> User getTyped() { return new User(); }
}
`,
    },
    header: `import java.util.List;\n`,
    // Java has no free functions, so each shape gets its own wrapper class. The
    // METHOD is named for the shape, which is what classification matches on.
    wrap: (entry, body) =>
      `class Cap_${entry} {\n    void ${entry}(Service svc, User[] repos) {\n        ${body}\n    }\n}\n`,
    shapes: [
      { id: 'plainChain', member: 'save', body: 'svc.getUser().save();' },
      { id: 'plainDeepChain', member: 'save', body: 'svc.getUser().address.save();' },
      { id: 'optionalChain', na: 'Java has no optional-chaining operator.' },
      { id: 'nonNullAssert', na: 'Java has no non-null assertion operator.' },
      { id: 'awaitParen', na: 'Java has no await expression in the core language.' },
      { id: 'explicitTypeArgs', member: 'save', body: 'svc.<User>getTyped().save();' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save();' },
      {
        id: 'fieldReceiverCall',
        member: 'save',
        body: 'this.repo.save();',
        raw: `class JavaHolder {
    User repo;
    void fieldReceiverCall() {
        this.repo.save();
    }
}
`,
      },
      { id: 'decoratedReceiverBase', na: 'Java `this` carries no type decoration.' },
      {
        id: 'decoratedFieldType',
        na: "Java's only field-type decorations are containers (arrays, generics), which change the member set and are measured by indexElement rather than by a type-preserving strip.",
      },
    ],
  },
  {
    lang: 'csharp',
    ext: '.cs',
    support: {
      'Models.cs': `using System.Threading.Tasks;

public class Address {
    public void Save() {}
}

public class User {
    public Address Address;
    public void Save() {}
}

public class Service {
    public User GetUser() { return new User(); }
    public async Task<User> GetUserAsync() { return new User(); }
    public User GetTyped<T>() { return new User(); }
}
`,
    },
    header: `using System.Threading.Tasks;\n`,
    wrap: (entry, body) =>
      `class Cap_${entry} {\n    async Task ${entry}(Service svc, User[] repos) {\n        ${body}\n    }\n}\n`,
    shapes: [
      { id: 'plainChain', member: 'Save', body: 'svc.GetUser().Save();' },
      { id: 'plainDeepChain', member: 'Save', body: 'svc.GetUser().Address.Save();' },
      { id: 'optionalChain', member: 'Save', body: 'svc?.GetUser().Save();' },
      { id: 'nonNullAssert', member: 'Save', body: 'svc!.GetUser().Save();' },
      { id: 'awaitParen', member: 'Save', body: '(await svc.GetUserAsync()).Save();' },
      { id: 'explicitTypeArgs', member: 'Save', body: 'svc.GetTyped<User>().Save();' },
      { id: 'indexElement', member: 'Save', body: 'repos[0].Save();' },
      {
        id: 'fieldReceiverCall',
        member: 'Save',
        body: 'this.repo.Save();',
        raw: `class CsHolder {
    User repo;
    void fieldReceiverCall() {
        this.repo.Save();
    }
}
`,
      },
      { id: 'decoratedReceiverBase', na: 'C# `this` carries no type decoration.' },
      {
        id: 'decoratedFieldType',
        member: 'Save',
        body: 'this.repo.Save();',
        raw: `class CsNullableHolder {
    User? repo;
    void decoratedFieldType() {
        this.repo.Save();
    }
}
`,
        note: 'nullable reference-type field',
      },
    ],
  },
  {
    lang: 'ruby',
    ext: '.rb',
    support: {
      'models.rb': `class Address
  def save; end
end

class User
  attr_reader :address
  def initialize
    @address = Address.new
  end
  def save; end
end

class Service
  def get_user
    User.new
  end
end
`,
    },
    header: `require_relative 'models'\n`,
    wrap: (entry, body) => `def ${entry}(svc, repos)\n  ${body}\nend\n`,
    shapes: [
      { id: 'plainChain', member: 'save', body: 'svc.get_user.save' },
      { id: 'plainDeepChain', member: 'save', body: 'svc.get_user.address.save' },
      { id: 'optionalChain', member: 'save', body: 'svc&.get_user.save', note: 'safe navigation' },
      { id: 'nonNullAssert', na: 'Ruby has no non-null assertion operator.' },
      { id: 'awaitParen', na: 'Ruby has no await expression in the core language.' },
      { id: 'explicitTypeArgs', na: 'Ruby has no type-argument syntax.' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save' },
      {
        id: 'fieldReceiverCall',
        member: 'save',
        body: '@repo.save',
        raw: `class RbHolder
  def initialize
    @repo = User.new
  end

  def fieldReceiverCall
    @repo.save
  end
end
`,
      },
      { id: 'decoratedReceiverBase', na: 'Ruby method receivers carry no type decoration.' },
      {
        id: 'decoratedFieldType',
        na: 'Ruby instance variables carry no declared type, so there is no decoration to strip.',
      },
    ],
  },
  {
    lang: 'rust',
    ext: '.rs',
    support: {
      'models.rs': `pub struct Address;

impl Address {
    pub fn save(&self) {}
}

pub struct User {
    pub address: Address,
}

impl User {
    pub fn save(&self) {}
}

pub struct Service;

impl Service {
    pub fn get_user(&self) -> User {
        User { address: Address }
    }
    pub fn get_typed<T>(&self) -> User {
        User { address: Address }
    }
}
`,
    },
    header: `mod models;\nuse models::{Address, Service, User};\n`,
    wrap: (entry, body) => `fn ${entry}(svc: &Service, repos: &Vec<User>) {\n    ${body}\n}\n`,
    shapes: [
      { id: 'plainChain', member: 'save', body: 'svc.get_user().save();' },
      { id: 'plainDeepChain', member: 'save', body: 'svc.get_user().address.save();' },
      {
        id: 'optionalChain',
        na: 'Rust `?` is error propagation, not optional chaining on a receiver.',
      },
      { id: 'nonNullAssert', na: 'Rust has no non-null assertion operator.' },
      {
        id: 'awaitParen',
        na: 'Rust `async fn` declares the AWAITED type; `.await` is postfix and mints no wrapper the emitter models as an async container.',
      },
      { id: 'explicitTypeArgs', member: 'save', body: 'svc.get_typed::<User>().save();' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save();' },
      {
        id: 'fieldReceiverCall',
        member: 'save',
        body: 'self.repo.save();',
        raw: `struct RsHolder {
    repo: User,
}

impl RsHolder {
    fn fieldReceiverCall(&self) {
        self.repo.save();
    }
}
`,
      },
      {
        // Rust is the one language besides Go whose method receiver carries
        // written decoration: `&self` / `&mut self` rather than a bare `self`.
        id: 'decoratedReceiverBase',
        member: 'save',
        body: 'self.repo.save();',
        raw: `struct RsMutHolder {
    repo: User,
}

impl RsMutHolder {
    fn decoratedReceiverBase(&mut self) {
        self.repo.save();
    }
}
`,
        note: '&mut self receiver',
      },
      {
        id: 'decoratedFieldType',
        member: 'save',
        body: 'self.repo.save();',
        raw: `struct RsBoxHolder {
    repo: Box<User>,
}

impl RsBoxHolder {
    fn decoratedFieldType(&self) {
        self.repo.save();
    }
}
`,
        note: 'Box<User> — deref-transparent smart pointer',
      },
    ],
  },
  {
    lang: 'c',
    ext: '.c',
    support: {
      'models.h': `#pragma once

typedef struct Address {
    void (*save)(void);
} Address;

typedef struct User {
    Address* address;
    void (*save)(void);
} User;
`,
    },
    header: `#include "models.h"\n`,
    wrap: (entry, body) => `void ${entry}(User* u, User* repos) {\n    ${body}\n}\n`,
    // C has no method dispatch. The only receiver-shaped construct is a call
    // through a struct function-pointer field, so the chain shapes that assume a
    // method on a returned value are inapplicable rather than gaps.
    shapes: [
      {
        id: 'plainChain',
        na: 'C has no method call on a returned value; dispatch is through struct function-pointer fields only.',
      },
      { id: 'plainDeepChain', member: 'save', body: 'u->address->save();' },
      { id: 'optionalChain', na: 'C has no optional-chaining operator.' },
      { id: 'nonNullAssert', na: 'C has no non-null assertion operator.' },
      { id: 'awaitParen', na: 'C has no await expression.' },
      { id: 'explicitTypeArgs', na: 'C has no generics.' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save();' },
      { id: 'fieldReceiverCall', member: 'save', body: 'u->save();' },
      {
        id: 'decoratedReceiverBase',
        na: 'C has no method receiver, so there is no receiver decoration.',
      },
      {
        id: 'decoratedFieldType',
        na: 'A C struct field is a function pointer, not a typed receiver whose decoration could be stripped.',
      },
    ],
  },
  {
    // Kotlin, Swift and Dart are vendored OPTIONAL grammars shipping only
    // darwin-arm64 prebuilds. On any other host these rows come back
    // GRAMMAR-UNAVAILABLE and are skipped by the gate in both directions, so the
    // cells below are the contract for a host that CAN load them rather than a
    // measurement this machine produced.
    lang: 'kotlin',
    ext: '.kt',
    support: {
      'models.kt': `class Address {
    fun save() {}
}

class User {
    val address: Address = Address()
    fun save() {}
}

class Service {
    fun getUser(): User = User()
    suspend fun getUserAsync(): User = User()
    fun <T> getTyped(): User = User()
}
`,
    },
    header: '',
    wrap: (entry, body) =>
      `suspend fun ${entry}(svc: Service, repos: List<User>) {\n    ${body}\n}\n`,
    shapes: [
      { id: 'plainChain', member: 'save', body: 'svc.getUser().save()' },
      { id: 'plainDeepChain', member: 'save', body: 'svc.getUser().address.save()' },
      { id: 'optionalChain', member: 'save', body: 'svc?.getUser()?.save()' },
      { id: 'nonNullAssert', member: 'save', body: 'svc!!.getUser().save()' },
      { id: 'awaitParen', member: 'save', body: '(svc.getUserAsync()).save()' },
      { id: 'explicitTypeArgs', member: 'save', body: 'svc.getTyped<User>().save()' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save()' },
      {
        id: 'fieldReceiverCall',
        member: 'save',
        body: 'this.repo.save()',
        raw: `class KtHolder {
    val repo: User = User()
    fun fieldReceiverCall() {
        this.repo.save()
    }
}
`,
      },
      { id: 'decoratedReceiverBase', na: 'Kotlin `this` carries no type decoration.' },
      {
        id: 'decoratedFieldType',
        member: 'save',
        body: 'this.repo?.save()',
        raw: `class KtNullableHolder {
    val repo: User? = null
    fun decoratedFieldType() {
        this.repo?.save()
    }
}
`,
        note: 'nullable field type',
      },
    ],
  },
  {
    lang: 'swift',
    ext: '.swift',
    support: {
      'models.swift': `class Address {
    func save() {}
}

class User {
    var address: Address = Address()
    func save() {}
}

class Service {
    func getUser() -> User { return User() }
    func getUserAsync() async -> User { return User() }
}
`,
    },
    header: '',
    wrap: (entry, body) => `func ${entry}(svc: Service, repos: [User]) async {\n    ${body}\n}\n`,
    shapes: [
      { id: 'plainChain', member: 'save', body: 'svc.getUser().save()' },
      { id: 'plainDeepChain', member: 'save', body: 'svc.getUser().address.save()' },
      { id: 'optionalChain', member: 'save', body: 'svc.getUser().address?.save()' },
      { id: 'nonNullAssert', member: 'save', body: 'svc.getUser().address!.save()' },
      { id: 'awaitParen', member: 'save', body: '(await svc.getUserAsync()).save()' },
      {
        id: 'explicitTypeArgs',
        na: 'Swift infers generic parameters; there is no call-site type-argument spelling on a method.',
      },
      { id: 'indexElement', member: 'save', body: 'repos[0].save()' },
      {
        id: 'fieldReceiverCall',
        member: 'save',
        body: 'self.repo.save()',
        raw: `class SwHolder {
    var repo: User = User()
    func fieldReceiverCall() {
        self.repo.save()
    }
}
`,
      },
      { id: 'decoratedReceiverBase', na: 'Swift `self` carries no type decoration.' },
      {
        id: 'decoratedFieldType',
        member: 'save',
        body: 'self.repo?.save()',
        raw: `class SwOptionalHolder {
    var repo: User? = nil
    func decoratedFieldType() {
        self.repo?.save()
    }
}
`,
        note: 'optional field type',
      },
    ],
  },
  {
    lang: 'dart',
    ext: '.dart',
    support: {
      'models.dart': `class Address {
  void save() {}
}

class User {
  Address address = Address();
  void save() {}
}

class Service {
  User getUser() => User();
  Future<User> getUserAsync() async => User();
}
`,
    },
    header: `import 'models.dart';\n`,
    wrap: (entry, body) =>
      `Future<void> ${entry}(Service svc, List<User> repos) async {\n  ${body}\n}\n`,
    shapes: [
      { id: 'plainChain', member: 'save', body: 'svc.getUser().save();' },
      { id: 'plainDeepChain', member: 'save', body: 'svc.getUser().address.save();' },
      { id: 'optionalChain', member: 'save', body: 'svc.getUser().address?.save();' },
      { id: 'nonNullAssert', member: 'save', body: 'svc.getUser().address!.save();' },
      { id: 'awaitParen', member: 'save', body: '(await svc.getUserAsync()).save();' },
      { id: 'explicitTypeArgs', na: 'Dart infers generic parameters at a method call site.' },
      { id: 'indexElement', member: 'save', body: 'repos[0].save();' },
      {
        id: 'fieldReceiverCall',
        member: 'save',
        body: 'this.repo.save();',
        raw: `class DartHolder {
  User repo = User();
  void fieldReceiverCall() {
    this.repo.save();
  }
}
`,
      },
      { id: 'decoratedReceiverBase', na: 'Dart `this` carries no type decoration.' },
      {
        id: 'decoratedFieldType',
        member: 'save',
        body: 'this.repo?.save();',
        raw: `class DartNullableHolder {
  User? repo;
  void decoratedFieldType() {
    this.repo?.save();
  }
}
`,
        note: 'nullable field type',
      },
    ],
  },
];

/**
 * Every corpus declares a cell for every SHAPE_ID, every `na` carries a reason,
 * and no id is declared twice or unknown. Throws rather than warning: a matrix
 * with a hole reports as if the hole were measured, which is the exact failure
 * the N/A-with-reason rule exists to prevent.
 */
function assertMatrixComplete(corpora) {
  const problems = [];
  for (const corpus of corpora) {
    // A language may carry EXTRA cells beyond the canonical axis when they
    // discriminate something the axis cannot — PHP's annotated/unannotated
    // return-type pair, C++'s pointer/value base pair. They must be declared, so
    // an extra stays a deliberate diagnostic rather than a typo'd canonical id.
    const known = new Set([...SHAPE_IDS, ...(corpus.extraShapeIds ?? [])]);
    const seen = new Set();
    for (const shape of corpus.shapes) {
      if (!known.has(shape.id)) {
        problems.push(
          `${corpus.lang}: shape id "${shape.id}" is neither canonical nor in extraShapeIds`,
        );
      }
      if (seen.has(shape.id)) problems.push(`${corpus.lang}: duplicate shape id "${shape.id}"`);
      seen.add(shape.id);
      if (shape.na !== undefined && String(shape.na).trim() === '') {
        problems.push(`${corpus.lang}.${shape.id}: N/A with no reason`);
      }
      if (shape.na === undefined && shape.body === undefined) {
        problems.push(`${corpus.lang}.${shape.id}: neither a body nor an N/A reason`);
      }
    }
    for (const id of SHAPE_IDS) {
      if (!seen.has(id)) problems.push(`${corpus.lang}: missing cell for "${id}"`);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `[receiver-resolution] shape matrix is incomplete:\n  ${problems.join('\n  ')}`,
    );
  }
}

function classify(corpus, result) {
  const calls = [];
  for (const rel of result.graph.iterRelationships()) {
    if (rel.type !== 'CALLS') continue;
    calls.push({
      from: result.graph.getNode(rel.sourceId)?.properties.name ?? '',
      to: result.graph.getNode(rel.targetId)?.properties.name ?? '',
    });
  }
  const drops = (result.resolutionOutcomes ?? []).filter(
    (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
  );

  return corpus.shapes.map((shape) => {
    if (shape.na !== undefined) {
      return { shape: null, id: shape.id, note: shape.na, state: 'N/A', siteKind: null };
    }
    const hasEdge = calls.some((call) => call.from === shape.id && call.to === shape.member);
    // A drop belongs to this shape when it names the shape's member and sits on
    // the shape's own line — matched on the generated source, not on an id.
    const drop = drops.find(
      (candidate) => candidate.name === shape.member && candidate.shapeId === shape.id,
    );
    return {
      shape: shape.body,
      id: shape.id,
      note: shape.note,
      state: hasEdge ? 'RESOLVES' : drop ? 'VISIBLE-GAP' : 'INVISIBLE-GAP',
      siteKind: drop?.siteKind ?? null,
    };
  });
}

/** Every cell for a language whose parser could not be loaded. Neither passes
 *  nor fails the gate — an unbuilt optional grammar is a fact about the host,
 *  not a resolution result. */
function grammarUnavailableRow(corpus, reason) {
  return corpus.shapes.map((shape) => ({
    shape: shape.body ?? null,
    id: shape.id,
    note: reason,
    state: 'GRAMMAR-UNAVAILABLE',
    siteKind: null,
  }));
}

/** A parse failure caused by a missing vendored grammar, as opposed to a real
 *  pipeline error. The vendored loader throws with the grammar package name, and
 *  a language whose grammar never loaded produces a graph with no nodes at all. */
function isGrammarLoadFailure(error) {
  const text = `${error?.message ?? ''}`;
  return (
    text.includes('tree-sitter-') &&
    (text.includes('Cannot find module') ||
      text.includes('No native build') ||
      text.includes('not supported on this platform') ||
      text.includes('prebuild'))
  );
}

async function runShapeArm() {
  assertMatrixComplete(CORPORA);
  const results = [];
  for (const [lang, reason] of Object.entries(NA_LANGUAGES)) {
    results.push({
      language: lang,
      shapes: SHAPE_IDS.map((id) => ({
        shape: null,
        id,
        note: reason,
        state: 'N/A',
        siteKind: null,
      })),
    });
  }
  for (const corpus of CORPORA) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `gn-recv-${corpus.lang}-`));
    try {
      for (const [rel, content] of Object.entries(corpus.support)) {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), content, 'utf8');
      }
      // Each shape's statement gets its own line, so a recorded drop's line
      // identifies which shape produced it without matching on an id.
      const lineOfShape = new Map();
      let text = corpus.header;
      for (const shape of corpus.shapes) {
        // N/A cells are declarations about the language, not code to measure.
        if (shape.na !== undefined) continue;
        // A shape whose receiver needs surrounding structure (a class with a
        // property, say) supplies `raw`; everything else is wrapped in a plain
        // function. Either way the statement itself is `body`, and its offset
        // is found by locating it in the generated block.
        const block = shape.raw ?? corpus.wrap(shape.id, shape.body);
        const blockStartLine = text.split('\n').length;
        const offset = block.split('\n').findIndex((line) => line.includes(shape.body));
        lineOfShape.set(shape.id, blockStartLine + offset);
        text += block;
      }
      fs.writeFileSync(path.join(root, `main${corpus.ext}`), text, 'utf8');

      let result;
      try {
        result = await runPipelineFromRepo(root, () => {});
      } catch (error) {
        if (!isGrammarLoadFailure(error)) throw error;
        results.push({
          language: corpus.lang,
          shapes: grammarUnavailableRow(corpus, `parser failed to load: ${error.message}`),
        });
        continue;
      }
      // A grammar that soft-fails produces no parse and therefore no nodes.
      // Reporting that as ten resolution gaps would be indistinguishable from a
      // real regression, so it gets its own state.
      if ([...result.graph.iterNodes()].length === 0) {
        results.push({
          language: corpus.lang,
          shapes: grammarUnavailableRow(corpus, 'parser produced no nodes — grammar unavailable'),
        });
        continue;
      }
      // Attach the owning shape to each drop by line before classifying.
      for (const outcome of result.resolutionOutcomes ?? []) {
        for (const [id, line] of lineOfShape) {
          if (outcome.range?.startLine === line) outcome.shapeId = id;
        }
      }
      results.push({ language: corpus.lang, shapes: classify(corpus, result) });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Count arm
// ---------------------------------------------------------------------------

async function runCountArm(repoPath) {
  const result = await runPipelineFromRepo(repoPath, () => {});
  const drops = (result.resolutionOutcomes ?? []).filter(
    (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
  );

  const byKind = new Map();
  const byExtension = new Map();
  const callDropsByExtension = new Map();
  // Shape census over the CALL drops only, so the answer to "which kind of
  // receiver are we losing?" is not diluted by property reads and writes.
  const callDropsByShape = new Map();
  // THE number that matters now. A drop whose receiver is rooted outside the
  // indexed program (`System.out.println`, `fetch(...)`) reaches code with no
  // node to point an edge at — nothing was lost. Only `in-program` and
  // `unknown` drops represent a real resolver gap, and only those make an
  // `impact` count a lower bound. Measured on this corpus: 76 external, 20
  // in-program, 6 unknown — i.e. three quarters of the raw count was the
  // program boundary rather than uncertainty about the program.
  const callDropsByOrigin = new Map();
  const callDropsByShapeAndExt = new Map();
  for (const drop of drops) {
    const kind = drop.siteKind ?? '<<unset>>';
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    const ext = path.extname(drop.filePath);
    byExtension.set(ext, (byExtension.get(ext) ?? 0) + 1);
    if (kind === 'call') {
      callDropsByExtension.set(ext, (callDropsByExtension.get(ext) ?? 0) + 1);
      const shape = drop.receiverShape ?? '<<unclassified>>';
      callDropsByShape.set(shape, (callDropsByShape.get(shape) ?? 0) + 1);
      const origin = drop.receiverOrigin ?? '<<unclassified>>';
      callDropsByOrigin.set(origin, (callDropsByOrigin.get(origin) ?? 0) + 1);
      const pair = `${ext} ${shape}`;
      callDropsByShapeAndExt.set(pair, (callDropsByShapeAndExt.get(pair) ?? 0) + 1);
    }
  }

  const sortDesc = (map) => Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
  return {
    repo: repoPath,
    // THE gate number. Property reads and writes are excluded deliberately.
    callDrops: byKind.get('call') ?? 0,
    totalDropsAllKinds: drops.length,
    bySiteKind: sortDesc(byKind),
    callDropsByExtension: sortDesc(callDropsByExtension),
    callDropsByShape: sortDesc(callDropsByShape),
    callDropsByOrigin: sortDesc(callDropsByOrigin),
    callDropsByShapeAndExtension: sortDesc(callDropsByShapeAndExt),
    allDropsByExtension: sortDesc(byExtension),
  };
}

// ---------------------------------------------------------------------------
// Perf arm — the U7 thresholds
// ---------------------------------------------------------------------------

/**
 * Wall-clock, peak RSS, persisted chain bytes and cache-dir growth for one
 * pipeline run over a corpus.
 *
 * The A/B control is produced by reverting ONLY the fold wiring
 * (`compound-receiver.ts` + `receiver-bound-calls.ts`) to the pre-U10 commit and
 * rebuilding, so the capture emission — and therefore the persisted bytes — is
 * identical in both arms and the delta isolates the fold itself.
 */
/** Every file under `root` with one of `exts`. */
function walkFiles(root, exts) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
    }
  }
  return out;
}

async function runPerfArm(repoPath, reps) {
  const timings = [];
  let peakRss = 0;
  let chainSites = 0;
  let chainBytes = 0;
  let referenceSites = 0;

  for (let i = 0; i < reps; i++) {
    const started = process.hrtime.bigint();
    const result = await runPipelineFromRepo(repoPath, () => {});
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);

    void result;
  }

  // Persisted chain payload, counted from the emitter rather than from the
  // pipeline result: `PipelineResult` exposes no ParsedFiles, and the emitter is
  // the side that decides what gets written, so this is the authoritative count.
  for (const file of walkFiles(repoPath, ['.ts', '.tsx'])) {
    const src = fs.readFileSync(file, 'utf8');
    for (const match of emitTsScopeCaptures(src, path.relative(repoPath, file))) {
      if (match['@reference.name'] === undefined) continue;
      referenceSites++;
      const chain = match['@reference.receiver-chain'];
      if (chain === undefined) continue;
      chainSites++;
      chainBytes += Buffer.byteLength(chain.text, 'utf8');
    }
  }

  timings.sort((a, b) => a - b);
  const median = timings[Math.floor(timings.length / 2)];
  return {
    reps,
    wallClockMsMedian: +median.toFixed(1),
    wallClockMsAll: timings.map((t) => +t.toFixed(1)),
    peakRssBytes: peakRss,
    referenceSites,
    chainSites,
    chainBytes,
    bytesPerChainSite: chainSites === 0 ? 0 : +(chainBytes / chainSites).toFixed(1),
  };
}

// ---------------------------------------------------------------------------

const KNOWN_BLIND = [
  "Case 0's gate is a C-family punctuation test (`.` or `(`), so PHP `->` and `::` receivers record no drop.",
  '`repos[0].save()` has neither `.` nor `(` in its receiver — same result.',
  '`?.` and explicit type arguments produce no reference site at all, so no drop is recorded.',
  'Every count is therefore a LOWER BOUND on a known-biased population. A later delta must be read against the same bias.',
];

/**
 * The gated projection: shape states per language, plus the call-drop counts.
 * Deliberately EXACT rather than budgeted — two consecutive runs are
 * byte-identical, so a range would only hide real movement. Adding fixtures
 * moves these numbers and requires a rebaseline; that treadmill is the accepted
 * cost of the guard, the same trade the scope-capture bench already makes.
 */
/**
 * NOTE ON SCOPE: this is the GATED projection — shape states plus call-drop
 * counts. The perf arm (`--perf N`: wall-clock, RSS, bytes/site) is deliberately
 * NOT part of it: those measurements need an A/B against a control build, which
 * `--check` has no way to construct, so asserting them here would compare against
 * numbers from a different machine and fail on noise. The perf figures recorded in
 * BASELINE.md are therefore a POINT-IN-TIME MEASUREMENT, not a CI guard — do not
 * read a green `--check` as evidence that performance has not regressed.
 */
function projection(output) {
  return {
    shapeArm: Object.fromEntries(
      output.shapeArm.map((corpus) => [
        corpus.language,
        Object.fromEntries(corpus.shapes.map((shape) => [shape.id, shape.state])),
      ]),
    ),
    countArm: {
      callDrops: output.countArm.callDrops,
      totalDropsAllKinds: output.countArm.totalDropsAllKinds,
      bySiteKind: output.countArm.bySiteKind,
      callDropsByExtension: output.countArm.callDropsByExtension,
      callDropsByShape: output.countArm.callDropsByShape,
      callDropsByOrigin: output.countArm.callDropsByOrigin,
    },
  };
}

/** Every leaf whose value differs, as `dotted.path: expected -> actual`.
 *
 *  `GRAMMAR-UNAVAILABLE` is skipped on EITHER side. That state is a fact about
 *  the host, not about the code: the optional grammars are absent when a run
 *  sets `GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1` or when no vendored prebuild matches
 *  the platform, so the same commit legitimately measures those cells on one
 *  runner and cannot on another. Gating on them would fail CI for the
 *  environment it ran in rather than for a regression — the opposite of what the
 *  state was added to prevent. Skipping both directions is what makes "neither
 *  passes nor fails the gate" true. */
function drift(expected, actual, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})]);
  for (const key of keys) {
    const want = expected?.[key];
    const got = actual?.[key];
    const at = prefix === '' ? key : `${prefix}.${key}`;
    if (want === 'GRAMMAR-UNAVAILABLE' || got === 'GRAMMAR-UNAVAILABLE') continue;
    if (want !== null && typeof want === 'object') out.push(...drift(want, got ?? {}, at));
    else if (want !== got) out.push(`${at}: ${JSON.stringify(want)} -> ${JSON.stringify(got)}`);
  }
  return out;
}

const args = process.argv.slice(2);
const corpusIndex = args.indexOf('--corpus');
const check = args.includes('--check');
const corpusPath =
  corpusIndex === -1 ? (check ? DEFAULT_CORPUS : undefined) : path.resolve(args[corpusIndex + 1]);

const output = { knownBlind: KNOWN_BLIND };
if (corpusPath === undefined || check || args.includes('--shapes')) {
  output.shapeArm = await runShapeArm();
}
if (corpusPath !== undefined) {
  output.countArm = await runCountArm(corpusPath);
}
const perfIndex = args.indexOf('--perf');
if (perfIndex !== -1) {
  const reps = Number(args[perfIndex + 1] ?? '3');
  output.perfArm = await runPerfArm(corpusPath ?? DEFAULT_CORPUS, Number.isFinite(reps) ? reps : 3);
}

if (args.includes('--update-baseline')) {
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(projection(output), null, 2)}\n`, 'utf8');
  console.error(`[receiver-resolution] wrote ${BASELINE_PATH}`);
} else if (check) {
  const expected = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const diffs = drift(expected, projection(output));
  if (diffs.length > 0) {
    console.error('[receiver-resolution] FAIL — drift against the committed baseline:');
    for (const line of diffs) console.error(`  ${line}`);
    console.error(
      '\nIf this is intended (a fixture was added, or a shape genuinely changed state),' +
        '\nre-run with --update-baseline and explain the movement in the commit message.',
    );
    process.exit(1);
  }
  console.error('[receiver-resolution] OK — shape states and call-drop counts match baseline.');
} else {
  console.log(JSON.stringify(output, null, 2));
}
