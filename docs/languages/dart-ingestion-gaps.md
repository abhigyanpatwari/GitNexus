# Dart Ingestion Gaps

Audited on 2026-10-23 with freshly built production sources at `c35806d24` and
the accompanying benchmark changes. See the [measurement audit](receiver-resolution-audit.md)
for commands, target checks, exclusions and test limits. Historical reports below
remain separate from freshly measured receiver cases; broader ingestion is not
exhaustively assessed.

## Receiver shape snapshot

States below come from [baseline.json](../../gitnexus/bench/receiver-resolution/baseline.json).
The [harness](../../gitnexus/bench/receiver-resolution/measure.mjs) defines each
spelling and its N/A reason. RESOLVES requires the exact expected declaration ID
and no same-named call to a different owner. WRONG-TARGET records incorrect edges.

| Shape                   | Recorded state | Expression or exclusion                 |
| ----------------------- | -------------- | --------------------------------------- |
| `plainChain`            | RESOLVES       | `svc.getUser().save();`                 |
| `plainDeepChain`        | RESOLVES       | `svc.getUser().address.save();`         |
| `optionalChain`         | RESOLVES       | `svc.getUser().address?.save();`        |
| `nonNullAssert`         | VISIBLE-GAP    | `svc.getUser().address!.save();`        |
| `awaitParen`            | RESOLVES       | `(await svc.getUserAsync()).save();`    |
| `explicitTypeArgs`      | VISIBLE-GAP    | `svc.getTyped<User>().save();`          |
| `indexElement`          | INVISIBLE-GAP  | `repos[0].save();`                      |
| `fieldReceiverCall`     | RESOLVES       | `this.repo.save();`                     |
| `decoratedReceiverBase` | N/A            | Dart `this` carries no type decoration. |
| `decoratedFieldType`    | RESOLVES       | `this.repo?.save();`                    |

Typed plain, deep, optional and field chains resolve. Before DART-04 was fixed, the awaited case was WRONG-TARGET: `getUserAsync()` declares `Future<User>`, but the call reached `Address.save` instead of `User.save` (the previous member-name-only gate had labeled it RESOLVES). The parenthesized head carried no receiver text, so the call was resolved receiver-less and the free-call tier bound `save` through the wildcard import's first-declared method. The emitter now gives the call its receiver text (so an untypable parenthesized head is a recorded `receiver-unresolved` drop, never a name guess) and a structural chain (`2|svc|cgetUserAsync|a`). The hoisted return binding of `getUserAsync` carries `Future<User>` whole — it used to arrive as a bare `Future` and be suppressed; only `Future`/`FutureOr` are re-joined, every other container keeps its bare spelling — so `svc.getUserAsync().save()` without an await types nothing, and the shared fold's `await` step unwraps the Future through the Dart `elementTypeOf` await route. [dart-awaited-receiver-owner.test.ts](../../gitnexus/test/integration/resolvers/dart-awaited-receiver-owner.test.ts) pins the exact `User.save` owner, the un-awaited and `Future<dynamic>` negatives, seven untypable parenthesized heads as recorded drops, and rejects the `Address.save` decoy — with a workspace `class Future<T>` present (DART-09), which an awaitable spelling must never bind to. The failing assertion spelling is `svc.getUser().address!.save()`; indexed access uses `List<User> repos`. The recorded statuses identify missing behavior but do not by themselves establish a root cause.

## Planning candidates

