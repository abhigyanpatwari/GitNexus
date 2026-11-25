import { registerCases } from '../support/cases.mjs';
import assert from 'node:assert/strict';
import { describe, it, before as beforeAll, after as afterAll } from 'node:test';
import { expect } from 'expect';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getResolutionOutcomes,
  runPipelineFromRepo,
  suppressionReasonsAt,
  useFixture,
  writeFixtureRepo,
  type PipelineResult,
} from '../support/fixture.js';

// ---------------------------------------------------------------------------
// Issue #1358: class-instance singleton (`export const x = new C()`)
// PR #1718 closed the object-literal-shorthand sub-case; this fixture covers
// the class-instance sub-case. Resolution chain: @type-binding.constructor
// (TS query) → propagateImportedReturnTypes (cross-file mirror) →
// receiver-bound Case 4 (simple typeBinding) → MRO walk.
// ---------------------------------------------------------------------------

describe('TypeScript class-instance singleton resolution (issue #1358 sub-case)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-class-instance-singleton'),
        () => {},
        { skipGraphPhases: true },
      );
    },
    { timeout: 60000 },
  );

  it('detects FooService class, getUser method, caller function, fooService Const', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('FooService');
    expect(getNodesByLabel(result, 'Method')).toContain('getUser');
    expect(getNodesByLabel(result, 'Function')).toContain('caller');
    expect(getNodesByLabel(result, 'Const')).toContain('fooService');
  });

  it('emits HAS_METHOD edge from FooService to getUser', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const fromClass = hasMethod.filter((e) => e.source === 'FooService').map((e) => e.target);
    expect(fromClass).toEqual(['getUser']);
  });

  it('resolves caller.fooService.getUser() to FooService.getUser via constructor-inferred typeBinding', () => {
    const calls = getRelationships(result, 'CALLS');
    const projected = calls
      .filter((e) => e.source === 'caller' && e.target === 'getUser')
      .map((e) => ({
        targetFilePath: e.targetFilePath,
        reason: e.rel.reason,
        confidence: e.rel.confidence,
      }));

    expect(projected).toEqual([
      {
        targetFilePath: 'src/service.ts',
        reason: 'import-resolved',
        confidence: 0.85,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Issue #1358: factory-pattern singleton (`export const x = makeC()`)
// Tests the @type-binding.alias chain-follow path through
// propagateImportedReturnTypes (followChainPostFinalize) — fooService aliases
// makeFooService's return type, which the constructor seeds as FooService.
// ---------------------------------------------------------------------------

describe('TypeScript factory-pattern singleton resolution (issue #1358 sub-case)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-factory-singleton'),
        () => {},
        { skipGraphPhases: true },
      );
    },
    { timeout: 60000 },
  );

  it('detects FooService class, makeFooService function, fooService Const, caller function', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('FooService');
    expect(getNodesByLabel(result, 'Function')).toContain('makeFooService');
    expect(getNodesByLabel(result, 'Function')).toContain('caller');
    expect(getNodesByLabel(result, 'Const')).toContain('fooService');
  });

  it('resolves caller.fooService.getUser() through the factory chain to FooService.getUser', () => {
    const calls = getRelationships(result, 'CALLS');
    const projected = calls
      .filter((e) => e.source === 'caller' && e.target === 'getUser')
      .map((e) => ({
        targetFilePath: e.targetFilePath,
        reason: e.rel.reason,
        confidence: e.rel.confidence,
      }));

    expect(projected).toEqual([
      {
        targetFilePath: 'src/service.ts',
        reason: 'import-resolved',
        confidence: 0.85,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dynamic-this contexts are never seeded from the lexically enclosing class
// (#2353 follow-up): an object-literal method's `this` is the literal, not
// the class instance — the compound resolver's literal-`this` head seed is
// restricted to initializer contexts and must not fire here.
// ---------------------------------------------------------------------------

describe('TS dynamic-this receiver seeding guard', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-dynamic-this-no-seed'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects the App and Router classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['App', 'Router']);
  });

  it('emits no CALLS edge from the object-literal method to Router.go', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.some((c) => c.target === 'go' && c.source === 'onClick')).toBe(false);
  });

  // Both sites on `this.route.go()` are lost for ONE reason: the object-literal
  // method owns `this` and gives it no type. The call's receiver is the chain
  // `this.route`, and the owned-receiver check was asked about that whole text
  // — which no scope owns — instead of its base `this`. So the call went on to
  // the compound fold and was filed as a generic `receiver-unresolved` drop,
  // or, when the read beside it (same start column) was handled first, as
  // nothing at all.
  registerCases(
    it,
    [
      [['app.ts', 17, 6, 'route', 'read'], ['receiver-owned-but-unbound']],
      [['app.ts', 17, 6, 'go', 'call'], ['receiver-owned-but-unbound']],
    ],
    'records %j under its real reason',
    (site, reasons) => {
      expect(suppressionReasonsAt(result, site)).toEqual(reasons);
    },
  );
});

// ---------------------------------------------------------------------------
// Inline constructor receiver: new Service(db).doWork() (#2708)
// The keyword form of the same shape covered for Python and Ruby. The receiver
// is the constructed value itself, so there is no binding to read a type from —
// the compound receiver resolver types it from the class the callee names.
// ---------------------------------------------------------------------------

describe('TypeScript inline constructor receiver resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-inline-constructor-receiver'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('resolves new Service(db).doWork() to Service.doWork', () => {
    const calls = getRelationships(result, 'CALLS');
    const inlineCall = calls.find((c) => c.source === 'viaInlineNew' && c.target === 'doWork');
    expect(inlineCall).toMatchObject({
      source: 'viaInlineNew',
      target: 'doWork',
      targetFilePath: 'src/svc.ts',
    });
    expect(inlineCall!.rel.targetId).toContain('Service');
  });

  it('keeps the two-step spelling resolving to Service.doWork', () => {
    const calls = getRelationships(result, 'CALLS');
    const twoStep = calls.find((c) => c.source === 'viaTwoStep' && c.target === 'doWork');
    // Pin the file too: this fixture also defines `LegacyService`, and
    // 'LegacyService'.includes('Service') is true, so the id check alone
    // cannot tell the two targets apart.
    expect(twoStep).toMatchObject({ target: 'doWork', targetFilePath: 'src/svc.ts' });
    expect(twoStep!.rel.targetId).toContain('Service');
  });

  it('resolves a generic constructor receiver — new Box<string>().unwrap()', () => {
    const calls = getRelationships(result, 'CALLS');
    const genericCall = calls.find((c) => c.source === 'viaGenericCtor' && c.target === 'unwrap');
    expect(genericCall).toMatchObject({
      source: 'viaGenericCtor',
      target: 'unwrap',
      targetFilePath: 'src/svc.ts',
    });
    expect(genericCall!.rel.targetId).toContain('Box');
  });

  it('resolves construction in the chain HEAD — new Service(db).inner.deep()', () => {
    const calls = getRelationships(result, 'CALLS');
    const chainCall = calls.find((c) => c.source === 'viaChainHead' && c.target === 'deep');
    expect(chainCall).toMatchObject({
      source: 'viaChainHead',
      target: 'deep',
      targetFilePath: 'src/svc.ts',
    });
    expect(chainCall!.rel.targetId).toContain('Inner');
  });

  it('resolves the keyword separated by a tab or a newline, not just one space', () => {
    const calls = getRelationships(result, 'CALLS');
    for (const source of ['viaTabSeparatedNew', 'viaNewlineSeparatedNew']) {
      const call = calls.find((c) => c.source === source && c.target === 'doWork');
      assert.doesNotThrow(
        () =>
          expect(call).toMatchObject({
            source,
            target: 'doWork',
            targetFilePath: 'src/svc.ts',
          }),
        `${source} -> doWork`,
      );
      expect(call!.rel.targetId).toContain('Service');
    }
  });

  it('resolves a namespace-qualified constructor — new ns.Service(db).doWork()', () => {
    const calls = getRelationships(result, 'CALLS');
    const qualified = calls.find((c) => c.source === 'viaQualifiedCtor' && c.target === 'doWork');
    expect(qualified).toMatchObject({
      source: 'viaQualifiedCtor',
      target: 'doWork',
      targetFilePath: 'src/svc.ts',
    });
    expect(qualified!.rel.targetId).toContain('Service');
  });

  it('resolves a bare factory call through its return type, not as a construction', () => {
    const calls = getRelationships(result, 'CALLS');
    const factoryCall = calls.find((c) => c.source === 'viaFactory' && c.target === 'doWork');
    expect(factoryCall).toBeDefined();
    // Other.doWork, via makeOther's return type — a bare call in a `new`
    // language must never be typed as a construction of a same-named class.
    expect(factoryCall!.rel.targetId).toContain('Other');
  });
});

