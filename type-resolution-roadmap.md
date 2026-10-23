# Type Resolution Roadmap

The current direction is to improve type evidence and receiver resolution through
language providers, the semantic model and the shared scope-resolution pipeline.
The semantic model and typing helpers remain active. The parallel call-resolution
DAG was removed in RING4-1 #942.

Reviewed on 2026-10-23 against
[`bbbc1b49e`](https://github.com/abhigyanpatwari/GitNexus/commit/bbbc1b49e3427c467b8ac83a112f7793109e279b).
See [Type Resolution System](type-resolution-system.md) for current execution paths
and [ARCHITECTURE.md](ARCHITECTURE.md#semantic-model) for ownership and lifecycle.

## Principles

- Prefer missing a binding over emitting an edge to an unrelated declaration.
- Preserve scope, import, package and declaration-owner evidence.
- Put language syntax and semantics in provider hooks; keep shared passes generic.
- Separate receiver-resolution improvements from compiler-grade typing.
- Use exact targets, negative controls and source-pinned measurements for completion.

## Current architecture

| Layer                                         | Status                           | Direction                                                                                |
| --------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
| `SemanticModel` registries                    | Active                           | Retain authoritative declarations and owner-indexed member lookup.                       |
| TypeEnv and type extractors                   | Active extraction helpers        | Keep their per-file hints distinct from workspace resolution.                            |
| `ParsedFile` and scope indexes                | Active                           | Carry declarations, visibility and type facts into resolution.                           |
| Shared scope-resolution pipeline              | Active reference-resolution path | Improve propagation, receiver folding, overload selection and diagnostics through hooks. |
| Legacy call-resolution DAG and migration flag | Removed in #942                  | Historical phase recipes are not implementation entry points.                            |
| `crossFile` phase                             | Accumulator disposal only        | Cross-file lookup and return propagation belong to scope resolution.                     |

## Delivered receiver series

All 15 PRs below are merged into main. This completes the merge program, not every
receiver-resolution feature or every shape in the benchmark.

| Area                          | Merged work                                                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider layout               | [#3670](https://github.com/abhigyanpatwari/GitNexus/pull/3670): colocate import-resolution rules with language providers.                                                                                                                                                               |
| Zig receivers                 | [#3652](https://github.com/abhigyanpatwari/GitNexus/pull/3652): import aliases, forwarding constructors, anonymous containers and type applications.                                                                                                                                    |
| Ownership and reporting       | [#3653](https://github.com/abhigyanpatwari/GitNexus/pull/3653): receiver drops and property ownership; [#3658](https://github.com/abhigyanpatwari/GitNexus/pull/3658): provider-proven external receiver drops.                                                                         |
| Visibility and inheritance    | [#3655](https://github.com/abhigyanpatwari/GitNexus/pull/3655): C# namespace ranking; [#3659](https://github.com/abhigyanpatwari/GitNexus/pull/3659): same-package inheritance bases with reused simple names.                                                                          |
| Qualified factories and types | [#3656](https://github.com/abhigyanpatwari/GitNexus/pull/3656): C++; [#3657](https://github.com/abhigyanpatwari/GitNexus/pull/3657): Rust; [#3660](https://github.com/abhigyanpatwari/GitNexus/pull/3660): Kotlin; [#3662](https://github.com/abhigyanpatwari/GitNexus/pull/3662): PHP. |
| Field types                   | [#3664](https://github.com/abhigyanpatwari/GitNexus/pull/3664): C# nullable fields; [#3665](https://github.com/abhigyanpatwari/GitNexus/pull/3665): selected standard Rust smart-pointer fields.                                                                                        |
| Hoisted returns               | [#3666](https://github.com/abhigyanpatwari/GitNexus/pull/3666): Swift/Dart chained receivers with owner checks and bounded override replay.                                                                                                                                             |
| Chain spellings               | [#3667](https://github.com/abhigyanpatwari/GitNexus/pull/3667): explicit type arguments, transparent wrappers, conditional access and additional subscript spellings.                                                                                                                   |
| Benchmark evidence            | [#3663](https://github.com/abhigyanpatwari/GitNexus/pull/3663): typed JS/Ruby/PHP shape bodies, deliberate untyped controls and C member-dispatch N/A cases.                                                                                                                            |

The merged [receiver baseline](gitnexus/bench/receiver-resolution/BASELINE.md)
records the combined results. Its count arm is 138 call drops, 168 total drops,
30 reads and no writes. The typed-shape PR changes exactly 13 parent-relative
cells; eight typed cells resolve, two untyped controls remain visible gaps, and
three C cells become N/A. At that merge, the shape gate matched only member
names. The [measurement audit](docs/languages/receiver-resolution-audit.md) adds
exact declaration checks, exposes a wrong Dart await target and executes previously
excluded C++, Rust, PHP, Dart and Vue cases. These are measurement corrections,
not resolver fixes.

The combined walker validation recorded a 5,559-record resolution corpus. The
benchmark-only child retained that parent evidence through identical producer
inputs; it did not claim a separate child corpus run. Local historical graph
coverage remained partial/UNKNOWN. These receipts do not establish exhaustive
language coverage, rename correctness or a performance proof.

## Current backlog

These are proposed follow-up slices, not claims that implementation has started.
Reproduce each gap on its chosen base before changing code. Use the
[per-language ingestion inventories](docs/languages/README.md) to select a bounded
case and link its gap ID from the implementation plan.

### 1. Isolate Ruby YARD parameter bindings

The typed baseline documents sibling-function leakage when two parameters share
a name. Fix capture/binding ownership in the Ruby provider. Test typed and untyped
functions using the same parameter name in both declaration orders. The typed
function must resolve the exact owned method; the untyped sibling must remain
unresolved. Preserve method return and instance-field bindings.

### 2. Type indexed receivers

The fresh audit records indexed gaps in JavaScript, Java, C#, Ruby, PHP, Swift,
Dart and Vue. Start with JavaScript `repos[0].save()`, then evaluate the others as
separate provider changes. Preserve element-type evidence and implement the
appropriate `ScopeResolver.elementTypeOf` routes. Reading a subscript spelling,
recognizing a container annotation and typing an element are separate steps.
Test exact targets, same-name decoys, untyped containers and unsupported routes.

### 3. Substitute proven C++ template return types

The walker reads `getTyped<User>()`, but a return annotation `T` does not generally
become `User`. Add only substitutions justified by the selected declaration and
its explicit type arguments. Keep ambiguous overloads and unknown mappings
unresolved; preserve the conversion-only suppression regression tests.

### 4. Extend callable returns and inherited overload selection

Dart awaited-call ownership needs correction: the fixture reaches Address.save
where User.save is required. Explicit generic calls also remain a measured gap.
Dart tear-off invocation and Swift argument-aware inherited overloads need
additional evidence. Existing supported fixed/variadic override positives must
remain exact. Fixture-local positive controls detect fixture-wide resolution loss;
they do not prove completeness for the unsupported primary expressions. Treat
argument labels, richer type identity and generic covariance as separate contracts.

### 5. Audit API and documentation remnants

- `resolveTypeRef` is exported and tested, with no production caller found in the
  reviewed source. Registry lookup has its own receiver-owner resolution. Compare
  policies and inventory API users before choosing integration or removal.
- `SemanticModel.scopes` / `attachScopeIndexes` exist, but the current production
  orchestrator consumes the returned indexes directly. Correct stale comments and
  decide the API's role before changing the exported contract.
- `reconcileOwnership` remains active. Remove it only after providers supply the
  necessary ownership and parity checks demonstrate that reconciliation is a no-op.
- Keep TypeEnv's supported helper options distinct from inputs actually supplied
  by production parse workers; audit consumers before deleting compatibility APIs.

### 6. Revalidate the remaining historical backlog

The typed C benchmark's N/A dispatch result does not fix C header ownership:
the baseline still records C structs in `.h` files being owned by the C++ provider.
Treat header ownership as a separate provider-classification task.

The earlier roadmap also deferred type predicates, positional destructuring and
discriminated-union narrowing. Keep those as candidates requiring current
source-pinned reproductions and a defined metadata contract; the receiver series
does not establish their completion. The Swift inventory applies the same rule
to its older extraction, inheritance and module-visibility reports.

## Historical delivery phases

The older phase names describe the evolution of TypeEnv and the former DAG.
They remain useful for commit/test history. Their original mechanisms are not the
current implementation plan.

| Historical phase                                                            | Delivered capability                                                                    | Current interpretation                                                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 7                                                                     | Return-aware and iterable hints, `ReturnTypeLookup`, PHP property annotations           | Extraction helpers remain; workspace return lookup belongs to scope resolution.                                                                               |
| Phase 8                                                                     | Owner-oriented fields, deep/mixed chains, ACCESSES and selected passthroughs            | Model registries and scope receiver passes own current resolution.                                                                                            |
| Phase 9 + 9C ([#379](https://github.com/abhigyanpatwari/GitNexus/pull/379)) | Call-result, copy, field and method-result propagation                                  | TypeEnv retains bounded helper propagation; the workspace pipeline refines scope bindings from resolved calls.                                                |
| Milestone D ([#387](https://github.com/abhigyanpatwari/GitNexus/pull/387))  | Loop replay, destructuring, inheritance/receiver handling and selected narrowing        | Do not restore the removed parse-time heritage pre-pass; current inheritance uses scope resolution and MRO.                                                   |
| Phase P.1–P.4                                                               | Parameter metadata, overload narrowing, constructor-visible dispatch and optional arity | Supported cases remain regression contracts; dispatch is provider- and evidence-dependent.                                                                    |
| Phase P.5                                                                   | Covariant return awareness was left open                                                | Exact Swift override replay is delivered; general covariance, labels and richer generic identity remain separate work.                                        |
| Phase S                                                                     | Swift parity backlog                                                                    | Swift is registered and tested; it is not globally blocked on Node 22. Check the current Swift inventory per construct.                                       |
| Phase 14                                                                    | Cross-file binding propagation                                                          | Delivered historically. Its legacy re-resolution implementation was retired in #942; finalized imports and imported-return propagation are active successors. |

Older descriptions are available in the
[pre-update roadmap](https://github.com/abhigyanpatwari/GitNexus/blob/bbbc1b49e3427c467b8ac83a112f7793109e279b/type-resolution-roadmap.md).
The [Swift inventory](docs/languages/swift-ingestion-gaps.md) distinguishes measured support from
historical reports that still need reproduction.

## Completion criteria for follow-up work

1. Pin the source and reproduce the intended behavior and a meaningful negative
   control before editing. Follow AGENTS.md for impact and change analysis.
2. Keep language-specific logic in the owning provider and shared passes generic.
3. Assert full declaration identities, shadowing/import boundaries and recorded
   drops; a member-name-only benchmark is insufficient ownership proof.
4. Run affected unit/integration checks and compare the receiver baseline without
   UPDATE first. Review any intended baseline changes explicitly.
5. Compare a fixed resolution corpus and record capture/performance checks when
   the change reaches those surfaces. Retain evidence by source/input identity
   when only ancestry changes; do not present retained runs as fresh runs.
6. Record grammar-unavailable cases and partial graph coverage honestly. Mark the
   specific slice delivered without implying whole-language or compiler parity.