| ID      | Evidence              | Gap or boundary                                                                                  | Next planning step and acceptance                                                                                                                                                      |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DART-01 | Measured gap          | `indexElement` is INVISIBLE-GAP: neither a call edge nor a receiver drop is recorded.            | Trace reference-site capture, chain extraction and element typing separately. Add both a diagnostic assertion and an exact target assertion before selecting the implementation slice. |
| DART-02 | Measured gap          | `nonNullAssert` is VISIBLE-GAP.                                                                  | Trace the postfix assertion through the typed field chain. Preserve working optional access and nullable-field controls; track awaited-call ownership separately in DART-04.           |
| DART-03 | Recorded boundary     | Callable-return/tear-off invocation is a separate roadmap follow-up.                             | Create a positive case for the primary tear-off expression and an ambiguous callable negative; fixture-local direct calls alone do not prove support.                                  |
| DART-04 | Fixed                 | `(await svc.getUserAsync()).save()` reached Address.save: a parenthesized head carried no receiver. | Fixed: the emitter mints the receiver text and chain for a parenthesized head. Regression test asserts the full User.save ID, keeps an unknown awaited result unresolved, rejects the Address.save decoy. |
| DART-05 | Measured gap          | `svc.getTyped<User>().save()` is VISIBLE-GAP even when getTyped declares a concrete User return. | Trace explicit type-argument call capture and receiver folding. This fixture tests the call spelling, not substitution of a generic return type. (The parenthesized spelling `(svc.getTyped<User>()).save()` resolves through the chain since DART-04: tree-sitter-dart nests the type arguments inside the `argument_part`.) |
| DART-06 | Fixed                 | Awaited call-result bindings: `final x = await rp.makeAsync(); x.m()` was a receiver-unresolved drop. | Fixed with DART-04: `emitVarTypeBinding` marks an awaited initializer `@type-binding.awaited`, the scope extractor keeps it as `TypeRef.awaited`, and both chain follows (`scope-extractor.ts` `followChainedRef`, `passes/imported-return-types.ts` `followChainPostFinalize`) take what the followed `Future<C>` yields through the Dart await route — `C`. `dart-prefixed-factory-return/lib/callers.dart:22` now has the exact `C.m` edge (dart.test.ts), and `dart-awaited-receiver-owner.test.ts` pins `final u = await makeUserAsync(); u.save()` → `User.save` (cross-file and same-file producers) with an unknown-typed awaited twin unresolved. The callee is a FREE or NAMESPACE function: a member call on a class instance, `final u = await svc.getUserAsync(); u.save()`, is bound to the dotted spelling but not followed (`svc` is a value, not a namespace), so it has no edge and — the SHARED gap — no recorded drop. The inference is guarded (review findings): the awaited call must be the entire operand (`await make().then(…)` binds nothing); a `Future<models.User>` keeps its qualifier, which is read in the PRODUCER's scope (the module whose annotation wrote it) and re-anchored at the module that declares the class — a same-file decoy `User`, or a consumer that reuses the `models` prefix for another file, is never chosen; a qualifier the producer's import cannot resolve declines the binding. Review round 2 replaced the per-initializer "written elsewhere" walk with one binder census per OUTERMOST function body (`dartBodyCensus`, memoized per file; the old walk was quadratic in awaited locals): a local is inferred, awaited or not, only when its name has exactly ONE binder in that body — declarators, the member's own and every closure's / local function's formal parameters, catch variables, for-in variables and every pattern binder (`visitDartBinderName`, the one list the field-shadow mask also reads) — and is assigned nowhere in it (`x = …`, `??=`, `++`, inside a closure too). A name bound twice gets NO inferred binding from either declaration, because one Function scope keeps one binding per name and a refused declaration's call sites would otherwise be answered by the sibling's: closure parameters, catch variables and local-function parameters reusing an awaited local's name, sibling argument closures each declaring `final r`, an outer local redeclared inside a closure, and `if`/`else` branches declaring `resp` are all pinned as no-edge. The count arm's `.dart` call drops moved 2 → 1 by the DART-06 edge, not by a hidden drop. |
| DART-07 | Fixed                 | Un-awaited call-result binding took the FIRST call: `var x = Foo().bar(); x.save()` bound `x` to `Foo`. | Fixed in the DART-04 review round 2: `findDirectCallValue`'s identifier branch now requires the call to be the whole initializer, as the awaited branch already did. The DART-04 fold had made the old behaviour a typed wrong edge — `final f = makeUserAsync().then((u) => u.address); (await f).save()` bound `f` to `makeUserAsync`, whose whole `Future<User>` the await step unwrapped to `User.save`; pinned as no-edge (`thenChainUnawaited`). |
| DART-08 | Recorded gap          | A cascade call on a parenthesized awaited head is still a name guess: `(await svc.getUserAsync())..save()` reaches `Address.save` (the first same-named method the wildcard import declares) instead of `User.save`. | Pre-existing, unchanged by DART-04, which covers member-call selectors only: `emitCascadeReference` classifies every cascade call as a FREE call (legacy parity) and mints no receiver. Fix shape: give a cascade whose head is a parenthesized run the same receiver text and chain `parenthesizedReceiver` mints for a selector run, so an untypable head becomes a recorded drop; a measured change on its own, since it moves every cascade on an expression head. |
| DART-09 | Recorded gap          | A workspace class named `Future` (an SDK stub, a mock SDK) must never capture a whole-`Future<T>` binding. | Closed in the DART-04 review round 2 for every receiver route: `classOfDeclaredType` (`passes/compound-receiver.ts`, the fold's one owner lookup) and the simple-binding owner lookup (`passes/receiver-bound-calls.ts`, Case 4) refuse to bind a spelling the language's `elementTypeOf` await route can unwrap — an awaitable wrapper is container evidence about what the position yields, not a class the position is — and the fold's `await` step consults that route BEFORE any class found for the position. `final f = makeUserAsync(); f.save()` is a recorded `receiver-unresolved` drop with a stray `class Future<T> { int save() => 0; }` in the repo, and `(await svc.getUserAsync()).save()` still reaches `User.save` beside it (`dart-awaited-receiver-owner.test.ts`, `stray.dart`). |
| SHARED  | Recorded gap          | Silent drop for classless typed receivers (shared, all languages).                               | A bare receiver whose type binding resolves to no class records NOTHING — no edge and no `receiver-unresolved` outcome. The drop guard in `gitnexus/src/core/ingestion/scope-resolution/passes/receiver-bound-calls.ts` (~:3783) fires for an untyped compound receiver, a namespace receiver, or a receiver bound to a namespace/qualified callee the analyzer could not type (#3498), but not for a receiver typed by a spelling that names no class. Exposed by `dart-prefixed-factory-return/lib/callers.dart:22` while DART-06 was open: with `x` typed `Future<C>` the `22:m` drop vanished without an edge. Not a Dart fix: widening the guard is a measured shared change (expect other languages' count-arm drops to surface), to be done on its own. |

## Awaited-inference recall boundaries (review 3)

Places where the awaited call-result inference (DART-04 / DART-06) declines a binding that a
fuller analysis could type. All are deliberate: each guard exists to keep a wrong owner out, and
the cost is a missing edge, never a wrong one. Recorded so the recall can be measured and added
on its own later; none is a precision defect.

### 1. A prefix bound to two modules declines even when the member is unambiguous

```dart
// users.dart
class User { void save() {} }
// other.dart
class Other {}
// producer.dart
import 'users.dart' as models;
import 'other.dart' as models;
Future<models.User> fetch() async => models.User();
// caller.dart
import 'producer.dart';
Future<void> run() async {
  final x = await fetch();
  x.save();
}
```

Missing edge: `run → users.dart:User.save`. `qualifiedYieldAt`
(`gitnexus/src/core/ingestion/scope-resolution/passes/imported-return-types.ts`) resolves the
yield's prefix in the producer's scope and requires it to bind exactly ONE target module; here
`models` binds two, so it answers nothing and the binding stays on its callee (no edge, and —
see the SHARED gap — no recorded drop). Fix shape for the recall: when the prefix binds several
modules, accept the yield if exactly one of them declares a class-like member of that name
(uniqueness across the target modules), and still decline on a tie.

### 2. A field label spelled like the local counts as a write

```dart
class User { final String name; User(this.name); void save() {} }
Future<User> fetch() async => User('a');
Future<void> run(Object value) async {
  final name = await fetch();
  if (value case User(name: var n)) {}
  name.save();
}
```

Missing edge: `run → User.save`. `isLocalWrittenElsewhere`
(`gitnexus/src/core/ingestion/languages/dart/captures.ts`) marks every identifier inside any
`*_pattern` node as a write of that name; the object pattern `User(name: var n)` contains the
identifier `name` as a FIELD LABEL, not a binder, so the local `name` is treated as written and
the inference is refused. Fix shape for the recall: inside an `object_pattern`, skip the label
identifier that precedes the `:` and scan only the sub-pattern (`var n`); keep every other
pattern identifier as a write.

### 3. A name bound more than once in a function body is never inferred

```dart
void h() {
  run(() async { final r = await makeUserAsync();    r.save(); });   // User.save would be right
  run(() async { final r = await makeAddressAsync(); r.save(); });   // Address.save would be right
}
```

Missing edges: both `r.save()` sites. This emitter opens no binding scope for an argument closure,
a local function, a block, a `catch` clause or a loop, so every `r` in `h` shares one flow-insensitive
binding and the last declaration emitted would type both sites (at the DART-04 head both reached
`Address.save`). `dartLocalInferenceAllowed` (`gitnexus/src/core/ingestion/languages/dart/captures.ts`)
therefore infers a name only when its outermost body declares it exactly once. Fix shape for the
recall: give an argument closure and a local function a Function scope of their own in the Dart
emitter (the query already does this for a closure bound to a local), so each `r` is declared once
in its own table; then the census can be taken per scope instead of per outermost body.

### 4. An awaited member call on a class instance is not followed

```dart
Future<void> run(Service svc) async {
  final u = await svc.getUserAsync();
  u.save();
}
```

Missing edge: `run → User.save` (no edge, and — the SHARED gap — no recorded drop). The binding is
`svc.getUserAsync` with the awaited marker, but the chain follows type a dotted callee only when its
head is a namespace import; a value receiver is not folded there. Fix shape: let the follow fold a
dotted awaited callee through the receiver's class, the way the structural fold already types
`svc.getUserAsync()` inside a receiver chain, and take the await route on the result.

### 5. A prefixed factory whose yield is qualified records a drop

```dart
// api.dart
import 'models.dart' as models;
Future<models.User> fetch() async => models.User();
// caller.dart
import 'api.dart' as api;
Future<void> run() async {
  final x = await api.fetch();
  x.save();
}
```

Missing edge: `run → User.save`, a recorded `receiver-unresolved` drop (pinned as
`prefixedQualifiedFactory` in `dart-awaited-receiver-owner.test.ts`; the same on the DART-04 base).
The binding is the namespace callee `api.fetch` with the awaited marker; the post-finalize follow
has to take two things on one binding — the namespace-callee step to `Future<models.User>` and the
qualified await hop through `qualifiedYieldAt` in `api.dart`'s scope — and today the hop is taken on
the first followed step only. Not traced further in this round; the fix must keep the producer-scope
rule for the qualifier.

## Code and regression entry points

- [Language provider directory](../../gitnexus/src/core/ingestion/languages/dart/).
- [Scope resolver](../../gitnexus/src/core/ingestion/languages/dart/scope-resolver.ts).
- [dart-coverage.test.ts](../../gitnexus/test/integration/resolvers/dart-coverage.test.ts).
- [dart.test.ts](../../gitnexus/test/integration/resolvers/dart.test.ts).
- [dart-type-extractor.test.ts](../../gitnexus/test/unit/dart-type-extractor.test.ts).

Evidence details: [receiver baseline notes](../../gitnexus/bench/receiver-resolution/BASELINE.md) and
[current roadmap](../../type-resolution-roadmap.md#current-backlog).

Dart permits explicit method type arguments; inference does not make this shape N/A.
See the [Dart type-system reference](https://dart.dev/language/type-system#type-argument-inference).