// ---------------------------------------------------------------------------
// #2744 drop recorder — the site kind travels with the drop.
//
// Case 0's gate tests the RECEIVER's punctuation, not the site's kind, so a
// compound-receiver property write is recorded in the same bucket as a dropped
// method call. Anything measuring resolver gaps has to tell those apart, and
// the site kind is the only authoritative signal for it.
//
// Both negative cases use untyped receivers, so their drops do not depend on
// an unsupported expression shape. A typed write is the positive control.
// ---------------------------------------------------------------------------

describe('TypeScript receiver-unresolved drops carry their site kind (#2744)', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(
    async () => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-drop-site-kind-'));
      writeFixtureRepo(repoDir, {
        'models.ts': `export class User {
  name: string = '';
  save(): void {}
}

export class Service {
  getUser(): User {
    return new User();
  }
  async getUserAsync(): Promise<User> {
    return new User();
  }
}
`,
        'main.ts': `import { Service } from './models';

export async function droppedCall(svc): Promise<void> {
  // An UNANNOTATED parameter. The chain mints fine, but the base has no type
  // binding to resolve against, so the site reaches the drop recorder.
  //
  // Third fixture for this case: \`!\` served until structural typing resolved
  // it, then the await-parenthesized form served until name-free step kinds
  // resolved that too. Both were shapes the resolver merely did not SUPPORT
  // yet, so each fix moved the goalposts. An untyped receiver carries no type
  // information at all, so no amount of resolver work can type it — which is
  // what makes it a stable choice rather than the next one to be fixed.
  svc.getUser().save();
}

export function droppedWrite(svc): void {
  // The unannotated receiver has no type proof, even though writes now
  // carry the same structural receiver chains as calls.
  svc!.getUser().name = 'x';
}

export function resolvedWrite(svc: Service | null): void {
  svc!.getUser().name = 'x';
}
`,
      });
      result = await runPipelineFromRepo(repoDir, () => {}, {});
    },
    { timeout: 60000 },
  );

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('tags a dropped method call as a call site', () => {
    const drops = getResolutionOutcomes(result).filter(
      (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
    );
    expect(drops).toContainEqual(expect.objectContaining({ name: 'save', siteKind: 'call' }));
  });

  it('tags a dropped property write as a write site, so it is separable from calls', () => {
    const drops = getResolutionOutcomes(result).filter(
      (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
    );
    expect(drops).toContainEqual(expect.objectContaining({ name: 'name', siteKind: 'write' }));
  });

  it('resolves the typed compound write while retaining the untyped write drop', () => {
    const accesses = getRelationships(result, 'ACCESSES').filter((edge) => edge.target === 'name');
    expect(accesses).toHaveLength(1);
    expect(accesses[0]).toMatchObject({
      source: 'resolvedWrite',
      target: 'name',
      targetFilePath: 'models.ts',
      rel: { targetId: 'Property:models.ts:User.name' },
    });
  });

  // The origin travels with the drop too, and its value here is the whole
  // point: `svc` is an UNANNOTATED parameter, so the scope model records it
  // nowhere — no type binding, no value binding, no qualified name. A
  // classifier that read that silence as `external` published
  // `epistemic: 'exact'` over a call it had genuinely lost. `unknown` is the
  // honest answer and it counts toward the hedge exactly like `in-program`.
  it('does not call an untyped in-program receiver external', () => {
    const drops = getResolutionOutcomes(result).filter(
      (outcome) => outcome.kind === 'suppressed' && outcome.reason === 'receiver-unresolved',
    );
    expect(drops).toContainEqual(
      expect.objectContaining({ name: 'save', siteKind: 'call', receiverOrigin: 'unknown' }),
    );
    expect(drops).not.toContainEqual(
      expect.objectContaining({ name: 'save', receiverOrigin: 'external' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Structural receiver typing: receiver spellings the text cascade cannot parse
// now resolve by folding the captured chain.
//
// Both shapes below emitted NO edge and recorded NO drop before this work:
// Case 0's gate fired, `resolveCompoundReceiverClass` returned undefined, and a
// later case marked the site handled — which suppresses the drop record too, so
// the loss was invisible to the epistemic signal as well as to the graph.
// ---------------------------------------------------------------------------

describe('TypeScript structural receiver chains', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(
    async () => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-receiver-chain-'));
      writeFixtureRepo(repoDir, {
        'models.ts': `export class Database {
  query(): void {}
}

export class Config {
  db: Database = new Database();
}

export function make(n: number): number {
  return n;
}

export class Address {
  persist(): void {}
}

export class User {
  address: Address = new Address();
  save(): void {}
}

export class Service {
  getUser(): User {
    return new User();
  }
  getTyped<T>(): User {
    return new User();
  }
}
`,
        'main.ts': `import { Service, Config, make } from './models';

export function viaOptionalChain(svc: Service | null): void {
  svc?.getUser().save();
}

// A local that merely SHADOWS an imported class name. Its value is a number,
// so it has NO members — the fold must not type it as the class.
export function shadowsAClassName(): void {
  const Config = make(1);
  Config.db.query();
}

export function viaTypeArgs(svc: Service): void {
  svc.getTyped<User>().save();
}

export function viaNonNull(svc: Service | null): void {
  svc!.getUser().save();
}

// A mixed call/field chain behind a spelling the TEXT cascade cannot parse
// (optional chaining), so this discriminates the fold rather than re-testing
// the pre-existing cascade path.
export function viaMixedChain(svc: Service | null): void {
  svc?.getUser().address.persist();
}

// User has no member named missing, so the chain dies at its middle step.
export function brokenMiddleStep(svc: Service): void {
  svc.getUser().missing.persist();
}

export function alreadyWorked(svc: Service): void {
  svc.getUser().save();
}
`,
      });
      result = await runPipelineFromRepo(repoDir, () => {}, {});
    },
    { timeout: 60000 },
  );

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('resolves an optional-chained receiver — svc?.getUser().save()', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'viaOptionalChain' && c.target === 'save')).toMatchObject(
      {
        target: 'save',
        targetFilePath: 'models.ts',
      },
    );
  });

  it('resolves an explicit-type-argument receiver — svc.getTyped<User>().save()', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'viaTypeArgs' && c.target === 'save')).toMatchObject({
      target: 'save',
      targetFilePath: 'models.ts',
    });
  });

  it('resolves a non-null-asserted receiver — svc!.getUser().save()', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'viaNonNull' && c.target === 'save')).toMatchObject({
      target: 'save',
      targetFilePath: 'models.ts',
    });
  });

  it('resolves a mixed call/field chain through the fold', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'viaMixedChain' && c.target === 'persist')).toMatchObject(
      {
        target: 'persist',
        targetFilePath: 'models.ts',
      },
    );
  });

  it('keeps the shape that already resolved through the text cascade', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.find((c) => c.source === 'alreadyWorked' && c.target === 'save')).toMatchObject({
      target: 'save',
      targetFilePath: 'models.ts',
    });
  });

  it('does NOT fabricate an edge when a local shadows a class name', () => {
    // Regression: the fold resolved its base through the permissive
    // bare-identifier path, which falls through to a plain class-name lookup
    // even when a receiver typeBinding exists but names no class. A local
    // `const Config = make(1)` (a number) was therefore typed as the imported
    // `class Config`, emitting a confident `CALLS` edge to `Database.query`
    // that the text cascade never produced. A missing edge is recoverable; a
    // wrong one is not.
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((c) => c.source === 'shadowsAClassName' && c.target === 'query')).toEqual(
      [],
    );
  });

  it('emits no CALLS edge when a middle step names no member of the previous class', () => {
    // A broken MIDDLE step must produce no edge, never a wrong one. `User` has no
    // member `missing`, so the chain cannot be typed past it and `persist` must
    // not bind to anything — in particular not to `Address.persist`, which a
    // field-walking fallback could otherwise reach.
    // `getUser` itself still resolves — only the tail past the broken step must not.
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((c) => c.source === 'brokenMiddleStep' && c.target === 'persist')).toEqual(
      [],
    );
    expect(
      calls.filter((c) => c.source === 'brokenMiddleStep' && c.target === 'getUser'),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Case 3b (chain-typebinding) interface dispatch (#2832). `const r = d.repo`
// binds `r` to the member expression `d.repo`, so the receiver is a bare name
// with a DOTTED typeBinding rawName — Case 3b's entry condition. Case 0 cannot
// take the site (`r` has no `.`/`(`, and no receiver chain is minted for a
// bare identifier), and Case 4 excludes itself on the dot. The fold lands on
// an Interface, so the implementations are reachable only via the fan-out.
// ---------------------------------------------------------------------------

describe('TypeScript chain-typed receiver folding to an interface (Case 3b, #2832)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'ts-chain-interface-dispatch'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  const saveCalls = () =>
    getRelationships(result, 'CALLS').filter((e) => e.source === 'runSave' && e.target === 'save');
  const fanout = () => saveCalls().filter((e) => e.rel.reason === 'interface-dispatch');
  const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1);

  it('emits the primary edge to the interface declaration', () => {
    const primary = saveCalls().filter((e) => e.rel.reason !== 'interface-dispatch');
    expect(primary.map((e) => basename(e.targetFilePath))).toEqual(['repository.ts']);
  });

  // A static member can never be reached through an instance-typed receiver —
  // TypeScript rejects `class C implements I { static save() {} }` as TS2420,
  // "Property 'save' is missing". ShadowRepo inherits the real SqlRepo.save and
  // adds a same-named static; only the inherited instance method is a dispatch
  // target. Before the guard this emitted an edge to the static one.
  it('never fans out to a static member', () => {
    const targets = fanout().map((e) => `${basename(e.targetFilePath)}`);
    expect(targets).not.toContain('shadow-repo.ts');
  });

  // Covers all three hierarchy shapes, now that TypeScript emits heritage for
  // interfaces and abstract classes too (#2842 review): a direct implementor
  // (sql-repo, mem-repo), a concrete class below an ABSTRACT intermediate
  // (hierarchy.ts DiskRepo, reachable only through BaseRepo), and an
  // implementor of an EXTENDING interface (hierarchy.ts ColdRepo, two hops from
  // the receiver's type). Exact-set, so a target appearing OR vanishing fails.
  // Two hierarchy.ts entries because that file holds two of the four targets.
  it('fans out through abstract intermediates and interface extension', () => {
    expect(
      fanout()
        .map((e) => basename(e.targetFilePath))
        .sort(),
    ).toEqual(['hierarchy.ts', 'hierarchy.ts', 'mem-repo.ts', 'sql-repo.ts']);
  });

  // The abstract declaration is bodiless: it must be WALKED THROUGH to reach
  // DiskRepo, never emitted to. tsc's own Go-to-Implementation behaves the same
  // way — the rule everywhere is "does it have a body?", not "is it in a class?".
  it('walks through the abstract declaration without targeting it', () => {
    const names = fanout()
      .filter((e) => basename(e.targetFilePath) === 'hierarchy.ts')
      .map((e) => e.target);
    expect(names).toEqual(['save', 'save']);
  });

  it('never targets the interface declaration in the fan-out', () => {
    expect(fanout().map((e) => basename(e.targetFilePath))).not.toContain('repository.ts');
  });

  // Stronger negative than the PlainCache case below: here an interface IS in
  // scope (SqlRepo implements Repo) and `save` is a name Repo declares, yet the
  // receiver's folded type is the concrete class, so nothing may fan out.
  //
  // This does NOT catch "member owner passed instead of folded type". The
  // reason is a property of TypeScript, not of the control: TS's MRO chain
  // never contains an implemented interface, so the walk cannot settle on an
  // interface declaration for a concrete receiver and the two values coincide.
  // (Not, as an earlier draft of this comment claimed, because an implementing
  // class always declares the member itself — `class C extends Base implements
  // I {}` is valid TS and inherits it.) The mutation IS expressible where a
  // concrete class inherits a `default` interface method — Java or Kotlin —
  // and is tracked for a follow-up fixture there.
  it('emits no fan-out when the chain folds to a concrete implementor', () => {
    const concrete = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'runConcrete' && e.target === 'save',
    );
    expect(concrete.map((e) => e.rel.reason).filter((r) => r === 'interface-dispatch')).toEqual([]);
    expect(concrete.map((e) => basename(e.targetFilePath))).toEqual(['sql-repo.ts']);
  });

  it('emits no fan-out when the chain folds to a concrete class', () => {
    const runCalls = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'runCache' && e.target === 'run',
    );
    expect(runCalls.map((e) => e.rel.reason).filter((r) => r === 'interface-dispatch')).toEqual([]);
    expect(runCalls.map((e) => basename(e.targetFilePath))).toEqual(['plain-cache.ts']);
  });
});

