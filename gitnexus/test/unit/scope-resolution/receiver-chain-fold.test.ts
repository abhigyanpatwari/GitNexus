/**
 * U6 — `foldReceiverChain` types a receiver from decoded structure rather than
 * from its source text.
 *
 * The fold is called directly: U6 deliberately wires it into no resolution
 * path (that is U10), so there is no pipeline behaviour to assert yet.
 */

import { describe, it, expect } from 'vitest';
import type { ScopeId } from 'gitnexus-shared';
import { typescriptScopeResolver } from '../../../src/core/ingestion/languages/typescript/scope-resolver.js';
import { csharpScopeResolver } from '../../../src/core/ingestion/languages/csharp/scope-resolver.js';
import { foldReceiverChain } from '../../../src/core/ingestion/scope-resolution/passes/compound-receiver.js';
import { decodeReceiverChain } from '../../../src/core/ingestion/utils/receiver-chain-codec.js';
import { buildScopeModel, type ScopeModelFixture } from '../../helpers/scope-model.js';

const SOURCE = `export class Address {
  save(): void {}
}

export class User {
  address: Address = new Address();
  save(): void {}
}

export class Base {
  inherited(): User {
    return new User();
  }
}

export class Item {
  run(): void {}
}

export class Service extends Base {
  getUser(): User {
    return new User();
  }
  getUserAsync(): Promise<User> {
    return Promise.resolve(new User());
  }
  getItems(): Item[] {
    return [];
  }
  getMap(): Map<string, Item> {
    return new Map();
  }
}

// A class with NO member \`save\`, whose FIELD's type has one. The field
// fallback finds \`save\` by walking in here; the fold must not.
export class Holder {
  user: User = new User();
}

// NOT a container: an ordinary class that happens to be subscriptable, with a
// member whose name COLLIDES with the element type's. Indexing it yields an
// \`Item\`, so \`grid[0].run()\` is \`Item.run\` — but an index step that folded
// on identity stayed on \`Grid\` and found \`Grid.run\` instead.
export class Grid {
  run(): void {}
  [i: number]: Item;
}

// Not subscriptable at all, and shares the member name too.
export class Plain {
  run(): void {}
}

const svc: Service = new Service();
const holder: Holder = new Holder();
declare const grid: Grid;
declare const plain: Plain;
declare const repos: User[];
declare const nested: User[][];
declare const byId: Record<string, Item>;
`;

/** A built scope model plus the scope a fold starts in. */
interface FoldContext {
  readonly fixture: ScopeModelFixture;
  readonly inScope: ScopeId;
}

/** `foldReceiverChain`'s options bag. The interface itself is module-private
 *  in `compound-receiver`, so it is read off the function rather than
 *  re-declared (which would let the two drift). */
type FoldOptions = NonNullable<Parameters<typeof foldReceiverChain>[4]>;

const tsFixture = buildScopeModel(typescriptScopeResolver, SOURCE, 'main.ts');
const ctx: FoldContext = { fixture: tsFixture, inScope: tsFixture.moduleScope };

/**
 * Fold `encoded` in `ctx`, under the language's own contract flags — exactly
 * as the resolver pass would pass them. TypeScript hoists method return-type
 * bindings out of the class body, so the fold needs that flag to find any of
 * them; `elementTypeOf` is what an index step consults, and passing it here is
 * what makes these tests measure the same fold `emitReceiverBoundCalls` runs.
 *
 * `overrides` replaces individual flags — used to exercise the OFF branch of
 * `hoistTypeBindingsToModule` (which six wired languages: c, cobol, dart,
 * python, ruby, swift, actually run) and the no-`elementTypeOf` branch (which
 * twelve of the fourteen do).
 */
function foldIn(ctx: FoldContext, encoded: string, overrides: FoldOptions = {}) {
  const decoded = decodeReceiverChain(encoded);
  expect(decoded).toBeDefined();
  return foldReceiverChain(decoded!, ctx.inScope, ctx.fixture.scopes, ctx.fixture.index, {
    fieldFallback: false,
    hoistTypeBindingsToModule: true,
    elementTypeOf: ctx.fixture.resolver.elementTypeOf,
    ...overrides,
  });
}

const fold = (encoded: string) => foldIn(ctx, encoded);

