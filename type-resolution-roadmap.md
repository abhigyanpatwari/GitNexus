# Type Resolution Roadmap

Planned work for type evidence and receiver resolution. Choose a bounded case
from the [language inventories](docs/languages/README.md), link its gap ID in the
implementation plan, and reproduce it on the chosen base before editing.

See the [measurement audit](docs/languages/receiver-resolution-audit.md) for
evidence and [Type Resolution System](type-resolution-system.md) for current
architecture.

## Current backlog

### 1. Correct bindings to unrelated declarations

- **Ruby YARD parameters (RUBY-01):** bind parameter annotations to their owning
  function. Test typed and untyped siblings that use the same parameter name in
  both declaration orders. The typed function must reach its exact method; the
  untyped sibling must remain unresolved. Preserve return and instance-field
  bindings.
- **Dart awaited calls (DART-04):** carry the declared awaited result into receiver
  resolution. `(await svc.getUserAsync()).save()` must reach `User.save` and reject
  the same-named `Address.save` decoy.

### 2. Type indexed receivers

Start with JavaScript `repos[0].save()`, then address Java, C#, Ruby, PHP, Swift,
Dart and Vue in separate provider changes. Preserve container element evidence
and implement the appropriate `ScopeResolver.elementTypeOf` routes. Keep capture
of a subscript, recognition of its container type and inference of its element
type separately testable.

Require exact targets, same-name decoys, untyped containers and unsupported-route
negatives. For Dart, require a recorded diagnostic when resolution fails. For
Vue, compare a real SFC with its equivalent TypeScript control.

### 3. Extend C++ template and coroutine result typing

- **Template returns (CPP-01):** substitute a return type such as `T` only when
  the selected declaration and explicit call arguments prove the mapping. Keep
  ambiguous overloads and unknown mappings unresolved; preserve conversion-only
  suppression tests.
- **Awaited results (CPP-03):** derive the receiver from a proven awaiter result
  such as `User await_resume()`. Require the exact `User.save` target and an
  unknown-awaiter negative in compiler-valid C++20 fixtures.

### 4. Extend Dart call spellings and callable returns

- **Non-null assertion (DART-02):** carry field ownership through
  `svc.getUser().address!.save()`. Preserve optional-access and nullable-field
  controls; keep awaited-call ownership covered separately.
- **Explicit type arguments (DART-05):** resolve `svc.getTyped<User>().save()`
  when the method declares a concrete `User` return. Treat generic return-type
  substitution as a separate contract.
- **Tear-offs (DART-03):** reproduce the primary callable-return expression and
  add an ambiguous-callable negative before choosing an implementation.

### 5. Extend Swift inherited-overload selection

Define one callable-identity rule at a time for **SWIFT-02**. Keep argument labels,
richer type identity and generic covariance as separate changes. Each change
must test its primary expression and preserve exact fixed/variadic override
targets and owner-mismatch negatives.

### 6. Audit overlapping APIs

- Inventory `resolveTypeRef` consumers and compare its policy with registry
  receiver-owner lookup before choosing integration or removal.
- Decide the role of `SemanticModel.scopes` and `attachScopeIndexes` before
  changing their exported contract; align comments with production consumers.
- Remove `reconcileOwnership` only after providers supply the necessary ownership
  and parity checks prove reconciliation is a no-op.
- Audit TypeEnv helper options and compatibility APIs against production parse
  worker inputs before deleting them.

### 7. Reproduce deferred ingestion and narrowing cases

Investigate C header ownership separately from function-pointer dispatch. Add
fixtures that distinguish C and C++ ownership for `.h` declarations.

Reproduce type predicates, positional destructuring and discriminated-union
narrowing on a pinned base before assigning implementation priority. Define the
required metadata contract for each. Apply the same process to the older Swift
extraction, inheritance and module-visibility reports in **SWIFT-03**.

## Completion criteria

1. Reproduce the target case and a meaningful negative control before editing;
   follow [AGENTS.md](AGENTS.md) for impact and change analysis.
2. Keep syntax and language semantics in provider hooks, with shared passes generic.
3. Assert full declaration identities, scope/import boundaries and diagnostics.
   Prefer an unresolved binding to an edge to an unrelated declaration.
4. Run affected unit/integration checks and compare the receiver baseline before
   updating it. Explain every intended classification change.
5. Compare a fixed resolution corpus; add capture and performance checks when
   the change affects those paths. Distinguish fresh runs from retained evidence.
6. Record unavailable grammars and partial graph coverage. Mark only the tested
   slice complete, without implying whole-language or compiler parity.