// #3498: `ns.make()` takes `make`'s return annotation from the namespace's
// module. A class method of the same name hoists its return type to the module
// under that name, so the lookup must stay anchored on the module function and
// fail closed instead of typing the receiver as the method's return.
describe('TypeScript namespace factory result types (#3498)', () => {
  let result: PipelineResult;
  let repoDir: string;

  beforeAll(
    async () => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-ts-namespace-factory-'));
      writeFixtureRepo(repoDir, {
        'src/mod.ts': `export class C {
  m(): number {
    return 1;
  }
}

export class Other {
  m(): number {
    return 2;
  }
}

export function make(): C {
  return new C();
}
`,
        'src/hoist.ts': `import { C, Other } from './mod';

export function build(): C {
  return new C();
}

export class Builder {
  build(): Other {
    return new Other();
  }
}
`,
        'src/callers.ts': `import * as rp from './mod';
import * as hz from './hoist';

export function aliasCall() {
  const x = rp.make();
  return x.m();
}

export function inlineCall() {
  return rp.make().m();
}

export function hoistedCall() {
  const y = hz.build();
  return y.m();
}

export function hoistedInline() {
  return hz.build().m();
}
`,
      });
      result = await runPipelineFromRepo(repoDir, () => {}, {});
    },
    { timeout: 60000 },
  );

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  registerCases(
    it,
    [
      { source: 'aliasCall', targets: ['Method:src/mod.ts:C.m#0'] },
      { source: 'inlineCall', targets: ['Method:src/mod.ts:C.m#0'] },
      { source: 'hoistedCall', targets: [] },
      { source: 'hoistedInline', targets: [] },
    ],
    'resolves m called from $source to $targets',
    ({ source, targets }) => {
      expect(
        getRelationships(result, 'CALLS')
          .filter((edge) => edge.source === source && edge.target === 'm')
          .map((edge) => edge.rel.targetId),
      ).toEqual(targets);
    },
  );

  it('records the hoisted sites as dropped instead of an exact miss', () => {
    const dropped = getResolutionOutcomes(result)
      .filter((outcome) => outcome.kind === 'suppressed')
      .filter(
        (outcome) =>
          outcome.reason === 'receiver-unresolved' && outcome.filePath === 'src/callers.ts',
      )
      .map((outcome) => `${outcome.range.startLine}:${outcome.name}`)
      .sort();
    expect(dropped).toEqual(['15:m', '19:m']);
  });
});