describe('foldReceiverChain', () => {
  it('types a single call step through the method return type', () => {
    expect(fold('2|svc|cgetUser')).toMatchObject({ qualifiedName: 'User', type: 'Class' });
  });

  it('types a mixed call/field chain, base-first', () => {
    expect(fold('2|svc|cgetUser|faddress')).toMatchObject({
      qualifiedName: 'Address',
      type: 'Class',
    });
  });

  it('types a step inherited through the MRO', () => {
    expect(fold('2|svc|cinherited')).toMatchObject({ qualifiedName: 'User', type: 'Class' });
  });

  it('returns undefined when a step names no member of the previous class', () => {
    expect(fold('2|svc|cgetUser|fnoSuchField')).toBeUndefined();
  });

  it('returns undefined when the base does not resolve', () => {
    expect(fold('2|noSuchLocal|cgetUser')).toBeUndefined();
  });

  it('does not consult the field fallback', () => {
    // `Holder` has no member `save` — only its field's TYPE does. The field
    // fallback would walk Holder's fields, find `User.save` and answer: a
    // guess, at O(fields x depth x names) per step. The fold declines.
    expect(fold('2|holder|csave')).toBeUndefined();
  });

  it('declines a truncated chain even though the producer refuses to mint one', () => {
    expect(fold('2|svc|cgetUser|~')).toBeUndefined();
  });

  it('declines a construction-selector step and leaves it to the cascade', () => {
    // `Factory.new` denotes an INSTANCE of Factory, not the result of looking up
    // a member named `new`. The cascade encodes that, together with the
    // class-constant test that separates it from an instance method genuinely
    // named `new`; a chain step records only a name, so the fold cannot make the
    // distinction and must not try. Folding it turned a correct Ruby edge
    // (`Factory.new.run` → `Factory#run`) into a wrong one (`Product.run`).
    expect(foldIn(ctx, '2|svc|cnew', { constructionSyntax: { selector: 'new' } })).toBeUndefined();
  });

  it('does NOT climb to module scope when hoistTypeBindingsToModule is off', () => {
    // The flag exists because TypeScript hoists a method's return-type binding
    // OUT of the class body, so the fold must walk to Module scope to find it.
    // Languages that do NOT hoist must not get that walk — climbing anyway is
    // how an unrelated module-level binding of the same name gets picked up,
    // which is exactly what the flag's own contract warns against. Same chain,
    // opposite answers, so this pins the branch rather than the happy path.
    expect(foldIn(ctx, '2|svc|cgetUser', { hoistTypeBindingsToModule: true })).toMatchObject({
      qualifiedName: 'User',
    });
    expect(foldIn(ctx, '2|svc|cgetUser', { hoistTypeBindingsToModule: false })).toBeUndefined();
  });
});

/**
 * The `index` step. Every case here would have folded onto the CONTAINER before
 * the step demanded positive evidence — `rawName` is `User` for both
 * `repos: User[]` and `grid: Grid`, so identity could not tell an element from
 * the thing that holds it.
 */
describe('foldReceiverChain — index step', () => {
  it('declines a subscript on a non-container class whose member name collides with the element type', () => {
    // `Grid` declares `[i: number]: Item` AND its own `run`. Identity kept the
    // fold on `Grid`, so `grid[0].run()` emitted `Grid.run`; the element's owner
    // is `Item`. The element type of a TypeScript index signature is not
    // recorded anywhere the fold can read, so declining is the only sound
    // answer — and it must never be the container.
    expect(fold('2|grid|i')).toBeUndefined();
  });

  it('declines a subscript on a class that is not subscriptable at all', () => {
    // `plain: Plain` reduces to nothing — `Plain` IS the written spelling — so
    // there is no container evidence and `plain[0]` types to nothing. Identity
    // answered `Plain`, which then owned every member looked up after it.
    expect(fold('2|plain|i')).toBeUndefined();
  });

  it('resolves a genuine container whose spelling capture already reduced away', () => {
    // `repos: User[]` binds to the bare `User`; only `declaredSpelling` still
    // says `User[]`. This is the shape the feature exists for.
    expect(fold('2|repos|i')).toMatchObject({ qualifiedName: 'User', type: 'Class' });
  });

  it('resolves a container spelling capture left intact', () => {
    // A multi-arg generic survives TypeScript's capture-time normalization, so
    // `rawName` IS the container here and the hook unwraps it to the value type.
    expect(fold('2|byId|i')).toMatchObject({ qualifiedName: 'Item', type: 'Class' });
  });

  it('declines a nested container: ONE subscript leaves a container, not an element', () => {
    // `nested: User[][]` reduces to the SAME `User` a single-level `User[]`
    // produces — the strip loop runs to a fixed point. So one index step leaves
    // `User[]`, and `nested[0].map(...)` is `Array.map`, never `User.map`.
    // Identity answered `User` and handed the next member to the wrong owner.
    expect(fold('2|nested|i')).toBeUndefined();
  });

  it('declines when the language answers no index route at all', () => {
    // Twelve of the fourteen wired languages leave `elementTypeOf` undefined.
    // They used to get identity — every index step in every one of them folded
    // onto the container. Answering the route is now the price of index folding.
    expect(foldIn(ctx, '2|repos|i', { elementTypeOf: undefined })).toBeUndefined();
  });

  it('declines when the hook names an element that binds to no class', () => {
    expect(
      foldIn(ctx, '2|repos|i', { elementTypeOf: () => 'NoSuchClassAnywhere' }),
    ).toBeUndefined();
  });

  it('declines an index step on a position that carries no declared type', () => {
    // A static class-name base (`Service`) resolves to a def with NO type
    // binding behind it, so there is no spelling to hand the hook.
    expect(fold('2|Service|i')).toBeUndefined();
  });

  it('unwraps a container returned by a method, through the hoisted binding', () => {
    // `getItems(): Item[]` — the return-type binding reduces to `Item` and only
    // the spelling remembers `Item[]`. TypeScript hoists it out of the class
    // body, so this also pins that `typeOfMemberOnClass` carries the spelling
    // along the hoisted branch.
    expect(fold('2|svc|cgetItems|i')).toMatchObject({ qualifiedName: 'Item', type: 'Class' });
  });

  it('treats await as identity, and does not require container evidence for it', () => {
    // `getUserAsync(): Promise<User>` reduces to `User` at capture, and awaiting
    // a non-thenable yields the value itself — both regimes agree, which is
    // exactly why `await` may stay identity where `index` may not.
    expect(fold('2|svc|cgetUserAsync|a')).toMatchObject({ qualifiedName: 'User', type: 'Class' });
  });
});