// ---------------------------------------------------------------------------
// #3956: a default import binds the declaration the target module publishes as
// its default export, whatever the importer calls it locally.
// ---------------------------------------------------------------------------

describe('TypeScript default imports (#3956)', () => {
  const result = useFixture('ts-default-import', {
    'src/c/Child.tsx':
      'export default function Child({ a }: { a: number }) { return <div>{a}</div>; }\n',
    'src/c/Named.tsx': 'export function Named() { return <span />; }\n',
    'src/c/plain.ts': 'export default function plainFn(x: number) { return x + 1; }\n',
    'src/c/Widget.tsx': 'export default function Panel() { return <div />; }\n',
    'src/c/helper.ts': 'function helper() { return 1; }\nexport { helper as default };\n',
    'src/c/arrow.ts': 'const arrowFn = () => 2;\nexport default arrowFn;\n',
    'src/ui/index.ts': "export { default } from '../c/Child';\n",
    'src/ui/alias.ts': "export { default as Btn } from '../c/Child';\n",
    'src/lib/index.ts':
      "export * from '../c/Child';\nexport default makeClient();\nfunction makeClient() { return () => 3; }\n",
    'src/route.ts':
      'const defineEventHandler = <T,>(fn: T) => fn;\nexport default defineEventHandler(async () => 4);\n',
    'src/Parent.tsx': `import Child from './c/Child';
import { Named } from './c/Named';
import plainFn from './c/plain';
export default function Parent() {
  const v = plainFn(1);
  return <div><Child a={v} /><Named /></div>;
}
`,
    'src/Other.tsx': `import Kid from './c/Widget';
import { default as P } from './c/plain';
import h from './c/helper';
import arrow from './c/arrow';
export function Other() {
  P(2);
  h();
  arrow();
  return <Kid />;
}
`,
    'src/ViaDefault.tsx':
      "import C from './ui';\nexport function ViaDefault() { return <C a={1} />; }\n",
    'src/ViaAlias.tsx':
      "import { Btn } from './ui/alias';\nexport function ViaAlias() { return <Btn a={2} />; }\n",
    'src/Client.ts':
      "import client from './lib';\nexport function useClient() { return client(); }\n",
    'src/Ghost.ts':
      "import Ghost from './c/Named';\nexport function useGhost() { return Ghost(); }\n",
    'src/UseRoute.ts':
      "import handler from './route';\nexport function useRoute() { return handler(); }\n",
  });
  const calls = () => getRelationships(result(), 'CALLS');
  const callsFrom = (source: string, targetFilePath: string) =>
    calls().filter((c) => c.source === source && c.targetFilePath === targetFilePath);

  it('links JSX and plain-call default imports to their declarations (issue repro)', () => {
    expect(callsFrom('Parent', 'src/c/Child.tsx').map((c) => c.target)).toContain('Child');
    expect(callsFrom('Parent', 'src/c/plain.ts').map((c) => c.target)).toContain('plainFn');
    expect(callsFrom('Parent', 'src/c/Named.tsx').map((c) => c.target)).toEqual(['Named']);
  });

  it('binds a local name that differs from both the declared name and the file stem', () => {
    expect(callsFrom('Other', 'src/c/Widget.tsx').map((c) => c.target)).toContain('Panel');
  });

  it('binds `{ default as X }`, `export { f as default }` and `export default <const arrow>`', () => {
    expect(callsFrom('Other', 'src/c/plain.ts').map((c) => c.target)).toContain('plainFn');
    expect(callsFrom('Other', 'src/c/helper.ts').map((c) => c.target)).toContain('helper');
    expect(callsFrom('Other', 'src/c/arrow.ts').map((c) => c.target)).toContain('arrowFn');
  });

  it('carries the default through `export { default }` and `export { default as Btn }` barrels', () => {
    expect(callsFrom('ViaDefault', 'src/c/Child.tsx').map((c) => c.target)).toContain('Child');
    expect(callsFrom('ViaAlias', 'src/c/Child.tsx').map((c) => c.target)).toContain('Child');
  });

  it('does not forward a default through `export *` or invent one for a module without it', () => {
    expect(callsFrom('useClient', 'src/c/Child.tsx')).toEqual([]);
    expect(callsFrom('useGhost', 'src/c/Named.tsx')).toEqual([]);
  });

  it('links a default import of a synthesized HOC default export', () => {
    expect(callsFrom('useRoute', 'src/route.ts').length).toBeGreaterThan(0);
  });
});