/**
 * P3: the hoisted branch of `typeOfMemberOnClass` returned `undefined` when a
 * member's declared type named no class, while the primary branch deliberately
 * carried the declared type forward for exactly that case. Ten languages set
 * `hoistTypeBindingsToModule`, so the two branches disagreed about the same
 * declared type depending only on where the binding happened to live.
 */
describe('foldReceiverChain — a member whose declared type names no class', () => {
  it('unwraps it identically whether the binding is reached by base lookup or by the hoisted walk', () => {
    // `Map<string, Item>` names no workspace class on either route.
    expect(fold('2|byId|i')).toMatchObject({ qualifiedName: 'Item' });
    expect(fold('2|svc|cgetMap|i')).toMatchObject({ qualifiedName: 'Item' });
  });

  it('still yields nothing when the chain ENDS on a type that named no class', () => {
    // Carrying the declared type forward must not start answering with a class
    // the position never had — only an unwrapping step may advance from here.
    expect(fold('2|svc|cgetMap')).toBeUndefined();
    expect(fold('2|svc|cgetMap|fnoSuchField')).toBeUndefined();
  });
});

// ── C#: a real indexer, and the containers around it ────────────────────────

const CSHARP_SOURCE = `using System.Collections.Generic;

class Row {
    public void Render() {}
}

class Table {
    public Row this[int i] { get { return null; } }
    public void Render() {}
}

class Cap {
    void Entry(Table t, Dictionary<string, Row> rows, List<Row> items, Row bare) {
    }
}
`;

const csFixture = buildScopeModel(csharpScopeResolver, CSHARP_SOURCE, 'main.cs');

// The parameter type bindings live in `Entry`'s own scope, so the fold must
// start there rather than at the module scope. Selected by the binding it
// must carry, not by position — every method body in the file is a Function
// scope and `Row.Render` comes first.
const csEntryScope = csFixture.parsed.scopes.find(
  (s) =>
    s.kind === 'Function' &&
    csFixture.scopes.scopeTree.getScope(s.id)?.typeBindings.has('t') === true,
);
if (csEntryScope === undefined) throw new Error('no C# scope binding `t`');

const csCtx: FoldContext = { fixture: csFixture, inScope: csEntryScope.id as ScopeId };

describe('foldReceiverChain — C# indexer vs C# containers', () => {
  it('declines a subscript on a class that declares an indexer', () => {
    // `Table` has `public Row this[int i]` AND its own `Render`. `t[0].Render()`
    // is `Row.Render`; identity made it `Table.Render`.
    expect(foldIn(csCtx, '2|t|i')).toBeUndefined();
  });

  it('declines a subscript on a class with neither indexer nor container spelling', () => {
    expect(foldIn(csCtx, '2|bare|i')).toBeUndefined();
  });

  it('resolves a dictionary subscript to the VALUE type', () => {
    expect(foldIn(csCtx, '2|rows|i')).toMatchObject({ qualifiedName: 'Row', type: 'Class' });
  });

  it('resolves a list subscript whose spelling capture reduced away', () => {
    // C#'s `stripGeneric` collapses `List<Row>` to `Row` at capture, so this
    // cell depends entirely on the retained spelling.
    expect(foldIn(csCtx, '2|items|i')).toMatchObject({ qualifiedName: 'Row', type: 'Class' });
  });
});
